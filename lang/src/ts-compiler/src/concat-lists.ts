/*
  Ported from: src/arr/compiler/concat-lists.arr

  data ConcatList<a>: concat-empty | concat-singleton | concat-append
                    | concat-cons | concat-snoc
  Pyret `+` on ConcatLists (_plus) becomes the method `append(other)`.
  `to-list` returns a plain array.
*/

import { InternalCompilerError } from './shared';

export abstract class ConcatListBase<T> {
  abstract get $name(): string;
  abstract toListAcc(rest: T[]): T[];
  abstract mapToListAcc<U>(f: (x: T) => U, rest: U[]): U[];
  abstract map<U>(f: (x: T) => U): ConcatList<U>;
  abstract each(f: (x: T) => void): void;
  abstract foldl<B>(f: (base: B, x: T) => B, base: B): B;
  abstract foldr<B>(f: (base: B, x: T) => B, base: B): B;
  abstract getFirst(): T;
  abstract getLast(): T;
  abstract isEmpty(): boolean;
  abstract length(): number;
  abstract joinStr(sep: string): string;
  abstract reverse(): ConcatList<T>;
  abstract all(f: (x: T) => boolean): boolean;
  // sharing method _plus
  append(other: ConcatList<T>): ConcatList<T> {
    const self = this as unknown as ConcatList<T>;
    if (isConcatEmpty(self)) { return other; }
    else if (isConcatEmpty(other)) { return self; }
    else { return new ConcatAppend<T>(self, other); }
  }
  toList(): T[] {
    return this.toListAcc([]);
  }
  mapToListLeft<U>(f: (x: T) => U): U[] {
    const revved = revmapToListAcc(this as unknown as ConcatList<T>, f, []);
    revved.reverse();
    return revved;
  }
  mapToList<U>(f: (x: T) => U): U[] {
    return this.mapToListAcc(f, []);
  }
  find(f: (x: T) => boolean): T | undefined {
    return find(f, this as unknown as ConcatList<T>);
  }
}

export class ConcatEmpty<T> extends ConcatListBase<T> {
  get $name(): 'concat-empty' { return 'concat-empty'; }
  toListAcc(rest: T[]): T[] { return rest; }
  mapToListAcc<U>(_f: (x: T) => U, rest: U[]): U[] { return rest; }
  map<U>(_f: (x: T) => U): ConcatList<U> { return this as unknown as ConcatList<U>; }
  each(_f: (x: T) => void): void { /* nothing */ }
  foldl<B>(_f: (base: B, x: T) => B, base: B): B { return base; }
  foldr<B>(_f: (base: B, x: T) => B, base: B): B { return base; }
  getFirst(): T { throw new InternalCompilerError('getFirst on concat-empty'); }
  getLast(): T { throw new InternalCompilerError('getLast on concat-empty'); }
  isEmpty(): boolean { return true; }
  length(): number { return 0; }
  joinStr(_sep: string): string { return ''; }
  reverse(): ConcatList<T> { return this; }
  all(_f: (x: T) => boolean): boolean { return true; }
}

export class ConcatSingleton<T> extends ConcatListBase<T> {
  get $name(): 'concat-singleton' { return 'concat-singleton'; }
  constructor(public element: T) { super(); }
  toListAcc(rest: T[]): T[] { return [this.element, ...rest]; }
  mapToListAcc<U>(f: (x: T) => U, rest: U[]): U[] { return [f(this.element), ...rest]; }
  map<U>(f: (x: T) => U): ConcatList<U> { return new ConcatSingleton(f(this.element)); }
  each(f: (x: T) => void): void { f(this.element); }
  foldl<B>(f: (base: B, x: T) => B, base: B): B { return f(base, this.element); }
  foldr<B>(f: (base: B, x: T) => B, base: B): B { return f(base, this.element); }
  getFirst(): T { return this.element; }
  getLast(): T { return this.element; }
  isEmpty(): boolean { return false; }
  length(): number { return 1; }
  joinStr(_sep: string): string { return String(this.element); }
  reverse(): ConcatList<T> { return this; }
  all(f: (x: T) => boolean): boolean { return f(this.element); }
}

