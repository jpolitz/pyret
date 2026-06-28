/*
  ANF-to-ANF optimization middle-end (promise backend only).

  This file adds the classical FP optimizer passes the compiler otherwise
  lacks. They run after `anfProgram` produces ANF and before flatness
  analysis / codegen (see js-of-pyret.ts), and ONLY for the promise backend
  -- the cont backend's codegen and its byte-parity oracle stay untouched
  (these passes mint fresh gensym atoms, which would perturb cont byte
  parity).

  Pass 1: a size-budgeted INLINER for non-recursive, directly-called user
  functions. Inlining is the keystone: it removes an `await` suspension point
  per call on the async backend, and exposes cross-function redundancies
  (record-field reads through helpers) that CSE then eliminates.

  Pass 2: common-subexpression elimination (CSE) of immutable field reads. A
  repeated `obj.field` on a non-`var` (immutable) binding is replaced by a copy
  of the first read; copy-propagation lets chained reads (`b.rest.rest...`)
  collapse. Immutable objects can't change, so no invalidation is needed -- the
  pass is sound across calls and assignments.

  Pass 3: loop-invariant code motion (LICM) for field reads -- as a write-once
  cross-iteration CACHE, not a hoist. A `let t = obj.field` inside a loop-body
  lambda whose `obj` is loop-invariant (a free variable of the lambda that is
  never reassigned) reads the same immutable value every iteration. Rather than
  *move* the read to the preheader (unsound: it can raise field-not-found ahead
  of a preceding raise/effect, or run on a zero-trip loop -- see the removed
  prototype and test-anf-opt-soundness.arr), we keep the read exactly where it
  is and give it a memo cell `cacheVar` declared in the preheader (init
  `undefined`). Codegen emits `cacheVar ??= getField(obj, field)` (promise
  backend, anf-loop-compiler-async.ts aDot): the first iteration to reach the
  read evaluates getField at its original program point -- so exception ordering
  is preserved -- and every later iteration reuses the cell. The cell is
  declared in the immediately-enclosing scope, so it resets once per loop
  invocation (and, for nested loops, once per outer iteration). This is the
  colleague's "write-once CSE" idea: it trades N getField calls for one read
  plus N-1 cheap `undefined` checks, with no exception-ordering hazard and no
  need for type-informed non-faulting proof.

  Correctness contract (mirrors the parity goal):
    - Inlining is capture-avoiding: every binder introduced by the callee
      body is renamed to a fresh atom, so no name in the caller can be
      captured and vice-versa.
    - Parameter annotation checks are PRESERVED: each parameter becomes a
      real `let p :: ann = arg`, so a contract that would have raised on
      entry still raises. The declared return annotation is likewise kept.
    - Only DIRECTLY-named calls (`~f(...)` / `f(...)` whose callee is a
      known function definition) are inlined; such a call sits inside the
      callee's lexical scope, so the callee's free variables are guaranteed
      to be in scope at the call site.
    - Recursive (and mutually-recursive) functions are never inlined, which
      guarantees termination.
*/

import * as A from './ast';
import * as N from './ast-anf';

const names = A.globalNames;

// ----- module knobs ---------------------------------------------------------

// Max body size (ANF node count) of a function we are willing to inline.
// Bloat is the one real downside of inlining; this caps it. The integrator
// helpers we care about (distance-between, f-g-on-obj1, track-cx/cy, ...)
// are well under this.
const INLINE_SIZE_BUDGET = 80;

// Binder base name of the optional per-inline marker (see splice). With the
// -inline-comments flag, the inliner prepends a `let <marker> = "<callee>"` at
// each inline site; the async loop compiler recognizes this binder and renders
// it as a `// inlined: <callee>` JS comment (it never emits the binding itself).
// Off by default, so normal builds are byte-for-byte unchanged.
export const INLINE_MARKER_BASE = '$inlineComment';

// ----- small AST helpers ----------------------------------------------------

function isRealAnn(ann: A.Ann): boolean {
  return !(A.isABlank(ann) || A.isAAny(ann));
}

function blankBind(name: A.Name): N.ABind {
  return new N.ABind(N.dummyLoc, name, new A.ABlank());
}

// The atomic value that a call's `_fun` resolves a known function by. Returns
// the bound name's key if `v` is a plain/var/letrec identifier, else undefined.
function calleeKey(v: N.AVal): string | undefined {
  switch (v.$name) {
    case 'a-id': return v.id.key();
    case 'a-id-safe-letrec': return v.id.key();
    default: return undefined;
  }
}

// ----- size measurement -----------------------------------------------------

function sizeExpr(e: N.AExpr): number {
  switch (e.$name) {
    case 'a-type-let': return 1 + sizeExpr(e.body);
    case 'a-let': return 1 + sizeLettable(e.e) + sizeExpr(e.body);
    case 'a-arr-let': return 1 + sizeLettable(e.e) + sizeExpr(e.body);
    case 'a-var': return 1 + sizeLettable(e.e) + sizeExpr(e.body);
    case 'a-seq': return 1 + sizeLettable(e.e1) + sizeExpr(e.e2);
    case 'a-lettable': return sizeLettable(e.e);
    default: return 1;
  }
}

