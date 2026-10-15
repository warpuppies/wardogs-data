// Decodes Wardogs game packages using CUE4Parse and writes plain files for the TypeScript pipeline.
//
// Configuration (environment variables, set by the TypeScript CLI):
//   WARDOGS_PAKS_DIR  folder containing the .pak / .utoc / .ucas files
//   WARDOGS_AES_KEY   64-character hex AES-256 key
//   WARDOGS_USMAP     path to the .usmap mappings file
//   WARDOGS_CLASS_CACHE  optional: a file where the scans keep the class names they resolved (shared by commands and runs)
//   WARDOGS_THREADS   optional: how many threads the scans use (default: one per processor, at most 8; more does not help, as the largest levels set the pace)
//
// Commands (all output goes to the paths given; progress goes to stderr):
//   list <pattern>                                        print the package paths that match (a diagnostic for exploring the install)
//   export-json <includeRegex> <excludeRegex> <outDir>   decode every matching .uasset to JSON
//   export-building-parts <worldFolder> <out.jsonl>       raw facts about destructible buildings in a world
//   export-texture <packagePath> <out.png>                largest decodable level of a texture, as PNG (8-bit colour or 16-bit grayscale)
//   export-textures <packages.json> <outDir>              full-size PNG of every texture in a list, under its package path (icons)
//   export-actors <worldFolder> <classPattern> <out.jsonl>  placed actors of a world whose class matches: class, name, transform, simple properties
//   export-rvt-volumes <levelPackage> <out.json>          runtime virtual texture volumes of a level (texture refs and transforms)
using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text.RegularExpressions;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.IO.Objects;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

static string Env(string name) =>
    Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException($"{name} is not set.");

var provider = new DefaultFileProvider(
    Env("WARDOGS_PAKS_DIR"), SearchOption.TopDirectoryOnly,
    new VersionContainer(EGame.GAME_UE5_7), StringComparer.OrdinalIgnoreCase);
provider.MappingsContainer = new FileUsmapTypeMappingsProvider(Env("WARDOGS_USMAP"));
provider.Initialize();
provider.SubmitKey(new FGuid(), new FAesKey("0x" + Env("WARDOGS_AES_KEY")));

Console.Error.WriteLine($"mounted {provider.MountedVfs.Count} containers, {provider.Files.Count} files");
if (provider.Files.Count == 0) { Console.Error.WriteLine("No files mounted: wrong AES key or Paks folder."); return 2; }

// How many threads the scans use: WARDOGS_THREADS, else one per processor, at most 8 (more does not help: the biggest levels set the pace).
static int Threads() => int.TryParse(Environment.GetEnvironmentVariable("WARDOGS_THREADS"), out var t) && t > 0 ? t : Math.Min(Environment.ProcessorCount, 8);

// The class of every export of an IoStore package, read from its export table without decoding any export. A level has
// over a hundred thousand exports, and the scans want a few of them. The class of an export that is a blueprint lives in
// another package, and resolving it loads that package's imports (some 40 ms), so each is resolved once for the whole run,
// by the hash of its name in its package, and not once per level. (Equal hashes mean the same name, which is all that is read.)
var classByImportHash = new ConcurrentDictionary<ulong, string?>();
var classByIndex = new ConcurrentDictionary<ulong, string?>();

