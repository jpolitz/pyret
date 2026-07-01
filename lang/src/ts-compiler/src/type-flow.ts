/*
  Upper-bound type flow: a forward abstract interpretation over the ANF that
  computes, per ANF value, the most precise SOUND over-approximation of its
  runtime type (its "upper bound" ub). `ub(x) = τ` means the value held by `x`
  is guaranteed `∈ ⟦τ⟧`; the analysis never excludes a value `x` could hold.
  `Any` (⊤) is the always-sound, useless fallback.

  This is the upper-bound type analysis that REPLACED the old numeric-flatness
  seam in flatness.ts. It has three consumers, all promise-only and all gated by
  the caller on `runtimeAnnotations && userAnnotations`:
    1. `weakenOperators` (below): rewrites polymorphic operator apps (`_plus` ...)
       into monomorphic, known-flat globals (`_plus_nums` ...) where both operands
       are proven Number, so ordinary structural flatness flattens the arithmetic.
    2. `makeProgMethodInfo`: resolves each method call's receiver data type.
    3. `makeProgTypeFlowEnv`: redundant `_checkAnn` elimination (below).
  The cont backend consults none of these, so its codegen and byte-parity oracle
  stay frozen.

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
       flatness verdict provably unchanged. `elidableAnnType` returns `undefined`
       for predicate/arrow/record/tuple anns, and we additionally gate on
       `annFlatness` being flat. (A refinement's BASE type still feeds the ub
       lattice via `annUpperBound` -- a value that passed `Number%(p)` is a
       Number for downstream purposes -- it just can't elide its own check.)

  All of the ub facts ultimately rest on the runtime annotation checks actually
  running (param checks seed types; declared return types are trusted because
  the callee re-checks them). So, like the direct-cases optimization, the whole
  pass is gated on `runtimeAnnotations && userAnnotations` by the caller.
*/

import * as A from './ast';
import * as N from './ast-anf';
import * as C from './compile-structs';
import * as T from './type-structs';
import * as FL from './flatness';
import { InternalCompilerError } from './shared';

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
  // dataId -> variantName -> set of that variant's OWN data-field names. Unlike
  // fieldTypes (the cross-variant intersection), this is per-variant, so when a
  // value's type is known down to its variant (e.g. `self` inside that variant's
  // method) EVERY field of that variant is a safe direct read. Used by
  // tagDirectFields.
  variantFieldNames: Map<string, Map<string, Set<string>>>;
  // dataId -> variantName -> set of method names defined in that variant's `with:`
  // block, and dataId -> set of `sharing:` method names (present on every variant).
  // Used by tagDirectMethods: `obj.m(args)` can dispatch directly when `m` is a
  // shared method, the known variant's own method, or a method every variant has.
  variantMethodNames: Map<string, Map<string, Set<string>>>;
  sharedMethodNames: Map<string, Set<string>>;
  // in-module type aliases: `type X = ann` binding key -> ann. Followed when
  // resolving an annotation so e.g. `type NonZeroNat = Number%(p)` resolves to
  // its base Number for the upper bound (while still never eliding its own
  // refinement check). Cross-module aliases aren't here (a follow-on).
  typeAliases: Map<string, A.Ann>;
  // resolution inputs
  typeBindings: Map<string, C.TypeBind>;
  moduleBindings: Map<string, C.ModuleBind>;
  bindings: Map<string, C.ValueBind>;
  compileEnv: C.CompileEnvironment;
  flatnessEnv: FL.FlatnessEnv;
  moduleUri: string;
  // When false (the receiver-type pre-pass for method flatness, which runs BEFORE
  // the flatness env exists), the redundant-ann-check work in bindLet is skipped
  // (it needs flatnessEnv); only the ub env is computed. When true (the ann-elision
  // consumer, after flatness), the redundancy set is filled.
  collectRedundant: boolean;
  // ----- method-flatness receiver info (filled regardless of collectRedundant) ---
  // For each method-application node, the canonical id of the receiver's data type,
  // when the receiver resolves to a concrete in-module data type (else absent).
  // The flatness pass keys its per-method flatness table on this id.
  methodReceiver: Map<N.AMethodApp, string>;
  // Each `a-method` node that is a member of an in-module data type, mapped to
  // (dataId, methodName). Used by the flatness pass to know which method-table
  // slot a method definition fills, and (here) to seed `self`'s type.
  methodOf: Map<N.AMethod, { dataId: string; methodName: string; variant?: string }>;
  // Transient (collect pass only): method-binding key -> the method node it binds,
  // so a data-expr's withMembers/shared field (an a-id to that binding) resolves
  // back to the method node.
  methodBindNodes: Map<string, N.AMethod>;
  // canonical dataId -> fieldName -> the field's type, for fields declared (with a
  // consistent type) by EVERY non-singleton variant of the data type. A field read
  // `v.field` where ub(v) is that data type therefore yields this type. Sound: the
  // value is some variant, all of which carry the field with this type (constructor
  // and ref-assignment field checks enforce it). Lets `self.x :: Number` reads feed
  // the numeric-flatness pass so a method's arithmetic body can flatten.
  fieldTypes: Map<string, Map<string, AbsType>>;
  // canonical `dataId#methodName` -> the method's DECLARED return-annotation upper
  // bound (joined over variants). Trusted on the same basis as funRet: a method's
  // `-> T` is _checkAnn'd before it returns, so `obj.m()` is a value of T's ub. Lets
  // e.g. `self.length() - 1` weaken (length returns Number) so a method using a
  // sibling's numeric result still flattens.
  methodRet: Map<string, AbsType>;
  // ----- nested-var upper-bound inference (local-var ub fixpoint) ----------------
  // Bind keys of mutable `var`s declared inside SOME function body (lambda/method),
  // i.e. lexical depth > 0. Only these get a non-Any ub: a top-level var is REPL-
  // mutable (open world -> its assignments aren't all visible), so it must stay Any; a
  // nested var's declaration AND every `:=` are lexically within a body we fully
  // analyze, so the join over its value sources is a sound flow-INSENSITIVE bound that
  // holds at every read.
  eligibleVars: Set<string>;
  // Converged upper bound for each eligible var = join over its value sources (init +
  // every assigned value), to a fixpoint (reads of a var consult this map, so a self-
  // referential `j := j + 1` resolves). A var read yields this ub (Any if absent). This
  // generalizes the old Any-always var rule to ANY type: a counter weakens its `+` to
  // `_plus_nums`, a string accumulator's to `_plus_strings`, etc.
  varUb: Map<string, AbsType>;
  // True only during the seed pass: a var's declaration writes varUb(v) = ub(init) so
  // the first real fixpoint pass has a starting type for self-references.
  seedingVarUb: boolean;
  // Non-null only during the fixpoint passes: var key -> joined ub of its value sources
  // observed this pass (init + each `:=` value). Becomes the var's next varUb.
  varSourceAccum: Map<string, AbsType> | null;
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

