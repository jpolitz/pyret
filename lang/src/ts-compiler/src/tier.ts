/*
  Per-function tier analysis (Stage 5; promise backend only).

  Computes, ahead of codegen and entirely on ANF, a verdict for every
  ALam / AMethod body:

    'flat'         -- today's flatness verdict; emitted as a plain sync jFun.
    'tail-flat'    -- every suspend site (if any) is a tail-position direct
                      return or a TCO `continue`; eligible for sync emission
                      with direct tail returns (Awaitable ABI: a suspended
                      sync tail chain returns the SAME promise through every
                      frame -- the O(1) bounce).
    'few-suspend'  -- at most FS_MAX_SUSPENDS continuation-capturing suspend
                      sites and at most FS_MAX_BRANCHES suspend-containing
                      branches; eligible for sync emission with per-site
                      `if (R.iT(t)) return t.then(<resume closure>)` guards.
    'gen'          -- everything else; emitted as a generator + sync wrapper
                      (awaits lowered to yields) in the Gen-tier commit.

  DESIGN RULES (see the re-derivation spec, rules 1-2):
  - All decisions live HERE, on the ANF, before codegen. The emission paths
    re-derive per-site facts through the SAME shared classifiers
    (FL.getAppFunFlatness / flatMethodApps / appInfo.needsStep /
    FL.annCheckClass), so analysis and emission cannot disagree; the
    post-emission residual-await scan (O7, anf-loop-compiler-async.ts) is an
    InternalCompilerError assertion, never a fallback or a decision procedure.
  - The map is keyed by ANF NODE IDENTITY (like flatMethodApps/flatMethods):
    no inheritable compile-state mode flags, so a nested function can never
    inherit an outer function's tier (the ref branch's ext()-inherits-
    tailFlatMode generator leak is structurally impossible here).
  - ORDERING CONSTRAINT: this pass must run LAST among the ANF passes
    (after the optimizer / weakening / direct-fields / method-info /
    flatness / ann-elision), immediately before codegen. Any ANF rewrite
    after it orphans the node-keyed map; the missing-entry
    InternalCompilerError in tierVerdictFor makes that loud, by design.
  - The toplevel module function is EXCLUDED (it stays async and is never
    in the map); codegen passes tier 'async' for it.

  Debug: PYRET_TIER_DEBUG=1 dumps one line per analyzed function plus a
  per-module summary (mirrors PYRET_METHOD_DEBUG in flatness.ts).
*/

import * as A from './ast';
import * as AA from './ast-anf';
import * as C from './compile-structs';
import * as FL from './flatness';
import { InternalCompilerError } from './shared';

export type Tier = 'flat' | 'tail-flat' | 'few-suspend' | 'gen';

// Per-function suspend-site accounting (the inputs to the verdict rules).
export interface SuspendSummary {
  // S: continuation-capturing suspend sites -- suspend sites that are neither
  // tail-position direct returns nor TCO continues. These are the sites that
  // need a resume closure in the FewSuspend tier.
  capturing: number;
  // Tail-position non-flat a-app / a-method-app sites: a DIRECT RETURN in a
  // sync tier (the ref's pattern C -- zero capture), so they never count
  // toward S.
  tail: number;
  // Self-tail-calls that compile to the explicit-loop TCO `continue` (not
  // suspend sites at all).
  tco: number;
  // B: number of a-if / a-cases nodes whose subtree contains at least one
  // capturing suspend site (suspend-free branches are opaque single units).
  branchesWithCapture: number;
  // Some capturing site's continuation (rest of its chain to function exit,
  // through enclosing branch joins) contains a TCO `continue` back-edge --
  // the resume closure can't be built (it would need the loop).
  loopUnsafe: boolean;
  // Some capturing site sits inside an a-cases branch (v1 conservatism:
  // demoted to Gen for measured-coverage parity with the ref).
  inCases: boolean;
}