// The resolved names are kept in a file (WARDOGS_CLASS_CACHE) shared by the commands of a run and by later runs: a name
// belongs to its hash, whatever the build. A file that cannot be read is ignored, and one that cannot be written is skipped.
var classCachePath = Environment.GetEnvironmentVariable("WARDOGS_CLASS_CACHE");
void LoadClassCache()
{
    if (classCachePath is null || !File.Exists(classCachePath)) return;
    try
    {
        foreach (var (key, name) in JsonConvert.DeserializeObject<Dictionary<string, string?>>(File.ReadAllText(classCachePath)) ?? new())
            (key[0] == 'i' ? classByImportHash : classByIndex)[ulong.Parse(key[1..])] = name;
    }
    catch { }
}
void SaveClassCache()
{
    if (classCachePath is null) return;
    try
    {
        var all = new SortedDictionary<string, string?>(StringComparer.Ordinal);
        // Merge with what other commands saved since this one started.
        if (File.Exists(classCachePath))
            foreach (var (key, name) in JsonConvert.DeserializeObject<Dictionary<string, string?>>(File.ReadAllText(classCachePath)) ?? new()) all[key] = name;
        foreach (var (hash, name) in classByImportHash) all["i" + hash] = name;
        foreach (var (id, name) in classByIndex) all["s" + id] = name;
        var temp = classCachePath + "." + Environment.ProcessId + ".tmp";
        File.WriteAllText(temp, JsonConvert.SerializeObject(all, Formatting.Indented));
        File.Move(temp, classCachePath, overwrite: true);
    }
    catch { }
}
LoadClassCache();
string?[] ExportClasses(IoPackage io)
{
    var classes = new string?[io.ExportMap.Length];
    var local = new Dictionary<ulong, string?>();
    for (int i = 0; i < classes.Length; i++)
    {
        var index = io.ExportMap[i].ClassIndex;
        if (local.TryGetValue(index.TypeAndId, out var known)) { classes[i] = known; continue; }
        string? name;
        if (index.IsPackageImport)
        {
            var hash = io.ImportedPublicExportHashes[index.AsPackageImportRef.ImportedPublicExportHashIndex];
            name = classByImportHash.GetOrAdd(hash, _ => io.ResolveObjectIndex(index)?.Name.Text);
        }
        else if (index.IsScriptImport) name = classByIndex.GetOrAdd(index.TypeAndId, _ => io.ResolveObjectIndex(index)?.Name.Text);
        else name = io.ResolveObjectIndex(index)?.Name.Text;
        local[index.TypeAndId] = classes[i] = name;
    }
    return classes;
}

switch (args.FirstOrDefault())
{
    case "list" when args.Length == 2:
        return List(new Regex(args[1], RegexOptions.IgnoreCase));

    case "export-json" when args.Length == 4:
        // Compiled: the patterns can name hundreds of packages and are tried against every file of the install.
        return ExportJson(new Regex(args[1], RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled), new Regex(args[2], RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled), args[3]);

    case "export-building-parts" when args.Length == 3:
        return ExportBuildingParts(args[1], args[2]);

    case "export-texture" when args.Length == 3:
        return ExportTexture(args[1], args[2]);

    case "export-actors" when args.Length == 4:
        return ExportActors(args[1], new Regex(args[2], RegexOptions.IgnoreCase), args[3]);

    case "export-textures" when args.Length == 3:
        return ExportTextures(args[1], args[2]);

    case "export-rvt-volumes" when args.Length == 3:
        return ExportRvtVolumes(args[1], args[2]);

    default:
        Console.Error.WriteLine("Usage: Unpack list <pattern> | export-json <include> <exclude> <outDir> | export-building-parts <worldFolder> <out.jsonl> | export-texture <package> <out.png> | export-textures <packages.json> <outDir> | export-actors <worldFolder> <classPattern> <out.jsonl> | export-rvt-volumes <level> <out.json>");
        return 1;
}

// Prints the package paths (`.uasset` and `.umap`) that match, one per line, sorted.
int List(Regex pattern)
{
    foreach (var path in provider.Files.Keys.Where(p => (p.EndsWith(".uasset") || p.EndsWith(".umap")) && pattern.IsMatch(p)).OrderBy(p => p, StringComparer.Ordinal))
        Console.WriteLine(path);
    return 0;
}

int ExportJson(Regex include, Regex exclude, string outDir)
{
    int ok = 0, failed = 0;
    var errors = new ConcurrentBag<string>();
    var wanted = provider.Files
        .Where(kv => kv.Key.EndsWith(".uasset") && include.IsMatch(kv.Key) && !exclude.IsMatch(kv.Key))
        .OrderBy(kv => kv.Key, StringComparer.Ordinal)
        .ToList();
    // Packages are independent, so they are decoded on several threads.
    Parallel.ForEach(wanted, new ParallelOptions { MaxDegreeOfParallelism = Threads() }, kv =>
    {
        var (path, file) = kv;
        try
        {
            var json = JsonConvert.SerializeObject(provider.LoadPackage(file).GetExports(), Formatting.Indented);
            var dest = Path.Combine(outDir, Path.ChangeExtension(path, ".json"));
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.WriteAllText(dest, json);
            Interlocked.Increment(ref ok);
        }
        catch (Exception e)
        {
            Interlocked.Increment(ref failed);
            errors.Add($"{path} :: {e.GetType().Name}: {e.Message.Split('\n')[0]}");
        }
    });
    Directory.CreateDirectory(outDir);
    File.WriteAllLines(Path.Combine(outDir, "_errors.txt"), errors.OrderBy(e => e, StringComparer.Ordinal));
    Console.Error.WriteLine($"exported {ok}, failed {failed}");
    return failed > 0 && ok == 0 ? 3 : 0;
}