export class ConcatAppend<T> extends ConcatListBase<T> {
  get $name(): 'concat-append' { return 'concat-append'; }
  constructor(public left: ConcatList<T>, public right: ConcatList<T>) { super(); }
  toListAcc(rest: T[]): T[] {
    return this.left.toListAcc(this.right.toListAcc(rest));
  }
  mapToListAcc<U>(f: (x: T) => U, rest: U[]): U[] {
    return this.left.mapToListAcc(f, this.right.mapToListAcc(f, rest));
  }
  map<U>(f: (x: T) => U): ConcatList<U> { return new ConcatAppend(this.left.map(f), this.right.map(f)); }
  each(f: (x: T) => void): void {
    this.left.each(f);
    this.right.each(f);
  }
  foldl<B>(f: (base: B, x: T) => B, base: B): B { return this.right.foldl(f, this.left.foldl(f, base)); }
  foldr<B>(f: (base: B, x: T) => B, base: B): B { return this.left.foldr(f, this.right.foldr(f, base)); }
  getFirst(): T { return this.left.isEmpty() ? this.right.getFirst() : this.left.getFirst(); }
  getLast(): T { return this.right.isEmpty() ? this.left.getLast() : this.right.getLast(); }
  isEmpty(): boolean { return this.left.isEmpty() && this.right.isEmpty(); }
  length(): number { return this.left.length() + this.right.length(); }
  joinStr(sep: string): string {
    const l = this.left.joinStr(sep);
    const r = this.right.joinStr(sep);
    if (l === '') { return r; }
    else if (r === '') { return l; }
    else { return l + sep + r; }
  }
  reverse(): ConcatList<T> { return new ConcatAppend(this.right.reverse(), this.left.reverse()); }
  all(f: (x: T) => boolean): boolean { return this.left.all(f) && this.right.all(f); }
}

export class ConcatCons<T> extends ConcatListBase<T> {
  get $name(): 'concat-cons' { return 'concat-cons'; }
  constructor(public first: T, public rest: ConcatList<T>) { super(); }
  toListAcc(rest: T[]): T[] { return [this.first, ...this.rest.toListAcc(rest)]; }
  mapToListAcc<U>(f: (x: T) => U, rest: U[]): U[] { return [f(this.first), ...this.rest.mapToListAcc(f, rest)]; }
  map<U>(f: (x: T) => U): ConcatList<U> { return new ConcatCons(f(this.first), this.rest.map(f)); }
  each(f: (x: T) => void): void {
    f(this.first);
    this.rest.each(f);
  }
  foldl<B>(f: (base: B, x: T) => B, base: B): B { return this.rest.foldl(f, f(base, this.first)); }
  foldr<B>(f: (base: B, x: T) => B, base: B): B { return f(this.rest.foldr(f, base), this.first); }
  getFirst(): T { return this.first; }
  getLast(): T { return this.rest.isEmpty() ? this.first : this.rest.getLast(); }
  isEmpty(): boolean { return false; }
  length(): number { return 1 + this.rest.length(); }
  joinStr(sep: string): string {
    const l = String(this.first);
    const r = this.rest.joinStr(sep);
    if (r === '') { return l; }
    else { return l + sep + r; }
  }
  reverse(): ConcatList<T> { return new ConcatSnoc(this.rest.reverse(), this.first); }
  all(f: (x: T) => boolean): boolean { return f(this.first) && this.rest.all(f); }
}

export class ConcatSnoc<T> extends ConcatListBase<T> {
  get $name(): 'concat-snoc' { return 'concat-snoc'; }
  constructor(public head: ConcatList<T>, public last: T) { super(); }
  toListAcc(rest: T[]): T[] { return this.head.toListAcc([this.last, ...rest]); }
  mapToListAcc<U>(f: (x: T) => U, rest: U[]): U[] { return this.head.mapToListAcc(f, [f(this.last), ...rest]); }
  map<U>(f: (x: T) => U): ConcatList<U> { return new ConcatSnoc(this.head.map(f), f(this.last)); }
  each(f: (x: T) => void): void {
    this.head.each(f);
    f(this.last);
  }
  foldl<B>(f: (base: B, x: T) => B, base: B): B { return f(this.head.foldl(f, base), this.last); }
  foldr<B>(f: (base: B, x: T) => B, base: B): B { return this.head.foldr(f, f(base, this.last)); }
  getFirst(): T { return this.head.isEmpty() ? this.last : this.head.getFirst(); }
  getLast(): T { return this.last; }
  isEmpty(): boolean { return false; }
  length(): number { return this.head.length() + 1; }
  joinStr(sep: string): string {
    const h = this.head.joinStr(sep);
    const l = String(this.last);
    if (h === '') { return l; }
    else { return h + sep + l; }
  }
  reverse(): ConcatList<T> { return new ConcatCons(this.last, this.head.reverse()); }
  all(f: (x: T) => boolean): boolean { return this.head.all(f) && f(this.last); }
}

