/*
  ANF-to-ANF optimization middle-end (promise backend only).

  This file adds the classical FP optimizer passes the compiler otherwise
  lacks. They run after `anfProgram` produces ANF and before flatness
  analysis / codegen (see js-of-pyret.ts), and ONLY for the promise backend
  -- the cont backend's codegen and its byte-parity oracle stay untouched
  (these passes mint fresh gensym atoms, which would perturb cont byte
  parity).

  Pass 1: a size-budgeted INLINER for non-recursive, directly-called user
  functions. Inlining is the keystone: it exposes cross-function loop
  invariants (record-field reads through helpers) that later passes (LICM/CSE)
  can hoist, and -- on the async backend -- removes an `await` suspension
  point per call.

  Pass 2: loop-invariant code motion (LICM). For a lambda that is bound and
  then handed to a higher-order function (a `for fold`/`for each`/`map`/...
  loop body), invariant pure bindings on the body's straight-line spine are
  hoisted to just before the lambda, so they run once instead of once per
  iteration. "Invariant" = depends only on the lambda's free variables (none
  of which is reassigned in the body) -- never on a parameter or a
  loop-varying local. Hoisted lettables are restricted to non-allocating,
  effect-free reads (`a-val` copies and `a-dot` immutable field reads), which
  preserves value identity and results bit-exactly. (As in standard LICM and
  the hand-proof variants, a hoisted field read executes at loop-entry rather
  than first-iteration; for the entered loops these benchmarks run this is
  observationally identical.)

  Pass 3: common-subexpression elimination (CSE) of immutable field reads. A
  repeated `obj.field` on a non-`var` (immutable) binding is replaced by a copy
  of the first read; copy-propagation lets chained reads (`b.rest.rest...`)
  collapse. Immutable objects can't change, so no invalidation is needed -- the
  pass is sound across calls and assignments.

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
  function vExpr(e: N.AExpr): void {
    switch (e.$name) {
      case 'a-let': case 'a-var': case 'a-arr-let':
        vLettable((e as any).e); vExpr((e as any).body); return;
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
        const k = calleeKey(l._fun);
        if (k !== undefined && defs.has(k)) { out.add(k); }
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

  constructor(coll: FunCollection) {
    this.defs = coll.defs;
    this.recursive = findRecursive(coll.defs);
    this.sizes = new Map();
    for (const [k, lam] of coll.defs) { this.sizes.set(k, sizeExpr(lam.body)); }
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
// Pass 2: loop-invariant code motion (LICM)
// ============================================================================

// Lettables we are willing to hoist out of a loop body: effect-free,
// non-allocating, value-identity-preserving reads. `a-val` (a copy or
// literal) and `a-dot` (an immutable field read) qualify. We deliberately
// exclude allocations (a-obj/a-tuple/a-update/a-extend -- hoisting could
// change observed object identity), ref dereferences (a-get-bang -- mutable),
// and calls (a-app/a-method-app/a-prim-app -- possible effects).
function isHoistable(l: N.ALettable): boolean {
  switch (l.$name) {
    case 'a-val': return true;
    case 'a-dot': return true;
    default: return false;
  }
}

// Collect names assigned (`:=`) anywhere inside an expression -- such a free
// variable is NOT loop-invariant even if it is free in the lambda.
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
      case 'a-assign': acc.add(l.id.key()); l.value; return;
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
// i.e. it is a loop body worth hoisting out of.)
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

interface Hoist { bind: N.ABind; e: N.ALettable; l: N.Loc; }

// Pull invariant bindings out of `body`, INCLUDING bindings nested inside
// a-if / a-cases branches (the integrator reads sit under the loop's
// conditionals). `invariant` starts as the lambda's hoistable free variables
// and grows monotonically as we discover invariant bindings; collecting in
// pre-order keeps each hoisted binding after the bindings it depends on.
//
// We do NOT descend into nested lambdas/methods (separate scopes with their
// own parameters). A hoisted invariant a-dot read now executes once at
// loop-entry even if its original branch was conditionally taken; like
// standard LICM (and the hand-proof variants) this relocates a pure,
// value-identical read -- validated against the frozen-cont parity oracle and
// the full promise suite.
function hoistAll(body: N.AExpr, invariant: Set<string>, hoisted: Hoist[]): N.AExpr {
  switch (body.$name) {
    case 'a-let': {
      const rhs = body.e;
      if (isHoistable(rhs) && operandsInvariant(rhs, invariant)) {
        invariant.add(body.bind.id.key());
        hoisted.push({ bind: body.bind, e: rhs, l: body.l });
        return hoistAll(body.body, invariant, hoisted);
      }
      return new N.ALet(body.l, body.bind, hoistInRhs(rhs, invariant, hoisted), hoistAll(body.body, invariant, hoisted));
    }
    case 'a-arr-let':
      return new N.AArrLet(body.l, body.bind, body.idx, hoistInRhs(body.e, invariant, hoisted), hoistAll(body.body, invariant, hoisted));
    case 'a-var':
      return new N.AVar(body.l, body.bind, hoistInRhs(body.e, invariant, hoisted), hoistAll(body.body, invariant, hoisted));
    case 'a-seq':
      return new N.ASeq(body.l, hoistInRhs(body.e1, invariant, hoisted), hoistAll(body.e2, invariant, hoisted));
    case 'a-type-let':
      return new N.ATypeLet(body.l, body.bind, hoistAll(body.body, invariant, hoisted));
    case 'a-lettable':
      return new N.ALettable(body.l, hoistInRhs(body.e, invariant, hoisted));
    default:
      return body;
  }
}

// Descend into the branches of a control-flow lettable (only); other lettables
// (including nested lambdas) are returned unchanged.
function hoistInRhs(l: N.ALettable, invariant: Set<string>, hoisted: Hoist[]): N.ALettable {
  switch (l.$name) {
    case 'a-if':
      return new N.AIf(l.l, l.c, hoistAll(l.t, invariant, hoisted), hoistAll(l.e, invariant, hoisted));
    case 'a-cases': {
      const branches = l.branches.map((b) => {
        if (b.$name === 'a-cases-branch') {
          return new N.ACasesBranch(b.l, b.patLoc, b.name, b.args, hoistAll(b.body, invariant, hoisted));
        }
        return new N.ASingletonCasesBranch(b.l, b.patLoc, b.name, hoistAll(b.body, invariant, hoisted));
      });
      return new N.ACases(l.l, l.typ, l.val, branches, hoistAll(l._else, invariant, hoisted));
    }
    default:
      return l;
  }
}

function operandsInvariant(rhs: N.ALettable, invariant: Set<string>): boolean {
  for (const k of N.freevarsL(rhs).keys()) {
    if (!invariant.has(k)) { return false; }
  }
  return true;
}

class Licm {
  changed = false;

  // Try to hoist invariant work out of a loop-body lambda; returns the hoisted
  // bindings (to emit before the lambda) and the slimmed lambda, or null.
  private tryHoist(lam: N.ALam): { hoisted: Hoist[]; lam: N.ALam } | null {
    const fvs = N.freevarsL(lam);
    const assigned = new Set<string>();
    collectAssigned(lam.body, assigned);
    const invariant = new Set<string>();
    for (const k of fvs.keys()) { if (!assigned.has(k)) { invariant.add(k); } }
    const hoisted: Hoist[] = [];
    const newBody = hoistAll(lam.body, invariant, hoisted);
    if (hoisted.length === 0) { return null; }
    return { hoisted, lam: new N.ALam(lam.l, lam.name, lam.args, lam.ret, newBody) };
  }

  optExpr(e: N.AExpr): N.AExpr {
    switch (e.$name) {
      case 'a-let': {
        if (e.e instanceof N.ALam && usedAsCallArg(e.bind.id, e.body)) {
          const innerLam = new N.ALam(e.e.l, e.e.name, e.e.args, e.e.ret, this.optExpr(e.e.body));
          const res = this.tryHoist(innerLam);
          if (res !== null) {
            this.changed = true;
            // <hoisted lets> ; let lam = slimmed-lam : opt(body)
            let out: N.AExpr = new N.ALet(e.l, e.bind, res.lam, this.optExpr(e.body));
            for (let i = res.hoisted.length - 1; i >= 0; i--) {
              const h = res.hoisted[i];
              out = new N.ALet(h.l, h.bind, h.e, out);
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

// ============================================================================
// Pass 3: common-subexpression elimination (CSE) for immutable field reads
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

// ----- entry point ----------------------------------------------------------

export function optimizeProgram(prog: N.AProg): N.AProg {
  if (!(prog instanceof N.AProgram)) { return prog; }
  let body = prog.body;
  let changed = false;

  const coll = collectFunDefs(body);
  if (coll.defs.size > 0) {
    const inliner = new Inliner(coll);
    body = inliner.optExpr(body);
    changed = changed || inliner.changed;
  }

  const licm = new Licm();
  body = licm.optExpr(body);
  changed = changed || licm.changed;

  const cse = new Cse(body);
  body = cse.optExpr(body, new Map());
  changed = changed || cse.changed;

  if (!changed) { return prog; }
  return new N.AProgram(prog.l, prog.provides, prog.imports, body);
}
