/*
  Repartee (Read, Eval, Print, And Respond To Each Edit) — an incremental
  re-run engine, the notebook-aware sibling of repl.ts.

  Paper: https://jpolitz.github.io/docs/plateau-2021-repartee.pdf

  Where repl.ts is an append-only chain (each interaction runs against a single
  forward-moving realm/globals), repartee is a notebook of ordered, editable
  chunks: it must be able to re-run starting from ANY chunk, not just the tail,
  because editing a chunk invalidates it and everything after it.

  Two layers, kept separate on purpose:
    - THIS layer is the pure incremental dataflow engine. Given an ordered list
      of locators it runs them, threading the environment forward and stopping
      at the first error, while memoizing the environment at each chunk boundary
      so a later call can resume from any of them.
    - The UI layer (CodeMirror buffers + edited/invalidated flags) lives
      elsewhere and is responsible for deciding WHICH contiguous suffix of
      locators to hand to rerunInteractions. The engine owns no source strings;
      locators read live from the editor.

  Reused from repl.ts unchanged: ReplExecutor, Finder, ReplEnv, copyEnv,
  makeCachingFinder, runOne, makeProvideForRepl.
*/

import * as A from './ast';
import * as CS from './compile-structs';
import * as CL from './compile-lib';
import * as P from './parse-pyret';
import { Either } from './shared';
import {
  ReplExecutor, Finder, ReplEnv,
  copyEnv, makeCachingFinder, runOne, makeProvideForRepl,
} from './repl';

// ---------------------------------------------------------------------------
// Result type: exactly the repl's Either, plus a Skip marker for chunks that
// never ran because an earlier chunk errored. The non-skip values ARE the
// Either<any[], Result> that hosts already render (left = compile problems,
// right = run answer), so existing rendering needs only a `$name === 'skip'`
// guard in front of it.
// ---------------------------------------------------------------------------

export interface Skip { $name: 'skip'; }
export const skip: Skip = { $name: 'skip' };

// A chunk whose compilation THREW rather than returning compile problems —
// most commonly a parse/syntax error (surfaceParse throws a PyretParseError).
// The repl exposes this same outcome by throwing out of runInteraction (CPO
// handles it with `.catch(resolveWithError)`); we keep it a value instead of a
// rejection so the result list stays uniform and Promise.all never blows up.
export interface Thrown { $name: 'thrown'; error: any; }

// Exactly the three outcomes the repl can produce for one chunk — resolve to a
// left (compile problems), resolve to a right (run answer), or throw — plus
// Skip for chunks that never ran because an earlier chunk stopped evaluation.
export type ReRunResult<Result = any> = Skip | Thrown | Either<any[], Result>;

export function isSkip(r: ReRunResult): r is Skip { return r.$name === 'skip'; }
export function isThrown(r: ReRunResult): r is Thrown { return r.$name === 'thrown'; }

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface RerunOptions {
  // Compile options for this run (defaults to the runner's default options).
  options?: CS.CompileOptions;
  // Resume AFTER the chunk with this uri — i.e. start from that chunk's recorded
  // end-state. Use this to run brand-new chunks (append at the end, or insert in
  // the middle) without re-running anything: pass the uri of the already-run
  // chunk that precedes the first locator. When omitted, the first locator runs
  // from its OWN recorded start-state (re-run / edit of an existing chunk), or
  // from the base environment if it has none (a first run / re-run all).
  after?: string;
}

export interface ReparteeRunner<A2, Realm = any, Result = any> {
  // Run the given locators in order, stopping at the first error. Returns one
  // promise per input locator, SYNCHRONOUSLY, so a UI can wire up per-chunk
  // handlers and show results as each chunk settles. The inner promises never
  // reject: a chunk that ran resolves to its Either, one whose compile threw
  // resolves to a Thrown, and a chunk after an error resolves to `skip`.
  //
  // Resume point (see RerunOptions.after): an `after` uri resumes from that
  // chunk's end-state; otherwise the first locator resumes from its own
  // recorded start-state, or the base environment if it has none.
  rerunInteractions(
    locators: CL.Locator[],
    options?: CS.CompileOptions | RerunOptions
  ): Promise<ReRunResult<Result>>[];