export type ConcatList<T> =
  | ConcatEmpty<T>
  | ConcatSingleton<T>
  | ConcatAppend<T>
  | ConcatCons<T>
  | ConcatSnoc<T>;

export function isConcatEmpty(x: any): x is ConcatEmpty<any> { return x instanceof ConcatEmpty; }
export function isConcatSingleton(x: any): x is ConcatSingleton<any> { return x instanceof ConcatSingleton; }
export function isConcatAppend(x: any): x is ConcatAppend<any> { return x instanceof ConcatAppend; }
export function isConcatCons(x: any): x is ConcatCons<any> { return x instanceof ConcatCons; }
export function isConcatSnoc(x: any): x is ConcatSnoc<any> { return x instanceof ConcatSnoc; }

// Singleton value for concat-empty (Pyret's concat-empty is a singleton)
// plus constructor helpers, in both original-style and short (cl*) names.
export const concatEmpty: ConcatList<any> = new ConcatEmpty<any>();
export function concatSingleton<T>(element: T): ConcatList<T> { return new ConcatSingleton(element); }
export function concatAppend<T>(left: ConcatList<T>, right: ConcatList<T>): ConcatList<T> { return new ConcatAppend(left, right); }
export function concatCons<T>(first: T, rest: ConcatList<T>): ConcatList<T> { return new ConcatCons(first, rest); }
export function concatSnoc<T>(head: ConcatList<T>, last: T): ConcatList<T> { return new ConcatSnoc(head, last); }

export const clEmpty: ConcatList<any> = concatEmpty;
export const clSing = concatSingleton;
export const clAppend = concatAppend;
export const clCons = concatCons;
export const clSnoc = concatSnoc;

function revmapToListAcc<T, U>(self: ConcatList<T>, f: (x: T) => U, revhead: U[]): U[] {
  if (isConcatEmpty(self)) { return revhead; }
  else if (isConcatSingleton(self)) { return [f(self.element), ...revhead]; }
  else if (isConcatAppend(self)) { return revmapToListAcc(self.right, f, revmapToListAcc(self.left, f, revhead)); }
  else if (isConcatCons(self)) { return revmapToListAcc(self.rest, f, [f(self.first), ...revhead]); }
  else if (isConcatSnoc(self)) {
    const newhead = revmapToListAcc(self.head, f, revhead);
    return [f(self.last), ...newhead]; // order of operations matters
  } else {
    throw new InternalCompilerError(`revmapToListAcc: unknown ConcatList ${(self as any).$name}`);
  }
}

// Takes a predicate and returns either the first item in this list that
// passes the predicate, or undefined (Pyret returns an Option)
export function find<T>(f: (x: T) => boolean, l: ConcatList<T>): T | undefined {
  switch (l.$name) {
    case 'concat-empty':
      return undefined;
    case 'concat-singleton':
      return f(l.element) ? l.element : undefined;
    case 'concat-append': {
      const resultLeft = find(f, l.left);
      if (resultLeft === undefined) { return find(f, l.right); }
      else { return resultLeft; }
    }
    case 'concat-cons':
      return f(l.first) ? l.first : find(f, l.rest);
    case 'concat-snoc': {
      const resultLeft = find(f, l.head);
      if (resultLeft === undefined) { return f(l.last) ? l.last : undefined; }
      else { return resultLeft; }
    }
    default:
      throw new InternalCompilerError(`find: unknown ConcatList ${(l as any).$name}`);
  }
}