// Destructible buildings are blueprint actors that own a BHDestructionBuildingEditorComponent. Their mesh parts are
// instanced-mesh components below that component, each carrying world-space cached bounds. All of a world's buildings
// live in one very large generated cell level, so the largest generated level of the world is used.
int ExportBuildingParts(string worldFolder, string outPath)
{
    var cells = provider.Files
        .Where(kv => kv.Key.StartsWith(worldFolder, StringComparison.OrdinalIgnoreCase) && kv.Key.EndsWith(".umap") && kv.Key.Contains("/_Generated_/"))
        .OrderByDescending(kv => kv.Value.Size)
        .ToList();
    if (cells.Count == 0) { Console.Error.WriteLine($"no generated levels under {worldFolder}"); return 4; }
    foreach (var c in cells.Take(3)) Console.Error.WriteLine($"candidate {c.Key} ({c.Value.Size / 1024 / 1024} MB)");
    var (cellPath, cell) = (cells[0].Key, cells[0].Value);

    // One line per export that is a building owner or an instanced mesh, kept by export number so the file is written in the
    // order of the level. The level has over a hundred thousand exports, so only these classes are decoded, on several threads.
    var package = provider.LoadPackage(cell);
    string? Line(UObject e, string type)
    {
        if (type == "BHDestructionBuildingEditorComponent")
        {
            var actor = e.Outer;
            return actor is null ? null : "O" + JsonConvert.SerializeObject(new { t = "owner", actor = actor.Name.Text, cls = actor.Class?.Name.Text });
        }
        // Only the one property is turned into JSON (the same JSON as in the whole export, 30 times faster).
        var tag = e.Properties.FirstOrDefault(p => p.Name.Text == "CachedBounds")?.Tag;
        var bounds = tag is null ? null : JToken.FromObject(tag)["Value"];
        if (bounds is null) return null;
        var owner = e.Outer?.Outer;   // chunk ISM -> EditorComponent -> building actor
        return owner is null ? null : "P" + JsonConvert.SerializeObject(new { t = "part", actor = owner.Name.Text, origin = bounds["Origin"], extent = bounds["BoxExtent"] });
    }
    bool Wanted(string? type) => type is "BHDestructionBuildingEditorComponent" or "InstancedStaticMeshComponent" or "HierarchicalInstancedStaticMeshComponent";

    string?[] lines;
    if (package is IoPackage io)
    {
        var classes = ExportClasses(io);
        lines = new string?[classes.Length];
        Parallel.For(0, classes.Length, new ParallelOptions { MaxDegreeOfParallelism = Threads() }, i =>
        {
            if (Wanted(classes[i])) lines[i] = Line(io.ExportsLazy[i].Value, classes[i]!);
        });
    }
    else
    {
        lines = package.GetExports().Select(e => { var type = e.ExportType ?? e.GetType().Name; return Wanted(type) ? Line(e, type) : null; }).ToArray();
    }

    int parts = 0, owners = 0;
    Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
    using var w = new StreamWriter(outPath);
    foreach (var line in lines)
    {
        if (line is null) continue;
        w.WriteLine(line[1..]);
        if (line[0] == 'O') owners++; else parts++;
    }
    SaveClassCache();
    Console.Error.WriteLine($"{cellPath}: {owners} building owners, {parts} parts");
    return 0;
}