function sizeLettable(l: N.ALettable): number {
  switch (l.$name) {
    case 'a-lam': return 1 + sizeExpr(l.body);
    case 'a-method': return 1 + sizeExpr(l.body);
    case 'a-if': return 1 + sizeExpr(l.t) + sizeExpr(l.e);
    case 'a-cases': {
      let n = 1 + sizeExpr(l._else);
      for (const b of l.branches) { n += b.$name === 'a-cases-branch' ? sizeExpr(b.body) : sizeExpr(b.body); }
      return n;
    }
    default: return 1;
  }
}

// ----- collecting function definitions --------------------------------------
//
// A "function definition" is a name bound to an a-lam. Two shapes occur:
//   (1) directly:  let f = lam(...): ... end
//   (2) letrec:    var f = UNDEFINED ... f := tmp   (where tmp = lam(...))
// Top-level `fun`s and local `fun`s use shape (2); immediately-bound lambdas
// use shape (1). We map the *function name's* key to its a-lam in both.

interface FunCollection {
  defs: Map<string, N.ALam>;
}

function collectFunDefs(body: N.AExpr): FunCollection {
  const tmpLams = new Map<string, N.ALam>();   // temp-binding key -> lam
  const defs = new Map<string, N.ALam>();       // function-name key -> lam
  const assignCounts = new Map<string, number>();

  function bump(key: string): void {
    assignCounts.set(key, 1 + (assignCounts.get(key) ?? 0));
  }

  function vExpr(e: N.AExpr): void {
    switch (e.$name) {
      case 'a-let': {
        if (e.e instanceof N.ALam) {
          tmpLams.set(e.bind.id.key(), e.e);
          defs.set(e.bind.id.key(), e.e);
        }
        vLettable(e.e);
        vExpr(e.body);
        return;
      }
      case 'a-var':
      case 'a-arr-let': {
        vLettable(e.e);
        vExpr(e.body);
        return;
      }
      case 'a-seq': {
        // Detect the letrec function shape `f := tmp` (where `let tmp = lam`).
        // Assignment counting itself happens in vLettable's a-assign case (so
        // we don't double-count this spine assign).
        if (e.e1 instanceof N.AAssign) {
          const val = e.e1.value;
          if (val instanceof N.AId && tmpLams.has(val.id.key())) {
            defs.set(e.e1.id.key(), tmpLams.get(val.id.key())!);
          }
        }
        vLettable(e.e1);
        vExpr(e.e2);
        return;
      }
      case 'a-type-let': {
        vExpr(e.body);
        return;
      }
      case 'a-lettable': {
        vLettable(e.e);
        return;
      }
      default:
        return;
    }
  }

  function vLettable(l: N.ALettable): void {
    switch (l.$name) {
      case 'a-lam':
      case 'a-method':
        vExpr(l.body);
        return;
      case 'a-if':
        vExpr(l.t);
        vExpr(l.e);
        return;
      case 'a-cases':
        for (const b of l.branches) {
          if (b.$name === 'a-cases-branch') { vExpr(b.body); }
          else { vExpr(b.body); }
        }
        vExpr(l._else);
        return;
      case 'a-assign':
        bump(l.id.key());
        return;
      default:
        return;
    }
  }

  vExpr(body);

  // A name reassigned more than once (beyond its single letrec init) is not a
  // stable function value -- drop it.
  for (const [key, count] of assignCounts) {
    if (count > 1) { defs.delete(key); }
  }

  return { defs };
}

// ----- recursion analysis ---------------------------------------------------
//
// Build the call graph restricted to known function names and mark every name
// that can reach itself. We never inline a call to such a name.

function findRecursive(defs: Map<string, N.ALam>): Set<string> {
  const edges = new Map<string, Set<string>>();
  for (const [key, lam] of defs) {
    edges.set(key, calleesOf(lam.body, defs));
  }
  const recursive = new Set<string>();
  for (const start of defs.keys()) {
    // DFS to see if `start` can reach itself.
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n === start) { recursive.add(start); break; }
      if (seen.has(n)) { continue; }
      seen.add(n);
      for (const m of edges.get(n) ?? []) { stack.push(m); }
    }
  }
  return recursive;
}

