/*
  Upper-bound type flow: a forward abstract interpretation over the ANF that
  computes, per ANF value, the most precise SOUND over-approximation of its
  runtime type (its "upper bound" ub). `ub(x) = τ` means the value held by `x`
  is guaranteed `∈ ⟦τ⟧`; the analysis never excludes a value `x` could hold.
  `Any` (⊤) is the always-sound, useless fallback.

  This is the generalization the numeric-flatness pass (flatness.ts) prototypes
  for `{Number, ⊤}`. It is kept DELIBERATELY DECOUPLED from that await-critical
  flatness number: this pass produces only optimization-facts in their own
  consumed-set and never rewrites the ANF, so it cannot perturb cont codegen
  (cont never consults the set) nor the sync-vs-async emission decision (which
  reads annotations, which this pass leaves untouched). It mirrors the
  `numericFlatApps` plumbing exactly.

  ----------------------------------------------------------------------------
  First consumer: redundant `_checkAnn` elimination.
  ----------------------------------------------------------------------------
  Every param / let / return / cases-scrutinee annotation `:: T` lowers to a
  runtime `_checkAnn(loc, T, v)` brand check (return and cases-scrutinee anns
  desugar into ordinary annotated lets, so they share the same emission sites).
  When `ub(v) ⊑ T` is already proven, that check is dead weight: it can never
  fail. We collect the binding keys of such checks into `redundantAnnChecks` and
  the async compiler treats them like a blank annotation (no check emitted).

  SOUNDNESS of eliding `:: T`'s check requires BOTH:
   (a) `ub(v) ⊑ T` (this analysis proves it), AND
   (b) `T` is a FLAT, NON-REFINEMENT annotation. A refinement `T%(pred)` runs
       user code that may raise even when `v` is of `T`'s brand, so eliding it
       changes behavior; and a flat-restriction additionally excludes
       alias-to-refinement (those resolve non-flat) and keeps the sync-vs-async
       flatness verdict provably unchanged. `resolveAnnType` returns `undefined`
       for predicate/arrow/record/tuple anns, and we additionally gate on
       `annFlatness` being flat.

  All of the ub facts ultimately rest on the runtime annotation checks actually
  running (param checks seed types; declared return types are trusted because
  the callee re-checks them). So, like the direct-cases optimization, the whole
  pass is gated on `runtimeAnnotations && userAnnotations` by the caller.
*/

import * as A from './ast';
import * as N from './ast-anf';
import * as C from './compile-structs';
import * as FL from './flatness';

// ---------------------------------------------------------------------------
// Lattice
// ---------------------------------------------------------------------------
// Domain elements ordered by subtyping. `data` carries a canonical type id
// (uri '#' originalName) and an optional variant name (tighter than the whole
// data type: a `link` value is ⊑ the `link` variant ⊑ `List`).
export type AbsType =
  | { k: 'any' }
  | { k: 'bot' }
  | { k: 'prim'; n: 'Number' | 'String' | 'Boolean' }
  | { k: 'data'; id: string; variant?: string };

const ANY: AbsType = { k: 'any' };
const BOT: AbsType = { k: 'bot' };

function prim(n: 'Number' | 'String' | 'Boolean'): AbsType { return { k: 'prim', n }; }

// `a ⊑ b` : is every value in ⟦a⟧ also in ⟦b⟧?
export function subtype(a: AbsType, b: AbsType): boolean {
  if (a.k === 'bot') { return true; }
  if (b.k === 'any') { return true; }
  if (a.k === 'any') { return false; }
  if (b.k === 'bot') { return false; }
  if (a.k === 'prim' && b.k === 'prim') { return a.n === b.n; }
  if (a.k === 'data' && b.k === 'data') {
    if (a.id !== b.id) { return false; }
    // b with no variant is the whole data type (a super of any variant).
    return b.variant === undefined || a.variant === b.variant;
  }
  return false;
}

// Least sound upper bound at a control-flow merge. Need not be the *least*
// upper bound, only a sound one, so unrelated elements widen to Any.
export function join(a: AbsType, b: AbsType): AbsType {
  if (a.k === 'bot') { return b; }
  if (b.k === 'bot') { return a; }
  if (a.k === 'any' || b.k === 'any') { return ANY; }
  if (a.k === 'prim' && b.k === 'prim') { return a.n === b.n ? a : ANY; }
  if (a.k === 'data' && b.k === 'data') {
    if (a.id !== b.id) { return ANY; }
    return { k: 'data', id: a.id, variant: a.variant === b.variant ? a.variant : undefined };
  }
  return ANY;
}

