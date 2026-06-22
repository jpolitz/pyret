/*
  Repartee (Read, Eval, Print, And Respond To Each Edit) — an incremental
  re-run engine, the notebook-aware sibling of repl.ts.

  Paper: https://jpolitz.github.io/docs/plateau-2021-repartee.pdf

  Where repl.ts is an append-only chain (each interaction runs against a single
  forward-moving realm/globals), repartee is a notebook of ordered, editable
  chunks: it must be able to re-run starting from ANY chunk, not just the tail,
  because editing a chunk invalidates it and everything after it.

  Two layers, kept separate on purpose:
    - THIS layer is the pure incremental dataflow engine. Given the COMPLETE,
      ordered roster of chunk locators and an index to start at, it re-runs the
      chunks from that index forward, threading the environment and stopping at
      the first error, while memoizing the environment after each chunk so a later
      call can resume from any boundary.
    - The UI layer (CodeMirror buffers + edited/invalidated flags) lives
      elsewhere and is responsible for deciding the startIndex — the earliest
      chunk whose result is no longer valid. The engine owns no source strings;
      locators read live from the editor.

  The roster is the single source of truth: it is the whole notebook, every call.
  The engine resumes from the recorded end-state of the chunk just before
  startIndex (so editing or deleting a chunk never re-runs anything before it),
  and reclaims memoized state for any chunk that has left the roster (a deletion)
  without the UI signalling liveness separately. Deleting a chunk is therefore
  exactly as cheap as blanking it to "": both re-run the suffix from the
  predecessor's end-state.

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
// Per-chunk result. A rerun returns one entry per roster locator, ALWAYS the
// same length as the roster, so a UI can index results positionally. Three kinds
// distinguish WHY a chunk does or does not have a fresh result:
//   - PrefixSkipped: the chunk is before startIndex. It was deliberately left
//     alone (not re-run); the UI keeps its existing render.
//   - NotReached: the chunk is at or after startIndex, but an earlier chunk in
//     this run errored, so evaluation stopped before reaching it.
//   - a "ran" outcome: the chunk actually compiled/ran — either Thrown (a
//     compile that threw, most commonly a parse error) or the repl's
//     Either<problems, Result> (left = compile problems, right = run answer).
//     These are exactly what hosts already render.
// ---------------------------------------------------------------------------

// A retained chunk before startIndex — not re-run this pass.
export interface PrefixSkipped { $name: 'prefix-skipped'; }
export const prefixSkipped: PrefixSkipped = { $name: 'prefix-skipped' };

// A chunk at/after startIndex that an earlier error stopped us from reaching.
export interface NotReached { $name: 'not-reached'; }
export const notReached: NotReached = { $name: 'not-reached' };

// A chunk whose compilation THREW rather than returning compile problems —
// most commonly a parse/syntax error (surfaceParse throws a PyretParseError).
// The repl exposes this same outcome by throwing out of runInteraction (CPO
// handles it with `.catch(resolveWithError)`); we keep it a value instead of a
// rejection so the result list stays uniform and Promise.all never blows up.
export interface Thrown { $name: 'thrown'; error: any; }

// One roster entry's outcome: retained, never reached, or a real ran result
// (a thrown compile, or the repl's left/right Either).
export type RerunEntry<Result = any> =
  PrefixSkipped | NotReached | Thrown | Either<any[], Result>;

export function isPrefixSkipped(r: RerunEntry): r is PrefixSkipped { return r.$name === 'prefix-skipped'; }
export function isNotReached(r: RerunEntry): r is NotReached { return r.$name === 'not-reached'; }
export function isThrown(r: RerunEntry): r is Thrown { return r.$name === 'thrown'; }

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface ReparteeRunner<A2, Realm = any, Result = any> {
  // Re-run the notebook from `startIndex` to the end. `roster` is the COMPLETE,
  // ordered list of every live chunk locator (the whole notebook), passed every
  // call — it is authoritative. Chunks before startIndex are retained and resolve
  // to PrefixSkipped; chunks from startIndex on re-run, resuming from the recorded
  // end-state of roster[startIndex-1] (or the base environment when startIndex is
  // 0). Stops at the first error; later chunks resolve to NotReached.
  //
  // Returns one promise per roster entry, SYNCHRONOUSLY and the SAME LENGTH as the
  // roster, so a UI can wire per-chunk handlers and map results positionally. The
  // inner promises never reject (errors are values).
  //
  // Because the roster is authoritative, any memoized boundary whose uri is no
  // longer in the roster (a chunk the UI deleted) is dropped here — snapshot
  // memory is reclaimed without a separate liveness signal.
  //
  // Throws SYNCHRONOUSLY (a caller contract violation, surfaced loudly rather
  // than guessing) if startIndex is out of [0, roster.length], or if resuming
  // after roster[startIndex-1] is requested but that chunk has no recorded
  // end-state (it never ran successfully).
  rerunInteractions(
    roster: CL.Locator[],
    startIndex: number,
    options?: CS.CompileOptions
  ): Promise<RerunEntry<Result>>[];

  // Whether a chunk has a recorded end-state — i.e. it ran successfully and can be
  // resumed-after (the predecessor of a valid startIndex). Mostly for tests / UI
  // introspection.
  hasEndState(uri: string): boolean;

  // Forget every memoized boundary, so the next run from startIndex 0 starts
  // genuinely fresh. Routine deletions are handled by the roster reconcile in
  // rerunInteractions; this is the heavier "dispose the whole session" reset.
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

  // Per-chunk post-state, keyed by locator uri: the env AFTER a chunk ran
  // successfully. Resuming a run at startIndex copies endEnvs[roster[startIndex-1]]
  // — the predecessor's end-state — so nothing before startIndex is re-run.
  // Recorded only on success; reconciled against the roster (a deleted chunk's
  // entry is dropped) on every call. There is no pre-state map: a chunk's resume
  // boundary IS its predecessor's end-state, so one map suffices.
  let endEnvs = new Map<string, ReplEnv<Realm>>();

  function hasEndState(uri: string): boolean { return endEnvs.has(uri); }

  function clearSnapshots(): void {
    endEnvs = new Map();
  }

  function rerunInteractions(
    roster: CL.Locator[],
    startIndex: number,
    options?: CS.CompileOptions
  ): Promise<RerunEntry<Result>>[] {
    const opts = options ?? baseOptions;

    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > roster.length) {
      throw new Error(
        `repartee: rerunInteractions startIndex ${startIndex} out of range [0, ${roster.length}]`);
    }

    // Resolve the resume environment up front, so a contract violation (resuming
    // after a chunk that never ran) throws synchronously, before any cell promise
    // is handed out — rather than silently restarting from the base environment.
    let resumeFrom: ReplEnv<Realm> | undefined;
    if (startIndex < roster.length) {
      if (startIndex === 0) {
        resumeFrom = baseEnv;
      } else {
        const predUri = roster[startIndex - 1].uri();
        resumeFrom = endEnvs.get(predUri);
        if (resumeFrom === undefined) {
          throw new Error(
            `repartee: cannot resume after "${predUri}" — it has no recorded end-state ` +
            `(a chunk must run successfully before a later chunk resumes from it)`);
        }
      }
    }

    // The roster is authoritative: forget any memoized boundary for a chunk that
    // is no longer in it (the UI deleted that chunk). This is the whole of GC —
    // no separate liveness signal needed.
    const live = new Set(roster.map((l) => l.uri()));
    for (const uri of [...endEnvs.keys()]) {
      if (!live.has(uri)) { endEnvs.delete(uri); }
    }

    const deferreds = roster.map(() => makeDeferred<RerunEntry<Result>>());
    // Retained prefix [0, startIndex): not re-run this pass.
    for (let i = 0; i < startIndex; i++) { deferreds[i].resolve(prefixSkipped); }

    // Detached driver: runs chunks [startIndex, end) sequentially (each needs the
    // prior env) and resolves each cell as it settles. Returns synchronously below.
    (async () => {
      if (startIndex >= roster.length) { return; } // nothing to run (e.g. trailing delete)
      const env = copyEnv<Realm>(resumeFrom!);
      const finder = makeCachingFinder(env, makeFinder());
      let stopped = false;
      for (let i = startIndex; i < roster.length; i++) {
        const loc = roster[i];
        if (stopped) { deferreds[i].resolve(notReached); continue; }
        let result: RerunEntry<Result>;
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
          // env is now this chunk's post-state; record it as a resume boundary.
          endEnvs.set(loc.uri(), copyEnv(env));
        } else {
          stopped = true;
        }
      }
    })().catch((err) => {
      // Defensive: an engine-level (non-chunk) failure. Resolve any still-pending
      // cells (those from startIndex on) so the UI never hangs; already-resolved
      // cells are unaffected (resolve is idempotent).
      // eslint-disable-next-line no-console
      console.error('repartee: rerunInteractions driver error', err);
      for (let i = startIndex; i < roster.length; i++) { deferreds[i].resolve(notReached); }
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