// Resolve an annotation's head type. `unwrapPred` controls the one place the two
// roles of this resolution diverge (see the two wrappers below): a-app always
// strips parametric args (layout/brand is invariant under instantiation); a-pred
// (a refinement `T%(p)`) is stripped to its base T only for the upper-bound role.
function resolveHead(ann: A.Ann, ctx: Ctx, unwrapPred: boolean, seen?: Set<string>): AbsType | undefined {
  let cur: A.Ann = ann;
  while (A.isAApp(cur) || (unwrapPred && A.isAPred(cur))) { cur = cur.ann; }
  if (A.isAName(cur)) {
    const name = cur.id.toname();
    if (name === 'Number' || name === 'String' || name === 'Boolean') { return prim(name); }
    // Follow an in-module type alias to its definition (e.g.
    // `type NonZeroNat = Number%(p)` -> resolve `Number%(p)`). The unwrapPred
    // flag carries through, so the alias is a refinement for elidability (stays
    // unresolved -> not elided) but its base feeds the upper bound.
    const key = cur.id.key();
    const alias = ctx.typeAliases.get(key);
    if (alias !== undefined) {
      const s = seen ?? new Set<string>();
      if (s.has(key)) { return undefined; }   // alias cycle -> give up
      s.add(key);
      return resolveHead(alias, ctx, unwrapPred, s);
    }
    const id = resolveTypeId(cur, ctx);
    return id === undefined ? undefined : { k: 'data', id };
  }
  if (A.isADot(cur)) {
    const id = resolveTypeId(cur, ctx);
    return id === undefined ? undefined : { k: 'data', id };
  }
  return undefined;
}

// The AbsType to use when DECIDING whether the annotation's own runtime check is
// redundant. A refinement `T%(p)` is rejected (undefined): even if the value is
// `⊑ T`, the predicate `p` is user code that can still raise, so its check is
// never redundant. arrow/record/tuple/blank/any/type-var/unresolvable -> undefined.
function elidableAnnType(ann: A.Ann, ctx: Ctx): AbsType | undefined {
  return resolveHead(ann, ctx, false);
}