// Writes the placed actors of a world whose class matches the pattern, one JSON line each: the class, the actor's name and
// package, the world transform of its root component (centimeters, as the game stores it) and its own simple properties
// (text, numbers, booleans, tags and object names, to two levels). The world's cells are the generated levels under the
// world folder, plus the world's main level. With the pattern `.` the output is large; the class counts are logged.
int ExportActors(string worldFolder, Regex classPattern, string outPath)
{
    var levels = provider.Files
        .Where(kv => kv.Key.StartsWith(worldFolder, StringComparison.OrdinalIgnoreCase) && kv.Key.EndsWith(".umap") && !kv.Key.Contains("/Landscape/"))
        .OrderBy(kv => kv.Key, StringComparer.Ordinal)
        .ToList();
    Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
    using var w = new StreamWriter(outPath);
    var counts = new SortedDictionary<string, int>();
    int actors = 0, failed = 0;
    // Levels are independent, so they are decoded on several threads; the results are kept per level and written in
    // the order of the sorted level list, so the output is the same as for a sequential scan.
    var lines = new List<string>?[levels.Count];
    var levelCounts = new Dictionary<string, int>?[levels.Count];
    var options = new ParallelOptions { MaxDegreeOfParallelism = Threads() };

    bool IsActorClass(string? cls) => cls is not null && classPattern.IsMatch(cls) && !cls.EndsWith("Component") && cls is not ("Level" or "World" or "WorldPartitionRuntimeLevelStreamingCell");

    // One actor as a JSON line, or null when it has no root component. `children` are the exports whose outer is the actor.
    string? ActorLine(UObject e, string cls, string path, Func<IEnumerable<UObject>> children)
    {
        var json = JObject.FromObject(e);
        var props = json["Properties"] as JObject;
        if (props is null || props["RootComponent"] is null) return null;
        var rootName = RootComponentName(props["RootComponent"]);
        var own = children().ToList();
        var root = own.FirstOrDefault(c => c.Name == rootName)
                   ?? own.FirstOrDefault(c => JObject.FromObject(c)["Properties"]?["RelativeLocation"] is not null);
        var rootProps = root is null ? null : JObject.FromObject(root)["Properties"] as JObject;
        return JsonConvert.SerializeObject(new
        {
            cls,
            name = e.Name,
            package = path,
            location = rootProps?["RelativeLocation"],
            rotation = rootProps?["RelativeRotation"],
            scale = rootProps?["RelativeScale3D"],
            props = Simple(props, 2),
        });
    }

    Parallel.For(0, levels.Count, options, li =>
    {
        var (path, file) = levels[li];
        var found = new List<string>();
        var perClass = new Dictionary<string, int>();
        try
        {
            var package = provider.LoadPackage(file);
            if (package is IoPackage io)
            {
                // The class of every export is in the package's export table, so only the actors that are wanted (and the
                // exports directly below them) are decoded: a cell level has over a hundred thousand other exports.
                var map = io.ExportMap;
                var classes = ExportClasses(io);
                var wanted = new List<(int Index, string Class)>();
                for (int i = 0; i < map.Length; i++)
                    if (IsActorClass(classes[i])) wanted.Add((i, classes[i]!));
                if (wanted.Count > 0)
                {
                    var below = wanted.ToDictionary(x => x.Index, _ => new List<int>());
                    for (int j = 0; j < map.Length; j++)
                        if (map[j].OuterIndex.IsExport && below.TryGetValue((int)map[j].OuterIndex.AsExport, out var list)) list.Add(j);
                    foreach (var (index, cls) in wanted)
                    {
                        var line = ActorLine(io.ExportsLazy[index].Value, cls, path, () => below[index].Select(j => io.ExportsLazy[j].Value));
                        if (line is null) continue;
                        found.Add(line);
                        perClass[cls] = perClass.GetValueOrDefault(cls) + 1;
                    }
                }
            }
            else
            {
                IReadOnlyList<UObject> exports = package.GetExports().ToList();
                foreach (var e in exports)
                {
                    var cls = e.ExportType ?? e.GetType().Name;
                    if (!IsActorClass(cls)) continue;
                    var line = ActorLine(e, cls, path, () => exports.Where(c => c.Outer?.Name.Text == e.Name));
                    if (line is null) continue;
                    found.Add(line);
                    perClass[cls] = perClass.GetValueOrDefault(cls) + 1;
                }
            }
        }
        catch { Interlocked.Increment(ref failed); return; }
        if (found.Count > 0) { lines[li] = found; levelCounts[li] = perClass; }
    });
    for (int li = 0; li < levels.Count; li++)
    {
        if (lines[li] is null) continue;
        foreach (var line in lines[li]!) { w.WriteLine(line); actors++; }
        foreach (var (cls, n) in levelCounts[li]!) counts[cls] = counts.GetValueOrDefault(cls) + n;
    }
    foreach (var (cls, n) in counts.OrderByDescending(kv => kv.Value).Take(60)) Console.Error.WriteLine($"{n,7} {cls}");
    SaveClassCache();
    Console.Error.WriteLine($"{worldFolder}: {levels.Count} levels ({failed} unreadable), {actors} actors written");
    return levels.Count == 0 ? 4 : 0;
}