export interface TierVerdict {
  tier: Tier;
  // Whether explicit-loop TCO is allowed for this function: false iff some
  // formal argument is captured by a nested lambda/method body (the loop
  // would clobber the captured binding). Computed HERE (moved out of
  // compileFunBody) and carried to codegen in the verdict.
  allowTco: boolean;
  suspendSites: SuspendSummary;
}

// NODE-IDENTITY keys: same discipline as flatMethodApps / flatMethods.
export type TierMap = Map<AA.ALam | AA.AMethod, TierVerdict>;

// The (structural) slice of CompileOptions the analysis consumes.
export interface TierOptions {
  properTailCalls: boolean;
  tailFlat: boolean;
  fewSuspend: boolean;
}

// FewSuspend bounds are MEASURED LAW, not aesthetics: FS_MAX_SUSPENDS=3 was a
// wash on orbital and ~6% worse on plagiarism (ref 5ca35308b; on the
// do-not-port list). Do not raise without new measurements.
export const FS_MAX_SUSPENDS = 2;
export const FS_MAX_BRANCHES = 1;

// Lookup with the assertion discipline: when a tier map exists, a missing
// entry for a visited ALam/AMethod means some pass AFTER tier analysis
// rebuilt ANF nodes (orphaning the identity-keyed map) -- a real bug, never
// something to fall back from.
export function tierVerdictFor(map: TierMap, node: AA.ALam | AA.AMethod, where: string): TierVerdict {
  const v = map.get(node);
  if (v === undefined) {
    throw new InternalCompilerError(
      'tier map has no entry for ' + node.$name + ' "' + node.name + '" at ' + where
      + ' (an ANF rewrite ran after tier analysis?)');
  }
  return v;
}

// The TCO-continue predicate, shared verbatim by this analysis and
// compileAppAsync (which additionally requires compiler.inTcoLoop -- the
// `while(true)` continue-target must exist). TCO-ness keys on the ANF's
// appInfo.isTail (the authoritative tail analysis), NOT the syntactic tail
// position: the `-> T` return-annotation desugaring makes a tail self-call
// let-bound (syntactically mid-body) while still isTail=true, and `continue`
// legitimately skips the trailing _checkAnn (the returned value is the base
// case's already-checked value).
export function isTcoSelfApp(
  appInfo: A.AppInfo,
  argCount: number,
  fnArity: number,
  allowTco: boolean,
  properTailCalls: boolean
): boolean {
  return appInfo.isRecursive && appInfo.isTail && allowTco && properTailCalls
    && argCount === fnArity;
}

// Pyret object extension idiom (clone preserving prototype), as in
// anf-loop-compiler-async.ts; used for the visitor extension below.
function ext<T extends object>(obj: T, fields: Record<string, any>): T {
  const out = Object.create(Object.getPrototypeOf(obj));
  Object.assign(out, obj, fields);
  return out as T;
}

// Detect whether one of `args` is referenced inside a nested a-lam/a-method
// body; if so, explicit-loop TCO must be disabled (the loop's argument
// reassignment would clobber the captured binding). MOVED here from
// compileFunBody (anf-loop-compiler-async.ts) so the tier analysis and the
// legacy 'async' emission path share ONE detector; the traversal is the
// original's, verbatim (queue of chain bodies, `lam` flag marking whether a
// body is inside some nested lambda relative to the function under analysis).
export function argUsedInNestedLambda(args: AA.ABind[], body: AA.AExpr): boolean {
  let inLam = false;
  let argUsedInLambda = false;
  const argNames = args.map((a) => a.id);
  const dummyAnfLettable = new AA.AObj(AA.dummyLoc, []);
  const pendingBodies: Array<{ body: AA.AExpr; lam: boolean }> = [];
  function enqueueChainBody(b: AA.AExpr, lam: boolean): any {
    pendingBodies.push({ body: b, lam });
    return dummyAnfLettable;
  }
  const detector = ext(AA.defaultMapVisitor as any, {
    aLam(node: AA.ALam): any {
      return enqueueChainBody(node.body, true);
    },
    aMethod(node: AA.AMethod): any {
      return enqueueChainBody(node.body, true);
    },
    aTypeLet(node: AA.ATypeLet): any {
      return enqueueChainBody(node.body, inLam);
    },
    aLet(node: AA.ALet): any {
      node.e.visit(this);
      return enqueueChainBody(node.body, inLam);
    },
    aArrLet(node: AA.AArrLet): any {
      node.e.visit(this);
      return enqueueChainBody(node.body, inLam);
    },
    aVar(node: AA.AVar): any {
      node.e.visit(this);
      return enqueueChainBody(node.body, inLam);
    },
    aSeq(node: AA.ASeq): any {
      node.e1.visit(this);
      return enqueueChainBody(node.e2, inLam);
    },
    aId(node: AA.AId): any {
      if (inLam && !argUsedInLambda && argNames.some((an) => an.key() === node.id.key())) {
        argUsedInLambda = true;
      }
      return new AA.AId(node.l, node.id);
    },
  });
  pendingBodies.push({ body, lam: false });
  while (pendingBodies.length > 0 && !argUsedInLambda) {
    const item = pendingBodies.pop()!;
    inLam = item.lam;
    item.body.visit(detector);
  }
  return argUsedInLambda;
}

