// Repartee evaluation sweep (node:test), against the REAL in-process load-lib
// runtime.  node --test src/ts-compiler/tests/repartee-eval-test.js
// (node:test rather than jest because the runtime needs requirejs; see
// repartee-test.js for the note.)
//
// Representative coverage: evaluation & globals chaining, edits and re-runs
// (earliest / middle / append-via-anchor / re-run-all), List/brand identity
// across a forked re-run, static errors (unbound / parse / shadow / type),
// dynamic errors (raise / div-zero / empty list), error-stops-evaluation + skip,
// recovery, and check blocks that actually run (pass / fail / off).
// Needs a warm builtin cache in tests/ts-compiled (built by `make ts-pyret-test`).

const path = require('path');
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
  function num(rr) {
    assert.equal(rr.$name, 'right');
    assert.equal(X.isSuccessResult(rr.v), true);
    return X.runtimeOf(rr.v).num_to_string(X.getAnswer(rr.v));
  }
  const isRuntimeFailure = (rr) => rr.$name === 'right' && !X.isSuccessResult(rr.v);
  const problemNames = (rr) =>
    JSON.stringify(rr.v.map((e) => (e.problems ? e.problems.map((p) => p.$name) : e.$name)));

  describe('evaluation & globals chaining', () => {
    test('single interaction sees definitions: 10*10 == 100', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('x = 10\n', 'definitions'), loc('x * x\n')], optsNone));
      assert.equal(out.length, 2);
      assert.equal(num(out[1]), '100');
    });

    test('three chunks chain bindings: (5+1)*5 == 30', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('base = 5\n', 'definitions'), loc('step = base + 1\n'), loc('step * base\n')], optsNone));
      assert.equal(num(out[2]), '30');
    });

    test('list pipeline across chunks: filter then length == 2', async () => {
      const out = await all(mkRunner().rerunInteractions([
        loc('xs = [list: 1, 2, 3, 4]\n', 'definitions'),
        loc('evens = filter(lam(n): num-modulo(n, 2) == 0 end, xs)\n'),
        loc('evens.length()\n'),
      ], optsNone));
      assert.equal(num(out[2]), '2');
    });
  });

  describe('edits & re-runs', () => {
    test('edit earliest + re-run all: n*10 goes 20 -> 30', async () => {
      const r = mkRunner();
      let defsSrc = 'n = 2\n';
      const defs = loc(() => defsSrc, 'definitions');
      const c1 = loc('n * 10\n');
      assert.equal(num((await all(r.rerunInteractions([defs, c1], optsNone)))[1]), '20');
      defsSrc = 'n = 3\n';
      r.clearSnapshots();
      assert.equal(num((await all(r.rerunInteractions([defs, c1], optsNone)))[1]), '30');
    });

    test('edit middle: re-run suffix recomputes; tail re-run alone is stable', async () => {
      const r = mkRunner();
      let c1Src = 'm = n + 1\n';
      const defs = loc('n = 2\n', 'definitions');
      const c1 = loc(() => c1Src);
      const c2 = loc('m * n\n');
      assert.equal(num((await all(r.rerunInteractions([defs, c1, c2], optsNone)))[2]), '6');
      c1Src = 'm = n + 10\n';
      const b = await all(r.rerunInteractions([c1, c2], optsNone));
      assert.equal(num(b[1]), '24');
      const c = await all(r.rerunInteractions([c2], optsNone));
      assert.equal(num(c[0]), '24');
    });

    test('append via `after`: running ONLY the new last chunk resumes from the anchor; a*2 == 14', async () => {
      const r = mkRunner();
      const defs = loc('a = 7\n', 'definitions');
      const c1 = loc('a + 1\n');
      assert.equal(num((await all(r.rerunInteractions([defs, c1], optsNone)))[1]), '8');
      assert.equal(r.hasEndState(c1.uri()), true);
      const c2 = loc('a * 2\n');
      const out = await all(r.rerunInteractions([c2], { after: c1.uri(), options: optsNone }));
      assert.equal(out.length, 1);
      assert.equal(num(out[0]), '14');
    });

    test('re-run: same list twice is deterministic == 8', async () => {
      const r = mkRunner();
      const list = [loc('k = 4\n', 'definitions'), loc('k + k\n')];
      assert.equal(num((await all(r.rerunInteractions(list, optsNone)))[1]), '8');
      assert.equal(num((await all(r.rerunInteractions(list, optsNone)))[1]), '8');
    });
  });

  describe('List/brand identity across a forked re-run', () => {
    test('edit middle chunk; map/foldl on defs\' (not re-run) xs still works: 12 -> 60', async () => {
      const r = mkRunner();
      let c1Src = 'ys = map(lam(e): e * 2 end, xs)\n';
      const defs = loc('xs = [list: 1, 2, 3]\n', 'definitions');
      const c1 = loc(() => c1Src);
      const c2 = loc('ys.foldl(lam(acc, e): acc + e end, 0)\n');
      assert.equal(num((await all(r.rerunInteractions([defs, c1, c2], optsNone)))[2]), '12');
      c1Src = 'ys = map(lam(e): e * 10 end, xs)\n';
      const b = await all(r.rerunInteractions([c1, c2], optsNone));
      // If List identity were broken across the fork, map(..., xs) on defs' xs
      // would throw; both chunks succeeding is the identity proof.
      assert.equal(X.isSuccessResult(b[0].v), true);
      assert.equal(num(b[1]), '60');
    });
  });

  describe('static (compile-time) errors stop evaluation', () => {
    test('unbound id -> left, successor -> skip', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('p = 1\n', 'definitions'), loc('bogus-name-zzz + 1\n'), loc('p + 1\n')], optsNone));
      assert.equal(out[1].$name, 'left');
      assert.match(problemNames(out[1]), /unbound/);
      assert.equal(out[2].$name, 'skip');
    });

    test('parse/syntax error -> thrown, successor -> skip', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('q = 1\n', 'definitions'), loc('z = q +\n'), loc('q\n')], optsNone));
      assert.equal(out[1].$name, 'thrown');
      assert.ok(out[1].error);
      assert.equal(out[2].$name, 'skip');
    });

    test('shadow / redefinition -> left, successor -> skip', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('w = 1\n', 'definitions'), loc('w = 2\n'), loc('w\n')], optsNone));
      assert.equal(out[1].$name, 'left');
      assert.equal(out[2].$name, 'skip');
    });

    test('type mismatch under typeCheck -> left, successor -> skip', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('', 'definitions'), loc('s :: String = 5\n'), loc('1\n')], optsType));
      assert.equal(out[1].$name, 'left');
      assert.equal(out[2].$name, 'skip');
    });
  });

  describe('dynamic (runtime) errors stop evaluation', () => {
    test('raise -> runtime failure (right, non-success), successor -> skip', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('', 'definitions'), loc('raise("boom")\n'), loc('1\n')], optsNone));
      assert.equal(isRuntimeFailure(out[1]), true);
      assert.equal(out[2].$name, 'skip');
    });

    test('division by zero -> runtime failure, successor -> skip', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('', 'definitions'), loc('1 / 0\n'), loc('1\n')], optsNone));
      assert.equal(isRuntimeFailure(out[1]), true);
      assert.equal(out[2].$name, 'skip');
    });

    test('.first on an empty list -> runtime failure, successor -> skip', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('ys = [list: ]\n', 'definitions'), loc('ys.first\n'), loc('1\n')], optsNone));
      assert.equal(isRuntimeFailure(out[1]), true);
      assert.equal(out[2].$name, 'skip');
    });
  });

  describe('error stops evaluation but preserves earlier results; recovery', () => {
    test('earlier chunk kept, error stops, later skipped; fixing re-runs both', async () => {
      const r = mkRunner();
      let c2Src = 'raise("later")\n';
      const defs = loc('g = 100\n', 'definitions');
      const c1 = loc('g + 1\n');
      const c2 = loc(() => c2Src);
      const c3 = loc('g + 2\n');
      const a = await all(r.rerunInteractions([defs, c1, c2, c3], optsNone));
      assert.equal(num(a[1]), '101');               // c1 preserved
      assert.equal(isRuntimeFailure(a[2]), true);
      assert.equal(a[3].$name, 'skip');              // c3 never ran
      c2Src = 'g + 50\n';
      const b = await all(r.rerunInteractions([c2, c3], optsNone));
      assert.equal(num(b[0]), '150');                // c2 now succeeds
      assert.equal(num(b[1]), '102');                // c3 finally runs
    });
  });

  describe('check blocks actually run (in-process checker)', () => {
    test('a passing check: total 1, passed 1, failed 0', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('', 'definitions'), loc('check "ok": (2 + 2) is 4 end\n')], optsMain));
      assert.equal(X.isSuccessResult(out[1].v), true);
      const s = await X.summarizeChecks(out[1].v);
      assert.equal(s.total, 1);
      assert.equal(s.passed, 1);
      assert.equal(s.failed, 0);
    });

    test('a failing check: still a successful RUN, but failed 1 / passed 0', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('', 'definitions'), loc('check "bad": (2 + 2) is 5 end\n')], optsMain));
      assert.equal(X.isSuccessResult(out[1].v), true); // a failing check is not a runtime failure
      const s = await X.summarizeChecks(out[1].v);
      assert.equal(s.total, 1);
      assert.equal(s.passed, 0);
      assert.equal(s.failed, 1);
    });

    test('checks OFF: the same check block runs no tests (total 0)', async () => {
      const out = await all(mkRunner().rerunInteractions(
        [loc('', 'definitions'), loc('check "ok": (2 + 2) is 4 end\n')], optsNone));
      assert.equal(X.isSuccessResult(out[1].v), true);
      const s = await X.summarizeChecks(out[1].v);
      assert.equal(s.total, 0);
    });
  });
});
