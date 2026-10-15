import { describeType, hasUnknown, parseUsmapSchema, readUsmap, serializeSchema, writeUsmap, type UsmapSchema, type UsmapStruct, type UsmapType } from "./usmap.js";

/**
 * Some game builds ship with the names of their properties scrambled (`_aaabiggnlpebjfhcidicc` for `ActivationID`), and a
 * mappings file taken from such a build carries the scrambled names, so nothing that reads a property by name finds it.
 * A scrambled name is the same text wherever the property appears, so an older mappings file with the real names tells
 * what each one stands for: wherever the two files describe a struct the same way, the old name at each position names
 * the new text at that position.
 */
const SCRAMBLED = /^_[a-p]{16,}$/;
const ROUNDS = 8;

export const isScrambled = (name: string): boolean => SCRAMBLED.test(name);

/** What kind of property a type is (`Array`, `Struct`, ...), without what is inside it: the contents can change between builds. */
const shape = (type: string): string => type.split(/[<:]/)[0]!;

export interface NameReport {
  /** Distinct scrambled names in the new file, and how many of them were given back their real name. */
  scrambled: number;
  restored: number;
  /** Names the old file gave two different answers for, which are left as they are. */
  conflicting: number;
  /** Names given by a hint (a name the data confirms, see `name-hints.json`). */
  hinted: number;
  /** Names given only by their place in a struct that grew at the end (see `restoreNames`): the weakest evidence. */
  guessed: number;
  /** Names that were not scrambled but are spelled with other capitals in the old file, which now has its spelling. */
  recased: number;
  /** Properties (counting repeats) whose name is still scrambled afterwards. */
  stillScrambled: number;
  properties: number;
}

type Candidates = Map<string, Map<string, number>>;

/**
 * Records that `name` stands for `real`: a scrambled name for the real one, or a name for the same name in the spelling the
 * reference has it. The game's names ignore case, and a mappings file made from a running game spells each name the way
 * the game met it first (`EntityId` for the property the data calls `EntityID`), so the reference's spelling is kept.
 */
function addVote(votes: Candidates, scrambled: string, real: string): void {
  if (isScrambled(real)) return;
  if (!isScrambled(scrambled) && scrambled.toLowerCase() !== real.toLowerCase()) return;
  const row = votes.get(scrambled) ?? new Map<string, number>();
  row.set(real, (row.get(real) ?? 0) + 1);
  votes.set(scrambled, row);
}

const voteCount = (votes: Candidates): number => votes.size + [...votes.values()].reduce((sum, row) => sum + row.size, 0);

/** The names with exactly one candidate. */
function settle(votes: Candidates): { names: Map<string, string>; conflicting: number } {
  const names = new Map<string, string>();
  let conflicting = 0;
  for (const [scrambled, row] of votes) {
    if (row.size === 1) names.set(scrambled, [...row.keys()][0]!);
    else conflicting++;
  }
  return { names, conflicting };
}

