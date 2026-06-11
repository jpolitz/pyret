#!/usr/bin/env node
// REPL-library test for the TS compiler port. Run from lang/:
//   node src/ts-compiler/tests/repl-test.js
// Exercises the compile side of repl.ts (provide rewriting, globals
// chaining across interactions, locator caching, error reporting) with a
// stub executor standing in for the host's realm runner (load-lib in CPO).

const path = require('path');
const assert = require('assert');

const OUT = path.join(__dirname, '..', '..', '..', 'build', 'ts-compiler');
function load(mod) { return require(path.join(OUT, mod)); }

const REPL = load('repl.js');
const CS = load('compile-structs.js');
const CML = load('cli-module-loader.js');
const BL = load('locators/builtin.js');

BL.setBuiltinJsDirs(['src/js/trove/']);
BL.setBuiltinArrDirs(['src/arr/trove/']);

// Builtins resolve through the warm cache used by the test suite; run
// `make ts-pyret-test` (or any TS build with --compiled-dir
// tests/ts-compiled/) first.
const context = {
  currentLoadPath: path.resolve('.'),
  cacheBaseDir: 'tests/ts-compiled',
  compiledReadOnlyDirs: [],
  urlFileMode: CS.allRemote,
};

const runLog = [];
let realmCounter = 0;
const executor = {
  run(realm, programJsSource, _options) {
    runLog.push({ realm, source: programJsSource });
    realmCounter++;
    return { kind: 'stub-success', realm: 'realm-' + realmCounter };
  },
  isSuccessResult(result) { return result.kind === 'stub-success'; },
  getResultRealm(result) { return result.realm; },
};

const repl = REPL.makeRepl(
  executor,
  new Map(),
  'realm-0',
  context,
  () => (ctx, dep) => CML.moduleFinder(ctx, dep)
);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}

const defs = repl.makeDefinitionsLocator(
  () => 'x = 10\nfun sq(n :: Number): n * n end\n',
  CS.standardGlobals
);
const opts = { ...CS.defaultCompileOptions, checks: 'none', displayProgress: false };

const r0 = repl.restartInteractions(defs, opts);
check('definitions compile and run', () => {
  assert.strictEqual(r0.$name, 'right');
  assert.strictEqual(runLog.length, 1);
  assert.ok(runLog[0].source.includes('definitions://'));
});

const i1 = repl.makeInteractionLocator(() => 'y = sq(x)\n');
const r1 = repl.runInteraction(i1);
check('interaction 1 sees definitions (x, sq)', () => {
  assert.strictEqual(r1.$name, 'right');
  assert.ok(runLog[1].source.includes('interactions://1'));
  // executor receives the chained realm from the previous run
  assert.strictEqual(runLog[1].realm, 'realm-1');
});

const i2 = repl.makeInteractionLocator(() => 'z = y + x\nz\n');
const r2 = repl.runInteraction(i2);
check('interaction 2 sees both definitions and interaction 1', () => {
  assert.strictEqual(r2.$name, 'right');
  assert.ok(runLog[2].source.includes('interactions://2'));
  assert.strictEqual(runLog[2].realm, 'realm-2');
});

const i3 = repl.makeInteractionLocator(() => 'no-such-name-xyz + 1\n');
const r3 = repl.runInteraction(i3);
check('unbound name in interaction is a compile error', () => {
  assert.strictEqual(r3.$name, 'left');
  const errs = r3.v;
  assert.ok(errs.length >= 1);
  const rendered = JSON.stringify(errs.map((e) =>
    e.problems ? e.problems.map((p) => p.$name) : e.$name));
  assert.match(rendered, /unbound/);
  // failed interaction must not advance the realm or globals
  assert.strictEqual(runLog.length, 3);
});

const i4 = repl.makeInteractionLocator(() => 'z * 2\n');
const r4 = repl.runInteraction(i4);
check('chain continues after a failed interaction', () => {
  assert.strictEqual(r4.$name, 'right');
  assert.strictEqual(runLog[3].realm, 'realm-3');
});

const r5 = repl.restartInteractions(defs, opts);
const i5 = repl.makeInteractionLocator(() => 'z\n');
const r6 = repl.runInteraction(i5);
check('restart clears interaction scope (z unbound again)', () => {
  assert.strictEqual(r5.$name, 'right');
  assert.strictEqual(r6.$name, 'left');
});

console.log('');
console.log(`repl tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
