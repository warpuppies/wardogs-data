# Developing wardogs-data

This is for running or changing the pipeline that builds the data. To use the data, read [README.md](README.md).

## Branches

- `main` holds only what a user of the data needs: `data/`, the `README.md` for users, the `LICENSE`, and the manifests of the images in `assets/` (`assets/icons.manifest.json`, `assets/maps.manifest.json`). The images themselves are not in git; they are ignored and ship in the full zip.
- `dev` is `main` plus everything that produces and checks the data: `src/` (including the public helpers in `src/lib/`), `extractor/`, `test/`, `scripts/`, CI and this file.

Work happens on `dev`. After `pnpm apply` (and `pnpm icons`, `pnpm maps`), `pnpm readme` and a passing `pnpm check`, commit on `dev`, then bring the user-facing files over to `main` without the tooling:

```sh
git switch main
git restore --source dev --staged --worktree -- data assets README.md LICENSE
git commit -m "Update data for build <id>"
git switch dev
git merge main   # keeps dev a superset of main
```

`git diff main dev -- data assets README.md LICENSE` is empty when `main` is up to date.

## Publishing a build

Releases are tagged on `dev`, after `main` is up to date and merged back, so the tag holds the tooling that builds the archives:

```sh
git tag build-<id> && git push origin build-<id>
```

The `publish` workflow (`.github/workflows/publish.yml`) then runs two jobs. `small` builds the small zip (data, README, license) with its checksum and creates the GitHub release with notes from the data (`pnpm bundle --small`). `pages` builds the static site (`pnpm site`) and deploys it to GitHub Pages, without any images.

The full zip (plus the icons and map tiles) cannot be built in CI, because the images are not in git. Build it on the machine that has them, after the workflow has created the release:

```sh
pnpm bundle                # verifies data, icons and tiles, then writes dist/bundles/
gh release upload build-<id> dist/bundles/*-full.zip dist/bundles/*-full.zip.sha256
```

The archives are reproducible, so `pnpm bundle` gives the same small zip as the one CI built.

One-time setup on GitHub: in the repository settings, set Pages to "GitHub Actions" and allow the `build-*` tags in the `github-pages` environment's deployment rules.

## What's in the repo

| Path | Contents |
| --- | --- |
| `data/` | Generated dataset: JSON, JSON Schema, CSV and a data dictionary. Never edited by hand; see `data/MANIFEST.json`. |
| `src/` | TypeScript pipeline: config, key and mappings checks, transforms, tiles, manifest, derived files, release, CLI. |
| `extractor/` | Small .NET tool (CUE4Parse) that decodes game packages to plain files. Its SDK and CUE4Parse revision are pinned; `extractor/patches/` holds the one local change to that revision (it keeps the bytes of property bags), applied by `pnpm setup:extractor`. |
| `test/` | Unit tests, end-to-end pipeline tests, dataset tests and live-install tests. |

Everything in `data/` is produced by the tooling and checked against a manifest of checksums (`pnpm verify`). To change a generated file, change the code or configuration that produces it and run `pnpm apply`.

Not in the repo, and never committed: the icon and map images in `assets/icons/` and `assets/maps/` (their manifests are committed), the game files, the AES key, the mappings (`.usmap`) file, the extraction cache (`.cache/`) and the build output in `dist/` (the working copy of the tiles and the zips from `pnpm bundle`). You supply the key and mappings yourself.

## Setup

Requirements: Node 22+, pnpm, git, the .NET 10 SDK, and a Wardogs install.

```bash
pnpm install
pnpm setup:extractor     # fetches the pinned CUE4Parse revision and builds the extractor
cp .env.example .env     # then fill in your paths (the file is gitignored)
```

