/*
  Ported from: src/arr/compiler/flatness.arr
  Flatness analysis: is a function "flat" (guaranteed not to need the
  Pyret stack)? See CONVENTIONS.md.

  A flatness environment maps from ANF id names (by .key()) to

  - undefined (Pyret none), if the name is for a function with an
    infinitely deep body
  - n (Pyret some(n)), where n is the number of nested calls that the
    function contains

  If a name isn't present, it is equivalent to containing a mapping for
  undefined.

  This notion is naturally extended to named annotations, which are similar
  to functions in that they delay computation until later.

  CAREFUL: because some(0) ports to the falsy value 0, Flatness values are
  always compared with explicit `=== undefined` / `!== undefined` checks,
  never truthiness. Where Pyret's MutableStringDict get-now produced
  Option<Flatness> (a double Option), `.has()` is used to distinguish
  "absent" from "present with value none".
*/

import * as A from './ast';
import * as AA from './ast-anf';
import * as C from './compile-structs';
import { InternalCompilerError, mapGetValue, raise } from './shared';

export type Flatness = number | undefined;
export type FEnv = Map<string, Flatness>;
// The { sd; ad } tuple returned by make-prog-flatness-env.
// Third/fourth elements: the method-flatness outputs (promise backend) -- the
// set of method-application nodes proven flat (so codegen emits a direct,
// no-await call) and the set of `a-method` nodes proven flat (so codegen emits
// the method body as a synchronous function). Empty unless method flatness is
// enabled (cont backend / no methodInfo -> empty, and never consulted there).
// Fifth element: this module's converged (dataId#method -> flatness) table.
// Consumed in-module today; a follow-on exports it via getFlatProvides so
// importers can flatten these methods cross-module.
// [funFlatness, annFlatness, flatMethodApps, flatMethods, methodTable]
export type FlatnessEnv = [FEnv, FEnv, Set<AA.AMethodApp>, Set<AA.AMethod>, Map<string, Flatness>];

// Receiver/type facts the method-flatness analysis consumes (produced by
// type-flow.ts's makeProgMethodInfo; structural to avoid an import cycle).
export interface MethodFlatInfo {
  receiver: Map<AA.AMethodApp, string>;
  methodOf: Map<AA.AMethod, { dataId: string; methodName: string }>;
}

// A function/method/annotation is "flat enough" for sync emission / await
// elision when its flatness is within this limit. Exported as the single
// source of truth: isFlatEnough (anf-loop-compiler-async.ts) and flatAnn
// (type-flow.ts) must use the SAME limit as the method-flatness analysis
// below, or the sync-vs-async emission decision could disagree with the
// analysis (an `await` inside a sync function is a JS syntax error).
export const FLAT_LIMIT = 5;
function methodFlatEnough(f: Flatness): boolean { return f !== undefined && f <= FLAT_LIMIT; }

// ---------------------------------------------------------------------------
// Method-flatness analysis (structural; promise backend only).
//
// A method call `obj.m(args)` is flat iff `obj`'s receiver resolves to an
// in-module data type whose `m` (across all variants) is itself flat.
// There is NO numeric special-casing here: arithmetic flatness is handled upstream by the
// typed-operator-weakening pass (type-flow.ts), which rewrites `_plus(a,b)` on
// Number operands into the flat global `_plus_nums(a,b)`, so ordinary structural
// function-flatness (getAppFunFlatness) picks it up like any other flat call.
//
// Intra-type method dependencies (a method calling a sibling on `self`, e.g.
// `get` using `self.length()`) are resolved by a FIXPOINT in makeProgFlatnessEnv:
// each pass resolves every `self.m()` call against the PREVIOUS pass's COMPLETE
// table (`methodTablePrev`), and the passes repeat until the table stops changing.
// Monotone (a method only ever moves non-flat -> flat as its callees resolve), so
// it converges; genuine recursion never resolves and correctly stays non-flat;
// stopping early is sound (a missing entry reads as non-flat).
// ---------------------------------------------------------------------------
interface MethodCtx {
  // ----- method flatness (promise backend; empty/disabled otherwise) -----------
  methodsEnabled: boolean;
  // receiver data type id per method-app, and method-node -> (dataId, methodName).
  methodReceiver: Map<AA.AMethodApp, string>;
  methodOf: Map<AA.AMethod, { dataId: string; methodName: string }>;
  // THIS pass's table, built incrementally: `dataId#methodName` -> the method's
  // flatness (max over all variants' definitions of that method, seen this pass).
  methodTable: Map<string, Flatness>;
  // The PREVIOUS pass's complete table, consulted to resolve `self.m()` calls
  // (complete because the prior pass saw every variant). Empty on the first pass.
  methodTablePrev: Map<string, Flatness>;
  // outputs consumed by codegen (rebuilt each pass; the final pass's are returned).
  flatMethodApps: Set<AA.AMethodApp>;
  flatMethods: Set<AA.AMethod>;
}

