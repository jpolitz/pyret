/*
  Ported from: src/arr/compiler/js-of-pyret.arr
  Glue between the ANF/codegen back end and compile-lib: runs ANF,
  flatness analysis, and the splitting compiler, and wraps the resulting
  dict of JS expressions in a CompiledCodePrinter.
*/

import * as fs from 'fs';
import * as A from './ast';
import * as N from './anf';
import * as AL from './anf-loop-compiler';
import * as AAL from './anf-loop-compiler-async';
import * as C from './compile-structs';
import * as CL from './concat-lists';
import * as FL from './flatness';
import * as TF from './type-flow';
import * as J from './js-ast';
import * as PP from './pprint';

const clEmpty = CL.clEmpty;
const clCons = CL.clCons;

// Note: in the Pyret original (cl-map-sd over a string-dict) field order
// follows Pyret's hash ordering; here we use Map insertion order. The
// object field order in emitted files is not semantically significant.
function clMapSd<T>(f: (key: string) => T, sd: Map<string, J.JExprT>): CL.ConcatList<T> {
  let acc: CL.ConcatList<T> = clEmpty as any;
  for (const key of sd.keys()) {
    acc = clCons(f(key), acc);
  }
  return acc;
}

export abstract class CompiledCodePrinterBase {
  abstract pyretToJsRunnable(): string;
  abstract printJsRunnable(printer: (s: string) => void): void;
}

export class CCPDict extends CompiledCodePrinterBase {
  get $name(): 'ccp-dict' { return 'ccp-dict'; }
  constructor(public dict: Map<string, J.JExprT>) { super(); }

  toJExpr(d: Map<string, J.JExprT>): J.JExprT {
    return new J.JParens(new J.JObj(clMapSd((k: string) => new J.JField(k, d.get(k)!), d)));
  }
  private dictWithout(key: string): Map<string, J.JExprT> {
    const d2 = new Map(this.dict);
    d2.delete(key);
    return d2;
  }
  pyretToJsStatic(): string {
    return this.toJExpr(this.dictWithout('theModule')).toUglySource();
  }
  printJsStatic(printer: (s: string) => void): void {
    printer(this.pyretToJsStatic());
  }
  pyretToJsPretty(): PP.PPrintDoc {
    return this.toJExpr(this.dict).tosource();
  }
  pyretToJsRunnable(): string {
    return this.toJExpr(this.dict).toUglySource();
  }
  printJsRunnable(printer: (s: string) => void): void {
    printer(this.pyretToJsRunnable());
  }
}

export class CCP extends CompiledCodePrinterBase {
  get $name(): 'ccp' { return 'ccp'; }
  constructor(public compiled: J.JExprT) { super(); }
  pyretToJsPretty(): PP.PPrintDoc {
    return this.compiled.tosource();
  }
  pyretToJsRunnable(): string {
    return this.compiled.toUglySource();
  }
  printJsRunnable(printer: (s: string) => void): void {
    printer(this.pyretToJsRunnable());
  }
}

export class CCPString extends CompiledCodePrinterBase {
  get $name(): 'ccp-string' { return 'ccp-string'; }
  constructor(public compiled: string) { super(); }
  pyretToJsPretty(): PP.PPrintDoc {
    return PP.str(this.compiled);
  }
  pyretToJsRunnable(): string {
    return this.compiled;
  }
  printJsRunnable(printer: (s: string) => void): void {
    printer(this.compiled);
  }
}

export class CCPFile extends CompiledCodePrinterBase {
  get $name(): 'ccp-file' { return 'ccp-file'; }
  constructor(public path: string) { super(); }
  pyretToJsRunnable(): string {
    return fs.readFileSync(this.path, 'utf8');
  }
  printJsRunnable(printer: (s: string) => void): void {
    printer(this.pyretToJsRunnable());
  }
}

export type CompiledCodePrinter = CCPDict | CCP | CCPString | CCPFile;

export function isCCPDict(x: any): x is CCPDict { return x instanceof CCPDict; }
export function isCCPString(x: any): x is CCPString { return x instanceof CCPString; }
export function isCCPFile(x: any): x is CCPFile { return x instanceof CCPFile; }

export function traceMakeCompiledPyret(
  addPhase: (name: string, value: any) => any,
  programAst: A.Program,
  env: C.CompileEnvironment,
  postEnv: C.ComputedEnvironment,
  provides: C.Provides,
  options: C.CompileOptions
): [C.Provides, C.CompileResult<CompiledCodePrinter>] {
  const anfedRaw = addPhase('ANFed', N.anfProgram(programAst));
  // Typed operator weakening (promise backend only): rewrite polymorphic operator
  // apps (`_plus` ...) into monomorphic, known-flat globals (`_plus_nums` ...) where
  // upper-bound type-flow proves the operand types, so ORDINARY structural flatness
  // flattens the arithmetic (no numeric special-casing in flatness.ts). An ANF->ANF
  // rewrite, so it MUST run before the flatness env build and codegen: every later
  // pass keys off (and codegen visits) the weakened ANF object graph, never the raw
  // one. Gated like ann elision: the ub facts rest on the runtime ann checks.
  const anfed =
    (C.isPromise(options.stackBackend) && options.opWeakening
      && options.runtimeAnnotations && options.userAnnotations)
      ? addPhase('Operator weakening', TF.weakenOperators(anfedRaw, postEnv, env, provides.fromUri))
      : anfedRaw;
  const flatnessEnv = addPhase('Build flatness env', FL.makeProgFlatnessEnv(anfed, postEnv, env));
  const flatProvides = addPhase('Get flat-provides', FL.getFlatProvides(provides, env, postEnv, flatnessEnv, anfed));
  // Upper-bound type-flow: bind keys whose `:: T` annotation check is provably
  // redundant. Promise backend only (cont codegen stays frozen for the byte-parity
  // oracle, and this set is never consulted there). Self-disables unless runtime
  // annotations are intact -- the ub facts rest on the checks that actually run.
  const redundantAnnChecks =
    (C.isPromise(options.stackBackend) && options.annElision
      && options.runtimeAnnotations && options.userAnnotations)
      ? addPhase('Type-flow ann elision',
        TF.makeProgTypeFlowEnv(anfed, postEnv, env, flatnessEnv, flatProvides.fromUri))
      : new Set<string>();
  // Dispatch to the requested control-flow backend. `auto` is resolved to a
  // concrete promise|cont before reaching here (see compile-structs / the CLI),
  // but is defended to cont in case a caller passes it through.
  const compiled = C.isPromise(options.stackBackend)
    ? anfed.visit(AAL.splittingCompiler(env, addPhase, flatnessEnv, flatProvides, postEnv, options, redundantAnnChecks))
    : anfed.visit(AL.splittingCompiler(env, addPhase, flatnessEnv, flatProvides, postEnv, options));
  return [flatProvides, addPhase('Generated JS', C.ok(new CCPDict(compiled)))];
}

export function makeCompiledPyret(
  programAst: any,
  env: C.CompileEnvironment,
  postEnv: C.ComputedEnvironment,
  provides: C.Provides,
  options: C.CompileOptions
): [C.Provides, CompiledCodePrinter] {
  const anfed = N.anfProgram(programAst);
  const flatnessEnv = FL.makeProgFlatnessEnv(anfed, postEnv, env);
  const flatProvides = FL.getFlatProvides(provides, env, postEnv, flatnessEnv, anfed);
  const compiled = anfed.visit(AL.splittingCompiler(env, (_name: string, v: any) => v, flatnessEnv, flatProvides, postEnv, options));
  return [flatProvides, new CCPDict(compiled)];
}
