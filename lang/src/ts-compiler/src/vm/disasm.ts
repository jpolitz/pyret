/*
  Disassembler and verifier for hybrid bytecode (see opcodes.ts).

  `disassemble(prog)` prints every function; `verify(prog)` walks each
  function's instruction stream with the operand shapes stated here and
  checks jump targets land on instruction boundaries, slot indices are in
  range, and inline-cache runs do not overlap. Both are consumers of the
  same opcode table the emitter uses; the machine's copy is checked against
  it by tests/vm-unit-test.js.
*/

import * as OP from './opcodes';
import { VMProgram, VMFunc } from './opcodes';

// Operand shape per opcode. Letters: d=dest slot, v=value source, k=name idx,
// l=loc idx, t=jump target, i=plain int, T=thunk idx, F=func idx,
// D=dispatch idx, C=cache base, then a variadic tail described separately.
const SHAPES: Record<number, string> = {};
SHAPES[OP.OP_MOVE] = 'dv';
SHAPES[OP.OP_BOX] = 'dv';
SHAPES[OP.OP_UNBOX] = 'dv';
SHAPES[OP.OP_SETVAR] = 'vvd';
SHAPES[OP.OP_LETREC] = 'dvlk';
SHAPES[OP.OP_MODREF] = 'dvk';
SHAPES[OP.OP_MODVARREF] = 'dvk';
SHAPES[OP.OP_ARRSET] = 'viv';
SHAPES[OP.OP_JMP] = 't';
SHAPES[OP.OP_IF] = 'vt';
SHAPES[OP.OP_RET] = 'v';
SHAPES[OP.OP_CALL] = 'dvl*';
SHAPES[OP.OP_CALLFLAT] = 'dvli*';
SHAPES[OP.OP_TAILCALL] = 'vl*';
SHAPES[OP.OP_METHCALL] = 'dvkliC*';
SHAPES[OP.OP_METHCALLD] = 'dvkli*';
SHAPES[OP.OP_PRIMAPP] = 'dkli*';
SHAPES[OP.OP_CLOSURE] = 'dF';
SHAPES[OP.OP_METHOD] = 'dF';
SHAPES[OP.OP_THUNK] = 'dTli*';
SHAPES[OP.OP_DOT] = 'dvkl';
SHAPES[OP.OP_DOTD] = 'dvk';
SHAPES[OP.OP_DOTC] = 'dvkliv';
SHAPES[OP.OP_COLON] = 'dvkl';
SHAPES[OP.OP_GETBANG] = 'dvkl';
SHAPES[OP.OP_TUPLEGET] = 'dvil';
SHAPES[OP.OP_CASES] = 'vDlt';
SHAPES[OP.OP_CASESPRE] = 'vill';
SHAPES[OP.OP_CASESBIND] = 'v#C';   // # = count of (d, i) pairs
SHAPES[OP.OP_CASESBINDD] = 'v%';   // % = count of (d, k, i) triples
SHAPES[OP.OP_ANNCHECKV] = 'vvli';
SHAPES[OP.OP_TUPLECHK] = 'vil';
SHAPES[OP.OP_NEWTYPE] = 'ddkl';
SHAPES[OP.OP_NOP] = '';

export interface Insn {
  pc: number;
  op: number;
  operands: number[];
  /** Positions in `operands` that are jump targets. */
  targets: number[];
  end: number;
}

/** Decode the instruction at pc. */
export function decode(code: number[], pc0: number): Insn {
  let pc = pc0;
  const op = code[pc++];
  const shape = SHAPES[op];
  if (shape === undefined) { throw new Error('disasm: unknown opcode ' + op + ' at ' + pc0); }
  const operands: number[] = [];
  const targets: number[] = [];
  for (let i = 0; i < shape.length; i++) {
    const ch = shape[i];
    switch (ch) {
      case '*': {
        const n = code[pc++];
        operands.push(n);
        for (let j = 0; j < n; j++) { operands.push(code[pc++]); }
        break;
      }
      case '#': {
        const n = code[pc++];
        operands.push(n);
        operands.push(code[pc++]); // C
        for (let j = 0; j < n; j++) { operands.push(code[pc++]); operands.push(code[pc++]); }
        i++; // consumed 'C'
        break;
      }
      case '%': {
        const n = code[pc++];
        operands.push(n);
        for (let j = 0; j < n; j++) { operands.push(code[pc++]); operands.push(code[pc++]); operands.push(code[pc++]); }
        break;
      }
      case 't':
        targets.push(operands.length);
        operands.push(code[pc++]);
        break;
      default:
        operands.push(code[pc++]);
    }
  }
  return { pc: pc0, op, operands, targets, end: pc };
}

