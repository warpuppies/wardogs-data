import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { EXTRACTOR_DLL } from "./extract/run.js";
import { readGameBuild } from "./extract/steam.js";
import { parseUsmapHeader } from "./extract/usmap.js";
import { restoreUsmap, scrambledShare } from "./extract/usmapNames.js";
import { summarizeKeyReports, verifyKeyAgainstInstall } from "./extract/verifyKey.js";
import { diffAgainstHead } from "./diffCommand.js";
import { formatPlan, hasChanges } from "./generated.js";
import { apply, buildAllAssets, extractAll, plan, verify } from "./pipeline.js";
import { buildZipBundles } from "./bundle.js";
import { syncReadme } from "./docs.js";
import { verifyAssets } from "./release.js";
import { buildSite } from "./site.js";
import { syncTrackedMaps, TRACKED_MAPS_DIR, verifyTrackedMaps } from "./trackedMaps.js";
import { iconReferences, syncTrackedIcons, TRACKED_ICONS_DIR, verifyTrackedIcons } from "./icons.js";
import { ICONS_DIR } from "./transform/build.js";

const HELP = `Usage: pnpm cli <command>

  doctor [--quiet]      Check install, AES key, mappings file and extractor
  restore-names <new.usmap> <old.usmap> <out.usmap>
                        Write a copy of a mappings file whose property names are scrambled, with the real names taken from an older one
  extract [dataset]     Decode game data into the cache (.cache/raw)
  plan [--check]        Show what apply would change, writing nothing (--check exits 1 if anything would change)
  apply                 Write every generated file and data/MANIFEST.json
  verify                Check data/ and assets/icons/ against their manifests (no game needed)
  icons                 Copy the item icons into assets/icons/ (not committed; shipped in the full zip) from the cache
  maps                  Copy the built map tiles and heightmaps from dist/ into assets/maps/ (not committed; shipped in the full zip)
  assets                Build map tiles, heightmaps and item icons into dist/ (not committed)
  verify-assets         Check dist/ against dist/RELEASE-MANIFEST.json
  readme                Rewrite the completeness table in README.md from the code
  bundle [--small]      Pack the small zip (data) and the full zip (data, icons, map tiles) into dist/bundles/ (publishes nothing)
  site                  Build the static API site (data files under /v1/, no images) into dist/site/
  diff                  Compare every data file with the last commit: records added, removed and changed
  update                doctor, extract, apply, verify, then tests

Configuration comes from the environment: WARDOGS_INSTALL_DIR, WARDOGS_AES_KEY (or _FILE), WARDOGS_USMAP.`;

function log(ok: boolean, message: string): boolean {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  return ok;
}

async function doctor(): Promise<boolean> {
  let healthy = true;
  const config = loadConfig();
  healthy = log(existsSync(config.paksDir), `Paks folder: ${config.paksDir}`) && healthy;
  if (!existsSync(config.paksDir)) return false;

  console.log(`     game build: ${readGameBuild(config.installDir)}`);
  try {
    const bytes = readFileSync(config.usmapPath);
    const info = parseUsmapHeader(bytes);
    const { scrambled, properties } = scrambledShare(bytes);
    const readable = scrambled <= properties * 0.05;
    healthy = log(readable, `mappings file: version ${info.version}, compression ${info.compression}, ${scrambled} of ${properties} property names scrambled`) && healthy;
    if (!readable) console.log("     The property names are scrambled, so nothing reads them by name. Run `pnpm restore-names <this file> <an older file with the real names> <output>` and point WARDOGS_USMAP at the output.");
  } catch (e) {
    healthy = log(false, `mappings file: ${(e as Error).message}`) && false;
  }
  const counts = summarizeKeyReports(await verifyKeyAgainstInstall(config.paksDir, config.aesKey));
  healthy = log(counts.ok > 0 && counts.wrong === 0, `AES key: ${counts.ok} containers ok, ${counts.wrong} wrong, ${counts.plain} unencrypted, ${counts.unsupported} unsupported`) && healthy;
  if (counts.wrong > 0) console.log("     The key no longer matches. A game update probably rotated it.");
  healthy = log(existsSync(EXTRACTOR_DLL), "extractor built") && healthy;
  return healthy;
}

function diff(): void {
  const report = diffAgainstHead(process.cwd());
  console.log(report ?? "No commit to compare against yet.");
}


