// Repartee engine unit tests (node:test). Run from lang/:
//   node --test src/ts-compiler/tests/repartee-test.js     (or `make ts-repartee-test`)
//
// Uses node's built-in test runner rather than jest: the in-process runtime
// suites (repartee-eval-test.js, repl-test.js) require requirejs, which cannot
// be loaded inside a jest worker (r.js auto-runs its CLI optimizer), so these
// run under plain node for consistency. Hyphenated filenames keep jest's default
// glob from picking them up.
//
// These exercise the engine's dataflow with a STUB executor that models the
// realm lineage (each run forks a child realm), asserting resume/anchor
// correctness without a runtime. End-to-end execution is in repartee-eval-test.js.
// Needs a warm builtin cache in tests/ts-compiled (built by `make ts-pyret-test`).

const path = require('path');
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

const OUT = path.join(__dirname, '..', '..', '..', 'build', 'ts-compiler');
const RP = require(path.join(OUT, 'repartee.js'));
const CS = require(path.join(OUT, 'compile-structs.js'));
const CML = require(path.join(OUT, 'cli-module-loader.js'));
const BL = require(path.join(OUT, 'locators/builtin.js'));

const context = {
  currentLoadPath: path.resolve('.'),
  cacheBaseDir: 'tests/ts-compiled',
  compiledReadOnlyDirs: [],
  urlFileMode: CS.allRemote,
};
const opts = { ...CS.defaultCompileOptions, checks: 'none', displayProgress: false };

// A stub executor whose realm is { id, parent }; each run forks a child. A
// source containing FAILRUN models a runtime failure (compiles, fails to run).
function mkStub() {
  const base = { id: 0, parent: null };
  let counter = 0;
  const log = [];
  const executor = {
    run(realm, programJsSource) {
      counter += 1;
      const child = { id: counter, parent: realm };
      log.push({ realmId: realm.id, childId: child.id, source: programJsSource });
      return programJsSource.includes('FAILRUN')
        ? { kind: 'fail', realm: child }
        : { kind: 'ok', realm: child };
    },
    isSuccessResult(r) { return r.kind === 'ok'; },
    getResultRealm(r) { return r.realm; },
  };
  return { base, log, executor };
}
function mkRunner(stub) {
  return RP.makeReparteeRunner(
    stub.executor, new Map(), stub.base, context,
    () => (ctx, dep) => CML.moduleFinder(ctx, dep));
}
const loc = (uri, src, kind) =>
  RP.makeChunkLocator(uri, typeof src === 'function' ? src : () => src, kind || 'interaction');
const all = (ps) => Promise.all(ps);