  // The recorded end-state uri set — chunks that have successfully run and can
  // therefore be used as an `after` anchor. (Mostly for tests / introspection.)
  hasEndState(uri: string): boolean;

  // Forget all memoized boundaries and restore the base realm/modules/globals,
  // so the next rerun starts genuinely fresh (a clean-realm "run all").
  clearSnapshots(): void;
}

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; }
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// Delegating wrapper that overrides getGlobals. compileModule reads
// locator.getGlobals(), but in a notebook the globals a chunk sees depend on
// the (possibly re-run) chunks before it, not on whatever was baked into the
// locator. The engine injects the threaded globals here; the locator's own
// getGlobals is ignored.
function withGlobals(loc: CL.Locator, globals: CS.Globals): CL.Locator {
  return {
    needsCompile: (p) => loc.needsCompile(p),
    getModifiedTime: () => loc.getModifiedTime(),
    getOptions: (o) => loc.getOptions(o),
    getModule: () => loc.getModule(),
    getDependencies: () => loc.getDependencies(),
    getNativeModules: () => loc.getNativeModules(),
    getExtraImports: () => loc.getExtraImports(),
    getGlobals: () => globals,
    uri: () => loc.uri(),
    name: () => loc.name(),
    setCompiled: (l, p) => loc.setCompiled(l, p),
    getCompiled: () => loc.getCompiled(),
    getUncached: loc.getUncached ? () => loc.getUncached!() : undefined,
    realPath: loc.realPath,
  };
}

export function makeReparteeRunner<A2, Realm = any, Result = any>(
  executor: ReplExecutor<Realm, Result>,
  modules: Map<string, CS.Loadable>,
  realm: Realm,
  compileContext: A2,
  makeFinder: () => Finder<A2>,
  defaultOptions?: CS.CompileOptions
): ReparteeRunner<A2, Realm, Result> {

  const baseOptions: CS.CompileOptions =
    defaultOptions ?? { ...CS.defaultCompileOptions, checks: 'main' };

  // The pristine starting environment. Never mutated: every run copies it (or a
  // stored snapshot) before threading forward.
  const baseEnv: ReplEnv<Realm> = {
    globals: CS.standardGlobals,
    realm,
    modules,
    locatorCache: new Map(),
  };

  // Per-chunk boundary snapshots, keyed by locator uri:
  //   startEnvs[uri] = the env the chunk runs AGAINST (its pre-state). Used to
  //     re-run an existing chunk (an edit) from the same boundary. Independent
  //     of the chunk's own source.
  //   endEnvs[uri]   = the env AFTER the chunk ran successfully (its post-state).
  //     Used as an `after` anchor: run brand-new chunks that follow this one
  //     without re-running it (append / insert). Recorded only on success.
  let startEnvs = new Map<string, ReplEnv<Realm>>();
  let endEnvs = new Map<string, ReplEnv<Realm>>();

  function hasEndState(uri: string): boolean { return endEnvs.has(uri); }

  function clearSnapshots(): void {
    startEnvs = new Map();
    endEnvs = new Map();
  }

  function rerunInteractions(
    locators: CL.Locator[],
    options?: CS.CompileOptions | RerunOptions
  ): Promise<ReRunResult<Result>>[] {
    // Second arg is either a bare CompileOptions (back-compat) or a RerunOptions
    // bag. Distinguish by the presence of repartee-specific keys.
    const bag: RerunOptions =
      options && ('after' in options || 'options' in options)
        ? (options as RerunOptions)
        : { options: options as CS.CompileOptions | undefined };
    const opts = bag.options ?? baseOptions;
    const after = bag.after;
    const deferreds = locators.map(() => makeDeferred<ReRunResult<Result>>());

    // Detached driver: runs chunks sequentially (each needs the prior env) and
    // resolves each cell as it settles. Returns synchronously below.
    (async () => {
      // Resume point: an explicit `after` anchor uses that chunk's end-state;
      // otherwise the head's own recorded start-state (re-run / edit); otherwise
      // the base environment (first run / re-run all from definitions).
      const resumeFrom =
        (after !== undefined ? endEnvs.get(after) : undefined) ??
        (locators.length > 0 ? startEnvs.get(locators[0].uri()) : undefined) ??
        baseEnv;
      const env = copyEnv<Realm>(resumeFrom);
      const finder = makeCachingFinder(env, makeFinder());
      let stopped = false;
      for (let i = 0; i < locators.length; i++) {
        const loc = locators[i];
        if (stopped) { deferreds[i].resolve(skip); continue; }
        // Record the env THIS chunk runs against (its pre-state), before it
        // mutates it. (Skipped chunks keep their stale snapshot; the UI never
        // starts a rerun at a skipped chunk — earliest-dirty is at or before the
        // chunk that errored.)
        startEnvs.set(loc.uri(), copyEnv(env));
        let result: ReRunResult<Result>;
        try {
          result = await runOne<A2, Realm, Result>(
            executor, finder, compileContext, env, withGlobals(loc, env.globals), opts);
        } catch (e) {
          // A static error that throws rather than returning problems (parse
          // errors, well-formedness throws). Treat it as this chunk's terminal
          // result and stop evaluation, exactly like a compile-error left.
          result = { $name: 'thrown', error: e };
        }
        deferreds[i].resolve(result);
        const ranOk = result.$name === 'right' && executor.isSuccessResult((result as any).v);
        if (ranOk) {
          // env is now this chunk's post-state; record it as an `after` anchor.
          endEnvs.set(loc.uri(), copyEnv(env));
        } else {
          stopped = true;
        }
      }
    })().catch((err) => {
      // Defensive: an engine-level (non-chunk) failure. Resolve any still-
      // pending cells so the UI never hangs; already-resolved cells are
      // unaffected (resolve is idempotent).
      // eslint-disable-next-line no-console
      console.error('repartee: rerunInteractions driver error', err);
      for (const d of deferreds) { d.resolve(skip); }
    });

    return deferreds.map((d) => d.promise);
  }

  return { rerunInteractions, hasEndState, clearSnapshots };
}