The pnpm scripts and the tests read `.env` automatically (variables already set in your shell win). Variables: `WARDOGS_INSTALL_DIR` (folder containing `Wardogs/`), `WARDOGS_AES_KEY` or `WARDOGS_AES_KEY_FILE`, `WARDOGS_USMAP`, and optionally `DOTNET_ROOT` if `dotnet` is not on your PATH.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm doctor` | Checks the install, the key against every encrypted container, the mappings header and the extractor. |
| `pnpm restore-names <new.usmap> <old.usmap> <out.usmap>` | Writes a copy of a mappings file whose property names are scrambled or whose array types are unsaid, with the real names and types taken from an older mappings file (see "Scrambled property names" below). |
| `pnpm extract [dataset]` | Decodes game data into the cache (`.cache/raw`). Datasets: `items`, `gameplay`, `damage`, `progression`, `meta`, `features`, `movement`, `maps`, `objectives`, `objects`. Only `items`, `gameplay`, `maps` and `objects` read the game; `damage`, `progression`, `meta`, `features`, `movement` and `objectives` only read what those extracted. The extractions run at the same time (see "Speed" below). |
| `pnpm plan` | Shows what `apply` would change and writes nothing. `--check` exits 1 if anything would change. |
| `pnpm apply` | Writes every generated file and `data/MANIFEST.json`. Safe to run twice. |
| `pnpm verify` | Checks `data/` against its manifest, and `assets/icons/` and `assets/maps/` against their manifests when those folders are present (they are not in git, so CI skips them). Needs no game, so CI runs it. |
| `pnpm icons` | Copies the item icons from the extraction cache into `assets/icons/` and writes their manifest. The images are ignored by git; commit the manifest. |
| `pnpm maps` | Copies the built map tiles and heightmaps from `dist/` into `assets/maps/` and writes their manifest, `assets/maps.manifest.json`. The files are ignored by git; commit the manifest. |
| `pnpm assets` | Builds the map tile pyramids, heightmaps and icons into `dist/`, with a release manifest of checksums. A world whose map image, heightmap and tiler settings are unchanged is kept, not tiled again. |
| `pnpm verify:assets` | Checks `dist/` against its release manifest (sizes and checksums, no unlisted files). |
| `pnpm readme` | Rewrites the completeness table in `README.md` from `src/derived/completeness.ts`. A test fails when the README is out of date. |
| `pnpm bundle [--small]` | Verifies the data (and, without `--small`, the icons and map tiles), then packs the small zip (data, README, license) and the full zip (plus icons and map tiles) into `dist/bundles/`, with `.sha256` files and release notes. Publishes nothing. |
| `pnpm site` | Builds the static API site into `dist/site/`: every file under `data/` at `/v1/<path>`, `/v1/index.json` with sizes and checksums, a landing page and a 404 page. No images. |
| `pnpm diff` | Markdown report of how every data file differs from the last commit: records added, removed and changed, field by field. Every published file type must declare how its records are keyed (`src/changes.ts`); a test enforces it. |
| `pnpm cli <command>` | Runs any command directly (`pnpm cli` lists them). |
| `pnpm update-data` | `doctor`, `extract`, `apply`, `verify`, then the tests, in one step. |
| `pnpm check` | Typecheck, tests and verify. Works without the game; live tests skip themselves. |

## Speed

A full `pnpm update-data` (extract, apply, verify and the tests) takes about 45 seconds on 16 cores, when the game files are on a local disk. What makes it fast:

- **A local copy of the game files.** Reading them through `/mnt/c` in WSL runs at about 65 MB/s, which made every scan three times slower. Copy the `Paks` folder (and the Steam manifest, which gives the build number) once, with the same layout, and point `WARDOGS_INSTALL_DIR` at the copy:

  ```bash
  SRC=/mnt/c/Games/Steam/steamapps; DST=$HOME/wardogs-copy/steamapps
  mkdir -p $DST/common/Wardogs/Wardogs/Content/Paks
  rsync -a --delete --info=progress2 $SRC/common/Wardogs/Wardogs/Content/Paks/ $DST/common/Wardogs/Wardogs/Content/Paks/
  cp $SRC/appmanifest_1867240.acf $DST/
  ```

  After a game update, run the `rsync` again: it only copies what changed. It also keeps the extraction off the Steam folder while you play.
- **The datasets extract together.** `pnpm extract` starts every dataset at once, and a dataset that needs another's files waits for it (the linked vehicle packages need the items). The extractor processes run through a pool: `WARDOGS_JOBS` at a time (default 9), and `WARDOGS_HEAVY_JOBS` of the ones that hold a whole map image in memory (default 4). Each prints how long it took, and when it started and ended, so a slow one is easy to see.
- **The scans decode what they need.** The class of every export of a level is in the package's export table, so the scans of actors, buildings and texture volumes decode only the exports of the classes they want, not the hundred thousand others of a level. Blueprint classes are resolved once per run, and their names are kept in `.cache/raw/class-names.json` for the next one. `WARDOGS_THREADS` sets the threads each scan uses (default one per processor, at most 8; more does not help).
- **Map images are written by a small PNG writer** (`extractor/FastPng.cs`): the same pixels, in seconds instead of minutes, in files about a third bigger.

## Updating after a game patch

1. `pnpm update-data`
2. If `doctor` reports the AES key no longer matches, the update rotated it. Get the new key and update your key file.
3. If extraction fails to decode packages, the mappings file is out of date for the new build. Replace it. If `doctor` says the property names in the new file are scrambled, see "Scrambled property names" below.
4. Read the plan output and `pnpm diff`. Added, removed and changed records (items, weapons, ammo, damage rules, buildings, objects and the rest) are listed with before and after values.
5. If a **canary test** fails (`test/data.test.ts`, `test/gameplay-data.test.ts`, `test/damage-data.test.ts`), decide whether the game changed that value (update the expectation) or the extraction broke (fix the transform).
6. If the **id test** fails, a new id form appeared. Extend `KNOWN_ID_PATTERN` or document it in `KNOWN_ID_QUIRKS` in `src/schema.ts`.
7. Commit the regenerated `data/` together with any code change.

## Scrambled property names

A game build can ship with the names of its properties scrambled (`_aaabiggnlpebjfhcidicc` instead of `ActivationID`). A mappings file taken from such a build has the scrambled names, and the transforms read properties by name, so they find nothing: `doctor` then reports how many of the file's property names are scrambled, and a map with no building parts or a table with no `Resources` is the other sign. A scrambled name is the same text wherever the property appears, so an older mappings file with the real names tells what most of them stand for: `pnpm restore-names <new.usmap> <old.usmap> <out.usmap>` writes a copy of the new file with those names restored (an uncompressed file, so it also reads where the original is compressed) and prints how many it could not restore. A file made from a live game can also leave the type inside an array unsaid (`Array<Unknown>`), and the arrays cannot then be read: the level files take minutes and gigabytes to decode. The same command takes those types from the property of the same name in the old file. Those are properties that only exist in the new build; nothing here can name them, so data that sits in one of them is missing until a mappings file with real names exists. `name-hints.json` lists the few names that the structure cannot give but that the data confirms (the scrambled key held the same non-trivial value as the old data's property of that name); the command applies them to names that are still scrambled and never over a name the old file settles. Point `WARDOGS_USMAP` at the output.

## How the tests protect the data

- **Unit tests** cover each transform with synthetic fixtures: grid and stack parsing, tooltip text and icons, vendor-table joins, unlock trees, weapon, ammo, attachment, armor, vehicle and damage tables, map metadata and padding, building boxes, tile cutting, terrain decoding and the buildings-on-terrain check, CSV, JSON Schema and dictionary generation, release and zip bundling, the static site, key verification (a synthetic container is built and encrypted in the test), diffing and the value-per-slot maths.
- **Pipeline tests** run `plan` and `apply` on a synthetic cache: applying twice changes nothing, a hand-edited generated file fails `verify`, and stale files are removed.
- **Dataset tests** validate every data file with its schema and with the generated JSON Schema, check ids are unique, sorted and cross-referenced (every weapon, attachment and vehicle exists in `items.json`), and enforce coverage floors so a silent extraction failure (for example a format change that drops fields) fails loudly.
- **Docs tests** fail if a pnpm script is missing from this file, a published file type or helper is missing from `README.md`, the completeness table is out of date, or a schema field has no description.
- **Canaries** pin values that were checked by hand against the game.
- **Live tests** (`test/live.test.ts`) run only when a game install is configured. They confirm the key still decrypts every container and that the committed data matches the installed build.

## Notes on the data

- A stackable item whose stack size equals the engine default is saved without a value, so the pipeline treats an empty stack fragment as `DEFAULT_MAX_STACK` (2). Verified against items with known stack sizes.
- Ammo prices are per purchase lot: `price` buys `amount` units.
- Value per slot is `price / amount * maxStack / (width * height)` (`src/analyze/valuePerSlot.ts`).
- The game ships a few developer test items and one item with a truncated id; see `KNOWN_ID_QUIRKS`.
