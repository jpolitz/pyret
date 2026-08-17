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
export const SHAPES: Record<number, string> = {};
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

/** Local slots READ and WRITTEN by a decoded instruction (for liveness).
    CLOSURE/METHOD read the parent slots their function's upvalue
    descriptors name -- hidden operands, which is why `funcs` is needed. */
export function slotUses(insn: Insn, funcs: VMFunc[]): { reads: number[]; writes: number[] } {
  const reads: number[] = [];
  const writes: number[] = [];
  const shape = SHAPES[insn.op];
  if (insn.op === OP.OP_CLOSURE || insn.op === OP.OP_METHOD) {
    const fdef = funcs[insn.operands[1]];
    for (const dsc of fdef.u) { if ((dsc & 3) === 0) { reads.push(dsc >> 2); } }
  }
  const rdv = (vs: number): void => { if ((vs & 3) === OP.VS_LOCAL) { reads.push(vs >> 2); } };
  let oi = 0;
  for (let i = 0; i < shape.length; i++) {
    switch (shape[i]) {
      case 'd': writes.push(insn.operands[oi++]); break;
      case 'v': rdv(insn.operands[oi++]); break;
      case '*': { const n = insn.operands[oi++]; for (let j = 0; j < n; j++) { rdv(insn.operands[oi++]); } break; }
      case '#': { const n = insn.operands[oi++]; oi++; for (let j = 0; j < n; j++) { writes.push(insn.operands[oi]); oi += 2; } i++; break; }
      case '%': { const n = insn.operands[oi++]; for (let j = 0; j < n; j++) { writes.push(insn.operands[oi]); oi += 3; } break; }
      default: oi++;
    }
  }
  // DOTC's cache cell is read and (possibly) written: 'dvkliv' -- the last v
  // is the cell; treat as read (already) and write.
  if (insn.op === OP.OP_DOTC) {
    const cvs = insn.operands[5];
    if ((cvs & 3) === OP.VS_LOCAL) { writes.push(cvs >> 2); }
  }
  // SETVAR 'vvd': the box read, value read, dest written -- covered.
  return { reads, writes };
}

/** Successor pcs of an instruction. */
export function successors(insn: Insn, code: number[], dispatches: Array<Record<string, number>>): number[] {
  switch (insn.op) {
    case OP.OP_RET: return [];
    case OP.OP_TAILCALL: return [];
    case OP.OP_JMP: return [insn.operands[0]];
    case OP.OP_IF: return [insn.end, insn.operands[1]];
    case OP.OP_CASES: {
      const out = [insn.operands[3]];
      const table = dispatches[insn.operands[1]];
      for (const k of Object.keys(table)) { out.push(table[k]); }
      return out;
    }
    default: return insn.end < code.length ? [insn.end] : [];
  }
}

/**
 * Backward liveness over one function's bytecode: returns, for each
 * instruction start pc, the set of local slots live BEFORE it (live-in).
 * A suspend site records the pc of the instruction AFTER it, so liveIn(pc)
 * is exactly what a bailout must materialize (minus the site's own
 * destination, written by the resume value).
 */
export function liveInSets(code: number[], dispatches: Array<Record<string, number>>, funcs: VMFunc[]): Map<number, Set<number>> {
  const insns: Insn[] = [];
  const byPc = new Map<number, number>();
  let pc = 0;
  while (pc < code.length) {
    const insn = decode(code, pc);
    byPc.set(pc, insns.length);
    insns.push(insn);
    pc = insn.end;
  }
  const n = insns.length;
  const uses = insns.map((insn) => slotUses(insn, funcs));
  const succ = insns.map((insn) => successors(insn, code, dispatches).map((t) => byPc.get(t)!));
  const liveIn: Array<Set<number>> = insns.map(() => new Set<number>());
  const liveOut: Array<Set<number>> = insns.map(() => new Set<number>());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = n - 1; i >= 0; i--) {
      const out = new Set<number>();
      for (const s of succ[i]) { for (const x of liveIn[s]) { out.add(x); } }
      const inn = new Set<number>(out);
      for (const w of uses[i].writes) { inn.delete(w); }
      for (const r of uses[i].reads) { inn.add(r); }
      if (out.size !== liveOut[i].size || inn.size !== liveIn[i].size) {
        changed = true;
      } else {
        for (const x of inn) { if (!liveIn[i].has(x)) { changed = true; break; } }
      }
      liveOut[i] = out;
      liveIn[i] = inn;
    }
  }
  const result = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) { result.set(insns[i].pc, liveIn[i]); }
  return result;
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