function calleesOf(body: N.AExpr, defs: Map<string, N.ALam>): Set<string> {
  const out = new Set<string>();
  // A call may reach a known function through a temp that merely *reads* it. The
  // case that matters: a mutually-recursive sibling defined LATER in the same
  // letrec is read via `let t = ~!f` (an a-id-letrec -- the uninitialized-guarded
  // FORWARD reference) and then called as `t(...)`. The call's `_fun` is just the
  // a-id `t`, so resolving the callee key directly sees `t`, not `f` -- the forward
  // edge (and hence the whole mutual cycle) is missed, the cycle members are not
  // marked recursive, and they get inlined, which breaks safe-for-space token
  // minting (deep mutual recursion then OOMs under the optimizer). So we follow
  // single-identifier alias bindings here. This only ADDS edges, so it can only
  // make recursion detection more complete -> the inliner strictly more
  // conservative; it never enables an unsound inline.
  const alias = new Map<string, string>();
  function resolve(key: string): string {
    let k = key; const seen = new Set<string>();
    while (alias.has(k) && !seen.has(k)) { seen.add(k); k = alias.get(k)!; }
    return k;
  }
  // The name a lettable purely reads, if it is a single-identifier read.
  function readTarget(l: N.ALettable): string | undefined {
    if (l instanceof N.AIdLetrec) { return l.id.key(); }
    if (l instanceof N.AIdVar) { return l.id.key(); }
    if (l instanceof N.AVal$) {
      const v = l.v;
      if (v instanceof N.AId || v instanceof N.AIdSafeLetrec) { return v.id.key(); }
    }
    return undefined;
  }
  function vExpr(e: N.AExpr): void {
    switch (e.$name) {
      case 'a-let': case 'a-var': case 'a-arr-let': {
        const t = readTarget((e as any).e);
        if (t !== undefined) { alias.set((e as any).bind.id.key(), t); }
        vLettable((e as any).e); vExpr((e as any).body); return;
      }
      case 'a-seq':
        vLettable(e.e1); vExpr(e.e2); return;
      case 'a-type-let':
        vExpr(e.body); return;
      case 'a-lettable':
        vLettable(e.e); return;
      default: return;
    }
  }
  function vLettable(l: N.ALettable): void {
    switch (l.$name) {
      case 'a-app': {
        const k0 = calleeKey(l._fun);
        if (k0 !== undefined) { const k = resolve(k0); if (defs.has(k)) { out.add(k); } }
        return;
      }
      case 'a-lam': case 'a-method': vExpr(l.body); return;
      case 'a-if': vExpr(l.t); vExpr(l.e); return;
      case 'a-cases':
        for (const b of l.branches) { vExpr(b.body); }
        vExpr(l._else); return;
      default: return;
    }
  }
  vExpr(body);
  return out;
}

// ----- capture-avoiding renamer ---------------------------------------------
//
// Renames every binder listed in `nameMap` (and its uses) to a fresh atom.
// We pre-populate `nameMap` with fresh atoms for ALL binders of a callee body
// (including its parameters), then run this visitor so the cloned body shares
// nothing with the original or the caller.

class Renamer extends N.DefaultMapVisitor {
  constructor(public nameMap: Map<string, A.Name>) { super(); }

  private remap(id: A.Name): A.Name {
    return this.nameMap.get(id.key()) ?? id;
  }

  // binders
  aBind(node: N.ABind): N.ABind {
    return new N.ABind(node.l, this.remap(node.id), node.ann);
  }
  // value identifiers
  aId(node: N.AId): N.AVal {
    return new N.AId(node.l, this.remap(node.id));
  }
  aIdSafeLetrec(node: N.AIdSafeLetrec): N.AVal {
    return new N.AIdSafeLetrec(node.l, this.remap(node.id));
  }
  // lettable identifiers / assignment
  aIdVar(node: N.AIdVar): N.ALettable {
    return new N.AIdVar(node.l, this.remap(node.id));
  }
  aIdLetrec(node: N.AIdLetrec): N.ALettable {
    return new N.AIdLetrec(node.l, this.remap(node.id), node.safe);
  }
  aAssign(node: N.AAssign): N.ALettable {
    return new N.AAssign(node.l, this.remap(node.id), node.value.visit(this));
  }
}

// Collect every binder key introduced inside an expression (NOT counting
// free variables), so we can freshen them.
function collectBinders(e: N.AExpr, acc: A.Name[]): void {
  switch (e.$name) {
    case 'a-let': case 'a-var': case 'a-arr-let':
      acc.push((e as any).bind.id);
      collectBindersLettable((e as any).e, acc);
      collectBinders((e as any).body, acc);
      return;
    case 'a-seq':
      collectBindersLettable(e.e1, acc);
      collectBinders(e.e2, acc);
      return;
    case 'a-type-let':
      collectBinders(e.body, acc);
      return;
    case 'a-lettable':
      collectBindersLettable(e.e, acc);
      return;
    default:
      return;
  }
}

function collectBindersLettable(l: N.ALettable, acc: A.Name[]): void {
  switch (l.$name) {
    case 'a-lam': case 'a-method':
      for (const a of l.args) { acc.push(a.id); }
      collectBinders(l.body, acc);
      return;
    case 'a-if':
      collectBinders(l.t, acc);
      collectBinders(l.e, acc);
      return;
    case 'a-cases':
      for (const b of l.branches) {
        if (b.$name === 'a-cases-branch') {
          for (const cb of b.args) { acc.push(cb.bind.id); }
        }
        collectBinders(b.body, acc);
      }
      collectBinders(l._else, acc);
      return;
    default:
      return;
  }
}