// Matches isFlatEnough in anf-loop-compiler-async.ts (inlined to avoid an
// import cycle: that compiler imports this module).
const FLAT_LIMIT = 5;
function flatAnn(ann: A.Ann, fl: FL.FlatnessEnv, mb: Map<string, C.ModuleBind>, env: C.CompileEnvironment): boolean {
  const f = FL.annFlatness(ann, fl[0], fl[1], mb, env);
  return f !== undefined && f <= FLAT_LIMIT;
}

// ---------------------------------------------------------------------------
// Analysis context
// ---------------------------------------------------------------------------
interface Ctx {
  env: Map<string, AbsType>;              // value key -> ub
  redundant: Set<string>;                 // bind keys whose ann check is dead
  // constructor binding key -> the data value it builds, plus whether it is a
  // singleton (a value, not a function: used directly, never applied).
  ctors: Map<string, { id: string; variant: string; singleton: boolean }>;
  funRet: Map<string, AbsType>;           // function binding key -> declared return ub
  // Count of distinct VALUE sources per binding key (a non-UNDEFINED `var` init
  // plus each `:=`). The constructor / funRet tags above are flow-INSENSITIVE,
  // so they are only sound for a binding that takes exactly one value over its
  // lifetime. The letrec desugaring (`var X = UNDEFINED; X := v`) is single-
  // valued; a user `var f` reassigned to a different-typed function is not, and
  // its tags are purged after the collect pass.
  valueSources: Map<string, number>;
  // canonical dataId -> variant name -> the variant's field annotations (in
  // order), from in-module `data` definitions. Used to refine `cases` branch
  // field binds to their declared field types (e.g. node(v,l,r) on a Tree gives
  // v::Number). Sound because constructors check field anns (and ref-field
  // assignment re-checks them), so a matched field always holds its declared
  // type. Imported types aren't here (their data-exprs aren't in this ANF) ->
  // those fields stay Any.
  typeVariants: Map<string, Map<string, A.Ann[]>>;
  // resolution inputs
  typeBindings: Map<string, C.TypeBind>;
  moduleBindings: Map<string, C.ModuleBind>;
  bindings: Map<string, C.ValueBind>;
  compileEnv: C.CompileEnvironment;
  flatnessEnv: FL.FlatnessEnv;
  moduleUri: string;
}

// ---------------------------------------------------------------------------
// Annotation / type resolution (mirrors resolveCasesDataType's name resolution)
// ---------------------------------------------------------------------------
// Canonical id for a *type reference* annotation (a-name / a-dot), or undefined.
function resolveTypeId(ann: A.Ann, ctx: Ctx): string | undefined {
  if (A.isAName(ann)) {
    const tb = ctx.typeBindings.get(ann.id.key());
    if (tb !== undefined) {
      return tb.origin.uriOfDefinition + '#' + tb.origin.originalName.toname();
    }
    const o = ctx.compileEnv.originByTypeName(ann.id.toname());
    if (o !== undefined) {
      return o.uriOfDefinition + '#' + o.originalName.toname();
    }
    return undefined;
  }
  if (A.isADot(ann)) {
    const mb = ctx.moduleBindings.get(ann.obj.key());
    if (mb !== undefined) { return mb.uri + '#' + ann.field; }
    return undefined;
  }
  return undefined;
}

// The AbsType an annotation GUARANTEES after its (passing) check, or undefined
// if the annotation is not one whose check we can soundly elide on a `⊑` proof
// (predicate/refinement, arrow, record, tuple, blank, any, type-var, or an
// unresolvable name). a-app strips parametric args (the layout/brand is
// invariant under instantiation); a-pred is intentionally rejected.
function resolveAnnType(ann: A.Ann, ctx: Ctx): AbsType | undefined {
  let cur: A.Ann = ann;
  while (A.isAApp(cur)) { cur = cur.ann; }
  if (A.isAName(cur)) {
    const name = cur.id.toname();
    if (name === 'Number' || name === 'String' || name === 'Boolean') { return prim(name); }
    const id = resolveTypeId(cur, ctx);
    return id === undefined ? undefined : { k: 'data', id };
  }
  if (A.isADot(cur)) {
    const id = resolveTypeId(cur, ctx);
    return id === undefined ? undefined : { k: 'data', id };
  }
  return undefined;
}