// The sound upper bound an annotation GUARANTEES about the value AFTER a passing
// check, for seeding/propagating ub downstream. Here a refinement contributes its
// BASE type -- a value that passed `Number%(is-nonzero)` is still a Number -- so
// `T%(p)` -> T. This never elides a check on its own; it only makes downstream
// uses of the value more precise (e.g. enabling a later `:: Number` to elide).
function annUpperBound(ann: A.Ann, ctx: Ctx): AbsType | undefined {
  return resolveHead(ann, ctx, true);
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
// Result-type recognition for global calls.
//
// `_plus`/`_minus`/`_times`/`_divide` are POLYMORPHIC dispatchers (declared
// `-> Any`): their result is a Number only when BOTH operands are -- a fact the
// declared signature can't express, so they need the operand-typed rule in
// `analyzeExpr` below. (`_plus` additionally yields a String on two Strings --
// the only string-typed arithmetic operator.) Every OTHER global's result type
// is just its declared return type, read from global.js via `globalDeclaredRet`;
// no hardcoded name lists. That subsumes the former NUM_RETURNING_*/
// STRING_RETURNING_GLOBALS/NEVER_RETURNS_GLOBAL tables and generalizes past them
// for free (e.g. `string-append -> String`, `num-random -> Number`,
// `raise -> Bot` all fall out without being enumerated).
// ---------------------------------------------------------------------------
const NUM_ARITH_OPS = new Set(['_plus', '_minus', '_times', '_divide']);

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

// The declared result type of a global call, read straight from global.js (via
// the compile env). A global declared `... -> τ` yields a value `∈ ⟦τ⟧` WHENEVER
// it returns: were it to produce some other shape it would raise instead, and a
// raise yields no value, so the bound holds vacuously. Trusting the declared
// return type is therefore a sound upper bound regardless of the argument types
// -- the same belt-and-suspenders that lets `analyzeExpr` trust user functions'
// declared returns (`funRet`). `raise`'s declared `-> tbot` gives BOT for free,
// so a branch ending in `raise` still joins to a precise result type. Only
// Number/String are surfaced (the lattice's only prims that consumers act on);
// other returns widen to Any. Replaces the hardcoded NUM_RETURNING_*/
// STRING_RETURNING_GLOBALS/NEVER_RETURNS_GLOBAL sets.
function globalDeclaredRet(name: string, ctx: Ctx): AbsType | undefined {
  const ve = ctx.compileEnv.globalValue(name);
  // VAlias carries no type; VFun/VJustType/VVar all expose the declared `.t`.
  if (ve === undefined || (!C.isVFun(ve) && !C.isVJustType(ve) && !C.isVVar(ve))) {
    return undefined;
  }
  let t: T.Type = ve.t;
  while (T.isTForall(t)) { t = t.onto; }
  if (!T.isTArrow(t)) { return undefined; }
  const r = t.ret;
  if (T.isTBot(r)) { return BOT; }
  if (T.isTName(r)) {
    const n = r.id.toname();
    if (n === 'Number' || n === 'String') { return prim(n); }
  }
  return undefined;
}

// Prim-apps that never return a value (they throw). A branch ending in one of
// these contributes nothing to a join, so an exhaustive `cases`/`if` whose only
// non-value branch is the compiler-inserted throw still has a precise result
// type. `throwNo{Cases,Branches}Matched` are prim-apps (desugar-post-tc /
// desugar); the global `raise` is handled by `globalDeclaredRet` (`-> tbot`).
const NEVER_RETURNS_PRIM = new Set(['throwNoCasesMatched', 'throwNoBranchesMatched']);

function isNum(v: N.AVal, ctx: Ctx): boolean {
  const t = absOfVal(v, ctx);
  return t.k === 'prim' && t.n === 'Number';
}

function isStr(v: N.AVal, ctx: Ctx): boolean {
  const t = absOfVal(v, ctx);
  return t.k === 'prim' && t.n === 'String';
}

function absTypeEq(a: AbsType, b: AbsType): boolean {
  if (a.k !== b.k) { return false; }
  if (a.k === 'prim' && b.k === 'prim') { return a.n === b.n; }
  if (a.k === 'data' && b.k === 'data') { return a.id === b.id && a.variant === b.variant; }
  return a.k === b.k;   // any/bot
}

// Set ub(key) = t. Used for every value-binding env write.
function recordUb(ctx: Ctx, key: string, t: AbsType): void {
  ctx.env.set(key, t);
}

// During a numericVars fixpoint pass, fold one of var `key`'s value sources (its init
// or an assigned value) into the per-pass accumulator. No-op outside the fixpoint
// (varSourceAccum null) or for a non-eligible var (top-level / not a nested var).
function contributeVarSource(ctx: Ctx, key: string, t: AbsType): void {
  if (ctx.varSourceAccum === null || !ctx.eligibleVars.has(key)) { return; }
  const prev = ctx.varSourceAccum.get(key);
  ctx.varSourceAccum.set(key, prev === undefined ? t : join(prev, t));
}

// Resolve `v.field` when v's ub is a known in-module data type carrying the field.
function fieldTypeOf(obj: AbsType, field: string, ctx: Ctx): AbsType | undefined {
  if (obj.k !== 'data') { return undefined; }
  return ctx.fieldTypes.get(obj.id)?.get(field);
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
  // Reading a mutable var yields its converged upper bound (Any for a top-level /
  // un-inferred var). This is the sole consumer of the nested-var ub fixpoint.
  if (N.isAIdVar(e)) {
    return ctx.varUb.get(e.id.key()) ?? ANY;
  }
  // `var := value`: the assigned value is one of the var's sources -- fold its ub into
  // the fixpoint accumulator (no-op outside the fixpoint passes).
  if (N.isAAssign(e)) {
    contributeVarSource(ctx, e.id.key(), absOfVal(e.value, ctx));
    return ANY;                            // the assignment expression itself is not a value we track
  }
  if (N.isALam(e) || N.isAMethod(e)) {
    // Seed params from their (post-check) annotations, then analyze the body.
    // The param's OWN check is the seed (untrusted caller -> ub starts at Any),
    // so it is never itself redundant. Functions are analyzed independently; we
    // do not infer across calls (only declared return signatures are trusted).
    for (const arg of e.args) {
      const annT = annUpperBound(arg.ann, ctx);
      recordUb(ctx, arg.id.key(), annT ?? ANY);
    }
    // Inside a data type's method, `self` (the first param, conventionally
    // unannotated) is a value of that data type. Seeding it lets method calls on
    // `self` (e.g. a method that calls a sibling method) resolve their receiver.
    // Sound: the runtime dispatches a method only on a genuine value of its type.
    if (N.isAMethod(e) && e.args.length > 0) {
      const mi = ctx.methodOf.get(e);
      if (mi !== undefined) { recordUb(ctx, e.args[0].id.key(), { k: 'data', id: mi.dataId, variant: mi.variant }); }
    }
    analyzeExpr(e.body, ctx);
    return ANY;                            // the value is a function
  }
  if (N.isAMethodApp(e)) {
    // Record the receiver's data type (if resolvable) for the flatness pass, and
    // use the method's declared return-ann ub as the call's result type (trusted:
    // the method _checkAnn's its return value). Lets `obj.m() <op> ...` chains weaken.
    const ot = absOfVal(e.obj, ctx);
    if (ot.k === 'data') {
      ctx.methodReceiver.set(e, ot.id);
      const r = ctx.methodRet.get(ot.id + '#' + e.meth);
      if (r !== undefined) { return r; }
    }
    return ANY;
  }
  if (N.isADot(e)) {
    // Field read on a known data type -> the field's declared type.
    return fieldTypeOf(absOfVal(e.obj, ctx), e.field, ctx) ?? ANY;
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
    const name = globalOpName(f, ctx);
    if (name !== undefined) {
      // Polymorphic arithmetic dispatchers (declared `-> Any`): the result type is
      // determined by the LEFT operand, because `_plus`/`_minus`/`_times`/`_divide`
      // dispatch on it. A Number LHS takes the numeric branch when the RHS is also a
      // Number and otherwise RAISES (a Number is not an object carrying a user `_plus`,
      // and `_plus`'s string branch needs a String LHS) -- so the result is
      // Number-or-raises => sound ub Number, REGARDLESS of the RHS. (`random(x) + e` is
      // Number even when `e` is untyped.) `_plus` with a String LHS is concat-or-raises
      // => String. The RHS alone proves nothing: a non-prim LHS may dispatch to a user
      // `_plus` returning anything. This must precede the declared-return fallback.
      if (NUM_ARITH_OPS.has(name) && e.args.length === 2 && isNum(e.args[0], ctx)) {
        return prim('Number');
      }
      if (name === '_plus' && e.args.length === 2 && isStr(e.args[0], ctx)) {
        return prim('String');
      }
      // Everything else (`_plus_nums`, `num-*`, `string-*`, `tostring`, `raise`,
      // ...): trust the global's declared return type from global.js.
      const r = globalDeclaredRet(name, ctx);
      if (r !== undefined) { return r; }
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
    const dataT = annUpperBound(e.typ, ctx);
    const vmap = (dataT !== undefined && dataT.k === 'data')
      ? ctx.typeVariants.get(dataT.id) : undefined;
    let acc: AbsType = BOT;
    for (const b of e.branches) {
      if (vmap !== undefined && N.isACasesBranch(b)) {
        const fieldAnns = vmap.get(b.name);
        if (fieldAnns !== undefined && fieldAnns.length === b.args.length) {
          for (let i = 0; i < b.args.length; i++) {
            recordUb(ctx, b.args[i].bind.id.key(), annUpperBound(fieldAnns[i], ctx) ?? ANY);
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
        const annT = annUpperBound(expr.bind.ann, ctx);
        absOfLettable(expr.e, ctx);          // walk for effects; value discarded
        recordUb(ctx, expr.bind.id.key(), annT ?? ANY);
        expr = expr.body;
        continue;
      }
      case 'a-var': {
        // Mutable var: the INIT is a value source. During the seed pass it sets the
        // var's starting ub; during fixpoint passes it joins into the accumulator.
        // Reads are handled in absOfLettable's a-id-var case; the env entry is unused.
        const key = expr.bind.id.key();
        const initT = absOfLettable(expr.e, ctx);   // single walk: effects + init ub
        if (ctx.seedingVarUb && ctx.eligibleVars.has(key)) { ctx.varUb.set(key, initT); }
        contributeVarSource(ctx, key, initT);
        ctx.env.set(key, ANY);
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
    recordUb(ctx, key, rhs);
    return;
  }
  const elideT = elidableAnnType(ann, ctx);   // refinement -> undefined (never elide)
  const ubT = annUpperBound(ann, ctx);         // refinement -> base type (for ub)
  if (ctx.collectRedundant && elideT !== undefined && subtype(rhs, elideT)
      && flatAnn(ann, ctx.flatnessEnv, ctx.moduleBindings, ctx.compileEnv)) {
    // (a) ub ⊑ T proven and (b) T is a flat, non-refinement ann -> dead check.
    ctx.redundant.add(key);
    recordUb(ctx, key, rhs);               // keep the (possibly tighter) rhs
  } else if (ubT !== undefined) {
    // Check stays; post-check the value is at least ubT (a refinement's base),
    // and still holds e's value -- keep rhs if it is already tighter.
    recordUb(ctx, key, subtype(rhs, ubT) ? rhs : ubT);
  } else {
    recordUb(ctx, key, rhs);               // unresolvable ann: x still holds e
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
        // Record `type X = ann` aliases so resolveHead can follow them. The
        // a-type-let wraps its body, so the alias is recorded before any use.
        if (N.isATypeBind(expr.bind)) { ctx.typeAliases.set(expr.bind.name.key(), expr.bind.ann); }
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
    let fnmap = ctx.variantFieldNames.get(id);
    if (fnmap === undefined) { fnmap = new Map(); ctx.variantFieldNames.set(id, fnmap); }
    let vmeth = ctx.variantMethodNames.get(id);
    if (vmeth === undefined) { vmeth = new Map(); ctx.variantMethodNames.set(id, vmeth); }
    let smeth = ctx.sharedMethodNames.get(id);
    if (smeth === undefined) { smeth = new Set(); ctx.sharedMethodNames.set(id, smeth); }
    // Initialize an (empty) method-name set per variant; recordMember below fills
    // them with ONLY genuine methods. A with:/sharing: member can hold a plain
    // FUNCTION (its value is an a-lam, not an a-method) -- `obj.dict[name]` is then
    // a PFunction (.app), NOT a PMethod (.full_meth) -- so recording every member
    // name blindly would mis-dispatch it via .full_meth. recordMember resolves the
    // method bind node, so only true methods land in these sets.
    for (const v of e.variants) {
      if (N.isAVariant(v)) {
        vmap.set(v.name, v.members.map((m) => m.bind.ann));
        fnmap.set(v.name, new Set(v.members.map((m) => m.bind.id.toname())));
      } else {
        // singleton variant: no fields
        fnmap.set(v.name, new Set());
      }
      if (!vmeth.has(v.name)) { vmeth.set(v.name, new Set()); }
    }
    // Associate each method member (a withMembers field on a variant, or a
    // data-level shared field, whose value is an a-id to the method's let-binding)
    // with (dataId, methodName), so the flatness pass can place its flatness. The
    // method bindings precede the data-expr in the ANF spine, so methodBindNodes is
    // already populated.
    const recordMember = (fieldName: string, val: N.AVal, variant?: string): void => {
      if (N.isAId(val) || N.isAIdSafeLetrec(val) || N.isAIdLetrec(val)) {
        const node = ctx.methodBindNodes.get(val.id.key());
        if (node !== undefined) {
          ctx.methodOf.set(node, { dataId: id, methodName: fieldName, variant });
          // Genuine method (its value is an a-method) -> safe for direct dispatch.
          if (variant !== undefined) { ctx.variantMethodNames.get(id)?.get(variant)?.add(fieldName); }
          else { ctx.sharedMethodNames.get(id)?.add(fieldName); }
          // Record the method's declared return-ann ub (joined over variants).
          const rt = annUpperBound(node.ret, ctx);
          if (rt !== undefined) {
            const rk = id + '#' + fieldName;
            const prev = ctx.methodRet.get(rk);
            ctx.methodRet.set(rk, prev === undefined ? rt : join(prev, rt));
          }
        }
      }
    };
    // A variant's own `with:` method runs only on that variant, so `self` is that
    // exact variant (record it). A `sharing:` method runs on any variant -> no
    // single variant.
    for (const v of e.variants) {
      for (const wm of v.withMembers) { recordMember(wm.name, wm.value, v.name); }
    }
    for (const sh of e.shared) { recordMember(sh.name, sh.value); }
    // Field types: a field read on a value of this data type is sound only when
    // the field is present (with a consistent type) on EVERY variant. Intersect
    // across variants. (Singleton variants have no fields -> any field present on
    // them is none, so a type with a singleton variant contributes no safe fields.)
    let common: Map<string, AbsType> | undefined;
    for (const v of e.variants) {
      const here = new Map<string, AbsType>();
      if (N.isAVariant(v)) {
        for (const m of v.members) {
          const ft = annUpperBound(m.bind.ann, ctx);
          if (ft !== undefined) { here.set(m.bind.id.toname(), ft); }
        }
      }
      if (common === undefined) { common = here; }
      else {
        for (const [fn, ft] of [...common]) {
          const o = here.get(fn);
          if (o === undefined || !absTypeEq(o, ft)) { common.delete(fn); }
        }
      }
    }
    if (common !== undefined && common.size > 0) { ctx.fieldTypes.set(id, common); }
  } else if (N.isALam(e) || N.isAMethod(e)) {
    if (N.isAMethod(e)) { ctx.methodBindNodes.set(key, e); }
    const r = annUpperBound(e.ret, ctx);
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

// Collect bind keys of mutable `var`s declared at lexical depth > 0 (inside some
// lambda/method body) -- the only vars eligible for a non-Any upper bound. `depth` is
// function-nesting depth: if/cases branches keep the same depth (they are not new
// scopes for this purpose), only entering a lam/method body increments it. Mirrors the
// recursion shape of collectLettable.
function collectEligibleVars(exprIn: N.AExpr, ctx: Ctx, depth: number): void {
  let expr: N.AExpr = exprIn;
  for (;;) {
    switch (expr.$name) {
      case 'a-type-let': expr = expr.body; continue;
      case 'a-let': collectEVLettable(expr.e, ctx, depth); expr = expr.body; continue;
      case 'a-arr-let': collectEVLettable(expr.e, ctx, depth); expr = expr.body; continue;
      case 'a-var':
        if (depth > 0) { ctx.eligibleVars.add(expr.bind.id.key()); }
        collectEVLettable(expr.e, ctx, depth);
        expr = expr.body;
        continue;
      case 'a-seq': collectEVLettable(expr.e1, ctx, depth); expr = expr.e2; continue;
      case 'a-lettable': collectEVLettable(expr.e, ctx, depth); return;
      default: return;
    }
  }
}

function collectEVLettable(e: N.ALettable, ctx: Ctx, depth: number): void {
  if (N.isALam(e) || N.isAMethod(e)) { collectEligibleVars(e.body, ctx, depth + 1); }
  else if (N.isAIf(e)) { collectEligibleVars(e.t, ctx, depth); collectEligibleVars(e.e, ctx, depth); }
  else if (N.isACases(e)) {
    for (const b of e.branches) { collectEligibleVars(b.body, ctx, depth); }
    collectEligibleVars(e._else, ctx, depth);
  }
}

// Receiver info the flatness pass consumes for method-call flatness.
export interface MethodInfo {
  // method-application node -> canonical id of its receiver's data type.
  receiver: Map<N.AMethodApp, string>;
  // a-method node -> the (dataId, methodName) slot it fills.
  methodOf: Map<N.AMethod, { dataId: string; methodName: string; variant?: string }>;
}

function newCtx(
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  flatnessEnv: FL.FlatnessEnv,
  moduleUri: string,
  collectRedundant: boolean,
): Ctx {
  const pe = postEnv as C.ComputedEnv;
  return {
    env: new Map(),
    redundant: new Set(),
    ctors: new Map(),
    funRet: new Map(),
    valueSources: new Map(),
    typeVariants: new Map(),
    variantFieldNames: new Map(),
    variantMethodNames: new Map(),
    sharedMethodNames: new Map(),
    typeAliases: new Map(),
    typeBindings: pe.typeBindings,
    moduleBindings: pe.moduleBindings,
    bindings: pe.bindings,
    compileEnv: env,
    flatnessEnv,
    moduleUri,
    collectRedundant,
    methodReceiver: new Map(),
    methodOf: new Map(),
    methodBindNodes: new Map(),
    fieldTypes: new Map(),
    methodRet: new Map(),
    eligibleVars: new Set(),
    varUb: new Map(),
    seedingVarUb: false,
    varSourceAccum: null,
  };
}

// The shared two-phase walk: collect data/ctor/method defs over the whole
// program, drop flow-insensitive tags for genuinely-reassigned vars, then run
// the forward abstract interpretation. Mutates ctx.
function runTypeFlow(anfed: N.AProg, ctx: Ctx): void {
  collectDefs(anfed.body, ctx, new Map());
  // Drop flow-insensitive tags for any binding that took more than one value
  // over its lifetime (a genuinely reassigned `var`): its return type / ctor
  // identity at a given use site is no longer statically certain.
  for (const [key, n] of ctx.valueSources) {
    if (n > 1) { ctx.funRet.delete(key); ctx.ctors.delete(key); }
  }
  // Nested-var upper-bound fixpoint: compute ub(v) = join over each var's value
  // sources (init + assignments), with var reads consulting the in-progress ub so a
  // self-referential `j := j + 1` resolves. Ascending Kleene iteration from a seed of
  // each var's init type; F is monotone over the shallow AbsType lattice, so it
  // converges (capped for safety -> fall back to all-Any, still sound).
  collectEligibleVars(anfed.body, ctx, 0);
  if (ctx.eligibleVars.size > 0) {
    const savedCR = ctx.collectRedundant;
    ctx.collectRedundant = false;          // suppress ann-elision work mid-fixpoint
    ctx.seedingVarUb = true;
    ctx.env = new Map();
    analyzeExpr(anfed.body, ctx);          // seed varUb(v) = ub(init_v)
    ctx.seedingVarUb = false;
    const CAP = 12;
    for (let iter = 0; ; iter++) {
      ctx.varSourceAccum = new Map();
      ctx.env = new Map();
      analyzeExpr(anfed.body, ctx);
      let changed = false;
      for (const k of ctx.eligibleVars) {
        const next = ctx.varSourceAccum.get(k) ?? ANY;
        if (!absTypeEq(next, ctx.varUb.get(k) ?? ANY)) { ctx.varUb.set(k, next); changed = true; }
      }
      if (!changed) { break; }
      if (iter >= CAP) {                    // non-convergence guard: widen all to Any
        for (const k of ctx.eligibleVars) { ctx.varUb.set(k, ANY); }
        break;
      }
    }
    ctx.varSourceAccum = null;
    ctx.collectRedundant = savedCR;
  }
  // Final pass: redundant-ann-check + method-receiver info, with converged varUb.
  // All three outputs are rebuilt fresh here so any spurious entry recorded under an
  // optimistic (pre-convergence) varUb during the seed/fixpoint passes is discarded --
  // a var that widened data->Any across iterations could otherwise leave a stale
  // method-receiver behind.
  ctx.env = new Map();
  ctx.redundant = new Set();
  ctx.methodReceiver = new Map();
  analyzeExpr(anfed.body, ctx);
}

// ---------------------------------------------------------------------------
// Entry point. Returns the set of bind keys whose annotation check is provably
// redundant. Threaded into the async compiler as redundantAnnChecks.
// ---------------------------------------------------------------------------
export function makeProgTypeFlowEnv(
  anfed: N.AProg,
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  flatnessEnv: FL.FlatnessEnv,
  moduleUri: string,
): Set<string> {
  const ctx = newCtx(postEnv, env, flatnessEnv, moduleUri, true);
  try {
    runTypeFlow(anfed, ctx);
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

// ---------------------------------------------------------------------------
// Receiver-type pre-pass for method flatness. Runs BEFORE the flatness env is
// built (it needs no flatness), so the flatness pass can resolve each method
// call's receiver data type and analyze that type's methods. Same forward
// abstract interpretation as above, minus the redundant-ann-check work.
// ---------------------------------------------------------------------------
export function makeProgMethodInfo(
  anfed: N.AProg,
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  moduleUri: string,
): MethodInfo {
  // flatnessEnv is unused when collectRedundant is false; pass an empty one.
  const dummyFlat: FL.FlatnessEnv = [new Map(), new Map(), new Set(), new Set(), new Map()];
  const ctx = newCtx(postEnv, env, dummyFlat, moduleUri, false);
  try {
    runTypeFlow(anfed, ctx);
    if (process.env.PYRET_TF_DEBUG) {
      process.stderr.write(`[type-flow ${moduleUri}] methodReceiver=${ctx.methodReceiver.size} methodOf=${ctx.methodOf.size}\n`);
    }
  } catch (_e) {
    // Fail safe to "no method info" (no method calls get flattened).
    return { receiver: new Map(), methodOf: new Map() };
  }
  return { receiver: ctx.methodReceiver, methodOf: ctx.methodOf };
}

// ---------------------------------------------------------------------------
// Typed operator weakening (ANF -> ANF; promise backend only).
//
// `a + b` lowers to a call of the POLYMORPHIC global `_plus`, which dispatches on
// operand type (numeric tower / string concat / a user `_plus` method -- arbitrary,
// possibly suspending code), so `_plus` has UNDEFINED flatness and the enclosing
// arithmetic compiles to an async function. But when this analysis proves both
// operands are Number, the dispatch ALWAYS takes the numeric-tower branch, so the
// call is statically a MONOMORPHIC, non-dispatching, known-flat `_plus_nums` -- the
// same numeric fast path exposed under a name and registered flat (0) in the global
// env (global.js). Rewriting `_plus` -> `_plus_nums` lets ORDINARY structural
// function-flatness pick it up with NO numeric special-casing in flatness.ts, and
// skips `_plus`'s per-call `isNumber` re-check at runtime.
//
// Soundness rests entirely on this upper-bound analysis (same basis as ann
// elision); the caller gates on `runtimeAnnotations && userAnnotations`, promise
// only. The rewrite ONLY rebuilds operator a-app nodes' callee; the method-info
// receiver pre-pass runs AFTER this on the weakened ANF, so method-app node
// identity is never stale.
// ---------------------------------------------------------------------------
// Binary operators that monomorphize on Number operands.
const WEAKEN_NUM_OPS: Map<string, string> = new Map([
  ['_plus', '_plus_nums'], ['_minus', '_minus_nums'],
  ['_times', '_times_nums'], ['_divide', '_divide_nums'],
  ['_lessthan', '_lessthan_nums'], ['_greaterthan', '_greaterthan_nums'],
  ['_lessequal', '_lessequal_nums'], ['_greaterequal', '_greaterequal_nums'],
]);
// Binary operators that monomorphize on String operands (`_plus` = concat; the
// comparisons are lexicographic). `_minus`/`_times`/`_divide` have no String path.
const WEAKEN_STR_OPS: Map<string, string> = new Map([
  ['_plus', '_plus_strings'],
  ['_lessthan', '_lessthan_strings'], ['_greaterthan', '_greaterthan_strings'],
  ['_lessequal', '_lessequal_strings'], ['_greaterequal', '_greaterequal_strings'],
]);
// Equality that monomorphizes when BOTH operands are primitives (ANY prim, not
// necessarily the same: `5 == "x"` is a flat NotEqual). Two primitives can't carry a
// user `_equals`, so `equal-always` cannot dispatch or suspend. `<>` is `not(==)`, so
// weakening the inner `equal-always` flattens it too.
const WEAKEN_EQ_OPS: Map<string, string> = new Map([
  ['equal-always', 'equal-always-prim'],
]);
// Unary tostring/torepr: pick the monomorphic flat helper by the operand's prim
// type (no user `_output`/`_torepr` dispatch possible on a primitive).
const WEAKEN_TOSTRING_OPS: Map<string, { Number: string; String: string; Boolean: string }> = new Map([
  ['tostring', { Number: 'tostring_num', String: 'tostring_str', Boolean: 'tostring_bool' }],
  ['torepr', { Number: 'torepr_num', String: 'torepr_str', Boolean: 'torepr_bool' }],
]);
// Unary globals that monomorphize with NO operand-type condition: they never
// dispatch and never suspend regardless of argument. `raise` always constructs
// and throws a PyretFailException synchronously, so its only-suspending-looking
// status was purely a conservative flatness default -- exposing it flat lets a
// branch whose sole work is `raise(msg)` (a bounds/guard error path) stay flat.
const WEAKEN_UNARY_OPS: Map<string, string> = new Map([
  ['raise', 'raise_flat'],
]);

// Both ends of every weakening entry are hand-written names that must line up
// with global.js, and a mismatch on EITHER end fails silently:
//   - a typo'd SOURCE (the polymorphic LHS we match on) simply never matches, so
//     that rewrite quietly stops firing -- a performance regression with no error
//     and nothing to grep for;
//   - a missing / mistyped / non-flat TARGET (the monomorphic RHS) makes the
//     "weakened" call resolve non-flat (or fail name resolution), defeating the
//     optimization (or worse) just as quietly.
// The target is also a multi-file surface: its name + arrow type + `flatness: 0`
// live in global.js, it is registered in compile-structs' runtimeProvides, and
// implemented in runtime.js / runtime-async.js.
//
// This tripwire pins that contract: every SOURCE must resolve as a global (it
// need not be flat -- sources are exactly the suspending dispatchers we are
// specializing away), and every TARGET must resolve as a `VFun` with flatness 0.
// It runs once per process (the global env is fixed -- global.js) and, crucially,
// is invoked OUTSIDE `weakenOperators`' fail-safe try below, so a broken table
// fails LOUDLY in any compile (hence any parity/exec test) rather than silently.
let weakenTableChecked = false;
function assertWeakenTableResolves(env: C.CompileEnvironment): void {
  if (weakenTableChecked) { return; }
  weakenTableChecked = true;
  // Sources: just need to exist as globals (a typo here silently disables the
  // rewrite). NUM_ARITH_OPS / the `_plus`-string rule reuse these same names.
  const sources = new Set<string>([
    ...WEAKEN_NUM_OPS.keys(),
    ...WEAKEN_STR_OPS.keys(),
    ...WEAKEN_EQ_OPS.keys(),
    ...WEAKEN_TOSTRING_OPS.keys(),
    ...WEAKEN_UNARY_OPS.keys(),
  ]);
  for (const s of sources) {
    if (env.globalValue(s) === undefined) {
      throw new InternalCompilerError(
        `operator-weakening source '${s}' is not a global in global.js: the weakening `
        + `table in type-flow.ts names an operator that doesn't exist (a typo here `
        + `silently disables that rewrite).`);
    }
  }
  // Targets: must resolve as flat (flatness 0) globals or the rewritten call is
  // no better (or breaks).
  const targets: string[] = [
    ...WEAKEN_NUM_OPS.values(),
    ...WEAKEN_STR_OPS.values(),
    ...WEAKEN_EQ_OPS.values(),
    ...WEAKEN_UNARY_OPS.values(),
    ...[...WEAKEN_TOSTRING_OPS.values()].flatMap((v) => [v.Number, v.String, v.Boolean]),
  ];
  for (const t of targets) {
    const ve = env.globalValue(t);
    if (ve === undefined || !C.isVFun(ve) || ve.flatness !== 0) {
      const got = ve === undefined ? 'missing from the global env'
        : !C.isVFun(ve) ? `a ${ve.$name}, not a function`
        : `a function with flatness ${ve.flatness} (expected 0)`;
      throw new InternalCompilerError(
        `operator-weakening target '${t}' is ${got}: every WEAKEN_* target must be `
        + `a flat (flatness 0) global declared in global.js. The weakening table in `
        + `type-flow.ts and global.js have drifted out of sync.`);
    }
  }
}

// The prim type of a value's ub, or undefined if not a primitive.
function primNameOf(v: N.AVal, ctx: Ctx): 'Number' | 'String' | 'Boolean' | undefined {
  const t = absOfVal(v, ctx);
  return t.k === 'prim' ? t.n : undefined;
}

class WeakenVisitor extends N.DefaultMapVisitor {
  constructor(private ctx: Ctx, private count: { n: number }) { super(); }
  aApp(node: N.AApp): N.ALettable {
    const name = globalOpName(node._fun, this.ctx);
    if (name !== undefined) {
      // Binary numeric / string operator on two same-prim operands.
      if (node.args.length === 2) {
        const p0 = primNameOf(node.args[0], this.ctx);
        const p1 = primNameOf(node.args[1], this.ctx);
        let weak: string | undefined;
        if (p0 === 'Number' && p1 === 'Number') { weak = WEAKEN_NUM_OPS.get(name); }
        else if (p0 === 'String' && p1 === 'String') { weak = WEAKEN_STR_OPS.get(name); }
        // Equality: any two primitives (need not match) -> the flat prim equality.
        if (weak === undefined && p0 !== undefined && p1 !== undefined) {
          weak = WEAKEN_EQ_OPS.get(name);
        }
        if (weak !== undefined) { return this.weakenTo(node, weak); }
      }
      // Unary globals.
      if (node.args.length === 1) {
        // Unconditional (no operand-type guard): e.g. raise.
        const uncond = WEAKEN_UNARY_OPS.get(name);
        if (uncond !== undefined) { return this.weakenTo(node, uncond); }
        // tostring/torepr on a primitive operand.
        const variants = WEAKEN_TOSTRING_OPS.get(name);
        if (variants !== undefined) {
          const p = primNameOf(node.args[0], this.ctx);
          if (p !== undefined) { return this.weakenTo(node, variants[p]); }
        }
      }
    }
    return super.aApp(node);
  }
  // An s-global reference rides the ordinary global-value rails: it is a free var,
  // so compile-module emits `var <name> = getModuleField('builtin://global',
  // 'values','<name>')`, and flatness resolves its (flat) flatness from the global
  // env. Args are leaf values -- left unchanged.
  private weakenTo(node: N.AApp, weak: string): N.ALettable {
    this.count.n += 1;
    const newFun = new N.AId(node._fun.l, new A.SGlobal(weak));
    return new N.AApp(node.l, newFun, node.args, node.appInfo);
  }
}

// Tags each `obj.field` read whose receiver's upper-bound type resolves to a
// data type carrying `field` as a plain data field on EVERY variant (exactly the
// `fieldTypes` intersection collectBind already computes -- so this excludes
// methods and partial fields). Such a read is guaranteed present and non-method,
// so codegen can emit `obj.dict["field"]` directly instead of routing through the
// one megamorphic `getField`. Mirrors directCases: sound because the receiver is
// proven of that type by the type checker OR its runtime `_checkAnn` (the caller
// gates on valueIsTyped). For `.`-access, a ref field is returned as-is by
// getField, and the direct dict read returns the same box -- so no derefField.
// Is `obj.field` a safe direct data-field read? Yes when the receiver resolves to
// a data type and `field` is (a) one of the receiver's KNOWN VARIANT's own fields
// -- `self` inside that variant's method is exactly that variant, so every one of
// its fields is present -- or, failing a known variant, (b) in the cross-variant
// intersection (present on every variant). Excludes methods either way (neither
// map records method members).
function directFieldOk(obj: AbsType, field: string, ctx: Ctx): boolean {
  if (obj.k !== 'data') { return false; }
  if (obj.variant !== undefined) {
    const vf = ctx.variantFieldNames.get(obj.id)?.get(obj.variant);
    if (vf !== undefined && vf.has(field)) { return true; }
  }
  return fieldTypeOf(obj, field, ctx) !== undefined;
}

// Is `obj.meth(...)` a safe direct method dispatch? Yes when the receiver resolves
// to a data type and `meth` is guaranteed to be a genuine method in the runtime
// value's dict: a `sharing:` method (on every variant), the KNOWN variant's own
// `with:` method, or -- when the variant is unknown -- a method every variant
// defines. Then `obj.dict["meth"]` is always a Method, so `.full_meth(obj,args)`
// is exactly what maybeMethodCall's isMethod branch does, minus the funnel.
function directMethodOk(obj: AbsType, meth: string, ctx: Ctx): boolean {
  if (obj.k !== 'data') { return false; }
  if (ctx.sharedMethodNames.get(obj.id)?.has(meth)) { return true; }
  const vm = ctx.variantMethodNames.get(obj.id);
  if (vm === undefined || vm.size === 0) { return false; }
  if (obj.variant !== undefined) {
    return vm.get(obj.variant)?.has(meth) ?? false;
  }
  // Unknown variant: safe only if every variant defines the method.
  for (const [, mset] of vm) { if (!mset.has(meth)) { return false; } }
  return true;
}

class TagDotVisitor extends N.DefaultMapVisitor {
  constructor(private ctx: Ctx, private count: { n: number }) { super(); }
  aDot(node: N.ADot): N.ALettable {
    const newObj = node.obj.visit(this) as N.AVal;
    if (directFieldOk(absOfVal(node.obj, this.ctx), node.field, this.ctx)) {
      this.count.n += 1;
      return new N.ADot(node.l, newObj, node.field, node.cacheVar, true);
    }
    return new N.ADot(node.l, newObj, node.field, node.cacheVar, node.directField);
  }
  aMethodApp(node: N.AMethodApp): N.ALettable {
    const newObj = node.obj.visit(this) as N.AVal;
    const newArgs = node.args.map((a) => a.visit(this) as N.AVal);
    if (directMethodOk(absOfVal(node.obj, this.ctx), node.meth, this.ctx)) {
      this.count.n += 1;
      return new N.AMethodApp(node.l, newObj, node.meth, newArgs, true);
    }
    return new N.AMethodApp(node.l, newObj, node.meth, newArgs, node.directMethod);
  }
}

export function tagDirectFields(
  anfed: N.AProg,
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  moduleUri: string,
): N.AProg {
  const dummyFlat: FL.FlatnessEnv = [new Map(), new Map(), new Set(), new Set(), new Map()];
  const ctx = newCtx(postEnv, env, dummyFlat, moduleUri, false);
  try {
    runTypeFlow(anfed, ctx);
    const count = { n: 0 };
    const newBody = anfed.body.visit(new TagDotVisitor(ctx, count)) as N.AExpr;
    const out = new N.AProgram(anfed.l, anfed.provides, anfed.imports, newBody);
    if (process.env.PYRET_TF_DEBUG) {
      process.stderr.write(`[direct-fields ${moduleUri}] tagged=${count.n}\n`);
    }
    return out;
  } catch (_e) {
    // Optimization only: fail safe to "tag nothing".
    if (process.env.PYRET_TF_DEBUG) {
      process.stderr.write(`[direct-fields ${moduleUri}] FAILED: ${(_e as any)?.stack ?? _e}\n`);
    }
    return anfed;
  }
}

export function weakenOperators(
  anfed: N.AProg,
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  moduleUri: string,
): N.AProg {
  // Pin the weakening table <-> global.js contract before doing any work, so a
  // typo'd source or drifted/non-flat target trips here (loudly) rather than
  // inside the fail-safe try, where it would be swallowed into a silent no-op.
  assertWeakenTableResolves(env);
  // flatnessEnv is unused when collectRedundant is false; pass an empty one.
  const dummyFlat: FL.FlatnessEnv = [new Map(), new Map(), new Set(), new Set(), new Map()];
  const ctx = newCtx(postEnv, env, dummyFlat, moduleUri, false);
  try {
    runTypeFlow(anfed, ctx);
    const count = { n: 0 };
    // Transform only the body and rebuild the program, preserving imports/provides
    // (the ANF map-visitor doesn't handle the surface s-import nodes the program
    // still carries -- and they contain no operator apps to weaken anyway).
    const newBody = anfed.body.visit(new WeakenVisitor(ctx, count)) as N.AExpr;
    const out = new N.AProgram(anfed.l, anfed.provides, anfed.imports, newBody);
    if (process.env.PYRET_TF_DEBUG) {
      process.stderr.write(`[op-weaken ${moduleUri}] weakened=${count.n} eligibleVars=${ctx.eligibleVars.size} funRet=${ctx.funRet.size}\n`);
      if (process.env.PYRET_TF_DUMP) {
        for (const k of ctx.eligibleVars) {
          const t = ctx.varUb.get(k); if (t && t.k !== 'any') { process.stderr.write(`  varUb ${k} = ${JSON.stringify(t)}\n`); }
        }
        for (const [k, t] of ctx.funRet) { process.stderr.write(`  funRet ${k} = ${JSON.stringify(t)}\n`); }
      }
    }
    return out;
  } catch (_e) {
    // Optimization only: an analysis miss or unexpected node must never break
    // compilation. Fail safe to "weaken nothing".
    if (process.env.PYRET_TF_DEBUG) {
      process.stderr.write(`[op-weaken ${moduleUri}] FAILED: ${(_e as any)?.stack ?? _e}\n`);
    }
    return anfed;
  }
}