function printVerify(): boolean {
  const root = process.cwd();
  const result = verify(root);
  if (result.ok) console.log(`ok   verify: ${result.checked} files match data/MANIFEST.json`);
  else {
    console.log("FAIL verify:");
    for (const p of result.problems) console.log(`     ${p}`);
    console.log("     Generated files must not be edited by hand. Fix the code or config, then run `pnpm apply`.");
  }
  // The images are not in git. Where they are absent (a fresh clone, CI) only the manifests are tracked, so skip them.
  const hasIcons = existsSync(join(root, TRACKED_ICONS_DIR));
  const icons = hasIcons ? verifyTrackedIcons(root, iconReferences(root)) : [];
  if (!hasIcons) console.log(`skip verify: ${TRACKED_ICONS_DIR}/ is not here (the images are built by \`pnpm icons\`)`);
  else if (icons.length === 0) console.log(`ok   verify: ${TRACKED_ICONS_DIR}/ matches its manifest`);
  else {
    console.log("FAIL verify icons:");
    for (const p of icons.slice(0, 20)) console.log(`     ${p}`);
    if (icons.length > 20) console.log(`     ... and ${icons.length - 20} more`);
  }
  const hasMaps = existsSync(join(root, TRACKED_MAPS_DIR));
  const maps = hasMaps ? verifyTrackedMaps(root) : [];
  if (!hasMaps) console.log(`skip verify: ${TRACKED_MAPS_DIR}/ is not here (the tiles are built by \`pnpm assets\` and \`pnpm maps\`)`);
  else if (maps.length === 0) console.log(`ok   verify: ${TRACKED_MAPS_DIR}/ matches its manifest`);
  else {
    console.log("FAIL verify maps:");
    for (const p of maps.slice(0, 20)) console.log(`     ${p}`);
    if (maps.length > 20) console.log(`     ... and ${maps.length - 20} more`);
  }
  return result.ok && icons.length === 0 && maps.length === 0;
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const root = process.cwd();
  switch (command) {
    case "doctor":
      process.exitCode = (await doctor()) ? 0 : 1;
      return;
    case "restore-names": {
      const [scrambled, reference, out] = process.argv.slice(3);
      if (!scrambled || !reference || !out) throw new Error("Usage: restore-names <new.usmap> <old.usmap> <out.usmap>");
      const hintsFile = join(root, "name-hints.json");
      const hints = existsSync(hintsFile) ? (JSON.parse(readFileSync(hintsFile, "utf8")) as { names?: Record<string, string> }).names ?? {} : {};
      const { file, report } = restoreUsmap(readFileSync(scrambled), readFileSync(reference), hints);
      writeFileSync(out, file, { mode: 0o600 });
      console.log(`${report.restored} of ${report.scrambled} scrambled names got their real name back (${report.conflicting} had two answers and were left alone); ${report.recased} names got the capitals the old file spells them with; ${report.guessed} were named by their place in a struct that grew at the end; ${report.hinted} came from name-hints.json.`);
      console.log(`${report.stillScrambled} of ${report.properties} properties are still scrambled: properties the old file does not have.`);
      console.log(`${report.typesRestored} types the file left unsaid were taken from the old file; ${report.stillUnknown} properties still have one. Written to ${out}.`);
      return;
    }
    case "extract":
      await extractAll(loadConfig(), arg);
      return;
    case "plan": {
      const { entries, built } = await plan(root, join(root, ".cache", "raw"));
      for (const n of built.notes) console.log(n);
      console.log(formatPlan(entries));
      if (arg === "--check" && hasChanges(entries)) process.exitCode = 1;
      return;
    }
    case "apply": {
      const { entries, built } = await apply(root, join(root, ".cache", "raw"));
      for (const n of built.notes) console.log(n);
      console.log(formatPlan(entries));
      return;
    }
    case "verify":
      process.exitCode = printVerify() ? 0 : 1;
      return;
    case "icons": {
      const files = syncTrackedIcons(root, join(root, ".cache", "raw", ICONS_DIR), iconReferences(root));
      console.log(`${files.length} icons in ${TRACKED_ICONS_DIR}/. The images are not committed; commit assets/icons.manifest.json.`);
      return;
    }
    case "maps": {
      const { worlds, files } = syncTrackedMaps(root, join(root, "dist"));
      console.log(`${files} map files for ${worlds} worlds in ${TRACKED_MAPS_DIR}/. The files are not committed; commit assets/maps.manifest.json.`);
      return;
    }
    case "assets":
      await buildAllAssets(loadConfig(), join(root, "dist"));
      return;
    case "verify-assets": {
      const problems = verifyAssets(join(root, "dist"));
      for (const p of problems.slice(0, 20)) console.log(`problem: ${p}`);
      console.log(problems.length ? `verify-assets: ${problems.length} problems` : "ok   verify-assets: dist/ matches its manifest");
      process.exitCode = problems.length ? 1 : 0;
      return;
    }
    case "readme":
      console.log(syncReadme(root) ? "README.md: completeness table updated." : "README.md: completeness table is current.");
      return;
    case "bundle": {
      const small = arg === "--small";
      if (small) {
        const result = verify(root);
        if (!result.ok) throw new Error(`verify failed:\n  ${result.problems.slice(0, 10).join("\n  ")}\nRun \`pnpm apply\` first.`);
      } else if (!printVerify()) throw new Error("verify failed: the data or the assets do not match their manifests.");
      const out = join(root, "dist", "bundles");
      const bundle = buildZipBundles(root, out, small ? ["small"] : ["small", "full"]);
      for (const f of bundle.files) console.log(`${f.name.padEnd(36)} ${(f.bytes / 1024 / 1024).toFixed(1)} MB  ${f.sha256.slice(0, 12)}`);
      console.log(`\nPrepared ${bundle.tag} in ${out}. Nothing was published.`);
      return;
    }
    case "site": {
      const out = join(root, "dist", "site");
      const site = buildSite(root, out);
      console.log(`Built the site for build ${site.build}: ${site.files.length} files under /v1/ in ${out}.`);
      return;
    }
    case "diff":
      return diff();
    case "update": {
      if (!(await doctor())) throw new Error("doctor failed; fix the problems above before updating.");
      const config = loadConfig();
      diff();
      await extractAll(config);
      const { entries, built } = await apply(root, config.rawDir);
      for (const n of built.notes) console.log(n);
      console.log(formatPlan(entries));
      diff();
      if (!printVerify()) throw new Error("verify failed after apply.");
      const tests = spawnSync("pnpm", ["test"], { stdio: "inherit" });
      process.exitCode = tests.status ?? 1;
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