// Canonical type id for a data-expr definition. Resolve its `namet` through the
// same path annotations use so the ids match; fall back to the module uri.
function dataExprId(de: N.ADataExpr, ctx: Ctx): string {
  const tb = ctx.typeBindings.get(de.namet.key());
  if (tb !== undefined) {
    return tb.origin.uriOfDefinition + '#' + tb.origin.originalName.toname();
  }
  return ctx.moduleUri + '#' + de.name;
}

// ---------------------------------------------------------------------------
// Numeric op recognition (a small slice of flatness.ts's numericAppInfo, reused
// here only to learn that an op RESULT is a Number).
// ---------------------------------------------------------------------------
const NUM_ARITH_OPS = new Set(['_plus', '_minus', '_times', '_divide']);
const NUM_RETURNING_BUILTINS = new Set([
  'num-sqrt', 'num-sqr', 'num-abs', 'num-floor', 'num-ceiling', 'num-round',
  'num-round-even', 'num-negate', 'num-min', 'num-max', 'num-modulo',
  'num-truncate', 'num-sin', 'num-cos', 'num-tan', 'num-asin', 'num-acos',
  'num-atan', 'num-atan2', 'num-exp', 'num-log', 'num-expt',
  'num-to-roughnum', 'num-to-rational', 'num-to-fixnum',
]);

function globalOpName(v: N.AVal, ctx: Ctx): string | undefined {
  if (N.isAIdModref(v)) { return v.uri === 'builtin://global' ? v.name : undefined; }
  if (N.isAId(v)) {
    if (A.isSGlobal(v.id)) { return v.id.toname(); }
    const vb = ctx.bindings.get(v.id.key());
    if (vb !== undefined && vb.origin.uriOfDefinition === 'builtin://global') {
      return vb.origin.originalName.toname();
    }
  }
  return undefined;
}

// Calls that never return a value (they throw). A branch ending in one of these
// contributes nothing to a join, so an exhaustive `cases`/`if` whose only
// non-value branch is the compiler-inserted throw still has a precise result
// type. `throwNo{Cases,Branches}Matched` are prim-apps (desugar-post-tc /
// desugar); `raise` is a global value app.
const NEVER_RETURNS_PRIM = new Set(['throwNoCasesMatched', 'throwNoBranchesMatched']);
const NEVER_RETURNS_GLOBAL = new Set(['raise']);

function isNum(v: N.AVal, ctx: Ctx): boolean {
  const t = absOfVal(v, ctx);
  return t.k === 'prim' && t.n === 'Number';
}

// ---------------------------------------------------------------------------
// ub of values and lettables
// ---------------------------------------------------------------------------
function absOfVal(v: N.AVal, ctx: Ctx): AbsType {
  if (N.isANum(v)) { return prim('Number'); }
  if (N.isAStr(v)) { return prim('String'); }
  if (N.isABool(v)) { return prim('Boolean'); }
  if (N.isAId(v) || N.isAIdSafeLetrec(v) || N.isAIdLetrec(v)) {
    const key = v.id.key();
    // A singleton-variant constructor used as a value IS a data value.
    const c = ctx.ctors.get(key);
    if (c !== undefined && c.singleton) { return { k: 'data', id: c.id, variant: c.variant }; }
    return ctx.env.get(key) ?? ANY;
  }
  // a-id-var (reading a mutable var), a-id-var-modref, a-undefined, etc.
  return ANY;
}