static string? RootComponentName(JToken? token)
{
    var name = (token as JObject)?["ObjectName"]?.ToString();
    if (name is null) return null;
    var colon = name.LastIndexOf(':');
    var end = name.LastIndexOf('\'');
    return colon >= 0 && end > colon ? name[(colon + 1)..end] : null;
}

// A shallow copy of an object's properties: simple values and short lists of them, to the given depth. Large structures
// (curves, meshes, arrays of objects) are left out so each actor stays a line of a few hundred bytes.
static JObject Simple(JObject source, int depth)
{
    var result = new JObject();
    foreach (var (key, value) in source)
    {
        if (key == "RootComponent" || key.StartsWith("_aaa") || value is null) continue;
        var copy = SimpleToken(value, depth);
        if (copy is not null) result[key] = copy;
    }
    return result;
}

static JToken? SimpleToken(JToken value, int depth)
{
    switch (value.Type)
    {
        case JTokenType.String: case JTokenType.Integer: case JTokenType.Float: case JTokenType.Boolean:
            return value.ToString().Length > 200 ? null : value.DeepClone();
        case JTokenType.Object when depth > 0 && ((JObject)value).ContainsKey("ObjectPath"):
            return null;   // a reference to another object (a component or an asset), which is not a property of the actor itself
        case JTokenType.Object when depth > 0:
            var o = Simple((JObject)value, depth - 1);
            return o.Count > 0 ? o : null;
        case JTokenType.Array when ((JArray)value).Count is > 0 and <= 16 && ((JArray)value).All(x => x.Type is JTokenType.String or JTokenType.Integer or JTokenType.Float or JTokenType.Boolean):
            return value.DeepClone();
        default:
            return null;
    }
}

int ExportTexture(string packagePath, string outPath)
{
    var tex = provider.LoadPackage(packagePath).GetExports().OfType<UTexture>().First();
    int levels = tex.PlatformData?.VTData is { } vt ? (int)vt.NumMips : 1;
    for (int level = 0; level < levels; level++)
    {
        CTexture? ct;
        try { ct = tex.DecodeMip(level); }
        catch (Exception e) { Console.Error.WriteLine($"level {level}: {e.GetType().Name}"); continue; }   // too large for one array
        if (ct is null) continue;
        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        if (!SavePng(ct, outPath)) { Console.Error.WriteLine($"unsupported pixel format {ct.PixelFormat}"); return 5; }
        Console.Error.WriteLine($"level {level}: wrote {ct.Width}x{ct.Height}");
        return 0;
    }
    Console.Error.WriteLine("no decodable level");
    return 6;
}

bool SavePng(CTexture ct, string outPath)
{
    switch (ct.PixelFormat.ToString())
    {
        // Written by FastPng: the same pixels as an encoder that searches for the smallest file, in a few seconds instead of minutes.
        case "PF_B8G8R8A8":
            FastPng.Write(outPath, ct.Data, ct.Width, ct.Height, 4, true, CompressionLevel.Fastest);
            return true;
        case "PF_R8G8B8A8":
            FastPng.Write(outPath, ct.Data, ct.Width, ct.Height, 4, false, CompressionLevel.Fastest);
            return true;
        case "PF_G16":
            FastPng.Write(outPath, ct.Data, ct.Width, ct.Height, 2, false, CompressionLevel.Fastest);
            return true;
        case "PF_FloatRGBA":   // four 16-bit floats per pixel, clamped to 0..1
            using (var img = new Image<Rgba32>(ct.Width, ct.Height))
            {
                byte ToByte(int offset) => (byte)Math.Round(Math.Clamp((float)BitConverter.ToHalf(ct.Data, offset), 0f, 1f) * 255f);
                for (int y = 0; y < ct.Height; y++)
                    for (int x = 0; x < ct.Width; x++)
                    {
                        int at = (y * ct.Width + x) * 8;
                        img[x, y] = new Rgba32(ToByte(at), ToByte(at + 2), ToByte(at + 4), ToByte(at + 6));
                    }
                img.SaveAsPng(outPath);
            }
            return true;
        default:
            return false;
    }
}

