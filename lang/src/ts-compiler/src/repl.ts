/*
  Ported from: src/arr/compiler/repl.arr

  The REPL library: manages the chain of interaction modules, threading
  each interaction's provides into the next one's globals, exactly as the
  Pyret original does. The original talks to runtime-lib/load-lib realms
  directly; those are Pyret-runtime constructs, so this port factors them
  behind a host-provided ReplExecutor. The compile side (provide
  rewriting, globals chaining, locator caching, worklist compilation) is
  fully implemented here; the host (e.g. code.pyret.org wrapping
  load-lib, or a test harness) supplies execution.

  Mirrors of the runtime touchpoints in repl.arr:
    CL.run-program(ws, prog, realm, runtime, options)
      -> compile errors are filtered HERE (left(problems)), then
         executor.run(realm, jsSource, options) receives the standalone
         program source (program.js-ast.to-ugly-source()), like
         L.run-program in the original.
    L.is-success-result(answer) -> executor.isSuccessResult(answer)
    L.get-result-realm(answer)  -> executor.getResultRealm(answer)
*/

import * as A from './ast';
import * as CS from './compile-structs';
import * as CL from './compile-lib';
import * as P from './parse-pyret';
import { Either, left, right, mapSet } from './shared';

// Result is whatever the host's run produces (a load-lib result in CPO).
// run may be synchronous or return a Promise (a browser host has to thread
// execution through the Pyret runtime's trampoline, which is async); the
// repl awaits it either way, so its own entry points return Promises.
export interface ReplExecutor<Realm = any, Result = any> {
  run(realm: Realm, programJsSource: string, options: CS.CompileOptions): Result | Promise<Result>;
  isSuccessResult(result: Result): boolean;
  getResultRealm(result: Result): Realm;
}

export type Finder<A2> = (context: A2, dep: CS.AnyDependency) => CL.Located<A2>;

export function makeProvideForRepl(p: A.Program): A.Program {
  return new A.SProgram(
    p.l,
    p._use,
    new A.SProvideNone(p.l),
    new A.SProvideTypesNone(p.l),
    [...p.provides, new A.SProvideBlock(p.l, [], [
      new A.SProvideName(p.l, new A.SStar(p.l, [])),
      new A.SProvideType(p.l, new A.SStar(p.l, [])),
      new A.SProvideModule(p.l, new A.SStar(p.l, []))
      // Adding s-provide-data for imports would be redundant because the
      // name/type exports will refer to the data anyway
    ])],
    p.imports,
    p.block
  );
}

export function addGlobalsFromEnv(postEnv: CS.ComputedEnv, g: CS.Globals): CS.Globals {
  let moduleGlobals = g.modules;
  for (const [k, mb] of postEnv.moduleEnv) {
    moduleGlobals = mapSet(moduleGlobals, k, mb.origin);
  }
  let valGlobals = g.values;
  for (const [k, vb] of postEnv.env) {
    valGlobals = mapSet(valGlobals, k, vb.origin);
  }
  let typeGlobals = g.types;
  for (const [k, tb] of postEnv.typeEnv) {
    typeGlobals = mapSet(typeGlobals, k, tb.origin);
  }
  return new CS.Globals(moduleGlobals, valGlobals, typeGlobals);
}

// Mirrors CL.run-program from compile-lib.arr for the repl's use: filter
// compile errors, build the standalone program, hand its JS source to the
// executor.
async function runProgramWith<Realm, Result>(
  executor: ReplExecutor<Realm, Result>,
  ws: CL.ToCompile[],
  prog: CL.CompiledProgram,
  realm: Realm,
  options: CS.CompileOptions
): Promise<Either<any[], Result>> {
  const errors = prog.loadables.filter(CL.isErrorCompilation);
  if (errors.length === 0) {
    const program = CL.makeStandalone(ws, prog, options);
    if (program.$name === 'left') {
      return left(program.v as any[]);
    }
    return right(await executor.run(realm, program.v.jsAst.toUglySource(), options));
  } else {
    return left(errors.map((e) => e.resultPrinter));
  }
}