// Analyze a lettable: walk any sub-expressions ONCE (seeding params, recording
// redundancies and env entries inside lambda/if/cases bodies) and return the ub
// of its result value. This is the single source of truth for both "what does
// this lettable do" and "what type does it produce".
function absOfLettable(e: N.ALettable, ctx: Ctx): AbsType {
  if (N.isAVal(e)) { return absOfVal(e.v, ctx); }
  if (N.isALam(e) || N.isAMethod(e)) {
    // Seed params from their (post-check) annotations, then analyze the body.
    // The param's OWN check is the seed (untrusted caller -> ub starts at Any),
    // so it is never itself redundant. Functions are analyzed independently; we
    // do not infer across calls (only declared return signatures are trusted).
    for (const arg of e.args) {
      const annT = resolveAnnType(arg.ann, ctx);
      ctx.env.set(arg.id.key(), annT ?? ANY);
    }
    analyzeExpr(e.body, ctx);
    return ANY;                            // the value is a function
  }
  if (N.isAApp(e)) {
    const f = e._fun;
    // Constructor application -> a data value of that variant.
    if (N.isAId(f) || N.isAIdSafeLetrec(f) || N.isAIdLetrec(f)) {
      const c = ctx.ctors.get(f.id.key());
      if (c !== undefined && !c.singleton) { return { k: 'data', id: c.id, variant: c.variant }; }
      // Declared return type of a known function (trusted: the callee re-checks
      // it before returning, the belt-and-suspenders that makes this sound).
      const r = ctx.funRet.get(f.id.key());
      if (r !== undefined) { return r; }
    }
    // Numeric operator / builtin on Number operands returns a Number.
    const name = globalOpName(f, ctx);
    if (name !== undefined) {
      if (NEVER_RETURNS_GLOBAL.has(name)) { return BOT; }
      if (NUM_ARITH_OPS.has(name) && e.args.length === 2 && isNum(e.args[0], ctx) && isNum(e.args[1], ctx)) {
        return prim('Number');
      }
      if (NUM_RETURNING_BUILTINS.has(name) && e.args.length >= 1 && e.args.every((a) => isNum(a, ctx))) {
        return prim('Number');
      }
    }
    return ANY;
  }
  if (N.isAPrimApp(e)) {
    return NEVER_RETURNS_PRIM.has(e.f) ? BOT : ANY;
  }
  if (N.isAIf(e)) {
    return join(analyzeExpr(e.t, ctx), analyzeExpr(e.e, ctx));
  }
  if (N.isACases(e)) {
    // Refine each matched branch's field binds to the variant's declared field
    // types, when the cases type resolves to an in-module data definition.
    const dataT = resolveAnnType(e.typ, ctx);
    const vmap = (dataT !== undefined && dataT.k === 'data')
      ? ctx.typeVariants.get(dataT.id) : undefined;
    let acc: AbsType = BOT;
    for (const b of e.branches) {
      if (vmap !== undefined && N.isACasesBranch(b)) {
        const fieldAnns = vmap.get(b.name);
        if (fieldAnns !== undefined && fieldAnns.length === b.args.length) {
          for (let i = 0; i < b.args.length; i++) {
            ctx.env.set(b.args[i].bind.id.key(), resolveAnnType(fieldAnns[i], ctx) ?? ANY);
          }
        }
      }
      acc = join(acc, analyzeExpr(b.body, ctx));
    }
    acc = join(acc, analyzeExpr(e._else, ctx));
    return acc;
  }
  // Everything else (a-method-app, a-prim-app, a-obj, a-update, a-dot, a-ref,
  // a-tuple, ...) is conservatively Any.
  return ANY;
}

// ---------------------------------------------------------------------------
// Forward pass over the AExpr spine. Mutates ctx.env / ctx.redundant. Returns
// the ub of the expression's tail value (for if/cases joins). The linear spine
// is walked with an explicit loop (one chain node per statement) so very long
// programs don't overflow fixed-size stacks; only genuine nesting recurses.
// ---------------------------------------------------------------------------
function analyzeExpr(exprIn: N.AExpr, ctx: Ctx): AbsType {
  let expr: N.AExpr = exprIn;
  for (;;) {
    switch (expr.$name) {
      case 'a-type-let':
        expr = expr.body;
        continue;
      case 'a-let': {
        bindLet(expr.bind, expr.e, ctx);
        expr = expr.body;
        continue;
      }
      case 'a-arr-let': {
        // Array-destructuring bind: element types aren't tracked, so the bound
        // value is Any and its check is never elided (annT !⊒ Any).
        const annT = resolveAnnType(expr.bind.ann, ctx);
        absOfLettable(expr.e, ctx);          // walk for effects; value discarded
        ctx.env.set(expr.bind.id.key(), annT ?? ANY);
        expr = expr.body;
        continue;
      }
      case 'a-var': {
        // Mutable var: reads are conservatively Any (sound default; matches the
        // numeric pass's var-stability discipline). No check is emitted for vars.
        absOfLettable(expr.e, ctx);          // walk for effects; value discarded
        ctx.env.set(expr.bind.id.key(), ANY);
        expr = expr.body;
        continue;
      }
      case 'a-seq': {
        absOfLettable(expr.e1, ctx);         // walk for effects; value discarded
        expr = expr.e2;
        continue;
      }
      case 'a-lettable':
        return absOfLettable(expr.e, ctx);
      default:
        return ANY;
    }
  }
}

