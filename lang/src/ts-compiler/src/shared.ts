/*
  Small shared helpers used across the TS port of the Pyret compiler.
  See CONVENTIONS.md for the type-mapping rules these support.
*/

export class InternalCompilerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InternalCompilerError';
  }
}

export class TODOError extends Error {
  constructor(msg: string) {
    super(`Not yet implemented in TS compiler: ${msg}`);
    this.name = 'TODOError';
  }
}

export function raise(msg: string): never {
  throw new InternalCompilerError(msg);
}

// ---------- Either ----------

export type Left<L> = { readonly $name: 'left'; readonly v: L };
export type Right<R> = { readonly $name: 'right'; readonly v: R };
export type Either<L, R> = Left<L> | Right<R>;

export function left<L>(v: L): Left<L> { return { $name: 'left', v }; }
export function right<R>(v: R): Right<R> { return { $name: 'right', v }; }
export function isLeft(e: { $name: string }): boolean { return e.$name === 'left'; }
export function isRight(e: { $name: string }): boolean { return e.$name === 'right'; }

// ---------- Persistent-map helpers ----------

// Copy-on-write set: mirrors Pyret's persistent StringDict.set.
export function mapSet<V>(m: Map<string, V>, k: string, v: V): Map<string, V> {
  const m2 = new Map(m);
  m2.set(k, v);
  return m2;
}

export function mapRemove<V>(m: Map<string, V>, k: string): Map<string, V> {
  const m2 = new Map(m);
  m2.delete(k);
  return m2;
}

export function mapGetValue<V>(m: Map<string, V>, k: string): V {
  if (!m.has(k)) {
    throw new InternalCompilerError(`Key ${k} not found in dict`);
  }
  return m.get(k)!;
}

// Merge `from` into `into` (mutating `into`), like merge-now on
// MutableStringDict.
export function mapMergeNow<V>(into: Map<string, V>, from: Map<string, V>): void {
  for (const [k, v] of from) into.set(k, v);
}

// ---------- List helpers (Pyret List<T> ports to T[]) ----------

export function listToArray<T>(xs: T[]): T[] { return xs; }

// distinct() on simple values, preserving Pyret's "last occurrence wins"
// is NOT what Pyret does; lists.distinct keeps first occurrences.
export function distinct<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

export function intersperse<T>(xs: T[], sep: T): T[] {
  const out: T[] = [];
  xs.forEach((x, i) => {
    if (i > 0) out.push(sep);
    out.push(x);
  });
  return out;
}

// fold over pairs of lists (Pyret's fold2; lengths must match)
export function fold2<A, B, Acc>(f: (acc: Acc, a: A, b: B) => Acc, init: Acc, as: A[], bs: B[]): Acc {
  if (as.length !== bs.length) {
    throw new InternalCompilerError('fold2: lists of unequal length');
  }
  let acc = init;
  for (let i = 0; i < as.length; i++) acc = f(acc, as[i], bs[i]);
  return acc;
}

export function map2<A, B, C>(f: (a: A, b: B) => C, as: A[], bs: B[]): C[] {
  if (as.length !== bs.length) {
    throw new InternalCompilerError('map2: lists of unequal length');
  }
  return as.map((a, i) => f(a, bs[i]));
}

export function each2<A, B>(f: (a: A, b: B) => void, as: A[], bs: B[]): void {
  if (as.length !== bs.length) {
    throw new InternalCompilerError('each2: lists of unequal length');
  }
  as.forEach((a, i) => f(a, bs[i]));
}

// Pyret's lists.partition
export function partition<T>(pred: (x: T) => boolean, xs: T[]): { isTrue: T[]; isFalse: T[] } {
  const isTrue: T[] = [];
  const isFalse: T[] = [];
  for (const x of xs) (pred(x) ? isTrue : isFalse).push(x);
  return { isTrue, isFalse };
}

export function filterMap<T, U>(f: (x: T) => U | undefined, xs: T[]): U[] {
  const out: U[] = [];
  for (const x of xs) {
    const r = f(x);
    if (r !== undefined) out.push(r);
  }
  return out;
}

// Pyret string utilities with exact semantics
export function stringSplitAll(s: string, sep: string): string[] {
  return s.split(sep);
}

export function joinStr(xs: string[], sep: string): string {
  return xs.join(sep);
}
