// The machine's step hook: pause/resume of a bytecode stack at arbitrary
// instruction boundaries from OUTSIDE the program, with the frames
// inspectable. Runs a hybrid standalone built with `--vm-fast none` (every
// Gen-tier function interpreted from its first instruction) under a hook
// that, every N instructions, records the machine's frames and pauses on a
// macrotask; then checks the program's own output is what it always is,
// that pauses happened at nonzero interpreted depth, and that frames carry
// names/locations.
//   node tests/async-opt/vm/step-hook-test.js <hybrid-nofast.jarr> <expected-first-line>
const path = require('path');
const jarr = path.resolve(process.argv[2]);
const expected = process.argv[3];

let instructions = 0, pauses = 0, maxDepth = 0;
const seen = new Set();
globalThis.PYRET_VM_HOOK = function(top) {
  instructions++;
  seen.add(top.name);
  if (top.depth > maxDepth) { maxDepth = top.depth; }
  if (instructions % 200000 === 0) {
    pauses++;
    if (typeof top.name !== 'string' || !Array.isArray(top.loc) || typeof top.op !== 'string') {
      throw new Error('bad frame info: ' + JSON.stringify(top));
    }
    // Materialize the whole stack once in a while: every frame must be
    // named and located.
    if (pauses % 10 === 1) {
      const frames = top.frames();
      if (frames.length !== top.depth) { throw new Error('frames() length ' + frames.length + ' != depth ' + top.depth); }
      for (const fr of frames) { if (typeof fr.name !== 'string' || !Array.isArray(fr.loc)) { throw new Error('bad frame: ' + JSON.stringify(fr)); } }
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return undefined;
};

// Capture the program's stdout.
let out = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { out += s; return true; };
process.on('exit', (code) => {
  process.stdout.write = origWrite;
  const first = out.split('\n')[0];
  const ok = code === 0 && first === expected && pauses > 0 && maxDepth > 1;
  console.log('step-hook: ' + instructions + ' instructions seen, ' + pauses + ' pauses, max depth ' + maxDepth
    + ', functions seen: ' + [...seen].slice(0, 6).join(',') + (seen.size > 6 ? ',...' : '')
    + ' | program output ' + JSON.stringify(first) + (first === expected ? ' (expected)' : ' (EXPECTED ' + JSON.stringify(expected) + ')')
    + ' => ' + (ok ? 'PASS' : 'FAIL'));
  if (!ok) { process.exitCode = 1; }
});
require(jarr);