// Bind `x = e` with x's annotation, recording redundancy and x's ub.
function bindLet(bind: N.ABind, e: N.ALettable, ctx: Ctx): void {
  const rhs = absOfLettable(e, ctx);         // single walk: effects + result ub
  const ann = bind.ann;
  const key = bind.id.key();
  if (A.isABlank(ann) || A.isAAny(ann)) {
    ctx.env.set(key, rhs);
    return;
  }
  const annT = resolveAnnType(ann, ctx);
  if (annT !== undefined && subtype(rhs, annT)
      && flatAnn(ann, ctx.flatnessEnv, ctx.moduleBindings, ctx.compileEnv)) {
    // (a) ub ⊑ T proven and (b) T is a flat, non-refinement ann -> dead check.
    ctx.redundant.add(key);
    ctx.env.set(key, rhs);                 // keep the (possibly tighter) rhs
  } else if (annT !== undefined) {
    // Check stays; post-check the value is of T (keep rhs if already tighter).
    ctx.env.set(key, subtype(rhs, annT) ? rhs : annT);
  } else {
    ctx.env.set(key, rhs);                 // unresolvable ann: x still holds e
  }
}

// ---------------------------------------------------------------------------
// Pre-pass: collect constructor bindings and function return types over the
// WHOLE program first, so forward analysis can resolve a constructor / a
// recursive self-call regardless of definition order.
//
// This mirrors flatness.ts's makeExprDataEnv data-tracking, because the data
// definition desugars in a way that is NOT obvious from source: the type and
// its constructors are bound as letrec `var`s initialized to UNDEFINED, then
// the data-expr value is `:=`-assigned to the type var and each
// `DataObj.variant` extraction is let-bound and `:=`-assigned to a constructor
// var. So we must propagate the "is a data object / constructor" tag through
// `a-assign` (and id copies), keyed by the data-expr's let-binding, exactly as
// flatness does.
//
// `dataObjs[k]` = k binds (an alias of) the data OBJECT, with its type id +
// variants. `ctx.ctors[k]` = k binds (an alias of) a specific variant's
// constructor / singleton value.
// ---------------------------------------------------------------------------
type DataObjInfo = { id: string; variants: N.AVariant[] };

function collectDefs(exprIn: N.AExpr, ctx: Ctx, dataObjs: Map<string, DataObjInfo>): void {
  let expr: N.AExpr = exprIn;
  for (;;) {
    switch (expr.$name) {
      case 'a-type-let':
        expr = expr.body;
        continue;
      case 'a-let': {
        collectBind(expr.bind.id.key(), expr.e, ctx, dataObjs);
        expr = expr.body;
        continue;
      }
      case 'a-arr-let':
        collectLettable(expr.e, ctx, dataObjs);
        expr = expr.body;
        continue;
      case 'a-var':
        // The letrec `var` is initialized to UNDEFINED here; the real value
        // arrives via a later a-assign. A non-UNDEFINED init is itself a value
        // source (counts toward single-valued-ness).
        if (!(N.isAVal(expr.e) && N.isAUndefined(expr.e.v))) {
          bumpSource(ctx, expr.bind.id.key());
        }
        collectLettable(expr.e, ctx, dataObjs);
        expr = expr.body;
        continue;
      case 'a-seq':
        collectLettable(expr.e1, ctx, dataObjs);
        expr = expr.e2;
        continue;
      case 'a-lettable':
        collectLettable(expr.e, ctx, dataObjs);
        return;
      default:
        return;
    }
  }
}