// ----- the inliner -----------------------------------------------------------

class Inliner {
  defs: Map<string, N.ALam>;
  recursive: Set<string>;
  sizes: Map<string, number>;
  changed = false;
  emitComments: boolean;

  constructor(coll: FunCollection, emitComments: boolean) {
    this.defs = coll.defs;
    this.recursive = findRecursive(coll.defs);
    this.sizes = new Map();
    for (const [k, lam] of coll.defs) { this.sizes.set(k, sizeExpr(lam.body)); }
    this.emitComments = emitComments;
  }

  private inlinable(key: string, argc: number): N.ALam | undefined {
    const lam = this.defs.get(key);
    if (lam === undefined) { return undefined; }
    if (this.recursive.has(key)) { return undefined; }
    if (lam.args.length !== argc) { return undefined; }
    if ((this.sizes.get(key) ?? Infinity) > INLINE_SIZE_BUDGET) { return undefined; }
    return lam;
  }

  // Build the inlined expression for `let resultBind = f(args) in k`.
  private splice(lam: N.ALam, args: N.AVal[], resultBind: N.ABind, k: N.AExpr): N.AExpr {
    // Freshen all binders (params + internals) of the callee body.
    const binders: A.Name[] = [];
    for (const a of lam.args) { binders.push(a.id); }
    collectBinders(lam.body, binders);
    const nameMap = new Map<string, A.Name>();
    for (const b of binders) {
      if (!nameMap.has(b.key())) {
        nameMap.set(b.key(), names.makeAtom(b instanceof A.SAtom ? b.base : 'inl'));
      }
    }
    const renamer = new Renamer(nameMap);
    const freshBody: N.AExpr = lam.body.visit(renamer);
    const freshParams = lam.args.map((a) => new N.ABind(a.l, nameMap.get(a.id.key())!, a.ann));

    // The continuation that binds the callee's tail value to resultBind.
    const ret = lam.ret;
    const plugged = plugTail(freshBody, (tail: N.ALettable, tl: N.Loc): N.AExpr => {
      if (isRealAnn(ret)) {
        const rv = names.makeAtom('inl_ret');
        return new N.ALet(tl, new N.ABind(tl, rv, ret), tail,
          new N.ALet(resultBind.l, resultBind, new N.AVal(resultBind.l, new N.AId(resultBind.l, rv)), k));
      }
      return new N.ALet(resultBind.l, resultBind, tail, k);
    });

    // Bind parameters (preserving their annotations) around the plugged body.
    let out: N.AExpr = plugged;
    for (let i = freshParams.length - 1; i >= 0; i--) {
      out = new N.ALet(lam.l, freshParams[i], new N.AVal(lam.l, args[i]), out);
    }
    // Optional inline marker (-inline-comments): a never-read `let` whose binder
    // the async loop compiler turns into a `// inlined: <callee>` comment. The value
    // carries the callee name. One marker per inline site (splice runs for every one).
    if (this.emitComments) {
      const calleeName = (lam.name === undefined || lam.name === '') ? 'anon' : lam.name;
      out = new N.ALet(lam.l,
        new N.ABind(lam.l, names.makeAtom(INLINE_MARKER_BASE), new A.ABlank()),
        new N.AVal(lam.l, new N.AStr(lam.l, calleeName)), out);
    }
    return out;
  }

  // Walk the let-chain spine, inlining calls. Recurses into the spliced body
  // so nested (acyclic) calls inline too.
  optExpr(e: N.AExpr): N.AExpr {
    switch (e.$name) {
      case 'a-let': {
        const lettable = e.e;
        if (lettable instanceof N.AApp) {
          const key = calleeKey(lettable._fun);
          if (key !== undefined) {
            const lam = this.inlinable(key, lettable.args.length);
            if (lam !== undefined) {
              this.changed = true;
              const k = this.optExpr(e.body);
              return this.optExpr(this.splice(lam, lettable.args, e.bind, k));
            }
          }
        }
        return new N.ALet(e.l, e.bind, this.optLettable(lettable), this.optExpr(e.body));
      }
      case 'a-seq': {
        const lettable = e.e1;
        if (lettable instanceof N.AApp) {
          const key = calleeKey(lettable._fun);
          if (key !== undefined) {
            const lam = this.inlinable(key, lettable.args.length);
            if (lam !== undefined) {
              this.changed = true;
              const k = this.optExpr(e.e2);
              const throwaway = blankBind(names.makeAtom('inl_seq'));
              return this.optExpr(this.splice(lam, lettable.args, throwaway, k));
            }
          }
        }
        return new N.ASeq(e.l, this.optLettable(lettable), this.optExpr(e.e2));
      }
      case 'a-lettable': {
        const lettable = e.e;
        if (lettable instanceof N.AApp) {
          const key = calleeKey(lettable._fun);
          if (key !== undefined) {
            const lam = this.inlinable(key, lettable.args.length);
            if (lam !== undefined) {
              this.changed = true;
              const rv = names.makeAtom('inl_tail');
              const k = new N.ALettable(e.l, new N.AVal(e.l, new N.AId(e.l, rv)));
              return this.optExpr(this.splice(lam, lettable.args, blankBind(rv), k));
            }
          }
        }
        return new N.ALettable(e.l, this.optLettable(lettable));
      }
      case 'a-arr-let':
        return new N.AArrLet(e.l, e.bind, e.idx, this.optLettable(e.e), this.optExpr(e.body));
      case 'a-var':
        return new N.AVar(e.l, e.bind, this.optLettable(e.e), this.optExpr(e.body));
      case 'a-type-let':
        return new N.ATypeLet(e.l, e.bind, this.optExpr(e.body));
      default:
        return e;
    }
  }