// The evaluation state threaded across interactions: the compile-time globals
// and the host's realm, plus the compiled-module and dependency-locator caches.
// globals/realm are functional (each successful run yields fresh ones), so they
// are held by reference; modules/locatorCache are mutable and so are copied when
// snapshotting (see copyEnv). The repl holds a single live ReplEnv; the repartee
// runner keeps one per chunk boundary so it can resume from any of them.
export interface ReplEnv<Realm = any> {
  globals: CS.Globals;
  realm: Realm;
  modules: Map<string, CS.Loadable>;
  locatorCache: Map<string, CL.Locator>;
}

// Snapshot copy: globals/realm by reference (immutable in the threading),
// modules/locatorCache shallow-copied (values are immutable compiled artifacts
// / locators, so a shallow copy is safe and cheap).
export function copyEnv<Realm>(e: ReplEnv<Realm>): ReplEnv<Realm> {
  return {
    globals: e.globals,
    realm: e.realm,
    modules: new Map(e.modules),
    locatorCache: new Map(e.locatorCache),
  };
}

// Wraps a finder so that already-known dependency locators resolve from the
// env's cache before falling back. Mirrors the inline finder repl.arr builds.
export function makeCachingFinder<A2>(
  env: { locatorCache: Map<string, CL.Locator> },
  fallback: Finder<A2>
): Finder<A2> {
  return (context, dep) => {
    if (dep instanceof CS.Dependency) {
      const cached = env.locatorCache.get(dep.arguments[0]);
      if (cached !== undefined) {
        return new CL.Located(cached, context);
      }
    }
    return fallback(context, dep);
  };
}

// Runs a single locator against env, mutating env in place. Mirrors repl.arr's
// run-interaction + update-env: the compiled modules are always merged into the
// module cache, but globals/realm/locator-cache advance ONLY on a successful run
// (compile errors -> left, runtime failures -> right with isSuccessResult false
// both leave the threaded env's globals/realm untouched). Returns the repl's
// Either result.
export async function runOne<A2, Realm, Result>(
  executor: ReplExecutor<Realm, Result>,
  finder: Finder<A2>,
  compileContext: A2,
  env: ReplEnv<Realm>,
  locator: CL.Locator,
  options: CS.CompileOptions
): Promise<Either<any[], Result>> {
  const worklist = CL.compileWorklistKnownModules(finder, locator, compileContext, env.modules as any);
  const compiled = CL.compileProgramWith(worklist, env.modules, options);
  for (const [k, v] of compiled.modules) {
    env.modules.set(k, v);
  }
  const result = await runProgramWith(executor, worklist, compiled, env.realm, options);
  if (result.$name === 'right' && executor.isSuccessResult(result.v)) {
    const last = compiled.loadables[compiled.loadables.length - 1];
    env.globals = addGlobalsFromEnv(last.postCompileEnv as CS.ComputedEnv, env.globals);
    env.locatorCache.set(locator.uri(), locator);
    env.realm = executor.getResultRealm(result.v);
  }
  return result;
}

export interface Repl<A2, Realm = any, Result = any> {
  restartInteractions(defsLocator: CL.Locator, options: CS.CompileOptions): Promise<Either<any[], Result>>;
  makeInteractionLocator(getInteractions: () => string): CL.Locator;
  makeDefinitionsLocator(getDefs: () => string, globals: CS.Globals): CL.Locator;
  runInteraction(locator: CL.Locator): Promise<Either<any[], Result>>;
}