// Tag the binding `key = e`.
function collectBind(key: string, e: N.ALettable, ctx: Ctx, dataObjs: Map<string, DataObjInfo>): void {
  if (N.isADataExpr(e)) {
    const id = dataExprId(e, ctx);
    dataObjs.set(key, { id, variants: e.variants });
    // Record each (non-singleton) variant's field annotations for cases-branch
    // field refinement.
    let vmap = ctx.typeVariants.get(id);
    if (vmap === undefined) { vmap = new Map(); ctx.typeVariants.set(id, vmap); }
    for (const v of e.variants) {
      if (N.isAVariant(v)) { vmap.set(v.name, v.members.map((m) => m.bind.ann)); }
    }
  } else if (N.isALam(e) || N.isAMethod(e)) {
    const r = resolveAnnType(e.ret, ctx);
    if (r !== undefined) { ctx.funRet.set(key, r); }
  } else if (N.isADot(e)) {
    // key = DataObj.variantName  (constructor or singleton extraction)
    const obj = e.obj;
    if (N.isAId(obj) || N.isAIdSafeLetrec(obj) || N.isAIdLetrec(obj)) {
      const d = dataObjs.get(obj.id.key());
      if (d !== undefined) {
        const sv = d.variants.find((v) => v.name === e.field);
        if (sv !== undefined) {
          ctx.ctors.set(key, { id: d.id, variant: e.field, singleton: N.isASingletonVariant(sv) });
        }
      }
    }
  } else if (N.isAVal(e)) {
    copyTag(key, e.v, ctx, dataObjs);
  }
  collectLettable(e, ctx, dataObjs);
}

// Propagate data/ctor/funRet tags across an id copy (`key = src`).
function copyTag(key: string, v: N.AVal, ctx: Ctx, dataObjs: Map<string, DataObjInfo>): void {
  if (N.isAId(v) || N.isAIdSafeLetrec(v) || N.isAIdLetrec(v)) {
    const src = v.id.key();
    const d = dataObjs.get(src); if (d !== undefined) { dataObjs.set(key, d); }
    const c = ctx.ctors.get(src); if (c !== undefined) { ctx.ctors.set(key, c); }
    const r = ctx.funRet.get(src); if (r !== undefined) { ctx.funRet.set(key, r); }
  }
}

function bumpSource(ctx: Ctx, key: string): void {
  ctx.valueSources.set(key, (ctx.valueSources.get(key) ?? 0) + 1);
}

function collectLettable(e: N.ALettable, ctx: Ctx, dataObjs: Map<string, DataObjInfo>): void {
  if (N.isAAssign(e)) {
    // var := value : the value carries the tag to the var's binding.
    bumpSource(ctx, e.id.key());
    copyTag(e.id.key(), e.value, ctx, dataObjs);
  } else if (N.isALam(e) || N.isAMethod(e)) {
    collectDefs(e.body, ctx, dataObjs);
  } else if (N.isAIf(e)) {
    collectDefs(e.t, ctx, dataObjs);
    collectDefs(e.e, ctx, dataObjs);
  } else if (N.isACases(e)) {
    for (const b of e.branches) { collectDefs(b.body, ctx, dataObjs); }
    collectDefs(e._else, ctx, dataObjs);
  }
}

// ---------------------------------------------------------------------------
// Entry point. Returns the set of bind keys whose annotation check is provably
// redundant. Threaded into the async compiler like numericFlatApps.
// ---------------------------------------------------------------------------
export function makeProgTypeFlowEnv(
  anfed: N.AProg,
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  flatnessEnv: FL.FlatnessEnv,
  moduleUri: string,
): Set<string> {
  const pe = postEnv as C.ComputedEnv;
  const ctx: Ctx = {
    env: new Map(),
    redundant: new Set(),
    ctors: new Map(),
    funRet: new Map(),
    valueSources: new Map(),
    typeVariants: new Map(),
    typeBindings: pe.typeBindings,
    moduleBindings: pe.moduleBindings,
    bindings: pe.bindings,
    compileEnv: env,
    flatnessEnv,
    moduleUri,
  };
  try {
    collectDefs(anfed.body, ctx, new Map());
    // Drop flow-insensitive tags for any binding that took more than one value
    // over its lifetime (a genuinely reassigned `var`): its return type / ctor
    // identity at a given use site is no longer statically certain.
    for (const [key, n] of ctx.valueSources) {
      if (n > 1) { ctx.funRet.delete(key); ctx.ctors.delete(key); }
    }
    analyzeExpr(anfed.body, ctx);
    if (process.env.PYRET_TF_DEBUG) {
      process.stderr.write(`[type-flow ${moduleUri}] redundant=${ctx.redundant.size} ctors=${ctx.ctors.size} funRet=${ctx.funRet.size}\n`);
    }
  } catch (_e) {
    // The analysis is purely an optimization; a resolution miss or unexpected
    // node must never break compilation. Fail safe to "elide nothing".
    return new Set();
  }
  return ctx.redundant;
}
