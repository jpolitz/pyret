// Unit checks for the hybrid bytecode machine's two halves:
//   1. the opcode table and format version stated in vm/opcodes.ts (emitter)
//      and in runtime-async.js (machine) agree;
//   2. every bytecode module in the given compiled dirs verifies
//      structurally (disasm.verify): operand shapes, jump targets on
//      instruction boundaries, slot/upval/const/global/thunk indices in
//      range, no overlapping inline-cache runs, no fall-off-the-end.
// Usage: node src/ts-compiler/tests/vm-unit-test.js [compiled-dir...]
const fs = require('fs');
const path = require('path');
const OP = require('../../../build/ts-compiler/vm/opcodes.js');
const D = require('../../../build/ts-compiler/vm/disasm.js');

let failed = 0;
function check(cond, msg) { if (cond) { console.log('ok   ' + msg); } else { console.log('FAIL ' + msg); failed++; } }

// 1. table parity: parse the runtime's VM_OPCODE_NAMES literal and VM_FORMAT_VERSION.
const rt = fs.readFileSync(path.join(__dirname, '../../js/base/runtime-async.js'), 'utf8');
const m = rt.match(/var VM_OPCODE_NAMES = \[([\s\S]*?)\];/);
check(m !== null, 'runtime declares VM_OPCODE_NAMES');
if (m) {
  const names = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s.length > 0);
  check(JSON.stringify(names) === JSON.stringify(OP.OPCODE_NAMES),
    'opcode tables agree (' + names.length + ' opcodes)');
  // The numbered OP_ constants in the runtime must match their positions.
  const consts = rt.match(/var OP_MOVE = 0,[\s\S]*?OP_NOP = (\d+);/);
  check(consts !== null && Number(consts[1]) === OP.OP_NOP, 'runtime OP_ constants numbered like the table');
}
const v = rt.match(/var VM_FORMAT_VERSION = (\d+);/);
check(v !== null && Number(v[1]) === OP.FORMAT_VERSION, 'format version agrees (' + OP.FORMAT_VERSION + ')');

// 2. verify compiled dirs
function progsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.indexOf('var $BC = R.$vm.load(') < 0) { return []; }
  const mod = eval('(' + src + ')');
  const code = mod.theModule;
  const marker = 'var $BC = R.$vm.load(';
  const out = [];
  let j = code.indexOf(marker);
  while (j >= 0) {
    const start = j + marker.length;
    let depth = 0, k = start;
    for (; k < code.length; k++) {
      const c = code[k];
      if (c === '"') { k++; while (code[k] !== '"') { if (code[k] === '\\') k++; k++; } continue; }
      if (c === '{') depth++;
      if (c === '}') { depth--; if (depth === 0) { k++; break; } }
    }
    out.push(JSON.parse(code.slice(start, k)));
    j = code.indexOf(marker, k);
  }
  return out;
}
let nm = 0, nf = 0, problems = 0;
for (const dir of process.argv.slice(2)) {
  if (!fs.existsSync(dir)) { continue; }
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('-module.js')) { continue; }
    for (const p of progsOf(path.join(dir, f))) {
      nm++; nf += p.funcs.length;
      check(p.v === OP.FORMAT_VERSION, 'format version of ' + f);
      const probs = D.verify(p);
      for (const pr of probs) { console.log('FAIL ' + f + ': ' + pr); problems++; }
    }
  }
}
check(problems === 0, 'verifier: ' + nm + ' bytecode modules, ' + nf + ' functions, ' + problems + ' problems');
if (failed > 0) { console.log(failed + ' checks FAILED'); process.exit(1); }
console.log('vm unit tests OK');
