// Repartee evaluation sweep (node:test), against the REAL in-process load-lib
// runtime.  node --test src/ts-compiler/tests/repartee-eval-test.js
// (node:test rather than jest because the runtime needs requirejs; see
// repartee-test.js for the note.)
//
// All calls use the roster API: rerunInteractions(roster, startIndex, options),
// where `roster` is the COMPLETE ordered notebook and `startIndex` is the first
// chunk to re-run. Results are same-length as the roster; entries before
// startIndex are 'prefix-skipped', entries an error stopped us reaching are
// 'not-reached'.
//
// Representative coverage: evaluation & globals chaining, edits and re-runs
// (earliest / middle / append / re-run-all), List/brand identity across a forked
// re-run, static errors (unbound / parse / shadow / type), dynamic errors (raise /
// div-zero / empty list), error-stops-evaluation + not-reached, recovery, check
// blocks that actually run (pass / fail / off), data/cases across chunks, in-chunk
// imports, type-check chaining, the always-recompile contract, realm-fork
// mutable-var sharing, external data files (CSV) and imported files (captured at
// load / reloaded only on re-run), use context, refinement-type aliases, and
// reordering chunks (stable uris, contents move).
// Needs a warm builtin cache in tests/ts-compiled (built by `make ts-pyret-test`).

const path = require('path');
const fs = require('fs');
const os = require('os');
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

const OUT = path.join(__dirname, '..', '..', '..', 'build', 'ts-compiler');
const RP = require(path.join(OUT, 'repartee.js'));
const CS = require(path.join(OUT, 'compile-structs.js'));
const { makeHost } = require('./in-process-host.js');