function vsStr(vs: number, prog: VMProgram): string {
  const i = vs >> 2;
  switch (vs & 3) {
    case OP.VS_LOCAL: return 'r' + i;
    case OP.VS_UPVAL: return 'u' + i;
    case OP.VS_CONST: return 'k' + i + '(' + JSON.stringify(prog.consts[i]) + ')';
    default: return 'g' + i;
  }
}

export function disassembleFunc(prog: VMProgram, idx: number): string {
  const fn = prog.funcs[idx];
  const out: string[] = [];
  out.push('function ' + idx + ': ' + (fn.n || '<anon>') + (fn.m ? ' (method)' : '')
    + ' arity=' + fn.a + ' slots=' + fn.s + ' upvals=' + JSON.stringify(fn.u) + ' loc=' + fn.l);
  let pc = 0;
  const code = fn.c;
  while (pc < code.length) {
    const insn = decode(code, pc);
    const name = OP.OPCODE_NAMES[insn.op];
    const shape = SHAPES[insn.op];
    const parts: string[] = [];
    let oi = 0;
    for (let i = 0; i < shape.length; i++) {
      const ch = shape[i];
      switch (ch) {
        case 'd': parts.push('r' + insn.operands[oi++]); break;
        case 'v': parts.push(vsStr(insn.operands[oi++], prog)); break;
        case 'k': parts.push(JSON.stringify(prog.names[insn.operands[oi++]])); break;
        case 'l': parts.push('L' + insn.operands[oi++]); break;
        case 't': parts.push('-> ' + insn.operands[oi++]); break;
        case 'i': parts.push(String(insn.operands[oi++])); break;
        case 'T': parts.push('thunk#' + insn.operands[oi++]); break;
        case 'F': parts.push('fn#' + insn.operands[oi++]); break;
        case 'D': parts.push('dispatch#' + insn.operands[oi++] + JSON.stringify(prog.dispatches[insn.operands[oi - 1]])); break;
        case 'C': parts.push('ic@' + insn.operands[oi++]); break;
        case '*': {
          const n = insn.operands[oi++];
          const args: string[] = [];
          for (let j = 0; j < n; j++) { args.push(vsStr(insn.operands[oi++], prog)); }
          parts.push('(' + args.join(', ') + ')');
          break;
        }
        case '#': {
          const n = insn.operands[oi++];
          parts.push('ic@' + insn.operands[oi++]);
          const binds: string[] = [];
          for (let j = 0; j < n; j++) { const d = insn.operands[oi++]; const r = insn.operands[oi++]; binds.push('r' + d + (r ? '!' : '')); }
          parts.push('[' + binds.join(', ') + ']');
          i++;
          break;
        }
        case '%': {
          const n = insn.operands[oi++];
          const binds: string[] = [];
          for (let j = 0; j < n; j++) {
            const d = insn.operands[oi++]; const k = insn.operands[oi++]; const m = insn.operands[oi++];
            binds.push('r' + d + '=' + JSON.stringify(prog.names[k]) + (m ? '/' + m : ''));
          }
          parts.push('[' + binds.join(', ') + ']');
          break;
        }
      }
    }
    out.push('  ' + String(pc).padStart(5) + '  ' + name.padEnd(10) + ' ' + parts.join(', '));
    pc = insn.end;
  }
  return out.join('\n');
}

export function disassemble(prog: VMProgram): string {
  const out: string[] = [];
  out.push('; bytecode format v' + prog.v + ': ' + prog.funcs.length + ' functions, '
    + prog.nglobals + ' globals, ' + prog.nthunks + ' thunks, ' + prog.consts.length + ' consts');
  for (let i = 0; i < prog.funcs.length; i++) {
    out.push(disassembleFunc(prog, i));
    out.push('');
  }
  return out.join('\n');
}