// ---------------------------------------------------------------------------
// Locator builders for repartee chunks
//
// A repartee chunk needs the same provide-* rewriting as a repl interaction (so
// its bindings chain into later chunks) but, unlike repl, must re-parse when its
// source changes — the UI keeps a stable uri per buffer and may re-run an edited
// chunk through the same locator. We therefore key the cached AST on the source
// string. getGlobals is a placeholder (standardGlobals); the engine overrides it
// via withGlobals at run time.
// ---------------------------------------------------------------------------

export type ChunkKind = 'definitions' | 'interaction';

export function makeChunkLocator(
  uri: string,
  getSource: () => string,
  kind: ChunkKind = 'interaction'
): CL.Locator {
  let cachedSource: string | undefined = undefined;
  let cachedAst: A.Program | undefined = undefined;
  function getAst(): A.Program {
    const s = getSource();
    if (cachedAst === undefined || s !== cachedSource) {
      cachedSource = s;
      cachedAst = makeProvideForRepl(P.surfaceParse(s, uri));
    }
    return cachedAst;
  }
  const isDefs = kind === 'definitions';
  const self: CL.Locator = {
    needsCompile: (_provs) => true,
    getModifiedTime: () => 0,
    getOptions: (options) => options,
    getNativeModules: () => [],
    getModule: () => new CL.PyretAst(getAst()),
    getExtraImports: () => (isDefs ? CS.standardImports : new CS.ExtraImports([])),
    getDependencies: () => {
      if (isDefs) {
        return CL.getStandardDependencies(self.getModule(), uri);
      }
      const modDeps = CL.getDependencies(self.getModule(), uri);
      return [...modDeps, ...self.getExtraImports().imports.map((i) => i.dependency)];
    },
    getGlobals: () => CS.standardGlobals,
    uri: () => uri,
    name: () => (isDefs ? 'definitions' : uri),
    setCompiled: (_loadable, _provides) => undefined,
    getCompiled: () => undefined,
  };
  return self;
}