  optLettable(l: N.ALettable): N.ALettable {
    switch (l.$name) {
      case 'a-lam':
        return new N.ALam(l.l, l.name, l.args, l.ret, this.optExpr(l.body));
      case 'a-method':
        return new N.AMethod(l.l, l.name, l.args, l.ret, this.optExpr(l.body));
      case 'a-if':
        return new N.AIf(l.l, l.c, this.optExpr(l.t), this.optExpr(l.e));
      case 'a-cases': {
        const branches = l.branches.map((b) => {
          if (b.$name === 'a-cases-branch') {
            return new N.ACasesBranch(b.l, b.patLoc, b.name, b.args, this.optExpr(b.body));
          }
          return new N.ASingletonCasesBranch(b.l, b.patLoc, b.name, this.optExpr(b.body));
        });
        return new N.ACases(l.l, l.typ, l.val, branches, this.optExpr(l._else));
      }
      default:
        return l;
    }
  }
}

// Rewrite each tail-position lettable of `e` using `k`. The recursion only
// follows the let-chain spine (ALet/AVar/AArrLet/ASeq/ATypeLet bodies); a
// control-flow lettable (a-if/a-cases) in tail position is handed to `k`
// whole, which is sound because `let x = if ... end in cont` is valid ANF.
function plugTail(e: N.AExpr, k: (tail: N.ALettable, l: N.Loc) => N.AExpr): N.AExpr {
  switch (e.$name) {
    case 'a-let':
      return new N.ALet(e.l, e.bind, e.e, plugTail(e.body, k));
    case 'a-arr-let':
      return new N.AArrLet(e.l, e.bind, e.idx, e.e, plugTail(e.body, k));
    case 'a-var':
      return new N.AVar(e.l, e.bind, e.e, plugTail(e.body, k));
    case 'a-seq':
      return new N.ASeq(e.l, e.e1, plugTail(e.e2, k));
    case 'a-type-let':
      return new N.ATypeLet(e.l, e.bind, plugTail(e.body, k));
    case 'a-lettable':
      return k(e.e, e.l);
    default:
      return e;
  }
}

// ============================================================================
// Pass 2: common-subexpression elimination (CSE) for immutable field reads
// ============================================================================
//
// Within a function scope, a repeated `obj.field` where `obj` is an immutable
// binding (NOT a `var`) always yields the same value -- the field is immutable
// and obj's value is fixed -- so the second read can be replaced by a copy of
// the first. No invalidation is ever needed (immutable objects can't change),
// which keeps this sound across calls and assignments. Copy-propagation
// (alias resolution) lets chained reads like `b.rest.rest` dedupe with
// `b.rest.rest.rest`. This is the classic CSE pass and composes with LICM
// (LICM relocates invariant reads; CSE removes the redundant ones).

// All names bound by `a-var` (mutable). Reads off a mutable var are not CSE'd.
function collectVarNames(body: N.AExpr): Set<string> {
  const out = new Set<string>();
  function vExpr(e: N.AExpr): void {
    switch (e.$name) {
      case 'a-var': out.add(e.bind.id.key()); vLettable(e.e); vExpr(e.body); return;
      case 'a-let': case 'a-arr-let': vLettable((e as any).e); vExpr((e as any).body); return;
      case 'a-seq': vLettable(e.e1); vExpr(e.e2); return;
      case 'a-type-let': vExpr(e.body); return;
      case 'a-lettable': vLettable(e.e); return;
      default: return;
    }
  }
  function vLettable(l: N.ALettable): void {
    switch (l.$name) {
      case 'a-lam': case 'a-method': vExpr(l.body); return;
      case 'a-if': vExpr(l.t); vExpr(l.e); return;
      case 'a-cases': for (const b of l.branches) { vExpr(b.body); } vExpr(l._else); return;
      default: return;
    }
  }
  vExpr(body);
  return out;
}

class Cse {
  changed = false;
  vars: Set<string>;
  // alias -> canonical binding (path-compressed at insertion)
  roots = new Map<string, A.Name>();

  constructor(body: N.AExpr) { this.vars = collectVarNames(body); }