/** Structural checks; returns a list of problems (empty = ok). */
export function verify(prog: VMProgram): string[] {
  const problems: string[] = [];
  const cacheRuns: Array<[number, number, string]> = [];
  prog.funcs.forEach((fn: VMFunc, idx: number) => {
    const where = 'fn#' + idx + ' ' + fn.n;
    const code = fn.c;
    const starts = new Set<number>();
    const insns: Insn[] = [];
    let pc = 0;
    try {
      while (pc < code.length) {
        starts.add(pc);
        const insn = decode(code, pc);
        insns.push(insn);
        pc = insn.end;
      }
    } catch (e) {
      problems.push(where + ': ' + (e as Error).message);
      return;
    }
    if (pc !== code.length) { problems.push(where + ': code overruns'); }
    for (const insn of insns) {
      const shape = SHAPES[insn.op];
      let oi = 0;
      for (let i = 0; i < shape.length; i++) {
        const ch = shape[i];
        const check = (vs: number, what: string): void => {
          const j = vs >> 2;
          switch (vs & 3) {
            case OP.VS_LOCAL: if (j >= fn.s) { problems.push(where + ' pc ' + insn.pc + ': ' + what + ' local r' + j + ' out of range'); } break;
            case OP.VS_UPVAL: if (j >= fn.u.length) { problems.push(where + ' pc ' + insn.pc + ': ' + what + ' upval u' + j + ' out of range'); } break;
            case OP.VS_CONST: if (j >= prog.consts.length) { problems.push(where + ' pc ' + insn.pc + ': const k' + j + ' out of range'); } break;
            default: if (j >= prog.nglobals) { problems.push(where + ' pc ' + insn.pc + ': global g' + j + ' out of range'); }
          }
        };
        switch (ch) {
          case 'd': if (insn.operands[oi] >= fn.s) { problems.push(where + ' pc ' + insn.pc + ': dest r' + insn.operands[oi] + ' out of range'); } oi++; break;
          case 'v': check(insn.operands[oi++], 'operand'); break;
          case 'k': if (insn.operands[oi] >= prog.names.length) { problems.push(where + ' pc ' + insn.pc + ': name out of range'); } oi++; break;
          case 't': if (!starts.has(insn.operands[oi]) && insn.operands[oi] !== code.length) { problems.push(where + ' pc ' + insn.pc + ': jump to ' + insn.operands[oi] + ' is not an instruction boundary'); } oi++; break;
          case 'T': if (insn.operands[oi] >= prog.nthunks) { problems.push(where + ' pc ' + insn.pc + ': thunk out of range'); } oi++; break;
          case 'F': if (insn.operands[oi] >= prog.funcs.length) { problems.push(where + ' pc ' + insn.pc + ': func out of range'); } oi++; break;
          case 'D': if (insn.operands[oi] >= prog.dispatches.length) { problems.push(where + ' pc ' + insn.pc + ': dispatch out of range'); } oi++; break;
          case 'C': cacheRuns.push([insn.operands[oi], OP.IC_WIDTH_METHCALL, where + ' pc ' + insn.pc]); oi++; break;
          case '*': { const n = insn.operands[oi++]; for (let j = 0; j < n; j++) { check(insn.operands[oi++], 'arg'); } break; }
          case '#': {
            const n = insn.operands[oi++];
            cacheRuns.push([insn.operands[oi], OP.IC_WIDTH_CASESBIND, where + ' pc ' + insn.pc]); oi++;
            for (let j = 0; j < n; j++) { if (insn.operands[oi] >= fn.s) { problems.push(where + ' pc ' + insn.pc + ': bind slot out of range'); } oi += 2; }
            i++;
            break;
          }
          case '%': { const n = insn.operands[oi++]; for (let j = 0; j < n; j++) { if (insn.operands[oi] >= fn.s) { problems.push(where + ' pc ' + insn.pc + ': bind slot out of range'); } oi += 3; } break; }
          default: oi++;
        }
      }
    }
    // Every path must end in RET/TAILCALL/JMP: the last instruction cannot fall off the end.
    const last = insns[insns.length - 1];
    if (last === undefined || (last.op !== OP.OP_RET && last.op !== OP.OP_JMP && last.op !== OP.OP_TAILCALL)) {
      problems.push(where + ': falls off the end of the code');
    }
    for (const c of prog.dispatches) { void c; }
  });
  cacheRuns.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < cacheRuns.length; i++) {
    if (cacheRuns[i - 1][0] + cacheRuns[i - 1][1] > cacheRuns[i][0]) {
      problems.push('inline-cache runs overlap: ' + cacheRuns[i - 1][2] + ' and ' + cacheRuns[i][2]);
    }
  }
  if (prog.ncaches > 0 && cacheRuns.length > 0) {
    const lastRun = cacheRuns[cacheRuns.length - 1];
    if (lastRun[0] + lastRun[1] > prog.ncaches) { problems.push('inline-cache run past ncaches'); }
  }
  return problems;
}