describe('repartee evaluation (in-process load-lib)', () => {
  let host, X;
  const optsNone = { ...CS.defaultCompileOptions, checks: 'none', displayProgress: false };
  const optsMain = { ...CS.defaultCompileOptions, checks: 'main', displayProgress: false };
  const optsType = { ...CS.defaultCompileOptions, checks: 'none', typeCheck: true, displayProgress: false };

  before(async () => { host = await makeHost({ quiet: true }); X = host.executor; });

  let uid = 0;
  const mkRunner = () =>
    RP.makeReparteeRunner(X, host.modules, host.realm, host.context, host.makeFinder);
  const loc = (src, kind) => {
    const uri = kind === 'definitions' ? 'definitions://' : 'chunk://' + (++uid);
    return RP.makeChunkLocator(uri, typeof src === 'function' ? src : () => src, kind || 'interaction');
  };
  const all = (ps) => Promise.all(ps);
  // Fresh runner, run the whole roster from the start (the common one-shot case).
  const once = (roster, opts) => all(mkRunner().rerunInteractions(roster, 0, opts));
  function num(rr) {
    assert.equal(rr.$name, 'right');
    assert.equal(X.isSuccessResult(rr.v), true);
    return X.runtimeOf(rr.v).num_to_string(X.getAnswer(rr.v));
  }
  const isRuntimeFailure = (rr) => rr.$name === 'right' && !X.isSuccessResult(rr.v);
  const problemNames = (rr) =>
    JSON.stringify(rr.v.map((e) => (e.problems ? e.problems.map((p) => p.$name) : e.$name)));
  // Write a unique temp file and return its path; the caller unlinks it (these
  // tests model files that live OUTSIDE the notebook and may be edited there).
  const tmp = (suffix, content) => {
    const p = path.join(os.tmpdir(), `repartee-${process.pid}-${++uid}-${suffix}`);
    fs.writeFileSync(p, content);
    return p;
  };

  describe('evaluation & globals chaining', () => {
    test('single interaction sees definitions: 10*10 == 100', async () => {
      const out = await once([loc('x = 10\n', 'definitions'), loc('x * x\n')], optsNone);
      assert.equal(out.length, 2);
      assert.equal(num(out[1]), '100');
    });

    test('three chunks chain bindings: (5+1)*5 == 30', async () => {
      const out = await once(
        [loc('base = 5\n', 'definitions'), loc('step = base + 1\n'), loc('step * base\n')], optsNone);
      assert.equal(num(out[2]), '30');
    });

    test('list pipeline across chunks: filter then length == 2', async () => {
      const out = await once([
        loc('xs = [list: 1, 2, 3, 4]\n', 'definitions'),
        loc('evens = filter(lam(n): num-modulo(n, 2) == 0 end, xs)\n'),
        loc('evens.length()\n'),
      ], optsNone);
      assert.equal(num(out[2]), '2');
    });
  });

  describe('edits & re-runs', () => {
    test('edit earliest + re-run all (startIndex 0): n*10 goes 20 -> 30', async () => {
      const r = mkRunner();
      let defsSrc = 'n = 2\n';
      const defs = loc(() => defsSrc, 'definitions');
      const c1 = loc('n * 10\n');
      const roster = [defs, c1];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '20');
      defsSrc = 'n = 3\n';
      // Editing defs is a run from index 0: it re-instantiates the definitions
      // from the base environment, so no separate reset is needed.
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '30');
    });

    test('edit middle: re-run from that index; a later index re-runs only the tail', async () => {
      const r = mkRunner();
      let c1Src = 'm = n + 1\n';
      const defs = loc('n = 2\n', 'definitions');
      const c1 = loc(() => c1Src);
      const c2 = loc('m * n\n');
      const roster = [defs, c1, c2];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[2]), '6');
      c1Src = 'm = n + 10\n';
      const b = await all(r.rerunInteractions(roster, 1, optsNone));
      assert.equal(b[0].$name, 'prefix-skipped');
      assert.equal(num(b[2]), '24');
      const c = await all(r.rerunInteractions(roster, 2, optsNone)); // just the tail
      assert.equal(num(c[2]), '24');
    });

    test('append (startIndex at the new tail): only the new chunk runs, from the anchor; a*2 == 14', async () => {
      const r = mkRunner();
      const defs = loc('a = 7\n', 'definitions');
      const c1 = loc('a + 1\n');
      assert.equal(num((await all(r.rerunInteractions([defs, c1], 0, optsNone)))[1]), '8');
      assert.equal(r.hasEndState(c1.uri()), true);
      const c2 = loc('a * 2\n');
      const out = await all(r.rerunInteractions([defs, c1, c2], 2, optsNone));
      assert.equal(out.length, 3);
      assert.deepEqual(out.slice(0, 2).map((x) => x.$name), ['prefix-skipped', 'prefix-skipped']);
      assert.equal(num(out[2]), '14');
    });

    test('re-run: same roster from 0 twice is deterministic == 8', async () => {
      const r = mkRunner();
      const roster = [loc('k = 4\n', 'definitions'), loc('k + k\n')];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '8');
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '8');
    });
  });

  describe('List/brand identity across a forked re-run', () => {
    test('edit middle chunk; map/foldl on defs\' (not re-run) xs still works: 12 -> 60', async () => {
      const r = mkRunner();
      let c1Src = 'ys = map(lam(e): e * 2 end, xs)\n';
      const defs = loc('xs = [list: 1, 2, 3]\n', 'definitions');
      const c1 = loc(() => c1Src);
      const c2 = loc('ys.foldl(lam(acc, e): acc + e end, 0)\n');
      const roster = [defs, c1, c2];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[2]), '12');
      c1Src = 'ys = map(lam(e): e * 10 end, xs)\n';
      const b = await all(r.rerunInteractions(roster, 1, optsNone));
      // If List identity were broken across the fork, map(..., xs) on defs' xs
      // would throw; both chunks succeeding is the identity proof.
      assert.equal(X.isSuccessResult(b[1].v), true);
      assert.equal(num(b[2]), '60');
    });
  });

  describe('static (compile-time) errors stop evaluation', () => {
    test('unbound id -> left, successor -> not-reached', async () => {
      const out = await once(
        [loc('p = 1\n', 'definitions'), loc('bogus-name-zzz + 1\n'), loc('p + 1\n')], optsNone);
      assert.equal(out[1].$name, 'left');
      assert.match(problemNames(out[1]), /unbound/);
      assert.equal(out[2].$name, 'not-reached');
    });

    test('parse/syntax error -> thrown, successor -> not-reached', async () => {
      const out = await once(
        [loc('q = 1\n', 'definitions'), loc('z = q +\n'), loc('q\n')], optsNone);
      assert.equal(out[1].$name, 'thrown');
      assert.ok(out[1].error);
      assert.equal(out[2].$name, 'not-reached');
    });

    test('shadow / redefinition -> left, successor -> not-reached', async () => {
      const out = await once(
        [loc('w = 1\n', 'definitions'), loc('w = 2\n'), loc('w\n')], optsNone);
      assert.equal(out[1].$name, 'left');
      assert.equal(out[2].$name, 'not-reached');
    });

    test('type mismatch under typeCheck -> left, successor -> not-reached', async () => {
      const out = await once(
        [loc('', 'definitions'), loc('s :: String = 5\n'), loc('1\n')], optsType);
      assert.equal(out[1].$name, 'left');
      assert.equal(out[2].$name, 'not-reached');
    });
  });

  describe('dynamic (runtime) errors stop evaluation', () => {
    test('raise -> runtime failure (right, non-success), successor -> not-reached', async () => {
      const out = await once(
        [loc('', 'definitions'), loc('raise("boom")\n'), loc('1\n')], optsNone);
      assert.equal(isRuntimeFailure(out[1]), true);
      assert.equal(out[2].$name, 'not-reached');
    });

    test('division by zero -> runtime failure, successor -> not-reached', async () => {
      const out = await once(
        [loc('', 'definitions'), loc('1 / 0\n'), loc('1\n')], optsNone);
      assert.equal(isRuntimeFailure(out[1]), true);
      assert.equal(out[2].$name, 'not-reached');
    });

    test('.first on an empty list -> runtime failure, successor -> not-reached', async () => {
      const out = await once(
        [loc('ys = [list: ]\n', 'definitions'), loc('ys.first\n'), loc('1\n')], optsNone);
      assert.equal(isRuntimeFailure(out[1]), true);
      assert.equal(out[2].$name, 'not-reached');
    });
  });

  describe('error stops evaluation but preserves earlier results; recovery', () => {
    test('earlier chunk kept, error stops, later not-reached; fixing re-runs both', async () => {
      const r = mkRunner();
      let c2Src = 'raise("later")\n';
      const defs = loc('g = 100\n', 'definitions');
      const c1 = loc('g + 1\n');
      const c2 = loc(() => c2Src);
      const c3 = loc('g + 2\n');
      const roster = [defs, c1, c2, c3];
      const a = await all(r.rerunInteractions(roster, 0, optsNone));
      assert.equal(num(a[1]), '101');               // c1 preserved
      assert.equal(isRuntimeFailure(a[2]), true);
      assert.equal(a[3].$name, 'not-reached');       // c3 never ran
      c2Src = 'g + 50\n';
      const b = await all(r.rerunInteractions(roster, 2, optsNone));
      assert.equal(num(b[2]), '150');                // c2 now succeeds
      assert.equal(num(b[3]), '102');                // c3 finally runs
    });
  });

  describe('check blocks actually run (in-process checker)', () => {
    test('a passing check: total 1, passed 1, failed 0', async () => {
      const out = await once(
        [loc('', 'definitions'), loc('check "ok": (2 + 2) is 4 end\n')], optsMain);
      assert.equal(X.isSuccessResult(out[1].v), true);
      const s = await X.summarizeChecks(out[1].v);
      assert.equal(s.total, 1);
      assert.equal(s.passed, 1);
      assert.equal(s.failed, 0);
    });

    test('a failing check: still a successful RUN, but failed 1 / passed 0', async () => {
      const out = await once(
        [loc('', 'definitions'), loc('check "bad": (2 + 2) is 5 end\n')], optsMain);
      assert.equal(X.isSuccessResult(out[1].v), true); // a failing check is not a runtime failure
      const s = await X.summarizeChecks(out[1].v);
      assert.equal(s.total, 1);
      assert.equal(s.passed, 0);
      assert.equal(s.failed, 1);
    });

    test('checks OFF: the same check block runs no tests (total 0)', async () => {
      const out = await once(
        [loc('', 'definitions'), loc('check "ok": (2 + 2) is 4 end\n')], optsNone);
      assert.equal(X.isSuccessResult(out[1].v), true);
      const s = await X.summarizeChecks(out[1].v);
      assert.equal(s.total, 0);
    });
  });

  describe('data definitions used across chunks', () => {
    const TREE = 'data Tree: leaf | node(v, l, r) end\n';
    const CASES = 'cases (Tree) t:\n  | leaf => 0\n  | node(v, _, _) => v\nend\n';

    test('construct in one chunk, cases-dispatch in another: node value == 1', async () => {
      const out = await once([
        loc(TREE, 'definitions'),
        loc('t = node(1, leaf, leaf)\n'),
        loc(CASES),
      ], optsNone);
      assert.equal(num(out[2]), '1');
    });

    test('edit the constructing chunk; cases re-runs against the same data brand: 1 -> 9', async () => {
      const r = mkRunner();
      let c1Src = 't = node(1, leaf, leaf)\n';
      const defs = loc(TREE, 'definitions');
      const c1 = loc(() => c1Src);
      const c2 = loc(CASES);
      const roster = [defs, c1, c2];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[2]), '1');
      // The constructor re-runs in a new realm fork, but `node`/`Tree` resolve to
      // the (not re-run) definitions' data declaration, so cases still dispatches.
      c1Src = 't = node(9, leaf, leaf)\n';
      const b = await all(r.rerunInteractions(roster, 1, optsNone));
      assert.equal(X.isSuccessResult(b[1].v), true);
      assert.equal(num(b[2]), '9');
    });
  });

  describe('import inside a chunk (finder / locator cache across a re-run)', () => {
    test('a chunk that imports a trove lib: length([list: 1,2,3]) == 3', async () => {
      const out = await once([
        loc('', 'definitions'),
        loc('import lists as L\nL.length([list: 1, 2, 3])\n'),
      ], optsNone);
      assert.equal(num(out[1]), '3');
    });

    test('re-running the importing chunk resolves the import again: stays 3', async () => {
      const r = mkRunner();
      const defs = loc('', 'definitions');
      const c1 = loc('import lists as L\nL.length([list: 1, 2, 3])\n');
      const roster = [defs, c1];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '3');
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '3');
    });
  });

  describe('type checking chains across chunks', () => {
    test('a type alias + annotated fn defined and used across chunks type-checks: f(41) == 42', async () => {
      const out = await once([
        loc('type Count = Number\n', 'definitions'),
        loc('f = lam(n :: Count) -> Count: n + 1 end\n'),
        loc('f(41)\n'),
      ], optsType);
      assert.equal(num(out[2]), '42');
    });

    test('an annotated fn from defs, mis-called in a later chunk -> left type-mismatch, successor not-reached', async () => {
      const out = await once([
        loc('fun h(n :: Number) -> Number: n end\n', 'definitions'),
        loc('h("not a number")\n'),
        loc('1\n'),
      ], optsType);
      assert.equal(out[1].$name, 'left');
      assert.match(problemNames(out[1]), /type-mismatch/);
      assert.equal(out[2].$name, 'not-reached');
    });
  });

  // The engine always recompiles AND re-executes every chunk from startIndex on,
  // from its current source — chunk locators never cache a compiled artifact
  // (getCompiled is a no-op, needsCompile is always true), so recompile-avoidance
  // applies only to dependencies via env.modules, never to the chunks under edit.
  // These pin that contract, which the UI layer is built to trust.
  describe('always recompiles + re-executes from current source', () => {
    test('edit a chunk repeatedly through one stable locator: each run reflects the new source', async () => {
      const r = mkRunner();
      let src = 'v = 1\nv * 100\n';
      const defs = loc('', 'definitions');
      const c1 = loc(() => src); // stable uri reused across every edit
      const roster = [defs, c1];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '100');
      src = 'v = 2\nv * 100\n';
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '200');
      src = 'v = 7\nv * 100\n';
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '700');
    });

    test('editing an upstream chunk re-runs an UNCHANGED downstream locator against fresh values: 1001 -> 1005', async () => {
      const r = mkRunner();
      let defsSrc = 'k = 1\n';
      const defs = loc(() => defsSrc, 'definitions');
      const down = loc('k + 1000\n'); // SAME object, never edited
      const roster = [defs, down];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '1001');
      defsSrc = 'k = 5\n';
      // `down` is byte-for-byte identical, yet running from 0 recompiles/re-executes
      // it against the new globals rather than reusing a compile bound to the old k.
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '1005');
    });
  });

  // The subtlest area: load-lib forks a child realm via Object.create(parent),
  // so a fork gets fresh bindings only for the modules instantiated AT OR BELOW
  // the fork point; an UPSTREAM module instance (and its `var` cells) is shared
  // by reference through the prototype chain. Immutable threading is fully
  // isolated (see the List/brand-identity tests); mutable upstream state is NOT.
  // Re-running a chunk that mutates an upstream `var` is therefore NOT idempotent.
  // This is intended: once a program uses state it is in a stateful co-routine
  // with the notebook; the engine does not try to track that. These pin the actual
  // semantics so any future change is a deliberate, visible decision.
  describe('realm-fork side effects: upstream var is shared across forks', () => {
    test('mutating an upstream var from a downstream chunk accumulates across tail re-runs: 5, 10, 15', async () => {
      const r = mkRunner();
      const defs = loc('var c = 0\n', 'definitions');
      const c1 = loc('c := c + 5\nc\n');
      const roster = [defs, c1];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '5');
      // Re-running just c1 (startIndex 1) resumes from defs' end-state, but that
      // holds the realm by reference and the var cell lives in the shared (not
      // re-run) defs module, so the mutation re-applies on top of the current value.
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '10');
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '15');
    });

    test('re-running from 0 (defs re-instantiated) gives the var a fresh cell: back to 5', async () => {
      const r = mkRunner();
      const defs = loc('var c = 0\n', 'definitions');
      const c1 = loc('c := c + 5\nc\n');
      const roster = [defs, c1];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '5');
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '10'); // shared
      // Running from 0 forks a fresh realm where `var c = 0` is instantiated anew —
      // the startIndex alone decides accumulate (1) vs reset (0); no reset call.
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '5');
    });

    test('appending a mutating chunk also sees the shared upstream var: 2, 3', async () => {
      const r = mkRunner();
      const defs = loc('var e = 0\n', 'definitions');
      const c1 = loc('e := e + 1\ne\n');
      assert.equal(num((await all(r.rerunInteractions([defs, c1], 0, optsNone)))[1]), '1');
      // Append c2 (another mutator) at the tail; it resumes from c1's end-state,
      // where e is the shared cell (== 1), and accumulates on each re-run.
      const c2 = loc('e := e + 1\ne\n');
      const roster = [defs, c1, c2];
      assert.equal(num((await all(r.rerunInteractions(roster, 2, optsNone)))[2]), '2');
      assert.equal(num((await all(r.rerunInteractions(roster, 2, optsNone)))[2]), '3');
    });

    test('control: a pure (immutable) downstream chunk re-runs idempotently: 7, 7, 7', async () => {
      const r = mkRunner();
      const defs = loc('base = 3\n', 'definitions');
      const c1 = loc('base + 4\n');
      const roster = [defs, c1];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '7');
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '7');
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '7');
    });
  });

  describe('resuming the tail from an anchor is independent of prior tail content', () => {
    test('editing only the tail re-runs it cleanly from the anchor each time: 110 / 210 / 110', async () => {
      const r = mkRunner();
      let tailSrc = 'base + 100\n';
      const defs = loc('base = 10\n', 'definitions');
      const c1 = loc('base + 1\n');
      const tail = loc(() => tailSrc);
      const roster = [defs, c1, tail];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[2]), '110');
      assert.equal(r.hasEndState(c1.uri()), true);
      tailSrc = 'base + 200\n';
      assert.equal(num((await all(r.rerunInteractions(roster, 2, optsNone)))[2]), '210');
      tailSrc = 'base + 100\n';
      // Resuming from c1's end-state again yields the original value, regardless of
      // what the tail computed in between.
      assert.equal(num((await all(r.rerunInteractions(roster, 2, optsNone)))[2]), '110');
    });

    test('re-running the same pure tail three times is deterministic: 30 each time', async () => {
      const r = mkRunner();
      const roster = [loc('q = 6\n', 'definitions'), loc('q * 5\n')];
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '30');
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '30');
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '30');
    });
  });

  // A CSV read from disk is external state, exactly like a `var`: it is captured
  // when the loading chunk runs, and a downstream chunk uses that captured table.
  // Editing the file outside the notebook does nothing until the LOADING chunk is
  // re-run — the engine does not (and deliberately should not) watch the file.
  describe('external data files (CSV): captured at load, reloaded only on re-run', () => {
    const tableChunk = (csvPath) =>
      'shed = load-table: name, age\n' +
      '  source: C.csv-table-file("' + csvPath + '", C.default-options)\n' +
      'end\n';

    test('a CSV loaded in one chunk is usable in a later chunk: 3 rows', async () => {
      const csv = tmp('a.csv', 'name,age\nAva,3\nBo,5\nCy,7\n');
      try {
        const out = await once([
          loc('import csv as C\n', 'definitions'),
          loc(tableChunk(csv)),
          loc('shed.length()\n'),
        ], optsNone);
        assert.equal(num(out[2]), '3');
      } finally { fs.unlinkSync(csv); }
    });

    test('editing the CSV outside the notebook is invisible until the loading chunk re-runs: 3 -> 3 -> 5', async () => {
      const csv = tmp('b.csv', 'name,age\nAva,3\nBo,5\nCy,7\n'); // 3 rows
      try {
        const r = mkRunner();
        const defs = loc('import csv as C\n', 'definitions');
        const load = loc(tableChunk(csv));
        const count = loc('shed.length()\n');
        const roster = [defs, load, count];
        assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[2]), '3');
        // Someone edits the file on disk -> 5 rows.
        fs.writeFileSync(csv, 'name,age\nAva,3\nBo,5\nCy,7\nDi,9\nEv,11\n');
        // Re-running only the downstream chunk (index 2) uses the table captured at load.
        assert.equal(num((await all(r.rerunInteractions(roster, 2, optsNone)))[2]), '3');
        // Re-running from the LOADING chunk (index 1) re-reads the file; new rows appear.
        assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[2]), '5');
      } finally { fs.unlinkSync(csv); }
    });
  });

  // Pulling code from another file into the session — common for class starter
  // files. Same external-state story as CSV: the import is resolved (and the file
  // read) when the importing chunk runs, and re-reading needs that chunk re-run.
  describe('importing another file into the session', () => {
    const DOUBLE_LIB = 'provide { double: double } end\nfun double(n): n * 2 end\n';

    test('import file(...) in definitions, used downstream: double(21) == 42', async () => {
      const lib = tmp('lib.arr', DOUBLE_LIB);
      try {
        const out = await once([
          loc('import file("' + lib + '") as M\n', 'definitions'),
          loc('M.double(21)\n'),
        ], optsNone);
        assert.equal(num(out[1]), '42');
      } finally { fs.unlinkSync(lib); }
    });

    test('import file(...) inside an interaction chunk also resolves: 42', async () => {
      const lib = tmp('lib.arr', DOUBLE_LIB);
      try {
        const out = await once([
          loc('', 'definitions'),
          loc('import file("' + lib + '") as M\nM.double(21)\n'),
        ], optsNone);
        assert.equal(num(out[1]), '42');
      } finally { fs.unlinkSync(lib); }
    });

    test('include file(...) flattens the provided names into scope: double(50) == 100', async () => {
      const lib = tmp('lib.arr', DOUBLE_LIB);
      try {
        const out = await once([
          loc('include file("' + lib + '")\n', 'definitions'),
          loc('double(50)\n'),
        ], optsNone);
        assert.equal(num(out[1]), '100');
      } finally { fs.unlinkSync(lib); }
    });

    test('editing the imported file is captured at import: 20 -> 20 until re-import -> 30', async () => {
      const lib = tmp('lib.arr', 'provide { f: f } end\nfun f(n): n * 2 end\n');
      try {
        const r = mkRunner();
        const defs = loc('import file("' + lib + '") as M\n', 'definitions');
        const use = loc('M.f(10)\n');
        const roster = [defs, use];
        assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '20');
        // Edit the library on disk: f now triples.
        fs.writeFileSync(lib, 'provide { f: f } end\nfun f(n): n * 3 end\n');
        // The bound module M is captured; re-running just the user chunk keeps f doubling.
        assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '20');
        // Re-running from 0 re-imports the file and picks up the edit.
        assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '30');
      } finally { fs.unlinkSync(lib); }
    });
  });

  // `use context <spec>` swaps the chunk's globals for those of the named context.
  // Class starter files commonly open with `use context url-file("https://...")`;
  // that fetches over the network, so here we exercise the SAME mechanism with the
  // local builtin contexts (deterministic and offline) — url-file differs only in
  // how the context module is located.
  describe('use context threads a non-standard context across chunks', () => {
    test('use context global + include lists exposes length: 4', async () => {
      const out = await once([
        loc('use context global\ninclude lists\n', 'definitions'),
        loc('length([list: 1, 2, 3, 4])\n'),
      ], optsNone);
      assert.equal(num(out[1]), '4');
    });

    test('use context essentials2020 exposes num-sqr: num-sqr(9) == 81', async () => {
      const out = await once([
        loc('use context essentials2020\n', 'definitions'),
        loc('num-sqr(9)\n'),
      ], optsNone);
      assert.equal(num(out[1]), '81');
    });

    test('use context empty-context drops the standard names: map is unbound', async () => {
      const out = await once([
        loc('use context empty-context\n', 'definitions'),
        loc('map(lam(x): x end, [list: 1])\n'),
      ], optsNone);
      assert.equal(out[1].$name, 'left');
      assert.match(problemNames(out[1]), /unbound/);
    });

    // Editing the defs `use context` and re-running from 0 is the notebook-level
    // "switch which starter / context this page runs in" gesture. Downstream
    // chunks must recompile and re-execute against the NEW context.
    test('editing the defs `use context` to a different file rebinds a downstream value: 6 -> 105', async () => {
      // Two custom context files providing the same name `tax` with different values.
      const ctxA = tmp('ctxA.arr', 'use context essentials2020\nprovide: tax end\ntax = 1\n');
      const ctxB = tmp('ctxB.arr', 'use context essentials2020\nprovide: tax end\ntax = 100\n');
      try {
        const r = mkRunner();
        let ctxPath = ctxA;
        const defs = loc(() => 'use context file("' + ctxPath + '")\n', 'definitions');
        const c1 = loc('tax + 5\n');
        const roster = [defs, c1];
        assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '6');
        // Point the same `use context` at a different file and re-run from 0.
        ctxPath = ctxB;
        assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '105');
      } finally { fs.unlinkSync(ctxA); fs.unlinkSync(ctxB); }
    });

    test('switching the defs context brings names in and out of scope: length unbound -> 4', async () => {
      const r = mkRunner();
      let ctx = 'use context empty-context\n';
      const defs = loc(() => ctx, 'definitions');
      const c1 = loc('length([list: 1, 2, 3, 4])\n');
      const roster = [defs, c1];
      // empty-context has no list functions: length is unbound.
      const a = await all(r.rerunInteractions(roster, 0, optsNone));
      assert.equal(a[1].$name, 'left');
      assert.match(problemNames(a[1]), /unbound/);
      // Switch to a context that provides them; the same chunk now compiles and runs.
      ctx = 'use context global\ninclude lists\n';
      assert.equal(num((await all(r.rerunInteractions(roster, 0, optsNone)))[1]), '4');
    });
  });

  // Refinement annotations (Number%(pred)) are runtime contracts, not static
  // types: the checker treats Number%(is-odd) as Number, and the predicate is
  // enforced when the value flows through the annotation. This pins that a
  // refinement-type ALIAS defined in one chunk works as an annotation in another.
  describe('refinement-type aliases thread across chunks', () => {
    const REFDEFS =
      'fun is-odd(n :: Number) -> Boolean: num-modulo(n, 2) == 1 end\n' +
      'type Odd = Number%(is-odd)\n';

    test('the alias used as a downstream annotation accepts a passing value: 3', async () => {
      const out = await once([
        loc(REFDEFS, 'definitions'), loc('x :: Odd = 3\nx\n'),
      ], optsType);
      assert.equal(num(out[1]), '3');
    });

    test('a value failing the refinement is a runtime contract error (type-check on)', async () => {
      const out = await once([
        loc(REFDEFS, 'definitions'), loc('y :: Odd = 4\ny\n'), loc('1\n'),
      ], optsType);
      assert.equal(isRuntimeFailure(out[1]), true); // contract failure, not a static left
      assert.equal(out[2].$name, 'not-reached');
    });

    test('the refinement is enforced even with type-checking off', async () => {
      const out = await once([
        loc(REFDEFS, 'definitions'), loc('y :: Odd = 4\ny\n'),
      ], optsNone);
      assert.equal(isRuntimeFailure(out[1]), true);
    });
  });

  // A UI may reorder chunks (drag textboxes) WITHOUT renaming them — the uris are
  // stable, only their position in the roster changes. The engine keys snapshots
  // by uri and resumes from the predecessor in the NEW order, recompiling each
  // moved chunk against the globals that now precede it. So reordering is just an
  // edit whose startIndex is the earliest moved position.
  describe('reordering chunks (stable uris, contents move)', () => {
    test('swapping two independent chunks keeps both correct', async () => {
      const r = mkRunner();
      const defs = loc('', 'definitions');
      const a = loc('p = 10\np\n');
      const b = loc('q = 20\nq\n');
      const out1 = await all(r.rerunInteractions([defs, a, b], 0, optsNone));
      assert.equal(num(out1[1]), '10');
      assert.equal(num(out1[2]), '20');
      // Same locator objects, swapped order. Re-run from the first moved position.
      const out2 = await all(r.rerunInteractions([defs, b, a], 1, optsNone));
      assert.equal(num(out2[1]), '20'); // b now at index 1
      assert.equal(num(out2[2]), '10'); // a now at index 2
    });

    test('moving a user BEFORE its definition makes it unbound; restoring order fixes it', async () => {
      const r = mkRunner();
      const defs = loc('', 'definitions');
      const def = loc('h = 5\nh\n');      // defines h
      const use = loc('h + 1\n');         // uses h
      const ok = await all(r.rerunInteractions([defs, def, use], 0, optsNone));
      assert.equal(num(ok[1]), '5');
      assert.equal(num(ok[2]), '6');
      // Reorder so `use` precedes `def`: h is now unbound where it is used.
      const bad = await all(r.rerunInteractions([defs, use, def], 1, optsNone));
      assert.equal(bad[1].$name, 'left'); // `use` (now index 1) can't see h
      assert.match(problemNames(bad[1]), /unbound/);
      assert.equal(bad[2].$name, 'not-reached');
      // Put them back; both compile and run again.
      const good = await all(r.rerunInteractions([defs, def, use], 1, optsNone));
      assert.equal(num(good[1]), '5');
      assert.equal(num(good[2]), '6');
    });

    test('reordering re-runs only from the earliest moved position; the prefix is retained', async () => {
      const r = mkRunner();
      const defs = loc('w = 1\n', 'definitions');
      const a = loc('aa = w + 1\naa\n');
      const b = loc('bb = w + 2\nbb\n');
      const c = loc('cc = w + 3\ncc\n');
      const first = await all(r.rerunInteractions([defs, a, b, c], 0, optsNone));
      assert.equal(num(first[3]), '4');
      // Swap b and c (independent); earliest moved position is index 2.
      const out = await all(r.rerunInteractions([defs, a, c, b], 2, optsNone));
      assert.deepEqual(out.slice(0, 2).map((x) => x.$name), ['prefix-skipped', 'prefix-skipped']);
      assert.equal(num(out[2]), '4'); // c now at index 2
      assert.equal(num(out[3]), '3'); // b now at index 3
    });
  });

  // The single-flight guard against the REAL async executor (run-program returns a
  // promise that takes real time), where the busy window genuinely spans
  // compilation + execution rather than a synchronous stub.
  describe('single-flight against the real runtime', () => {
    test('isRunning spans a real run; re-entry throws mid-flight, then succeeds once settled', async () => {
      const r = mkRunner();
      const roster = [loc('z = 21\n', 'definitions'), loc('z * 2\n')];
      const ps = r.rerunInteractions(roster, 0, optsNone);
      assert.equal(r.isRunning(), true);
      assert.throws(() => r.rerunInteractions(roster, 0, optsNone), /already in progress/);
      const out = await all(ps);
      assert.equal(num(out[1]), '42');
      assert.equal(r.isRunning(), false);
      // Settled: a fresh run goes through.
      assert.equal(num((await all(r.rerunInteractions(roster, 1, optsNone)))[1]), '42');
    });
  });
});