  private resolve(id: A.Name): A.Name {
    return this.roots.get(id.key()) ?? id;
  }

  private dotKey(obj: N.AVal, field: string): string | null {
    if (obj instanceof N.AId) {
      return 'dot|' + this.resolve(obj.id).key() + '|' + field;
    }
    return null;
  }

  // `avail` maps a dot-key to the canonical binding holding that read.
  optExpr(e: N.AExpr, avail: Map<string, A.Name>): N.AExpr {
    switch (e.$name) {
      case 'a-let': {
        const rhs = e.e;
        // Track copies (`let v = w`) for alias resolution.
        if (rhs instanceof N.AVal && rhs.v instanceof N.AId) {
          this.roots.set(e.bind.id.key(), this.resolve(rhs.v.id));
          return new N.ALet(e.l, e.bind, rhs, this.optExpr(e.body, avail));
        }
        if (rhs instanceof N.ADot && rhs.obj instanceof N.AId && !this.vars.has(this.resolve(rhs.obj.id).key())) {
          const k = this.dotKey(rhs.obj, rhs.field)!;
          const have = avail.get(k);
          if (have !== undefined) {
            this.changed = true;
            this.roots.set(e.bind.id.key(), have);
            const copy = new N.AVal(e.l, new N.AId(e.l, have));
            return new N.ALet(e.l, e.bind, copy, this.optExpr(e.body, avail));
          }
          avail.set(k, e.bind.id);
          return new N.ALet(e.l, e.bind, rhs, this.optExpr(e.body, avail));
        }
        return new N.ALet(e.l, e.bind, this.optLettable(rhs, avail), this.optExpr(e.body, avail));
      }
      case 'a-seq':
        return new N.ASeq(e.l, this.optLettable(e.e1, avail), this.optExpr(e.e2, avail));
      case 'a-arr-let':
        return new N.AArrLet(e.l, e.bind, e.idx, this.optLettable(e.e, avail), this.optExpr(e.body, avail));
      case 'a-var':
        return new N.AVar(e.l, e.bind, this.optLettable(e.e, avail), this.optExpr(e.body, avail));
      case 'a-type-let':
        return new N.ATypeLet(e.l, e.bind, this.optExpr(e.body, avail));
      case 'a-lettable':
        return new N.ALettable(e.l, this.optLettable(e.e, avail));
      default:
        return e;
    }
  }

  // Branches get a CLONE of `avail` (reads computed on one path are not
  // available after the join). Lambda bodies start a fresh scope.
  optLettable(l: N.ALettable, avail: Map<string, A.Name>): N.ALettable {
    switch (l.$name) {
      case 'a-lam':
        return new N.ALam(l.l, l.name, l.args, l.ret, this.optExpr(l.body, new Map()));
      case 'a-method':
        return new N.AMethod(l.l, l.name, l.args, l.ret, this.optExpr(l.body, new Map()));
      case 'a-if':
        return new N.AIf(l.l, l.c, this.optExpr(l.t, new Map(avail)), this.optExpr(l.e, new Map(avail)));
      case 'a-cases': {
        const branches = l.branches.map((b) => {
          if (b.$name === 'a-cases-branch') {
            return new N.ACasesBranch(b.l, b.patLoc, b.name, b.args, this.optExpr(b.body, new Map(avail)));
          }
          return new N.ASingletonCasesBranch(b.l, b.patLoc, b.name, this.optExpr(b.body, new Map(avail)));
        });
        return new N.ACases(l.l, l.typ, l.val, branches, this.optExpr(l._else, new Map(avail)));
      }
      default:
        return l;
    }
  }
}

// ============================================================================
// Pass 3: loop-invariant field-read caching (LICM as write-once memoization)
// ============================================================================
//
// We look for a loop body: a lambda that is bound (`let lam = lam(...): ...`)
// and then handed to a higher-order/iterating function (detected by
// `usedAsCallArg`, the same proxy the old hoisting LICM used). Inside such a
// body, a field read `let t = obj.field` whose `obj` is loop-invariant -- a
// free variable of the lambda that is never reassigned in the body -- yields
// the same immutable value on every iteration (a-dot reads only immutable
// fields; mutable refs use a-get-bang). We do NOT move the read; we tag it with
// a fresh `cacheVar` and declare `let cacheVar = undefined` in the preheader
// (just before the lambda). Codegen turns the tagged read into
// `cacheVar ??= getField(...)`, so the read still executes at its original spot
// the first time it is reached -- preserving exception ordering and zero-trip
// semantics -- and is reused thereafter.