// Per-function walk state.
interface FnCtx {
  // Formal-argument count as the TCO arity gate sees it: a zero-arg lambda
  // gets the synthetic `resumer` formal in codegen, so its compiled arity is
  // 1 and a zero-arg self call (argCount 0) never TCOs -- mirrored here.
  arityForTco: number;
  allowTco: boolean;
  fnIsFlat: boolean;
  capturing: number;
  tail: number;
  tco: number;
  branchesWithCapture: number;
  loopUnsafe: boolean;
  inCases: boolean;
}

export function makeProgTierMap(
  prog: AA.AProg,
  flatnessEnv: FL.FlatnessEnv,
  redundantAnnChecks: Set<string>,
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  options: TierOptions
): TierMap {
  const sd = flatnessEnv[0];
  const ad = flatnessEnv[1];
  const flatMethodApps = flatnessEnv[2];
  const flatMethods = flatnessEnv[3];
  const mb = (postEnv as C.ComputedEnv).moduleBindings;
  const properTailCalls = options.properTailCalls;
  const tierMap: TierMap = new Map();
  const debug = !!process.env.PYRET_TIER_DEBUG;

  // ---- shared per-site classifiers (rule 2: one helper per fact) ----------

  // Mirrors compileAppAsync's isFlat: resolve via FL.getAppFunFlatness for
  // id/safe-letrec/modref callees; anything else is conservatively non-flat.
  function appIsFlat(f: AA.AVal): boolean {
    if (AA.isAId(f) || AA.isAIdSafeLetrec(f) || AA.isAIdModref(f)) {
      return FL.isFlatEnough(FL.getAppFunFlatness(f, sd, mb, env));
    }
    return false;
  }

  function annClass(b: AA.ABind): FL.AnnCheckClass {
    return FL.annCheckClass(b, sd, ad, redundantAnnChecks, mb, env);
  }

  // ---- TCO-in-continuation scan (for loopUnsafe) ---------------------------
  // Does this subtree (within the SAME function -- nested lam/method bodies
  // are their own functions and never descend) contain an app that will
  // compile to a TCO `continue`?
  function hasTcoInExpr(ctx: FnCtx, e: AA.AExpr): boolean {
    let cur: AA.AExpr = e;
    for (;;) {
      switch (cur.$name) {
        case 'a-type-let':
          cur = cur.body; continue;
        case 'a-let':
        case 'a-arr-let':
        case 'a-var':
          if (hasTcoInLettable(ctx, cur.e)) { return true; }
          cur = cur.body; continue;
        case 'a-seq':
          if (hasTcoInLettable(ctx, cur.e1)) { return true; }
          cur = cur.e2; continue;
        case 'a-lettable':
          return hasTcoInLettable(ctx, cur.e);
        default:
          throw new InternalCompilerError('hasTcoInExpr: unknown expr ' + (cur as any).$name);
      }
    }
  }
  function hasTcoInLettable(ctx: FnCtx, l: AA.ALettable): boolean {
    switch (l.$name) {
      case 'a-app':
        return isTcoSelfApp(l.appInfo, l.args.length, ctx.arityForTco, ctx.allowTco, properTailCalls);
      case 'a-if':
        return hasTcoInExpr(ctx, l.t) || hasTcoInExpr(ctx, l.e);
      case 'a-cases':
        return l.branches.some((b) => hasTcoInExpr(ctx, b.body)) || hasTcoInExpr(ctx, l._else);
      default:
        // Nested a-lam / a-method: their TCO is their own, never the outer fn's.
        return false;
    }
  }

  // ---- the walk ------------------------------------------------------------

  // Record one continuation-capturing suspend site.
  function capture(ctx: FnCtx, inCases: boolean, contTco: () => boolean): void {
    ctx.capturing++;
    if (inCases) { ctx.inCases = true; }
    if (!ctx.loopUnsafe && ctx.allowTco && properTailCalls && contTco()) {
      ctx.loopUnsafe = true;
    }
  }

  // Walk one lettable in position (tail = syntactic function-tail position,
  // exactly the compiler's tailPos threading). Returns 'tco' when the
  // lettable is an app that compiles to the TCO `continue` (its enclosing
  // let's ann check is then unreachable and must not count as a site).
  function walkLettable(
    l: AA.ALettable,
    tail: boolean,
    ctx: FnCtx | undefined,
    inCases: boolean,
    contTco: () => boolean,
    letBind?: AA.ABind
  ): 'tco' | undefined {
    switch (l.$name) {
      case 'a-app': {
        if (ctx === undefined) { return undefined; }  // toplevel: not tiered
        if (appIsFlat(l._fun)) { return undefined; }
        if (isTcoSelfApp(l.appInfo, l.args.length, ctx.arityForTco, ctx.allowTco, properTailCalls)) {
          ctx.tco++;
          return 'tco';
        }
        if (tail) { ctx.tail++; return undefined; }
        capture(ctx, inCases, contTco);
        return undefined;
      }
      case 'a-method-app': {
        if (ctx === undefined) { return undefined; }
        if (flatMethodApps.has(l)) { return undefined; }
        // One site regardless of receiver shape: the fresh design normalizes
        // the non-JId-receiver fallback to a single guarded site in sync
        // tiers (dossier B.3), so it is ONE suspend here, not two.
        if (tail) { ctx.tail++; return undefined; }
        capture(ctx, inCases, contTco);
        return undefined;
      }
      case 'a-prim-app': {
        if (ctx === undefined) { return undefined; }
        // needsStep prim-apps count as CAPTURING even in tail position: the
        // ref's tail-direct-return (pattern C) covered only a-app and
        // a-method-app, and the measured FewSuspend coverage was established
        // on that basis. (A tail direct-return for prim sites is a possible
        // later relaxation; it must land together with its emission.)
        if (l.appInfo.needsStep) { capture(ctx, inCases, contTco); }
        return undefined;
      }
      case 'a-update': {
        // checkRefAnns may run arbitrary (user refinement) annotation code:
        // always a capturing suspend site.
        if (ctx !== undefined) { capture(ctx, inCases, contTco); }
        return undefined;
      }
      case 'a-if': {
        const before = ctx === undefined ? 0 : ctx.capturing;
        walkExpr(l.t, tail, ctx, inCases, contTco);
        walkExpr(l.e, tail, ctx, inCases, contTco);
        if (ctx !== undefined && ctx.capturing > before) { ctx.branchesWithCapture++; }
        return undefined;
      }
      case 'a-cases': {
        const before = ctx === undefined ? 0 : ctx.capturing;
        for (const br of l.branches) {
          // Cases-bind annotation checks run inside the branch block.
          if (ctx !== undefined && AA.isACasesBranch(br)) {
            for (const arg of br.args) {
              if (annClass(arg.bind) === 'suspend') { capture(ctx, true, contTco); }
            }
          }
          walkExpr(br.body, tail, ctx, true, contTco);
        }
        walkExpr(l._else, tail, ctx, true, contTco);
        if (ctx !== undefined && ctx.capturing > before) { ctx.branchesWithCapture++; }
        return undefined;
      }
      case 'a-lam': {
        // A nested function: an opaque VALUE for the enclosing function
        // (never a suspend site); analyzed innermost as its own context.
        analyzeFunction(l, letBind);
        return undefined;
      }
      case 'a-method': {
        analyzeFunction(l, undefined);
        return undefined;
      }
      // Everything else is a flat value form (or a-assign / a-data-expr,
      // which emit no suspend sites and contain no tiered functions --
      // a-data-expr's constructors are plain sync jFuns and its member
      // values are AVals).
      default:
        return undefined;
    }
  }

  // Walk an AExpr chain iteratively (like compileAexprAsync / flatness.ts:
  // one chain node per statement would overflow fixed stacks recursively).
  // `tail` is whether the chain's TERMINAL lettable sits in function-tail
  // position; every RHS is non-tail. `contTco` answers "does the code that
  // runs AFTER this whole chain contain a TCO continue" (lazily).
  function walkExpr(
    e: AA.AExpr,
    tail: boolean,
    ctx: FnCtx | undefined,
    inCases: boolean,
    contTco: () => boolean
  ): void {
    let cur: AA.AExpr = e;
    for (;;) {
      switch (cur.$name) {
        case 'a-type-let':
          cur = cur.body; continue;
        case 'a-let': {
          const b = cur.bind;
          const rest = cur.body;
          const contHere = ctx === undefined
            ? contTco
            : () => hasTcoInExpr(ctx, rest) || contTco();
          const rhsTco = walkLettable(cur.e, false, ctx, inCases, contHere, b);
          // The bind's annotation check is a site UNLESS the RHS compiled to
          // a TCO `continue` (which skips the trailing check -- sound: the
          // returned value is the base case's already-checked value).
          if (ctx !== undefined && rhsTco !== 'tco' && annClass(b) === 'suspend') {
            capture(ctx, inCases, contHere);
          }
          cur = rest; continue;
        }
        case 'a-arr-let': {
          const b = cur.bind;
          const rest = cur.body;
          const contHere = ctx === undefined
            ? contTco
            : () => hasTcoInExpr(ctx, rest) || contTco();
          const rhsTco = walkLettable(cur.e, false, ctx, inCases, contHere);
          if (ctx !== undefined && rhsTco !== 'tco' && annClass(b) === 'suspend') {
            capture(ctx, inCases, contHere);
          }
          cur = rest; continue;
        }
        case 'a-var': {
          // NOTE: the async codegen emits no annCheckStmts for a-var binds;
          // only the RHS can be a site.
          const rest = cur.body;
          const contHere = ctx === undefined
            ? contTco
            : () => hasTcoInExpr(ctx, rest) || contTco();
          walkLettable(cur.e, false, ctx, inCases, contHere);
          cur = rest; continue;
        }
        case 'a-seq': {
          const rest = cur.e2;
          const contHere = ctx === undefined
            ? contTco
            : () => hasTcoInExpr(ctx, rest) || contTco();
          walkLettable(cur.e1, false, ctx, inCases, contHere);
          cur = rest; continue;
        }
        case 'a-lettable':
          walkLettable(cur.e, tail, ctx, inCases, contTco);
          return;
        default:
          throw new InternalCompilerError('makeProgTierMap: unknown expr ' + (cur as any).$name);
      }
    }
  }

  // ---- per-function analysis + verdict --------------------------------------

  function analyzeFunction(node: AA.ALam | AA.AMethod, letBind: AA.ABind | undefined): void {
    // Flatness verdict, exactly as the emitter derives it: lambdas via their
    // let-binding's entry in the function-flatness env (compileALam consults
    // compiler.curLetBind); methods via the node-identity set.
    const fnIsFlat = AA.isAMethod(node)
      ? flatMethods.has(node)
      : (letBind !== undefined && FL.isFunctionFlat(sd, letBind.id.key()));
    const allowTco = !argUsedInNestedLambda(node.args, node.body);
    const ctx: FnCtx = {
      arityForTco: node.args.length > 0 ? node.args.length : 1,
      allowTco,
      fnIsFlat,
      capturing: 0,
      tail: 0,
      tco: 0,
      branchesWithCapture: 0,
      loopUnsafe: false,
      inCases: false,
    };
    // Argument annotation contracts run at the top of the body (and on every
    // TCO re-entry); a non-flat arg ann is a capturing suspend site. Zero-arg
    // lambdas get the synthetic blank-ann resumer in codegen: no sites.
    for (const arg of node.args) {
      if (annClass(arg) === 'suspend') { capture(ctx, false, () => hasTcoInExpr(ctx, node.body)); }
    }
    walkExpr(node.body, true, ctx, false, () => false);

    let tier: Tier;
    if (fnIsFlat) {
      // Agreement assertion (rule 2 tripwire): a function the flatness
      // analysis proved flat must have ZERO suspend sites under the shared
      // site classifiers -- a site here means the classifiers drifted apart,
      // which today's emission would turn into `await` inside a sync
      // function (a JS syntax error). Assert, never fall back.
      if (ctx.capturing + ctx.tail + ctx.tco > 0) {
        throw new InternalCompilerError(
          'tier/flatness disagreement: ' + node.$name + ' "' + node.name + '" at '
          + node.l.key() + ' is flat but the tier walk found suspend sites'
          + ' (capturing=' + ctx.capturing + ', tail=' + ctx.tail + ', tco=' + ctx.tco + ')');
      }
      tier = 'flat';
    } else if (ctx.capturing === 0) {
      // All suspend sites (if any) are tail direct-returns or TCO continues.
      // Covers the "non-flat only by FLAT_LIMIT depth" functions too (zero
      // sites at all). -no-tail-flat demotes to Gen.
      tier = options.tailFlat ? 'tail-flat' : 'gen';
    } else if (
      ctx.capturing <= FS_MAX_SUSPENDS
      && ctx.branchesWithCapture <= FS_MAX_BRANCHES
      && !ctx.loopUnsafe
      && !ctx.inCases
    ) {
      // -no-few-suspend demotes to Gen.
      tier = options.fewSuspend ? 'few-suspend' : 'gen';
    } else {
      tier = 'gen';
    }

    tierMap.set(node, {
      tier,
      allowTco,
      suspendSites: {
        capturing: ctx.capturing,
        tail: ctx.tail,
        tco: ctx.tco,
        branchesWithCapture: ctx.branchesWithCapture,
        loopUnsafe: ctx.loopUnsafe,
        inCases: ctx.inCases,
      },
    });
    if (debug) {
      const dn = node.name !== '' ? node.name
        : (letBind !== undefined ? letBind.id.toname() : '<anon>');
      process.stderr.write(
        '[tier] name=' + dn + ' kind=' + (AA.isAMethod(node) ? 'method' : 'lam')
        + ' tier=' + tier + ' allowTco=' + allowTco
        + ' S=' + ctx.capturing + ' B=' + ctx.branchesWithCapture
        + ' tail=' + ctx.tail + ' tco=' + ctx.tco
        + (ctx.loopUnsafe ? ' loopUnsafe' : '') + (ctx.inCases ? ' inCases' : '')
        + ' loc=' + node.l.key() + '\n');
    }
  }

  // Toplevel module body: walked (to find every function) but NOT itself a
  // function context -- it stays async by design and is never in the map.
  walkExpr(prog.body, true, undefined, false, () => false);

  if (debug) {
    const counts: Record<Tier, number> = { 'flat': 0, 'tail-flat': 0, 'few-suspend': 0, 'gen': 0 };
    for (const v of tierMap.values()) { counts[v.tier]++; }
    process.stderr.write(
      '[tier] summary flat=' + counts['flat'] + ' tail-flat=' + counts['tail-flat']
      + ' few-suspend=' + counts['few-suspend'] + ' gen=' + counts['gen']
      + ' total=' + tierMap.size + '\n');
  }
  return tierMap;
}