// Writes the full-size image of every texture in a JSON array of package paths to `<outDir>/<path>.png`, where the path
// is the package path without its leading `/Game/` or slash and without the `.Name` suffix (`/Game/UI/Icons/T_A.T_A`
// becomes `UI/Icons/T_A.png`, `/TNK_01/Textures/T_B` becomes `TNK_01/Textures/T_B.png`). The folder structure keeps
// textures that share a name apart. A texture that cannot be read is listed in `_errors.txt` and does not stop the rest.
int ExportTextures(string listPath, string outDir)
{
    var packages = JsonConvert.DeserializeObject<List<string>>(File.ReadAllText(listPath)) ?? new List<string>();
    Directory.CreateDirectory(outDir);

    // Feature plugins mount at `/<PluginName>/` and live at `.../<PluginName>/Content/...` in the containers.
    var pluginFiles = provider.Files
        .Where(kv => kv.Key.Contains("/Plugins/") && kv.Key.EndsWith(".uasset"))
        .Select(kv => (key: kv.Key, at: kv.Key.IndexOf("/Content/", StringComparison.Ordinal)))
        .Where(x => x.at > 0)
        .ToDictionary(
            x => (x.key[(x.key.LastIndexOf('/', x.at - 1) + 1)..x.at] + "/" + x.key[(x.at + "/Content/".Length)..^".uasset".Length]).ToLowerInvariant(),
            x => x.key);

    int ok = 0;
    var errors = new List<string>();
    foreach (var package in packages)
    {
        var path = package.Contains('.') ? package[..package.LastIndexOf('.')] : package;
        try
        {
            var relative = path.TrimStart('/');
            string source;
            if (relative.StartsWith("Game/", StringComparison.OrdinalIgnoreCase))
            {
                source = path;
                relative = relative["Game/".Length..];
            }
            else if (!pluginFiles.TryGetValue(relative.ToLowerInvariant(), out source!))
            {
                throw new FileNotFoundException($"no plugin file for {path}");
            }
            var tex = provider.LoadPackage(source).GetExports().OfType<UTexture>().First();
            var ct = tex.DecodeMip(0) ?? throw new InvalidOperationException("no decodable level");
            var dest = Path.Combine(outDir, relative + ".png");
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            if (!SavePng(ct, dest)) throw new InvalidOperationException($"unsupported pixel format {ct.PixelFormat}");
            ok++;
        }
        catch (Exception e)
        {
            errors.Add($"{package} :: {e.GetType().Name}: {e.Message.Split('\n')[0]}");
        }
    }
    File.WriteAllLines(Path.Combine(outDir, "_errors.txt"), errors);
    Console.Error.WriteLine($"exported {ok}, failed {errors.Count}");
    return ok == 0 && packages.Count > 0 ? 3 : 0;
}

// A runtime virtual texture volume places a baked texture in the world: the unit box [0,1]^3 scaled by the component's
// scale and moved to its location. The Z range of a baked height texture is the volume's Z extent.
int ExportRvtVolumes(string levelPackage, string outPath)
{
    var rows = new List<object>();
    var package = provider.LoadPackage(levelPackage);
    // Only the volume components are decoded: the level has over a hundred thousand other exports.
    IEnumerable<UObject> volumes = package is IoPackage io
        ? ExportClasses(io).Select((cls, i) => (cls, i)).Where(x => x.cls == "RuntimeVirtualTextureComponent").Select(x => io.ExportsLazy[x.i].Value)
        : package.GetExports().Where(e => (e.ExportType ?? e.GetType().Name) == "RuntimeVirtualTextureComponent");
    foreach (var e in volumes)
    {
        var p = JObject.FromObject(e)["Properties"] as JObject;
        if (p is null) continue;
        rows.Add(new
        {
            virtualTexture = p["VirtualTexture"]?["ObjectName"],
            streamingTexture = p["StreamingTexture"]?["ObjectPath"],
            location = p["RelativeLocation"],
            rotation = p["RelativeRotation"],
            scale = p["RelativeScale3D"],
        });
    }
    Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
    File.WriteAllText(outPath, JsonConvert.SerializeObject(rows, Formatting.Indented));
    SaveClassCache();
    Console.Error.WriteLine($"{rows.Count} runtime virtual texture components");
    return rows.Count > 0 ? 0 : 7;
}