// Names assigned (`:=`) anywhere inside an expression -- such a free variable is
// NOT loop-invariant even if it is free in the lambda.
function collectAssigned(e: N.AExpr, acc: Set<string>): void {
  function vExpr(x: N.AExpr): void {
    switch (x.$name) {
      case 'a-let': case 'a-var': case 'a-arr-let':
        vLettable((x as any).e); vExpr((x as any).body); return;
      case 'a-seq': vLettable(x.e1); vExpr(x.e2); return;
      case 'a-type-let': vExpr(x.body); return;
      case 'a-lettable': vLettable(x.e); return;
      default: return;
    }
  }
  function vLettable(l: N.ALettable): void {
    switch (l.$name) {
      case 'a-assign': acc.add(l.id.key()); return;
      case 'a-lam': case 'a-method': vExpr(l.body); return;
      case 'a-if': vExpr(l.t); vExpr(l.e); return;
      case 'a-cases':
        for (const b of l.branches) { vExpr(b.body); }
        vExpr(l._else); return;
      default: return;
    }
  }
  vExpr(e);
}

// Does `name` get used as an argument to some function application inside `e`?
// (A proxy for "this lambda is passed to a higher-order/iterating function",
// i.e. it is a loop body worth caching reads in.)
function usedAsCallArg(name: A.Name, e: N.AExpr): boolean {
  const key = name.key();
  let found = false;
  function vExpr(x: N.AExpr): void {
    if (found) { return; }
    switch (x.$name) {
      case 'a-let': case 'a-var': case 'a-arr-let':
        vLettable((x as any).e); vExpr((x as any).body); return;
      case 'a-seq': vLettable(x.e1); vExpr(x.e2); return;
      case 'a-type-let': vExpr(x.body); return;
      case 'a-lettable': vLettable(x.e); return;
      default: return;
    }
  }
  function argHit(args: N.AVal[]): boolean {
    return args.some((a) => a instanceof N.AId && a.id.key() === key);
  }
  function vLettable(l: N.ALettable): void {
    if (found) { return; }
    switch (l.$name) {
      case 'a-app': if (argHit(l.args)) { found = true; } return;
      case 'a-method-app': if (argHit(l.args)) { found = true; } return;
      case 'a-prim-app': if (argHit(l.args)) { found = true; } return;
      case 'a-lam': case 'a-method': vExpr(l.body); return;
      case 'a-if': vExpr(l.t); vExpr(l.e); return;
      case 'a-cases':
        for (const b of l.branches) { vExpr(b.body); }
        vExpr(l._else); return;
      default: return;
    }
  }
  vExpr(e);
  return found;
}

class LicmCache {
  changed = false;

  // Tag invariant field reads in `body` with fresh cache cells. Descends through
  // the straight-line spine AND into a-if / a-cases branches (reads sit under a
  // loop's conditionals), but NOT into nested lambdas -- those are separate
  // scopes and are visited as their own loop bodies by optExpr. `invariant` is
  // the set of names that are loop-invariant for this lambda; `cells` collects
  // the cache cells to declare in the preheader.
  private tagBody(body: N.AExpr, invariant: Set<string>, cells: A.Name[]): N.AExpr {
    switch (body.$name) {
      case 'a-let': {
        const rhs = body.e;
        if (rhs instanceof N.ADot && rhs.cacheVar === undefined
            && rhs.obj instanceof N.AId && invariant.has(rhs.obj.id.key())) {
          const cell = names.makeAtom('fieldcache');
          cells.push(cell);
          this.changed = true;
          const tagged = new N.ADot(rhs.l, rhs.obj, rhs.field, cell);
          return new N.ALet(body.l, body.bind, tagged, this.tagBody(body.body, invariant, cells));
        }
        return new N.ALet(body.l, body.bind, this.tagInRhs(rhs, invariant, cells), this.tagBody(body.body, invariant, cells));
      }
      case 'a-arr-let':
        return new N.AArrLet(body.l, body.bind, body.idx, this.tagInRhs(body.e, invariant, cells), this.tagBody(body.body, invariant, cells));
      case 'a-var':
        return new N.AVar(body.l, body.bind, this.tagInRhs(body.e, invariant, cells), this.tagBody(body.body, invariant, cells));
      case 'a-seq':
        return new N.ASeq(body.l, this.tagInRhs(body.e1, invariant, cells), this.tagBody(body.e2, invariant, cells));
      case 'a-type-let':
        return new N.ATypeLet(body.l, body.bind, this.tagBody(body.body, invariant, cells));
      case 'a-lettable':
        return new N.ALettable(body.l, this.tagInRhs(body.e, invariant, cells));
      default:
        return body;
    }
  }

  // Descend into the branches of a control-flow lettable; other lettables
  // (including nested lambdas) are returned unchanged.
  private tagInRhs(l: N.ALettable, invariant: Set<string>, cells: A.Name[]): N.ALettable {
    switch (l.$name) {
      case 'a-if':
        return new N.AIf(l.l, l.c, this.tagBody(l.t, invariant, cells), this.tagBody(l.e, invariant, cells));
      case 'a-cases': {
        const branches = l.branches.map((b) => {
          if (b.$name === 'a-cases-branch') {
            return new N.ACasesBranch(b.l, b.patLoc, b.name, b.args, this.tagBody(b.body, invariant, cells));
          }
          return new N.ASingletonCasesBranch(b.l, b.patLoc, b.name, this.tagBody(b.body, invariant, cells));
        });
        return new N.ACases(l.l, l.typ, l.val, branches, this.tagBody(l._else, invariant, cells));
      }
      default:
        return l;
    }
  }

