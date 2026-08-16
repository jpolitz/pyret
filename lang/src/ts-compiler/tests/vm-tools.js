// Small CLI over the hybrid bytecode: disassemble / verify the bytecode
// programs embedded in compiled hybrid modules.
//   node build/ts-compiler/../../src/ts-compiler/tests/vm-tools.js disasm <module.js> [fnIndex]
//   node .../vm-tools.js verify <compiled-dir-or-module.js>...
//   node .../vm-tools.js stats  <compiled-dir-or-module.js>...   (static opcode histogram)
const fs = require('fs');
const path = require('path');
const OP = require('../../../build/ts-compiler/vm/opcodes.js');
const D = require('../../../build/ts-compiler/vm/disasm.js');

function progsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const marker = 'var $BC = R.$vm.load(';
  let i = src.indexOf(marker);
  // theModule is a JS string inside the module file, so the JSON is
  // escaped: unescape by evaluating the module object.
  if (i < 0) { return out; }
  const mod = eval('(' + src + ')');
  const code = mod.theModule;
  let j = code.indexOf(marker);
  while (j >= 0) {
    const start = j + marker.length;
    // JSON ends right before ",L,[" -- find the matching brace.
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

function files(args) {
  const out = [];
  for (const a of args) {
    if (fs.statSync(a).isDirectory()) {
      for (const f of fs.readdirSync(a)) { if (f.endsWith('-module.js')) out.push(path.join(a, f)); }
    } else { out.push(a); }
  }
  return out;
}

const cmd = process.argv[2];
if (cmd === 'disasm') {
  const progs = progsOf(process.argv[3]);
  const fi = process.argv[4];
  for (const p of progs) {
    if (fi !== undefined) console.log(D.disassembleFunc(p, Number(fi)));
    else console.log(D.disassemble(p));
  }
} else if (cmd === 'verify') {
  let bad = 0, nf = 0, nm = 0;
  for (const f of files(process.argv.slice(3))) {
    for (const p of progsOf(f)) {
      nm++; nf += p.funcs.length;
      const probs = D.verify(p);
      for (const pr of probs) { console.log(f + ': ' + pr); bad++; }
    }
  }
  console.log(nm + ' bytecode modules, ' + nf + ' functions, ' + bad + ' problems');
  process.exit(bad === 0 ? 0 : 1);
} else if (cmd === 'stats') {
  const hist = {};
  let nf = 0, ninsn = 0, nthunks = 0;
  for (const f of files(process.argv.slice(3))) {
    for (const p of progsOf(f)) {
      nthunks += p.nthunks;
      for (const fn of p.funcs) {
        nf++;
        let pc = 0;
        while (pc < fn.c.length) {
          const insn = D.decode(fn.c, pc);
          const n = OP.OPCODE_NAMES[insn.op];
          hist[n] = (hist[n] || 0) + 1; ninsn++;
          pc = insn.end;
        }
      }
    }
  }
  const rows = Object.entries(hist).sort((a, b) => b[1] - a[1]);
  console.log(nf + ' functions, ' + ninsn + ' instructions, ' + nthunks + ' thunks');
  for (const [k, v] of rows) console.log(k.padEnd(11) + String(v).padStart(8) + '  ' + (100 * v / ninsn).toFixed(1) + '%');
} else {
  console.log('usage: vm-tools.js disasm|verify|stats ...');
}