/** Pairs of positions that read the same in both lists (the longest run of them in order). */
function alignment(count: [number, number], same: (a: number, b: number) => boolean): Array<[number, number]> {
  const [n, m] = count;
  const best = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) best[i]![j] = same(i, j) ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (same(i, j)) pairs.push([i, j++]), i++;
    else if (best[i + 1]![j]! >= best[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/**
 * Pairs the properties between two anchors: the ones of the old struct with the ones of the new. They pair when every kind
 * of property the old side has occurs as often on the new side (the new side may have more of other kinds, which are
 * new properties) and the pairs keep their order; otherwise nothing is paired.
 */
function pairUp(now: string[], was: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const used = new Map<string, number>();
  for (let j = 0; j < was.length; j++) {
    const kind = was[j]!;
    const sameNow = now.flatMap((k, i) => (k === kind ? [i] : []));
    const sameWas = was.filter((k) => k === kind).length;
    if (sameNow.length !== sameWas) return [];
    const seen = used.get(kind) ?? 0;
    used.set(kind, seen + 1);
    pairs.push([sameNow[seen]!, j]);
  }
  return pairs.every(([i], n) => n === 0 || i > pairs[n - 1]![0]) ? pairs : [];
}

/**
 * Gives the scrambled names of `target` their real names from `reference`. Returns the target's name table with the names
 * replaced where the reference settles them; the rest is left as it is.
 */
export function restoreNames(target: UsmapSchema, reference: UsmapSchema, hints: Readonly<Record<string, string>> = {}): { names: string[]; report: NameReport } {
  const oldStructs = new Map(reference.structs.map((s) => [s.name, s]));
  const votes: Candidates = new Map();

  // Where a struct reads the same in both files, position by position, each pair is one name.
  const unaligned: Array<[UsmapSchema["structs"][number], UsmapSchema["structs"][number]]> = [];
  for (const now of target.structs) {
    const was = oldStructs.get(now.name);
    if (!was) continue;
    const alike = was.properties.length === now.properties.length && now.properties.every((p, i) => p.index === was.properties[i]!.index && shape(p.type) === shape(was.properties[i]!.type));
    if (alike) now.properties.forEach((p, i) => addVote(votes, p.name, was.properties[i]!.name));
    else unaligned.push([now, was]);
  }
  const oldEnums = new Map(reference.enums.map((e) => [e.name, e]));
  for (const now of target.enums) {
    const was = oldEnums.get(now.name);
    if (was && was.values.length === now.values.length) now.values.forEach((v, i) => addVote(votes, v, was.values[i]!));
  }

  // A struct that changed between the builds: what is already known anchors the properties that stayed, and the
  // properties between two anchors pair up when there are as many on each side with the same types.
  const converge = (): void => {
    for (let round = 0; round < ROUNDS; round++) {
      const known = settle(votes).names;
      const size = voteCount(votes);
      for (const [now, was] of unaligned) {
        const a = now.properties;
        const b = was.properties;
        const anchors = alignment([a.length, b.length], (i, j) => shape(a[i]!.type) === shape(b[j]!.type) && (a[i]!.name.toLowerCase() === b[j]!.name.toLowerCase() || known.get(a[i]!.name) === b[j]!.name));
        const edges: Array<[number, number]> = [[-1, -1], ...anchors, [a.length, b.length]];
        for (let k = 1; k < edges.length; k++) {
          const [i0, j0] = edges[k - 1]!;
          const [i1, j1] = edges[k]!;
          for (const [i, j] of pairUp(a.slice(i0 + 1, i1).map((p) => shape(p.type)), b.slice(j0 + 1, j1).map((p) => shape(p.type)))) addVote(votes, a[i0 + 1 + i]!.name, b[j0 + 1 + j]!.name);
        }
      }
      if (voteCount(votes) === size) break;
    }
  };
  converge();

  // Weaker evidence, used last: a struct that only grew at the end. When every property up to some place matches, and from
  // there each old property has a new one at the same place with the same kind, the new ones are those properties (the
  // game adds members after the existing ones). It would be wrong if a member of the same kind was added just before them.
  let guessed = 0;
  const known = settle(votes).names;
  for (const [now, was] of unaligned) {
    const a = now.properties;
    const b = was.properties;
    if (a.length <= b.length) continue;
    const same = (i: number): boolean => a[i]!.index === b[i]!.index && shape(a[i]!.type) === shape(b[i]!.type);
    let p = 0;
    while (p < b.length && same(p) && (a[p]!.name.toLowerCase() === b[p]!.name.toLowerCase() || known.get(a[p]!.name) === b[p]!.name)) p++;
    if (p === b.length || ![...b.keys()].filter((i) => i >= p).every(same)) continue;
    for (let i = p; i < b.length; i++) {
      if (!isScrambled(a[i]!.name) || isScrambled(b[i]!.name) || known.has(a[i]!.name)) continue;
      addVote(votes, a[i]!.name, b[i]!.name);
      guessed++;
    }
  }
  if (guessed > 0) converge();

  const { names: settled, conflicting } = settle(votes);
  // Hints name what the structure could not. They never change a name the reference settled or that has two answers.
  let hinted = 0;
  for (const n of target.names) {
    const hint = hints[n];
    if (hint !== undefined && isScrambled(n) && !isScrambled(hint) && !settled.has(n) && !votes.has(n)) {
      settled.set(n, hint);
      hinted++;
    }
  }
  const names = target.names.map((n) => settled.get(n) ?? n);
  const scrambled = new Set(target.names.filter(isScrambled));
  const recased = [...settled].filter(([from, to]) => !isScrambled(from) && from !== to).length;
  let stillScrambled = 0;
  let properties = 0;
  for (const s of target.structs) {
    for (const p of s.properties) {
      properties++;
      if (isScrambled(settled.get(p.name) ?? p.name)) stillScrambled++;
    }
  }
  return { names, report: { scrambled: scrambled.size, restored: [...scrambled].filter((n) => settled.has(n)).length, conflicting, recased, guessed, hinted, stillScrambled, properties } };
}

/** Whether `type` is what `known` says, with the parts of `type` the file leaves unsaid free to be anything. */
function fits(type: UsmapType, known: UsmapType): boolean {
  if (hasUnknown(known)) return false;
  if (type.id === 255) return true;
  return type.id === known.id && (!type.inner || fits(type.inner, known.inner!)) && (!type.value || fits(type.value, known.value!));
}

export interface RestoreReport extends NameReport {
  /** Properties whose type the file left unsaid (`Array<Unknown>`) and the reference gave, and the ones still unsaid. */
  typesRestored: number;
  stillUnknown: number;
}

/**
 * Restores a mappings file with scrambled names: the names as `restoreNames` does, and the types the file leaves unsaid
 * (a dumper that cannot tell what is inside an array writes `Unknown`, and then the array cannot be read), taken from the
 * property of the same name in the same struct of the reference.
 */
export function restoreSchema(target: UsmapSchema, reference: UsmapSchema, hints: Readonly<Record<string, string>> = {}): { names: string[]; structs: UsmapStruct[]; report: RestoreReport } {
  const { names: restored, report } = restoreNames(target, reference, hints);
  const names = [...restored];
  const index = new Map<string, number>();
  names.forEach((n, i) => index.has(n) || index.set(n, i));
  const nameIndex = (text: string): number => {
    let at = index.get(text);
    if (at === undefined) {
      at = names.length;
      names.push(text);
      index.set(text, at);
    }
    return at;
  };
  const adopt = (type: UsmapType): UsmapType => ({
    id: type.id,
    ...(type.name !== undefined ? { name: nameIndex(reference.names[type.name]!) } : {}),
    ...(type.inner ? { inner: adopt(type.inner) } : {}),
    ...(type.value ? { value: adopt(type.value) } : {}),
  });

  const before = new Map(reference.structs.map((s) => [s.name, s]));
  let typesRestored = 0;
  let stillUnknown = 0;
  const structs = target.structs.map((struct) => {
    const known = new Map<string, UsmapType | null>();
    for (const p of before.get(struct.name)?.properties ?? []) known.set(p.name, known.has(p.name) ? null : p.tree);
    const properties = struct.properties.map((p) => {
      if (!hasUnknown(p.tree)) return p;
      const was = known.get(restored[p.nameIndex]!);
      if (was && fits(p.tree, was)) {
        typesRestored++;
        const tree = adopt(was);
        return { ...p, tree, type: describeType(tree, names) };
      }
      stillUnknown++;
      return p;
    });
    return { ...struct, properties };
  });
  return { names, structs, report: { ...report, typesRestored, stillUnknown } };
}

/** Reads how much of a mappings file's property names are scrambled. */
export function scrambledShare(bytes: Uint8Array): { scrambled: number; properties: number } {
  const schema = parseUsmapSchema(readUsmap(bytes));
  let scrambled = 0;
  let properties = 0;
  for (const s of schema.structs) for (const p of s.properties) (properties++, isScrambled(p.name) && scrambled++);
  return { scrambled, properties };
}

/** Writes `scrambled` again with the real names and the unsaid types from `reference` wherever they can be told. The body is left uncompressed. */
export function restoreUsmap(scrambled: Uint8Array, reference: Uint8Array, hints: Readonly<Record<string, string>> = {}): { file: Buffer; report: RestoreReport } {
  const file = readUsmap(scrambled);
  const schema = parseUsmapSchema(file);
  const { names, structs, report } = restoreSchema(schema, parseUsmapSchema(readUsmap(reference)), hints);
  return { file: writeUsmap({ headStart: file.headStart, payload: serializeSchema({ enumBytes: schema.enumBytes, structs }, names, file.version) }), report };
}