  // For a loop-body lambda, tag its invariant field reads; returns the cache
  // cells to declare in the preheader and the rewritten lambda, or null.
  private tryCache(lam: N.ALam): { cells: A.Name[]; lam: N.ALam } | null {
    const fvs = N.freevarsL(lam);
    const assigned = new Set<string>();
    collectAssigned(lam.body, assigned);
    const invariant = new Set<string>();
    for (const k of fvs.keys()) { if (!assigned.has(k)) { invariant.add(k); } }
    const cells: A.Name[] = [];
    const newBody = this.tagBody(lam.body, invariant, cells);
    if (cells.length === 0) { return null; }
    return { cells, lam: new N.ALam(lam.l, lam.name, lam.args, lam.ret, newBody) };
  }

  optExpr(e: N.AExpr): N.AExpr {
    switch (e.$name) {
      case 'a-let': {
        if (e.e instanceof N.ALam && usedAsCallArg(e.bind.id, e.body)) {
          // Recurse into the body first so nested loops get their own cells.
          const innerLam = new N.ALam(e.e.l, e.e.name, e.e.args, e.e.ret, this.optExpr(e.e.body));
          const res = this.tryCache(innerLam);
          if (res !== null) {
            // <cache-cell decls> ; let lam = tagged-lam : opt(body)
            let out: N.AExpr = new N.ALet(e.l, e.bind, res.lam, this.optExpr(e.body));
            for (let i = res.cells.length - 1; i >= 0; i--) {
              const cell = res.cells[i];
              out = new N.ALet(N.dummyLoc, blankBind(cell), new N.AVal(N.dummyLoc, new N.AUndefined(N.dummyLoc)), out);
            }
            return out;
          }
          return new N.ALet(e.l, e.bind, innerLam, this.optExpr(e.body));
        }
        return new N.ALet(e.l, e.bind, this.optLettable(e.e), this.optExpr(e.body));
      }
      case 'a-seq':
        return new N.ASeq(e.l, this.optLettable(e.e1), this.optExpr(e.e2));
      case 'a-arr-let':
        return new N.AArrLet(e.l, e.bind, e.idx, this.optLettable(e.e), this.optExpr(e.body));
      case 'a-var':
        return new N.AVar(e.l, e.bind, this.optLettable(e.e), this.optExpr(e.body));
      case 'a-type-let':
        return new N.ATypeLet(e.l, e.bind, this.optExpr(e.body));
      case 'a-lettable':
        return new N.ALettable(e.l, this.optLettable(e.e));
      default:
        return e;
    }
  }

  optLettable(l: N.ALettable): N.ALettable {
    switch (l.$name) {
      case 'a-lam':
        return new N.ALam(l.l, l.name, l.args, l.ret, this.optExpr(l.body));
      case 'a-method':
        return new N.AMethod(l.l, l.name, l.args, l.ret, this.optExpr(l.body));
      case 'a-if':
        return new N.AIf(l.l, l.c, this.optExpr(l.t), this.optExpr(l.e));
      case 'a-cases': {
        const branches = l.branches.map((b) => {
          if (b.$name === 'a-cases-branch') {
            return new N.ACasesBranch(b.l, b.patLoc, b.name, b.args, this.optExpr(b.body));
          }
          return new N.ASingletonCasesBranch(b.l, b.patLoc, b.name, this.optExpr(b.body));
        });
        return new N.ACases(l.l, l.typ, l.val, branches, this.optExpr(l._else));
      }
      default:
        return l;
    }
  }
}

// ----- entry point ----------------------------------------------------------

export function optimizeProgram(prog: N.AProg, inlineComments: boolean = false, licm: boolean = true): N.AProg {
  if (!(prog instanceof N.AProgram)) { return prog; }
  let body = prog.body;
  let changed = false;

  const coll = collectFunDefs(body);
  if (coll.defs.size > 0) {
    const inliner = new Inliner(coll, inlineComments);
    body = inliner.optExpr(body);
    changed = changed || inliner.changed;
  }

  const cse = new Cse(body);
  body = cse.optExpr(body, new Map());
  changed = changed || cse.changed;

  // LICM after CSE: CSE first collapses within-iteration repeats, then LICM
  // gives each surviving loop-invariant read a cross-iteration memo cell.
  // The `-no-licm` CLI flag disables just this pass (A/B measurement knob; the
  // inliner and CSE still run), analogous to `-no-optimize` for the whole
  // middle-end.
  if (licm) {
    const licmPass = new LicmCache();
    body = licmPass.optExpr(body);
    changed = changed || licmPass.changed;
  }

  if (!changed) { return prog; }
  return new N.AProgram(prog.l, prog.provides, prog.imports, body);
}