export function foldl<T, B>(f: (base: B, x: T) => B, base: B, lst: ConcatList<T>): B {
  return lst.foldl(f, base);
}
export function foldr<T, B>(f: (base: B, x: T) => B, base: B, lst: ConcatList<T>): B {
  return lst.foldr(f, base);
}
export function map<T, U>(f: (x: T) => U, lst: ConcatList<T>): ConcatList<U> {
  return lst.map(f);
}
export function each<T>(f: (x: T) => void, lst: ConcatList<T>): void {
  return lst.each(f);
}

export function all<T>(f: (x: T) => boolean, lst: ConcatList<T>): boolean {
  return lst.all(f);
}

// Pyret's `[clist: ...]` construction object; mirrors the arity-specific
// structures (make1..make5 build cons/singleton chains; the general case
// folds with snoc).
export function clist<T>(...elts: T[]): ConcatList<T> {
  switch (elts.length) {
    case 0: return concatEmpty as ConcatList<T>;
    case 1: return new ConcatSingleton(elts[0]);
    case 2: return new ConcatCons(elts[0], new ConcatSingleton(elts[1]));
    case 3: return new ConcatCons(elts[0], new ConcatCons(elts[1], new ConcatSingleton(elts[2])));
    case 4: return new ConcatCons(elts[0], new ConcatCons(elts[1], new ConcatCons(elts[2], new ConcatSingleton(elts[3]))));
    case 5: return new ConcatCons(elts[0], new ConcatCons(elts[1], new ConcatCons(elts[2], new ConcatCons(elts[3], new ConcatSingleton(elts[4])))));
    default: {
      let clst: ConcatList<T> = concatEmpty as ConcatList<T>;
      for (const elt of elts) {
        clst = new ConcatSnoc(clst, elt);
      }
      return clst;
    }
  }
}

// Returns a catenable list made up of f(n, e1), f(n+1, e2) .. for e1, e2
// ... in lst
export function map_list_n<T, U>(f: (n: number, x: T) => U, n: number, lst: T[]): ConcatList<U> {
  // f is applied front-to-back, as in the Pyret original (order matters
  // for side-effecting f, e.g. gensym)
  const mapped = lst.map((x, idx) => f(n + idx, x));
  let result: ConcatList<U> = concatEmpty as ConcatList<U>;
  for (let idx = mapped.length - 1; idx >= 0; idx--) {
    result = new ConcatCons(mapped[idx], result);
  }
  return result;
}

export function each_n<T>(f: (n: number, x: T) => void, n: number, lst: ConcatList<T>): void {
  let counter = n;
  lst.each((item: T) => {
    f(counter, item);
    counter = counter + 1;
  });
}

export function map_list<T, U>(f: (x: T) => U, lst: T[]): ConcatList<U> {
  // f is applied front-to-back, as in the Pyret original
  const mapped = lst.map(f);
  let result: ConcatList<U> = concatEmpty as ConcatList<U>;
  for (let idx = mapped.length - 1; idx >= 0; idx--) {
    result = new ConcatCons(mapped[idx], result);
  }
  return result;
}

// Returns a catenable list made up of f(elem1, elem2) for each elem1 in
// l1, elem2 in l2
export function map_list2<A, B, C>(f: (a: A, b: B) => C, l1: A[], l2: B[]): ConcatList<C> {
  // f is applied front-to-back, as in the Pyret original; stops at the
  // shorter list
  const len = Math.min(l1.length, l2.length);
  const mapped: C[] = [];
  for (let idx = 0; idx < len; idx++) {
    mapped.push(f(l1[idx], l2[idx]));
  }
  let result: ConcatList<C> = concatEmpty as ConcatList<C>;
  for (let idx = mapped.length - 1; idx >= 0; idx--) {
    result = new ConcatCons(mapped[idx], result);
  }
  return result;
}

// Returns a ConcatList version of this list
export function from_list<T>(l: T[]): ConcatList<T> {
  let result: ConcatList<T> = concatEmpty as ConcatList<T>;
  for (let idx = l.length - 1; idx >= 0; idx--) {
    result = new ConcatCons(l[idx], result);
  }
  return result;
}

// camelCase aliases for the underscore-named helpers
export const mapListN = map_list_n;
export const eachN = each_n;
export const mapList = map_list;
export const mapList2 = map_list2;
export const fromList = from_list;