// Where Pyret used torepr in internal error messages; best-effort
// structural rendering (same approach as anf.ts / compile-errors.ts).
function torepr(v: any): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === undefined) return 'none';
  if (Array.isArray(v)) return '[list: ' + v.map(torepr).join(', ') + ']';
  if (v !== null && typeof v === 'object' && typeof v.$name === 'string') {
    const fields = Object.keys(v).map((kk) => torepr(v[kk]));
    return fields.length === 0 ? v.$name : v.$name + '(' + fields.join(', ') + ')';
  }
  return String(v);
}

export function flatnessMax(a: Flatness, b: Flatness): Flatness {
  // read the docs, maybe there's a quicker way to write this
  if (a !== undefined) {
    if (b !== undefined) {
      return Math.max(a, b);
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }
}

// Calculate the flatness of an annotation. Does not change val-env and ann-env
export function annFlatness(
  ann: A.Ann,
  valEnv: FEnv,
  annEnv: FEnv,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment
): Flatness {
  switch (ann.$name) {
    case 'a-blank': return 0;
    case 'a-any': return 0;
    case 'a-name':
      // get-now(...).or-else(none): absent and stored-none coincide here
      return annEnv.get(ann.id.key());
    case 'a-type-var': return 0;
    case 'a-arrow':
      // NOTE(joe): This is a flat check because it's not higher-order; we don't check args and ret
      return 0;
    case 'a-arrow-argnames':
      // NOTE(joe): This is a flat check because it's not higher-order; we don't check args and ret
      return 0;
    case 'a-method': return 0;
    case 'a-record': {
      let flatness: Flatness = 0;
      for (const f of ann.fields) {
        flatness = flatnessMax(flatness, annFlatness(f.ann, valEnv, annEnv, mb, env));
      }
      return flatness;
    }
    case 'a-tuple': {
      let flatness: Flatness = 0;
      for (const f of ann.fields) {
        flatness = flatnessMax(flatness, annFlatness(f, valEnv, annEnv, mb, env));
      }
      return flatness;
    }
    case 'a-app':
      // NOTE(joe): the args are ignored because we don't dynamically check
      // the Number in List<Number>
      return annFlatness(ann.ann, valEnv, annEnv, mb, env);
    case 'a-pred': {
      const valFlatness = valEnv.get((ann.exp as any).id.key());
      return flatnessMax(
        annFlatness(ann.ann, valEnv, annEnv, mb, env),
        valFlatness
      );
    }
    case 'a-dot': {
      const moduleInfo = mapGetValue(env.allModules, mapGetValue(mb, ann.obj.key()).uri);
      const provides = moduleInfo.provides;
      if (provides.dataDefinitions.has(ann.field)) {
        return 0;
      } else if (provides.aliases.has(ann.field)) {
        // NOTE(joe): We'd love to do something like the below; however,
        // the things in aliases are TYPES, which don't match the type of
        // ann-flatness, so we can't tell what the flatness of an ann is
        // from its provides, limiting the effectiveness of checking for
        // refinements cross-module

        // ann-flatness(provides.aliases.get-value(field), val-env, ann-env, mb, env)
        // So we return none instead
        return undefined;
      } else {
        return undefined;
      }
    }
    case 'a-checked': return undefined;
    default:
      throw new InternalCompilerError('annFlatness: unknown ann ' + (ann as any).$name);
  }
}

// (Mutably) fills in the sd (value environment) with flatnesses for predicates
// and constructors, and ad (type environment) with flatnesses for datatype annotations
// and type aliases. Return value should be ignored.
export function makeExprDataEnv(
  aexpr: AA.AExpr,
  sd: FEnv,
  ad: FEnv,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment,
  typeNameToVariants: Map<string, AA.AVariant[]>,
  aliasToTypeName: Map<string, string>
): void {
  // The body recursion is a tail call in every case; loop instead of
  // recursing so long programs (one chain node per statement) don't
  // overflow fixed-size stacks (e.g. browsers).
  for (;;) {
  switch (aexpr.$name) {
    case 'a-type-let': {
      const bind = aexpr.bind;
      switch (bind.$name) {
        case 'a-newtype-bind':
          // We know that the annotation for a newtype bind is just a flat
          // brand check, so make it some(0)
          ad.set(bind.name.key(), 0);
          break;
        case 'a-type-bind':
          ad.set(bind.name.key(), annFlatness(bind.ann, sd, ad, mb, env));
          break;
        default:
          throw new InternalCompilerError('makeExprDataEnv: unknown type bind ' + (bind as any).$name);
      }
      aexpr = aexpr.body;
      continue;
    }
    case 'a-let': {
      const bind = aexpr.bind;
      const val = aexpr.e;
      if (AA.isADataExpr(val)) {
        typeNameToVariants.set(bind.id.key(), val.variants);
        // Make self-mapping entry so we know it's a "type" name
        aliasToTypeName.set(bind.id.key(), bind.id.key());
      } else if (AA.isAIdSafeLetrec(val)) {
        // If we say
        // x = Type
        // y = x
        // z = y
        // We say z and y are aliases of x
        // (NOTE: as in the Pyret original, this test can never succeed for
        // an ALettable; a-id-safe-letrec is an AVal variant)
        const typeNameOpt = aliasToTypeName.get((val as unknown as AA.AIdSafeLetrec).id.key());
        if (typeNameOpt !== undefined) {
          aliasToTypeName.set(bind.id.key(), typeNameOpt);
        }
      } else if (AA.isADot(val) && AA.isAIdSafeLetrec(val.obj)) {
        // Check for: xyz = Type.is-variant or xyz = Type.flat-constructor
        const typeNameOpt = aliasToTypeName.get(val.obj.id.key());
        if (typeNameOpt !== undefined) {
          const typeName = typeNameOpt;
          const variants = mapGetValue(typeNameToVariants, typeName);

          const isIsFunction = variants.some((v) => ('is-' + v.name) === val.field);
          if (isIsFunction) {
            sd.set(bind.id.key(), 0);
          }

          const theVariant = variants.find((v) => (v.name === val.field) && AA.isAVariant(v)) as AA.AVariant$ | undefined;
          if (theVariant !== undefined) {
            let variantFlatness: Flatness = 0;
            for (const m of theVariant.members) {
              variantFlatness = flatnessMax(variantFlatness, annFlatness(m.bind.ann, sd, ad, mb, env));
            }
            sd.set(bind.id.key(), variantFlatness);
          }
        }
      } else {
        // nothing
      }
      makeLettableDataEnv(val, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      aexpr = aexpr.body;
      continue;
    }
    case 'a-arr-let': {
      makeLettableDataEnv(aexpr.e, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      aexpr = aexpr.body;
      continue;
    }
    case 'a-var':
      aexpr = aexpr.body;
      continue;
    case 'a-seq': {
      makeLettableDataEnv(aexpr.e1, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      aexpr = aexpr.e2;
      continue;
    }
    case 'a-lettable':
      makeLettableDataEnv(aexpr.e, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      return;
    default:
      throw new InternalCompilerError('makeExprDataEnv: unknown expr ' + (aexpr as any).$name);
  }
  }
}

export function makeLettableDataEnv(
  lettable: AA.ALettable,
  sd: FEnv,
  ad: FEnv,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment,
  typeNameToVariants: Map<string, AA.AVariant[]>,
  aliasToTypeName: Map<string, string>
): void {
  // default-ret = none (return value is ignored by all callers)
  switch (lettable.$name) {
    case 'a-if': {
      makeExprDataEnv(lettable.t, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      makeExprDataEnv(lettable.e, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      break;
    }
    case 'a-assign': {
      const value = lettable.value;
      if (AA.isAId(value)) {
        if (sd.has(value.id.key())) {
          sd.set(lettable.id.key(), sd.get(value.id.key()));
        }

        if (aliasToTypeName.has(value.id.key())) {
          const valType = mapGetValue(aliasToTypeName, value.id.key());
          aliasToTypeName.set(lettable.id.key(), valType);
        }
      }

      if (AA.isAIdSafeLetrec(value)) {
        const typeNameOpt = aliasToTypeName.get(value.id.key());
        if (typeNameOpt !== undefined) {
          aliasToTypeName.set(lettable.id.key(), typeNameOpt);
        }
      }
      break;
    }
    case 'a-cases': {
      const visitBranch = (caseBranch: AA.ACasesBranch): void => {
        makeExprDataEnv(caseBranch.body, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      };
      lettable.branches.forEach(visitBranch);
      makeExprDataEnv(lettable._else, sd, ad, mb, env, typeNameToVariants, aliasToTypeName);
      break;
    }
    // (The Pyret original also lists an a-id-safe-letrec branch, but
    // a-id-safe-letrec is not an ALettable variant, so it is unreachable.)
    case 'a-module':
    case 'a-app':
    case 'a-method-app':
    case 'a-prim-app':
    case 'a-ref':
    case 'a-tuple':
    case 'a-tuple-get':
    case 'a-obj':
    case 'a-update':
    case 'a-extend':
    case 'a-dot':
    case 'a-colon':
    case 'a-get-bang':
    case 'a-lam':
    case 'a-method':
    case 'a-id-var':
    case 'a-id-var-modref':
    case 'a-id-letrec':
    case 'a-val':
    case 'a-data-expr':
      break;
    default:
      throw new InternalCompilerError('makeLettableDataEnv: unknown lettable ' + (lettable as any).$name);
  }
}

// Calculate the flatness of aexpr, and along the way mutably update sd to
// contain mappings for all defined names of functions
export function makeExprFlatnessEnv(
  aexprIn: AA.AExpr,
  sd: FEnv,
  ad: FEnv,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment,
  nc: MethodCtx
): Flatness {
  // The body recursion (one chain node per statement) is rewritten as a
  // forward loop plus a backward fold so long programs don't overflow
  // fixed-size stacks (e.g. browsers). Per-node pre-work (incl. sd/ad
  // mutations) happens in the forward pass in the original order; work
  // the recursive code did after the body call (a-let's annFlatness and
  // the flatnessMax combinations) happens in the frames, applied in the
  // original unwind order (deepest first).
  const frames: Array<(bodyFlatness: Flatness) => Flatness> = [];
  let aexpr: AA.AExpr = aexprIn;
  let result: Flatness;
  forward: for (;;) {
    switch (aexpr.$name) {
      case 'a-type-let':
        aexpr = aexpr.body;
        continue;
      case 'a-let': {
        const bind = aexpr.bind;
        const val = aexpr.e;

        let valFlatness: Flatness;
        if (AA.isALam(val)) {
          const retFlatness = annFlatness(val.ret, sd, ad, mb, env);
          let argsFlatness = retFlatness;
          for (const elt of val.args) {
            argsFlatness = flatnessMax(argsFlatness, annFlatness(elt.ann, sd, ad, mb, env));
          }

          const bodyFlatness = makeExprFlatnessEnv(val.body, sd, ad, mb, env, nc);
          const lamFlatness = flatnessMax(bodyFlatness, argsFlatness);

          sd.set(bind.id.key(), lamFlatness);
          // flatness of defining this lambda is 0, since we're not actually
          // doing anything with it
          valFlatness = 0;
        } else if (AA.isAIdSafeLetrec(val)) {
          // If we're binding this name to something that's already been defined
          // just copy over the definition
          // (NOTE: as in the Pyret original, this test can never succeed for
          // an ALettable; a-id-safe-letrec is an AVal variant)
          const valISL = val as unknown as AA.AIdSafeLetrec;
          if (sd.has(valISL.id.key())) {
            sd.set(bind.id.key(), sd.get(valISL.id.key()));
          }
          // flatness of the binding part of the let is 0 since we don't
          // call anything
          valFlatness = 0;
        } else if (AA.isAVal(val) && AA.isAIdModref(val.v)) {
          const funFlatness = getFlatnessForModuleFun(val.v.id, val.v.name, mb, env);
          sd.set(bind.id.key(), funFlatness);
          valFlatness = 0;
        } else {
          valFlatness = makeLettableFlatnessEnv(val, sd, ad, mb, env, nc);
        }

        frames.push((bodyFlatness) => {
          const annF = annFlatness(bind.ann, sd, ad, mb, env);
          return flatnessMax(flatnessMax(valFlatness, bodyFlatness), annF);
        });
        aexpr = aexpr.body;
        continue;
      }
      case 'a-arr-let': {
        // Could maybe try to add some string like "bind.name + idx" to the
        // sd to let us keep track of the flatness if e is an a-lam, but for
        // now we don't since I'm not sure it'd work right.
        const annF = annFlatness(aexpr.bind.ann, sd, ad, mb, env);
        const lettF = makeLettableFlatnessEnv(aexpr.e, sd, ad, mb, env, nc);
        frames.push((bodyFlatness) => flatnessMax(annF, flatnessMax(lettF, bodyFlatness)));
        aexpr = aexpr.body;
        continue;
      }
      case 'a-var': {
        // Do same thing with a-var as with a-let for now
        const annF = annFlatness(aexpr.bind.ann, sd, ad, mb, env);
        frames.push((bodyFlatness) => flatnessMax(annF, bodyFlatness));
        aexpr = aexpr.body;
        continue;
      }
      case 'a-seq': {
        const aFlatness = makeLettableFlatnessEnv(aexpr.e1, sd, ad, mb, env, nc);
        frames.push((bodyFlatness) => flatnessMax(aFlatness, bodyFlatness));
        aexpr = aexpr.e2;
        continue;
      }
      case 'a-lettable':
        result = makeLettableFlatnessEnv(aexpr.e, sd, ad, mb, env, nc);
        break forward;
      default:
        throw new InternalCompilerError('makeExprFlatnessEnv: unknown expr ' + (aexpr as any).$name);
    }
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    result = frames[i](result);
  }
  return result;
}

export function incrementFlatness(f: Flatness): Flatness {
  if (f === undefined) {
    return undefined;
  } else {
    return f + 1;
  }
}

export function getFlatnessForCall(funName: string, sd: FEnv): Flatness {
  // If it's not in our lookup dict OR the flatness is none treat it the same
  if (sd.has(funName)) {
    return incrementFlatness(sd.get(funName));
  } else {
    return undefined;
  }
}

export function getFlatnessForModuleFun(
  id: A.Name,
  field: string,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment
): Flatness {
  const moduleInfo = mapGetValue(env.allModules, mapGetValue(mb, id.key()).uri);
  const provides = moduleInfo.provides;
  const valueExport = provides.values.get(field);
  if (valueExport === undefined) {
    return undefined;
  } else if (C.isVFun(valueExport)) {
    return valueExport.flatness;
  } else {
    return undefined;
  }
}

export function getFlatnessForModuleCall(
  id: A.Name,
  field: string,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment
): Flatness {
  return incrementFlatness(getFlatnessForModuleFun(id, field, mb, env));
}

// The flatness of an a-app's CALL given its callee value `f`. Single source of
// truth shared by this analysis and the async codegen, so the sync-vs-async
// emission decision can never disagree with the analysis (a disagreement emits an
// `await` inside a sync function -- a JS syntax error -- or fails to await a
// Promise). Mirrors the a-app cases below.
export function getAppFunFlatness(
  f: AA.AVal,
  sd: FEnv,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment
): Flatness {
  if (AA.isAId(f) || AA.isAIdSafeLetrec(f)) {
    if (!sd.has(f.id.key()) && A.isSGlobal(f.id)) {
      // A global introduced AFTER name resolution (e.g. `_plus_nums` from the
      // operator-weakening pass) has no binding in sd, but its flatness lives in
      // the global env like any builtin. Resolve it there so ordinary structural
      // flatness flattens it -- no numeric special-casing in the analysis itself.
      const ve = env.globalValue(f.id.toname());
      if (ve !== undefined && C.isVFun(ve)) { return incrementFlatness(ve.flatness); }
    }
    return getFlatnessForCall(f.id.key(), sd);
  } else if (AA.isAIdModref(f)) {
    return getFlatnessForModuleCall(f.id, f.name, mb, env);
  }
  return undefined;
}

export function makeLettableFlatnessEnv(
  lettable: AA.ALettable,
  sd: FEnv,
  ad: FEnv,
  mb: Map<string, C.ModuleBind>,
  env: C.CompileEnvironment,
  nc: MethodCtx
): Flatness {
  const defaultRet: Flatness = 0;
  switch (lettable.$name) {
    case 'a-module':
      return defaultRet;
    case 'a-if':
      return flatnessMax(makeExprFlatnessEnv(lettable.t, sd, ad, mb, env, nc), makeExprFlatnessEnv(lettable.e, sd, ad, mb, env, nc));

    // NOTE -- a-assign might not be flat b/c it checks annotations
    case 'a-assign': {
      if (AA.isAId(lettable.value) && sd.has(lettable.value.id.key())) {
        // get-now(...).or-else(some(0)): absent means some(0); a stored
        // none stays none
        const current: Flatness = sd.has(lettable.id.key()) ? sd.get(lettable.id.key()) : 0;
        sd.set(lettable.id.key(),
          flatnessMax(current, mapGetValue(sd, lettable.value.id.key())));
      }
      return defaultRet;
    }

    case 'a-app': {
      const f = lettable._fun;
      // Look up flatness via the shared resolver (also used by codegen). Operator
      // arithmetic on Number operands is already a flat `_plus_nums` global here
      // (the weakening pass rewrote it), so it flattens structurally with no
      // numeric special-casing.
      return getAppFunFlatness(f, sd, mb, env);
    }

    case 'a-method-app': {
      // Method calls are infinite flatness UNLESS the receiver resolves to an
      // in-module data type whose method (across all its variants) is itself flat.
      // Sound because a value of type T has T's original methods (functional extend
      // that overrides a method strips the brand, so it can't satisfy `:: T`), and
      // the receiver type rests on that same annotation/constructor basis.
      if (nc.methodsEnabled) {
        const dataId = nc.methodReceiver.get(lettable);
        if (dataId !== undefined) {
          const key = dataId + '#' + lettable.meth;
          // Consult the previous pass's COMPLETE table (the fixpoint; see MethodCtx).
          const f = nc.methodTablePrev.get(key);
          if (methodFlatEnough(f)) {
            nc.flatMethodApps.add(lettable);
            return incrementFlatness(f);
          }
        }
      }
      return undefined;
    }

    case 'a-prim-app':
      // A prim-app marked needsStep=false never needs the Pyret stack -- the async
      // codegen emits it as a direct, no-await call (compileLettableAsync). Honor
      // that so a function/method whose only "calls" are flat prim-apps (e.g. the
      // checkWrapBoolean / throwNoCasesMatched that `if`/`or`/`cases` desugar to)
      // can be sync. Gated to the promise backend (methodsEnabled): the cont
      // backend's flatness, codegen, and byte-parity oracle stay frozen.
      if (nc.methodsEnabled && !lettable.appInfo.needsStep) { return defaultRet; }
      return getFlatnessForCall(lettable.f, sd);

    // May check unknown annotations, so is nonflat
    case 'a-update':
      return undefined;

    // These are flat value constructors, and due to ANF, they only contain
    // values as sub-fields
    case 'a-ref': return defaultRet;
    case 'a-tuple': return defaultRet;
    case 'a-tuple-get': return defaultRet;
    case 'a-obj': return defaultRet;

    case 'a-extend': return defaultRet;
    case 'a-dot': return defaultRet;
    case 'a-colon': return defaultRet;
    case 'a-get-bang': return defaultRet;
    case 'a-lam': return defaultRet;
    case 'a-method': {
      // A data type's method: analyze its body like a lambda and record the
      // resulting flatness in the per-(dataType,methodName) table. Methods not
      // attached to an in-module data type (object literals, or unresolved) are
      // left opaque exactly as before (no recursion, no table entry).
      if (nc.methodsEnabled) {
        const mi = nc.methodOf.get(lettable);
        if (mi !== undefined) {
          const retF = annFlatness(lettable.ret, sd, ad, mb, env);
          let argsF = retF;
          for (const arg of lettable.args) {
            argsF = flatnessMax(argsF, annFlatness(arg.ann, sd, ad, mb, env));
          }
          const bodyF = makeExprFlatnessEnv(lettable.body, sd, ad, mb, env, nc);
          const methF = flatnessMax(bodyF, argsF);
          const key = mi.dataId + '#' + mi.methodName;
          const prev: Flatness = nc.methodTable.has(key) ? nc.methodTable.get(key) : 0;
          nc.methodTable.set(key, flatnessMax(prev, methF));
          if (methodFlatEnough(methF)) { nc.flatMethods.add(lettable); }
        }
      }
      return defaultRet;
    }
    case 'a-id-var': return defaultRet;
    case 'a-id-var-modref': return defaultRet;
    case 'a-id-letrec': return defaultRet;
    // (The Pyret original also lists an a-id-safe-letrec branch, but
    // a-id-safe-letrec is not an ALettable variant, so it is unreachable.)
    case 'a-val': return defaultRet;
    case 'a-data-expr': return defaultRet;
    // NOTE -- cases might not be flat b/c it checks annotations
    case 'a-cases': {
      // Flatness is the max of the flatness all the cases branches
      const combine = (caseBranch: AA.ACasesBranch, maxFlatAcc: Flatness): Flatness => {
        const branchFlatness = makeExprFlatnessEnv(caseBranch.body, sd, ad, mb, env, nc);
        return flatnessMax(maxFlatAcc, branchFlatness);
      };
      let maxFlat: Flatness = 0;
      for (const b of lettable.branches) {
        maxFlat = combine(b, maxFlat);
      }

      const elseFlat = makeExprFlatnessEnv(lettable._else, sd, ad, mb, env, nc);
      const typFlat = annFlatness(lettable.typ, sd, ad, mb, env);
      return flatnessMax(typFlat, flatnessMax(maxFlat, elseFlat));
    }
    default:
      throw new InternalCompilerError('makeLettableFlatnessEnv: unknown lettable ' + (lettable as any).$name);
  }
}

export function makeProgFlatnessEnv(
  anfed: AA.AProg,
  postEnv: C.ComputedEnvironment,
  env: C.CompileEnvironment,
  methodInfo?: MethodFlatInfo
): FlatnessEnv {
  const pe = postEnv as C.ComputedEnv;
  const bindings = pe.bindings;
  const moduleBindings = pe.moduleBindings;
  const mb = moduleBindings;
  const typeBindings = pe.typeBindings;

  const sd: FEnv = new Map();
  for (const k of bindings.keys()) {
    const vb = mapGetValue(bindings, k);
    if (!vb.origin.newDefinition) {
      if (A.isSGlobal(vb.atom)) {
        const name = vb.atom.toname();
        const ve = env.globalValue(name);
        if (ve !== undefined) {
          if (C.isVFun(ve)) {
            sd.set(vb.atom.key(), ve.flatness);
          }
        }
      } else {
        const valueExport = env.valueByUri(vb.origin.uriOfDefinition, vb.origin.originalName.toname());
        if (valueExport === undefined) {
          raise('The name: ' + vb.atom.toname() + ' could not be found on the module ' + vb.origin.uriOfDefinition);
        } else {
          if (C.isVFun(valueExport)) {
            sd.set(k, valueExport.flatness);
          }
        }
      }
    }
  }

  const ad: FEnv = new Map();
  function initTypeProvides(provides: C.Provides, tb: C.TypeBind): void {
    const name = tb.origin.originalName.toname();

    if (provides.dataDefinitions.has(name)) {
      // NOTE(joe): Datatypes _must_ just be flat brand checks
      ad.set(tb.atom.key(), 0);
    } else if (provides.aliases.has(name)) {
      // NOTE(joe): Right now we don't trust any cross-module aliases. We need to
      // get either a representation of flatness for annotations in provides, or
      // make sure that all provided annotations have a path back to the
      // underlying annotation in terms of datatypes and simple constructors so we
      // can use ann-flatness on them
      ad.set(tb.atom.key(), undefined);
    } else {
      raise("Unknown type key (shouldn't happen): " + name);
    }
  }
  for (const k of typeBindings.keys()) {
    const tb = mapGetValue(typeBindings, k);
    if (!tb.origin.newDefinition) {
      if (A.isSTypeGlobal(tb.atom)) {
        const name = tb.atom.toname();
        const providesOpt = env.providesByTypeName(name);
        if (providesOpt !== undefined) {
          initTypeProvides(providesOpt, tb);
        }
      } else {
        const modProvides = env.providesByUri(tb.origin.uriOfDefinition);
        if (modProvides === undefined) {
          raise('There is a type binding whose module is not in the compile env: ' + torepr(k) + ' ' + tb.origin.uriOfDefinition);
        } else {
          initTypeProvides(modProvides, tb);
        }
      }
    }
  }

  // cases(AA.AProg) anfed: | a-program(_, prov, imports, body)
  const body = anfed.body;
  const methodsEnabled = methodInfo !== undefined;
  const methodReceiver = methodInfo?.receiver ?? new Map<AA.AMethodApp, string>();
  const methodOf = methodInfo?.methodOf ?? new Map<AA.AMethod, { dataId: string; methodName: string }>();
  // Fixpoint over the per-(dataType,method) flatness table (see MethodCtx): each
  // pass resolves self-method calls against the previous pass's complete table and
  // repeats until the table is stable. A module with no in-module methods produces
  // an empty table and stops after one pass (== the old single pass, no overhead);
  // method dependency chains of depth d converge in ~d passes. The cap bounds
  // pathological cases and is sound (an unconverged slot just reads as non-flat).
  const MAX_METHOD_PASSES = 16;
  let methodTablePrev = new Map<string, Flatness>();
  let flatMethodApps = new Set<AA.AMethodApp>();
  let flatMethods = new Set<AA.AMethod>();
  for (let pass = 0; pass < MAX_METHOD_PASSES; pass++) {
    flatMethodApps = new Set<AA.AMethodApp>();
    flatMethods = new Set<AA.AMethod>();
    const nc: MethodCtx = {
      methodsEnabled, methodReceiver, methodOf,
      methodTable: new Map(),
      methodTablePrev,
      flatMethodApps,
      flatMethods,
    };
    // Inside the fixpoint: a type alias to a refinement (`type Nat = Number%(Nat)`)
    // has flatness = its predicate's flatness, but the predicate is an in-module
    // function whose flatness is only known after makeExprFlatnessEnv has run. So
    // recompute the data/type env each pass; once the predicate resolves flat, the
    // alias does too, and a method/function annotated `:: Nat` can then flatten.
    makeExprDataEnv(body, sd, ad, mb, env, new Map<string, AA.AVariant[]>(), new Map<string, string>());
    makeExprFlatnessEnv(body, sd, ad, mb, env, nc);
    const stable = flatnessMapsEqual(nc.methodTable, methodTablePrev);
    if (process.env.PYRET_METHOD_DEBUG && nc.methodTable.size > 0) {
      const rows = [...nc.methodTable.entries()].map(([k, f]) => `${k.split('#').pop()}=${f === undefined ? 'INF' : f}`);
      process.stderr.write(`[method-flat] pass ${pass} recv=${methodReceiver.size}: ${rows.join(' ')}\n`);
    }
    methodTablePrev = nc.methodTable;
    if (!methodsEnabled || stable) { break; }
  }
  if (process.env.PYRET_METHOD_DEBUG && methodTablePrev.size > 0) {
    const rows = [...methodTablePrev.entries()].map(([k, f]) => `${k}=${f === undefined ? 'INF' : f}`);
    process.stderr.write(`[method-flat] table: ${rows.join('  ')}\n[method-flat] flatMethods=${flatMethods.size} flatMethodApps=${flatMethodApps.size}\n`);
  }
  return [sd, ad, flatMethodApps, flatMethods, methodTablePrev];
}

// Equality of two (dataType,method) -> Flatness tables, for the method fixpoint's
// convergence check (a stored `none`/undefined value is distinct from absent).
function flatnessMapsEqual(a: Map<string, Flatness>, b: Map<string, Flatness>): boolean {
  if (a.size !== b.size) { return false; }
  for (const [k, v] of a) {
    if (!b.has(k) || b.get(k) !== v) { return false; }
  }
  return true;
}

export function getDefinedValues(ast: AA.AProg): Map<string, string> {
  function help(ae: AA.AExpr): AA.AModule {
    switch (ae.$name) {
      case 'a-type-let': return help(ae.body);
      case 'a-let': return help(ae.body);
      case 'a-arr-let': return help(ae.body);
      case 'a-var': return help(ae.body);
      case 'a-seq': return help(ae.e2);
      case 'a-lettable': {
        const e = ae.e;
        if (!AA.isAModule(e)) {
          raise('Ill-formed ANF ast: ' + torepr(e));
        }
        return e;
      }
      default:
        throw new InternalCompilerError('getDefinedValues: unknown expr ' + (ae as any).$name);
    }
  }

  const theModule = help(ast.body);
  const theDvs = theModule.definedValues;

  const dvsDict = new Map<string, string>();
  for (const d of theDvs) {
    switch (d.$name) {
      case 'a-defined-value':
        dvsDict.set(d.name, ((d.value as any).id as A.Name).key());
        break;
      case 'a-defined-var':
        dvsDict.set(d.name, d.id.key());
        break;
      default:
        throw new InternalCompilerError('getDefinedValues: unknown defined value ' + (d as any).$name);
    }
  }

  return dvsDict;
}

export function getFlatProvides(
  provides: C.Provides,
  env: C.CompileEnvironment,
  postEnv: C.ComputedEnvironment,
  flatnessEnvAndTypes: FlatnessEnv,
  ast: AA.AProg
): C.Provides {
  // dvs-dict is computed (and may raise on ill-formed ASTs) but unused,
  // exactly as in the Pyret original
  getDefinedValues(ast);
  const flatnessEnv = flatnessEnvAndTypes[0];
  const pe = postEnv as C.ComputedEnv;
  // cases(C.Provides) provides: | provides(uri, modules, values, aliases, datatypes)
  const uri = provides.fromUri;
  const modules = provides.modules;
  const values = provides.values;
  const aliases = provides.aliases;
  const datatypes = provides.dataDefinitions;
  const newValues = new Map<string, C.ValueExport>();
  for (const k of values.keys()) {
    let newVal: C.ValueExport;
    const bind = pe.env.get(k);
    if (bind === undefined) {
      newVal = mapGetValue(values, k);
    } else {
      // MutableStringDict<Flatness>.get-now is a double Option: use has()
      // to distinguish absent from present-but-none
      const hasFlatness = flatnessEnv.has(bind.atom.key());
      const maybeFlatness = flatnessEnv.get(bind.atom.key());
      const ve = mapGetValue(values, k);
      let existingVal: C.ValueExport;
      if (C.isVAlias(ve)) {
        existingVal = env.valueByUriValue(ve.origin.uriOfDefinition, ve.origin.originalName.toname());
      } else {
        existingVal = ve;
      }
      if (!hasFlatness) {
        newVal = ve;
      } else {
        // existing-val.t errors in Pyret if existing-val is a v-alias;
        // mirrored here with a dynamic access
        newVal = new C.VFun(ve.origin, (existingVal as any).t, k, maybeFlatness);
      }
    }
    newValues.set(k, newVal);
  }
  return new C.Provides(uri, modules, newValues, aliases, datatypes);
}
