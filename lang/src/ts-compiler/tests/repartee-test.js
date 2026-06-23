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
// realm lineage (each run forks a child realm), asserting the roster API:
// resume-from-predecessor-end-state, the prefix-skipped / not-reached result
// kinds, cheap delete (only the chunk after a deleted one re-runs), roster-driven
// GC of removed chunks, and the synchronous contract-violation throws (startIndex
// out of range, or resuming after a chunk with no end-state). End-to-end execution
// is in repartee-eval-test.js.
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

  test('rerunInteractions returns a synchronous array of promises, one per roster entry', () => {
    const ps = mkRunner(mkStub()).rerunInteractions(
      [loc('definitions://', 'x = 1\n', 'definitions'), loc('chunk://1', 'x\n')], 0, opts);
    assert.ok(Array.isArray(ps));
    assert.equal(ps.length, 2);
    assert.ok(ps[0] instanceof Promise);
  });

  test('full run (startIndex 0): same-size list, all right; realm threads forward', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'y = x\n'),
      loc('chunk://2', 'z = y\n'),
    ], 0, opts));
    assert.deepEqual(out.map((r) => r.$name), ['right', 'right', 'right']);
    assert.equal(stub.log[0].realmId, stub.base.id);        // defs <- base
    assert.equal(stub.log[1].realmId, stub.log[0].childId); // c1 <- defs
    assert.equal(stub.log[2].realmId, stub.log[1].childId); // c2 <- c1
  });

  test('edit middle (startIndex into full roster): resumes from the predecessor end-state', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    let c1Src = 'y = x\n';
    const roster = [
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', () => c1Src),
      loc('chunk://2', 'z = y\n'),
    ];
    await all(runner.rerunInteractions(roster, 0, opts));
    const postDefs = stub.log[1].realmId;                   // c1's input realm first run
    c1Src = 'y = x + 1\n';
    // Edit c1 -> re-run the whole roster from index 1; index 0 (defs) is retained.
    const out = await all(runner.rerunInteractions(roster, 1, opts));
    assert.deepEqual(out.map((r) => r.$name), ['prefix-skipped', 'right', 'right']);
    assert.equal(stub.log[3].realmId, postDefs);            // c1 resumed at the predecessor boundary
    assert.equal(stub.log[4].realmId, stub.log[3].childId); // c2 threaded from re-run c1
  });

  test('compile error -> left, successor -> not-reached, executor never called', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'nosuchname777 + 1\n'),
      loc('chunk://2', 'x\n'),
    ], 0, opts));
    assert.equal(out[0].$name, 'right');
    assert.equal(out[1].$name, 'left');
    assert.equal(out[2].$name, 'not-reached');
    assert.equal(stub.log.length, 1); // only definitions reached the executor
  });

  test('runtime failure -> right (non-success), successor -> not-reached', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'w = "FAILRUN"\n'),
      loc('chunk://2', 'x\n'),
    ], 0, opts));
    assert.equal(out[1].$name, 'right');
    assert.equal(stub.executor.isSuccessResult(out[1].v), false);
    assert.equal(out[2].$name, 'not-reached');
    assert.equal(stub.log.length, 2); // defs + the failing chunk ran; the third did not
  });

  test('parse error -> thrown (carrying the error), successor -> not-reached', async () => {
    const stub = mkStub();
    const out = await all(mkRunner(stub).rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'y = x +\n'),
      loc('chunk://2', 'x\n'),
    ], 0, opts));
    assert.equal(out[1].$name, 'thrown');
    assert.ok(out[1].error);
    assert.equal(out[2].$name, 'not-reached');
    assert.equal(stub.log.length, 1); // parse failed before reaching the executor
  });

  test('append (startIndex at the new tail): only the new chunk runs, from the predecessor end-state', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    const defs = loc('definitions://', 'x = 1\n', 'definitions');
    const c1 = loc('chunk://1', 'y = x\n');
    await all(runner.rerunInteractions([defs, c1], 0, opts));
    const postC1 = stub.log[1].childId;
    const before = stub.log.length;
    const c2 = loc('chunk://2', 'z = y\n');
    const out = await all(runner.rerunInteractions([defs, c1, c2], 2, opts));
    assert.deepEqual(out.map((r) => r.$name), ['prefix-skipped', 'prefix-skipped', 'right']);
    assert.equal(stub.log.length, before + 1);     // ONLY the new chunk ran
    assert.equal(stub.log[before].realmId, postC1); // resumed from c1's end-state
  });

  test('insert (startIndex at the inserted chunk): the inserted chunk and all after it re-run', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    const defs = loc('definitions://', 'x = 1\n', 'definitions');
    const c1 = loc('chunk://1', 'y = x\n');
    const c2 = loc('chunk://2', 'z = y\n');
    await all(runner.rerunInteractions([defs, c1, c2], 0, opts));
    const postDefs = stub.log[0].childId;
    const before = stub.log.length;
    const mid = loc('chunk://mid', 'm = x\n');
    // Insert `mid` between defs and c1: new roster, startIndex 1 re-runs mid, c1, c2.
    const out = await all(runner.rerunInteractions([defs, mid, c1, c2], 1, opts));
    assert.deepEqual(out.map((r) => r.$name), ['prefix-skipped', 'right', 'right', 'right']);
    assert.equal(stub.log.length, before + 3);                       // mid + c1 + c2
    assert.equal(stub.log[before].realmId, postDefs);                // mid <- post-defs
    assert.equal(stub.log[before + 1].realmId, stub.log[before].childId);     // c1 <- mid
    assert.equal(stub.log[before + 2].realmId, stub.log[before + 1].childId); // c2 <- c1
  });

  test('delete is as cheap as blanking: only the chunk after the deleted one re-runs', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    const defs = loc('definitions://', 'x = 1\n', 'definitions');
    const c1 = loc('chunk://1', 'y = x\n');
    const c2 = loc('chunk://2', 'z = x\n');
    await all(runner.rerunInteractions([defs, c1, c2], 0, opts));
    const postDefs = stub.log[0].childId;
    const before = stub.log.length;
    // Delete c1: new roster is [defs, c2]; c2 is now index 1, resumes from defs.
    const out = await all(runner.rerunInteractions([defs, c2], 1, opts));
    assert.deepEqual(out.map((r) => r.$name), ['prefix-skipped', 'right']);
    assert.equal(stub.log.length, before + 1);          // only c2 re-ran; defs untouched
    assert.equal(stub.log[before].realmId, postDefs);   // c2 resumed from defs' end-state
    assert.equal(runner.hasEndState('chunk://1'), false); // deleted chunk's snapshot GC'd
    assert.equal(runner.hasEndState('definitions://'), true);
  });

  test('GC reconcile: a removed chunk\'s end-state is dropped even on a no-op (startIndex == length) call', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    const defs = loc('definitions://', 'x = 1\n', 'definitions');
    const c1 = loc('chunk://1', 'y = x\n');
    const c2 = loc('chunk://2', 'z = y\n');
    await all(runner.rerunInteractions([defs, c1, c2], 0, opts));
    assert.equal(runner.hasEndState('chunk://2'), true);
    const before = stub.log.length;
    // Remove the trailing chunk; pass the shorter roster, run nothing (startIndex == length).
    const out = await all(runner.rerunInteractions([defs, c1], 2, opts));
    assert.deepEqual(out.map((r) => r.$name), ['prefix-skipped', 'prefix-skipped']);
    assert.equal(stub.log.length, before);                // nothing ran
    assert.equal(runner.hasEndState('chunk://2'), false); // but its snapshot was reclaimed
    assert.equal(runner.hasEndState('chunk://1'), true);
  });

  test('startIndex out of range throws synchronously', () => {
    const runner = mkRunner(mkStub());
    const roster = [loc('definitions://', 'x = 1\n', 'definitions'), loc('chunk://1', 'x\n')];
    assert.throws(() => runner.rerunInteractions(roster, 3, opts), /out of range/);
    assert.throws(() => runner.rerunInteractions(roster, -1, opts), /out of range/);
  });

  test('resuming after a chunk with no recorded end-state throws synchronously', () => {
    const runner = mkRunner(mkStub());
    const roster = [loc('definitions://', 'x = 1\n', 'definitions'), loc('chunk://1', 'x\n')];
    // Nothing has run, so defs has no end-state to resume after.
    assert.throws(() => runner.rerunInteractions(roster, 1, opts), /no recorded end-state/);
  });

  test('hasEndState reflects only successfully-run chunks; clearSnapshots forgets everything', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    await all(runner.rerunInteractions([
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'w = "FAILRUN"\n'),
    ], 0, opts));
    assert.equal(runner.hasEndState('definitions://'), true);
    assert.equal(runner.hasEndState('chunk://1'), false); // failed -> no end-state
    runner.clearSnapshots();
    assert.equal(runner.hasEndState('definitions://'), false);
  });

  test('clearSnapshots makes the next run start from the base realm', async () => {
    const stub = mkStub();
    const runner = mkRunner(stub);
    const list = [loc('definitions://', 'x = 1\n', 'definitions'), loc('chunk://1', 'x\n')];
    await all(runner.rerunInteractions(list, 0, opts));
    runner.clearSnapshots();
    const before = stub.log.length;
    await all(runner.rerunInteractions(list, 0, opts));
    assert.equal(stub.log[before].realmId, stub.base.id); // defs <- base again
  });

  test('an empty roster returns an empty array synchronously and runs nothing', async () => {
    const stub = mkStub();
    const ps = mkRunner(stub).rerunInteractions([], 0, opts);
    assert.ok(Array.isArray(ps));
    assert.equal(ps.length, 0);
    assert.deepEqual(await all(ps), []);
    assert.equal(stub.log.length, 0);
  });

  describe('single-flight / isRunning', () => {
    const roster = () => [
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'y = x\n'),
    ];

    test('isRunning is false at rest, true while a run is in flight, false once it settles', async () => {
      const runner = mkRunner(mkStub());
      assert.equal(runner.isRunning(), false);
      const ps = runner.rerunInteractions(roster(), 0, opts);
      assert.equal(runner.isRunning(), true); // synchronously busy after launch
      await all(ps);
      assert.equal(runner.isRunning(), false); // settled before the awaiting caller resumes
    });

    test('a re-entrant rerunInteractions throws while a run is in flight; works once settled', async () => {
      const runner = mkRunner(mkStub());
      const r = roster();
      const ps = runner.rerunInteractions(r, 0, opts);
      assert.throws(() => runner.rerunInteractions(r, 0, opts), /already in progress/);
      await all(ps);
      const out = await all(runner.rerunInteractions(r, 0, opts)); // fine now
      assert.deepEqual(out.map((x) => x.$name), ['right', 'right']);
    });

    test('clearSnapshots throws while a run is in flight; works once settled', async () => {
      const runner = mkRunner(mkStub());
      const ps = runner.rerunInteractions(roster(), 0, opts);
      assert.throws(() => runner.clearSnapshots(), /in progress/);
      await all(ps);
      runner.clearSnapshots(); // fine now
      assert.equal(runner.hasEndState('definitions://'), false);
    });

    test('a no-op call (startIndex == length) never goes busy and does not block the next run', async () => {
      const runner = mkRunner(mkStub());
      const r = roster();
      await all(runner.rerunInteractions(r, 0, opts));
      const ps = runner.rerunInteractions(r, 2, opts); // run nothing
      assert.equal(runner.isRunning(), false);          // never busy
      assert.deepEqual((await all(ps)).map((x) => x.$name), ['prefix-skipped', 'prefix-skipped']);
      // Not blocked: a real run can follow immediately.
      const out = await all(runner.rerunInteractions(r, 1, opts));
      assert.equal(out[1].$name, 'right');
    });

    test('isRunning returns to false after a run that stops on an error', async () => {
      const runner = mkRunner(mkStub());
      const r = [
        loc('definitions://', 'x = 1\n', 'definitions'),
        loc('chunk://1', 'w = "FAILRUN"\n'),
        loc('chunk://2', 'x\n'),
      ];
      const out = await all(runner.rerunInteractions(r, 0, opts));
      assert.equal(out[2].$name, 'not-reached');
      assert.equal(runner.isRunning(), false); // cleared even though evaluation stopped early
    });
  });

  // The pull/stream form. The headline property is the one the old push API
  // silently violated and that motivated this API: while the consumer holds its
  // turn (between yields), the engine takes NO execution turn — so a consumer can
  // safely re-enter the runtime to render. The stub's run-counter lets us assert
  // it directly: the engine must not advance during the consumer's body.
  describe('pull/stream API (rerunStream)', () => {
    const threeRoster = () => [
      loc('definitions://', 'x = 1\n', 'definitions'),
      loc('chunk://1', 'x\n'),
      loc('chunk://2', 'x\n'),
    ];

    test('suspends at each yield: the engine runs no chunk while the consumer holds its turn', async () => {
      const stub = mkStub();
      const runner = mkRunner(stub);
      const seen = [];
      for await (const { index, entry } of runner.rerunStream(threeRoster(), 0, opts)) {
        seen.push(index);
        const runsAtYield = stub.log.length;
        // Consumer takes a turn (a macrotask, like an async render would).
        await new Promise((r) => setTimeout(r, 0));
        // The engine, parked at the yield, must not have run the next chunk.
        assert.equal(stub.log.length, runsAtYield,
          `engine advanced during the consumer's turn at index ${index}`);
        assert.equal(entry.$name, 'right');
      }
      assert.deepEqual(seen, [0, 1, 2]);
      assert.equal(stub.log.length, 3); // each chunk ran exactly once, in order
      assert.equal(runner.isRunning(), false);
    });

    test('yields prefix-skipped for the retained prefix, then runs the suffix', async () => {
      const stub = mkStub();
      const runner = mkRunner(stub);
      const r = threeRoster();
      await all(runner.rerunInteractions(r, 0, opts)); // establish end-states
      const kinds = [];
      for await (const { entry } of runner.rerunStream(r, 2, opts)) { kinds.push(entry.$name); }
      assert.deepEqual(kinds, ['prefix-skipped', 'prefix-skipped', 'right']);
    });

    test('stops at the first error; later chunks yield not-reached', async () => {
      const runner = mkRunner(mkStub());
      const r = [
        loc('definitions://', 'x = 1\n', 'definitions'),
        loc('chunk://1', 'w = "FAILRUN"\n'),
        loc('chunk://2', 'x\n'),
      ];
      const kinds = [];
      for await (const { entry } of runner.rerunStream(r, 0, opts)) { kinds.push(entry.$name); }
      assert.deepEqual(kinds, ['right', 'right', 'not-reached']);
      assert.equal(runner.isRunning(), false);
    });

    test('throws synchronously on contract violations (range / no end-state / overlap)', async () => {
      const runner = mkRunner(mkStub());
      const r = threeRoster();
      assert.throws(() => runner.rerunStream(r, 9, opts), /out of range/);
      assert.throws(() => runner.rerunStream(r, 2, opts), /no recorded end-state/); // nothing ran yet
      const live = runner.rerunStream(r, 0, opts); // claims the channel synchronously
      assert.equal(runner.isRunning(), true);
      assert.throws(() => runner.rerunStream(r, 0, opts), /in progress/);
      assert.throws(() => runner.rerunInteractions(r, 0, opts), /in progress/);
      for await (const _ of live) { /* drain to release */ }
      assert.equal(runner.isRunning(), false);
    });

    test('breaking out closes the stream and releases the single-flight claim', async () => {
      const runner = mkRunner(mkStub());
      const r = threeRoster();
      for await (const { index } of runner.rerunStream(r, 0, opts)) {
        if (index === 1) { break; } // for-await calls .return() -> finally -> running=false
      }
      assert.equal(runner.isRunning(), false);
      const out = await all(runner.rerunInteractions(r, 0, opts)); // a fresh run still works
      assert.equal(out.length, 3);
      assert.equal(out[2].$name, 'right');
    });
  });
});