export function makeRepl<A2, Realm = any, Result = any>(
  executor: ReplExecutor<Realm, Result>,
  modules: Map<string, CS.Loadable>,
  realm: Realm,
  compileContext: A2,
  makeFinder: () => Finder<A2>
): Repl<A2, Realm, Result> {

  let currentCompileOptions: CS.CompileOptions = { ...CS.defaultCompileOptions, checks: 'main' };
  let env: ReplEnv<Realm> = {
    globals: CS.standardGlobals,
    realm,
    modules,
    locatorCache: new Map(),
  };
  let currentInteraction = 0;
  let currentFinder: Finder<A2> = makeFinder();

  // Built once; reads the live env's cache and the latest currentFinder (both
  // reassigned by restartInteractions), so it tracks state across restarts.
  const finder: Finder<A2> = (context, dep) => {
    if (dep instanceof CS.Dependency) {
      const cached = env.locatorCache.get(dep.arguments[0]);
      if (cached !== undefined) {
        return new CL.Located(cached, context);
      }
    }
    return currentFinder(context, dep);
  };

  function runInteraction(locator: CL.Locator): Promise<Either<any[], Result>> {
    return runOne(executor, finder, compileContext, env, locator, currentCompileOptions);
  }

  function restartInteractions(defsLocator: CL.Locator, options: CS.CompileOptions): Promise<Either<any[], Result>> {
    currentInteraction = 0;
    currentCompileOptions = options;
    env = {
      globals: defsLocator.getGlobals(),
      realm,
      modules: new Map(modules), // Make a copy
      locatorCache: new Map(),
    };
    currentFinder = makeFinder();
    return runInteraction(defsLocator);
  }

  function makeInteractionLocator(getInteractions: () => string): CL.Locator {
    currentInteraction = currentInteraction + 1;
    const thisInteraction = currentInteraction;
    const uri = 'interactions://' + String(thisInteraction);
    let ast: A.Program | undefined = undefined;
    function getAst(): A.Program {
      if (ast === undefined) {
        const interactions = getInteractions();
        const parsed = P.surfaceParse(interactions, uri);
        ast = makeProvideForRepl(parsed);
      }
      return ast;
    }
    const globalsNow = env.globals;
    const self: CL.Locator = {
      getUncached: () => undefined,
      needsCompile: (_provs) => true,
      getModifiedTime: () => 0,
      getOptions: (options) => options,
      getNativeModules: () => [],
      getModule: () => new CL.PyretAst(getAst()),
      getExtraImports: () => new CS.ExtraImports([]),
      getDependencies: () => {
        const modDeps = CL.getDependencies(self.getModule(), self.uri());
        return [...modDeps, ...self.getExtraImports().imports.map((i) => i.dependency)];
      },
      getGlobals: () => globalsNow,
      uri: () => uri,
      name: () => 'interactions' + String(thisInteraction),
      setCompiled: (_env, _result) => undefined,
      getCompiled: () => undefined,
    };
    return self;
  }

  function makeDefinitionsLocator(getDefs: () => string, defsGlobals: CS.Globals): CL.Locator {
    let ast: A.Program | undefined = undefined;
    function getAst(): A.Program {
      if (ast === undefined) {
        const initialDefinitions = getDefs();
        const parsed = P.surfaceParse(initialDefinitions, 'definitions://');
        ast = makeProvideForRepl(parsed);
      }
      return ast;
    }
    const self: CL.Locator = {
      getUncached: () => undefined,
      needsCompile: (_provs) => true,
      getModifiedTime: () => 0,
      getOptions: (options) => options,
      getNativeModules: () => [],
      getModule: () => new CL.PyretAst(getAst()),
      getExtraImports: () => CS.standardImports,
      getDependencies: () => CL.getStandardDependencies(self.getModule(), self.uri()),
      getGlobals: () => defsGlobals,
      uri: () => 'definitions://',
      name: () => 'definitions',
      setCompiled: (_env, _result) => undefined,
      getCompiled: () => undefined,
    };
    return self;
  }

  return {
    restartInteractions,
    makeInteractionLocator,
    makeDefinitionsLocator,
    runInteraction,
  };
}