describe('repartee engine (stub executor)', () => {
  before(() => {
    BL.setBuiltinJsDirs(['src/js/trove/']);
    BL.setBuiltinArrDirs(['src/arr/trove/']);
  });

  test('rerunInteractions returns a synchronous array of promises', () => {
    const ps = mkRunner(mkStub()).rerunInteractions(
      [loc('definitions://', 'x = 1\n', 'definitions'), loc('chunk://1', 'x\n')], opts);
    assert.ok(Array.isArray(ps));
    assert.equal(ps.length, 2);
    assert.ok(ps[0] instanceof Promise);
  });

  test('full run: same-size list, all right; realm threads forward', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'y = x\n'),
      loc('chunk://2', 'z = y\n'),
    ], opts));
    assert.deepEqual(out.map((r) => r.$name), ['right', 'right', 'right']);
    assert.equal(stub.log[0].realmId, stub.base.id);        // defs <- base
    assert.equal(stub.log[1].realmId, stub.log[0].childId); // c1 <- defs
    assert.equal(stub.log[2].realmId, stub.log[1].childId); // c2 <- c1
  });

  test('edit middle: re-run resumes from the recorded start boundary, not the old result', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    let c1Src = 'y = x\n';
    const list = [
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', () => c1Src),
      loc('chunk://2', 'z = y\n'),
    ];
    await all(runner.rerunInteractions(list, opts));
    const postDefs = stub.log[1].realmId;
    c1Src = 'y = x + 1\n';
    const out = await all(runner.rerunInteractions([list[1], list[2]], opts));
    assert.deepEqual(out.map((r) => r.$name), ['right', 'right']);
    assert.equal(stub.log[3].realmId, postDefs);            // c1 resumed at the right boundary
    assert.equal(stub.log[4].realmId, stub.log[3].childId); // c2 threaded from re-run c1
  });

  test('compile error -> left, successor -> skip, executor never called', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'nosuchname777 + 1\n'),
      loc('chunk://2', 'x\n'),
    ], opts));
    assert.equal(out[0].$name, 'right');
    assert.equal(out[1].$name, 'left');
    assert.equal(out[2].$name, 'skip');
    assert.equal(stub.log.length, 1); // only definitions reached the executor
  });

  test('runtime failure -> right (non-success), successor -> skip', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'w = "FAILRUN"\n'),
      loc('chunk://2', 'x\n'),
    ], opts));
    assert.equal(out[1].$name, 'right');
    assert.equal(stub.executor.isSuccessResult(out[1].v), false);
    assert.equal(out[2].$name, 'skip');
    assert.equal(stub.log.length, 2); // defs + the failing chunk ran; skip did not
  });

  test('parse error -> thrown (carrying the error), successor -> skip', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'y = x +\n'),
      loc('chunk://2', 'x\n'),
    ], opts));
    assert.equal(out[1].$name, 'thrown');
    assert.ok(out[1].error);
    assert.equal(out[2].$name, 'skip');
    assert.equal(stub.log.length, 1); // parse failed before reaching the executor
  });

  test('append via `after`: a new chunk resumes from the anchor end-state without re-running it', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    await all(runner.rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'y = x\n'),
    ], opts));
    const postC1 = stub.log[1].childId;
    const before = stub.log.length;
    const out = await all(runner.rerunInteractions(
      [loc('chunk://2', 'z = y\n')], { after: 'chunk://1' }));
    assert.equal(out.length, 1);
    assert.equal(out[0].$name, 'right');
    assert.equal(stub.log.length, before + 1);     // ONLY the new chunk ran
    assert.equal(stub.log[before].realmId, postC1); // resumed from c1's end-state
  });

  test('insert via `after`: new middle chunk + re-run of its successor, anchored after a prior chunk', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    await all(runner.rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'y = x\n'),
      loc('chunk://2', 'z = y\n'),
    ], opts));
    const postDefs = stub.log[0].childId;
    const before = stub.log.length;
    const out = await all(runner.rerunInteractions(
      [loc('chunk://mid', 'm = x\n'), loc('chunk://1', 'y = x\n')], { after: 'definitions://' }));
    assert.deepEqual(out.map((r) => r.$name), ['right', 'right']);
    assert.equal(stub.log.length, before + 2);                       // mid + c1 only
    assert.equal(stub.log[before].realmId, postDefs);               // mid <- post-defs
    assert.equal(stub.log[before + 1].realmId, stub.log[before].childId); // c1 <- mid
  });

  test('hasEndState reflects only successfully-run chunks; clearSnapshots forgets everything', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    await all(runner.rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'w = "FAILRUN"\n'),
    ], opts));
    assert.equal(runner.hasEndState('definitions://'), true);
    assert.equal(runner.hasEndState('chunk://1'), false); // failed -> no end-state
    runner.clearSnapshots();
    assert.equal(runner.hasEndState('definitions://'), false);
  });

  test('clearSnapshots makes the next run start from the base realm', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    const list = [loc('definitions://', 'x = 1\n', 'definitions'), loc('chunk://1', 'x\n')];
    await all(runner.rerunInteractions(list, opts));
    runner.clearSnapshots();
    const before = stub.log.length;
    await all(runner.rerunInteractions(list, opts));
    assert.equal(stub.log[before].realmId, stub.base.id); // defs <- base again
  });
});
