/*
  ANF -> hybrid bytecode (the machine's compiler half; the machine itself is
  the "hybrid bytecode machine" section of src/js/base/runtime-async.js).

  Only functions whose tier verdict is in options.vmTiers arrive here; the
  promise backend's JS code generator (anf-loop-compiler-async.ts) calls
  `compileRootFunction` from compileALam / aMethod for exactly those, emits
  `R.$vm.mkFun($BC, idx, [captures])` in their place, and prepends the
  module's one `var $BC = R.$vm.load(...)` to the toplevel. Everything the
  bytecode needs that is better emitted as JS -- object literals, data
  declarations, annotation objects, and JS-tier functions nested inside a
  bytecode function -- goes back to the JS emitter through `host` as a
  THUNK: a JS function whose parameters are the construct's free variables.

  Why ANF is the right level for this
  -----------------------------------
  ANF has already made every intermediate value a named binding and every
  operand atomic, which is precisely a register machine's shape: a lettable
  is one instruction, its binding is the destination register, and its
  operands are register/constant reads. No expression stack, and no
  evaluation-order decision is left to the machine: the order of effects is
  fixed by the same pass that fixes it for the JS backend.

  Slots, upvalues, globals
  ------------------------
  Each function gets a flat frame of local slots, one per ANF binding it
  introduces plus scratch. Free variables are captured BY VALUE into the
  closure's upvalue array -- by CLOSURE/METHOD when the enclosing function
  is bytecode, and by the JS emitter's captures array when it is JS. Sound
  because ANF bindings are single-assignment: Pyret's mutable bindings are
  `{"$var": v}` boxes bound once (the JS emitter keeps every var that a
  bytecode function can see boxed -- see collectUnboxableVarKeys), and
  letrec cells are boxes too. Module-level cross-module names (imports,
  builtins, type globals) are `globals`: JS variables the emitter hands to
  the loader once, read with no capture at all.

  Per-site facts (callee flatness, direct fields/methods/cases, annotation
  check class, needsStep) come from EXACTLY the shared classifiers the JS
  emitter and the tier analysis use, so what the machine assumes about a
  callee (CALLFLAT: "never a thenable, never bytecode") is what the JS
  emitter proved when it compiled that callee.
*/

import * as A from '../ast';
import * as N from '../ast-anf';
import * as J from '../js-ast';
import * as SL from '../srcloc';
import * as FL from '../flatness';
import * as TIER from '../tier';
import * as DAG from '../js-dag-utils';
import { INLINE_MARKER_BASE } from '../optimize-anf';
import { InternalCompilerError } from '../shared';
import * as OP from './opcodes';
import { VMProgram, VMFunc } from './opcodes';
import { liveInSets, disassembleFunc } from './disasm';

type Loc = SL.Loc;

// What the bytecode compiler needs from the JS code generator. Implemented
// by the promise backend's CompilerVisitor (anf-loop-compiler-async.ts).
export interface VMHost {
  // The module's shared srcloc table (`L`): bytecode carries indices into it.
  getLocId(l: Loc): number;
  // Shared classifier inputs.
  flatnessEnv: FL.FEnv;
  typeFlatnessEnv: FL.FEnv;
  flatMethodApps: Set<N.AMethodApp>;
  flatMethods: Set<N.AMethod>;
  redundantAnnChecks: Set<string>;
  moduleBindings: Map<string, any>;
  env: any;
  tierMap: TIER.TierMap | undefined;
  options: any;
  // Direct-cases resolution (the JS emitter's own helper).
  resolveCasesDataType(typ: A.Ann): any;
  // JS thunks. `params` are the ANF names the machine will pass (in order);
  // the returned function expression takes their jsIdOf names as parameters.
  thunkForLam(node: N.ALam, letBind: N.ABind | undefined, params: A.Name[]): J.JExprT;
  thunkForMethod(node: N.AMethod, params: A.Name[]): J.JExprT;
  thunkForLettable(node: N.ALettable, params: A.Name[]): J.JExprT;
  thunkForAnnCheck(b: N.ABind, params: A.Name[]): J.JExprT;   // (val, params...) => _checkAnn(...)
  thunkForAnn(ann: A.Ann, optName: string | undefined, params: A.Name[]): J.JExprT;
  thunkForUpdate(node: N.AUpdate, params: A.Name[]): J.JExprT;
}

// A jump target. `pc` is -1 until the label is placed; every emitted
// reference is recorded so it can be back-patched.
interface Label {
  pc: number;
  refs: number[];
}

// Where the value of the expression currently being compiled should go
// once control leaves it. RETURN means "this function returns it".
const RETURN: Label = { pc: -2, refs: [] };

class FuncCtx {
  code: number[] = [];
  slots: Map<string, number> = new Map();
  /** Bindings that are just another name for a value source already
      available here (`a-let x = a-val v`). Sound because ANF binds each
      name once, so an alias can never go stale. */
  aliases: Map<string, number> = new Map();
  nslots = 0;
  upvals: number[] = [];
  upvalMap: Map<string, number> = new Map();
  /** For a ROOT (created from JS): the names of the upvalues, in order. */
  upvalNames: A.Name[] = [];
  /** The ANF name whose JS variable holds each slot's value (primary
      binder of the slot, or the alias name for a temp an alias points at).
      What a bailout from the fast JS form materializes a live slot from. */
  slotNames: Map<number, A.Name> = new Map();
  /** Suspend sites, keyed by ANF node (a-app / a-method-app / a-prim-app /
      a-update lettable, or the ABind of a suspend-class annotation check):
      the pc AFTER the instruction (where the machine resumes) and the slot
      the resumed value belongs in (-1 to discard). `live` is filled after
      the function is complete: the slots the fast form must hand over. */
  sites: Map<any, SiteInfo> = new Map();
  private freeTemps: number[] = [];

  constructor(public parent: FuncCtx | undefined, public name: string, public loc: number,
    public args: N.ABind[], public allowTco: boolean) {}

  allocSlot(): number { return this.nslots++; }

  slotFor(id: A.Name): number {
    const k = id.key();
    let s = this.slots.get(k);
    if (s === undefined) {
      s = this.allocSlot();
      this.slots.set(k, s);
      this.slotNames.set(s, id);
    }
    return s;
  }

  /** Record a suspend site: the instruction just emitted ends at code.length. */
  site(key: any, dest: number): void {
    this.sites.set(key, { pc: this.code.length, dest, live: [] });
  }

  newTemp(): number {
    const t = this.freeTemps.pop();
    if (t !== undefined) { return t; }
    return this.allocSlot();
  }

  freeTemp(t: number): void { this.freeTemps.push(t); }
}

export interface SiteInfo {
  pc: number;
  dest: number;
  live: number[];
}

export interface RootResult {
  idx: number;
  captures: A.Name[];
  /** Suspend-site table and slot->name map, for the fast JS form's bailouts. */
  sites: Map<any, SiteInfo>;
  slotNames: Map<number, A.Name>;
  arity: number;
}

export class VMModuleCompiler {
  prog: VMProgram;
  /** Names of the globals, in index order (the JS emitter turns each into
      its JS variable). */
  globalNames: A.Name[] = [];
  /** Extra globals that are JS expressions evaluated once at load (hoisted
      module-field reads); index into the same globals array, after names. */
  globalExprs: Array<{ id: A.Name; name: string; isVar: boolean }> = [];
  thunks: J.JExprT[] = [];
  /** Every compiled function by its ANF node: a function nested in a
      bytecode parent is compiled once (via CLOSURE) and found here again
      when the parent's FAST form reaches the same node (see vmRootExpr). */
  compiledByNode: Map<N.ALam | N.AMethod, RootResult> = new Map();
  /** JS-tier lambdas/methods nested in bytecode, by node: the thunk that
      builds them and its parameter names. The fast form of the enclosing
      bytecode function reuses the thunk instead of emitting the lambda a
      second time. */
  jsThunkByNode: Map<N.ALam | N.AMethod, { idx: number; params: A.Name[] }> = new Map();
  private nameIdx: Map<string, number> = new Map();
  private constIdx: Map<string, number> = new Map();
  private globalIdx: Map<string, number> = new Map();
  private globalExprIdx: Map<string, number> = new Map();
  private vmTiers: Set<string>;

  constructor(public host: VMHost, externals: A.Name[], vmTiers: string[]) {
    this.prog = {
      v: OP.FORMAT_VERSION,
      names: [],
      consts: [],
      nglobals: 0,
      funcs: [],
      dispatches: [],
      ncaches: 0,
      nthunks: 0,
      sites: [],
    };
    for (const n of externals) {
      const k = n.key();
      if (!this.globalIdx.has(k)) {
        this.globalIdx.set(k, this.globalNames.length);
        this.globalNames.push(n);
      }
    }
    this.vmTiers = new Set(vmTiers);
  }

  /** Total globals = named + hoisted expressions; the JS emitter emits them
      in this order. */
  finish(): void {
    this.prog.nglobals = this.globalNames.length + this.globalExprs.length;
    this.prog.nthunks = this.thunks.length;
  }

  isVmTier(tier: TIER.Tier): boolean { return this.vmTiers.has(tier); }

  private newCache(width: number): number {
    const base = this.prog.ncaches;
    this.prog.ncaches += width;
    return base;
  }

  // ---------- interning ----------

  nameK(s: string): number {
    const cached = this.nameIdx.get(s);
    if (cached !== undefined) { return cached; }
    const i = this.prog.names.length;
    this.prog.names.push(s);
    this.nameIdx.set(s, i);
    return i;
  }

  locK(l: Loc): number { return this.host.getLocId(l); }

  private constK(desc: any[]): number {
    const key = JSON.stringify(desc);
    const cached = this.constIdx.get(key);
    if (cached !== undefined) { return cached; }
    const i = this.prog.consts.length;
    this.prog.consts.push(desc);
    this.constIdx.set(key, i);
    return i;
  }

  private thunkK(fn: J.JExprT): number {
    const i = this.thunks.length;
    this.thunks.push(fn);
    return i;
  }

  // ---------- name resolution ----------

  /**
   * Value source, valid in `ctx`, for a name bound outside it -- capturing
   * it as an upvalue if that is what it takes. Constants and globals need
   * no capture: they mean the same thing at every depth.
   */
  private resolveOuter(ctx: FuncCtx, key: string, id: A.Name): number | undefined {
    const have = ctx.upvalMap.get(key);
    if (have !== undefined) { return OP.vsUpval(have); }
    const p = ctx.parent;
    let inParent: number | undefined;
    if (p === undefined) {
      // A root: everything free that is not a global comes from the
      // enclosing JS function, by value, in the captures array.
      const g = this.globalIdx.get(key);
      if (g !== undefined) { return OP.vsGlobal(g); }
      const idx = ctx.upvals.length;
      ctx.upvals.push(-1);
      ctx.upvalNames.push(id);
      ctx.upvalMap.set(key, idx);
      return OP.vsUpval(idx);
    }
    inParent = p.aliases.get(key);
    if (inParent === undefined) {
      const slot = p.slots.get(key);
      inParent = slot === undefined ? this.resolveOuter(p, key, id) : OP.vsLocal(slot);
    }
    if (inParent === undefined) { return undefined; }
    let desc: number;
    switch (inParent & 3) {
      case OP.VS_LOCAL: desc = OP.uvLocal(inParent >> 2); break;
      case OP.VS_UPVAL: desc = OP.uvUpval(inParent >> 2); break;
      case OP.VS_CONST:
        // A name the parent aliased to a constant or a global: captured
        // anyway, as a constant/global upvalue, so this function's fast
        // form (a factory over exactly the upvalues) sees it under the
        // alias name as a parameter. (The alias itself is a JS variable of
        // the PARENT's fast form only.)
        desc = OP.uvConst(inParent >> 2); break;
      default:
        if (this.isGlobalName(key)) {
          // The global itself (not a local alias to one): a module-scope
          // JS variable visible to every fast form -- no capture.
          ctx.aliases.set(key, inParent);
          return inParent;
        }
        desc = OP.uvGlobal(inParent >> 2); break;
    }
    const idx = ctx.upvals.length;
    ctx.upvals.push(desc);
    ctx.upvalNames.push(id);
    ctx.upvalMap.set(key, idx);
    return OP.vsUpval(idx);
  }

  /** Value source for an already-bound identifier. */
  idSource(ctx: FuncCtx, id: A.Name): number {
    const key = id.key();
    const alias = ctx.aliases.get(key);
    if (alias !== undefined) { return alias; }
    const local = ctx.slots.get(key);
    if (local !== undefined) { return OP.vsLocal(local); }
    const outer = this.resolveOuter(ctx, key, id);
    if (outer !== undefined) { return outer; }
    throw new InternalCompilerError('vm-compile: unbound identifier ' + key);
  }

  /** Is this name a module-level cross-module global (never an upvalue)? */
  private isGlobalName(key: string): boolean { return this.globalIdx.has(key); }

  /**
   * A field read out of an imported module (`a-id-modref` on a global) is
   * loop-invariant, so it is resolved once at load and becomes a global.
   */
  private hoistedModuleField(ctx: FuncCtx, id: A.Name, name: string, isVar: boolean): number | undefined {
    if (!this.isGlobalName(id.key())) { return undefined; }
    const key = (isVar ? '$varfield$' : '$field$') + id.key() + '$' + name;
    let idx = this.globalExprIdx.get(key);
    if (idx === undefined) {
      idx = this.globalExprs.length;
      this.globalExprs.push({ id, name, isVar });
      this.globalExprIdx.set(key, idx);
    }
    return OP.vsGlobal(this.globalNames.length + idx);
  }

  // NOTE: hoisted-expression globals are numbered AFTER the named ones, so
  // globalNames must be complete before the first hoisted read; the
  // externals list handed to the constructor is the complete set.

  // ---------- atomic values ----------

  valSource(ctx: FuncCtx, v: N.AVal): number {
    switch (v.$name) {
      case 'a-srcloc':
        return OP.vsConst(this.constK([OP.CONST_LOC, this.locK(v.loc)]));
      case 'a-num':
        return OP.vsConst(typeof v.n === 'number'
          ? this.constK([OP.CONST_FIXNUM, v.n])
          : this.constK([OP.CONST_NUM_STR, String(v.n)]));
      case 'a-str':
        return OP.vsConst(this.constK([OP.CONST_STR, v.s]));
      case 'a-bool':
        return OP.vsConst(this.constK([OP.CONST_BOOL, v.b]));
      case 'a-undefined':
        return OP.vsConst(this.constK([OP.CONST_UNDEFINED]));
      case 'a-prim-val':
        return OP.vsConst(this.constK([OP.CONST_RT, v.name]));
      case 'a-id':
        return this.idSource(ctx, v.id);
      case 'a-id-safe-letrec': {
        const t = ctx.newTemp();
        emit(ctx, OP.OP_UNBOX, t, this.idSource(ctx, v.id));
        return OP.vsLocal(t);
      }
      case 'a-id-modref': {
        const hoisted = this.hoistedModuleField(ctx, v.id, v.name, false);
        if (hoisted !== undefined) { return hoisted; }
        const t = ctx.newTemp();
        emit(ctx, OP.OP_MODREF, t, this.idSource(ctx, v.id), this.nameK(v.name));
        return OP.vsLocal(t);
      }
      default:
        throw new InternalCompilerError('vm-compile: unknown AVal ' + (v as any).$name);
    }
  }

  private valSources(ctx: FuncCtx, vs: N.AVal[]): number[] {
    return vs.map((v) => this.valSource(ctx, v));
  }

  // ---------- thunks ----------

  /** The free variables of a node that must be passed to its JS thunk: all
      of them except globals (module-scope JS variables the thunk sees
      lexically). */
  private thunkParams(fv: Map<string, A.Name>): A.Name[] {
    const out: A.Name[] = [];
    for (const [k, n] of fv) {
      if (!this.isGlobalName(k)) { out.push(n); }
    }
    return out;
  }

  private emitThunkCall(ctx: FuncCtx, dest: number, thunkIdx: number, l: Loc, step: boolean, params: A.Name[]): void {
    const srcs = params.map((n) => this.idSource(ctx, n));
    emit(ctx, OP.OP_THUNK, dest, thunkIdx, this.locK(l), step ? 1 : 0, srcs.length, ...srcs);
  }

  // ---------- annotations ----------

  /** Annotations that ARE a value already to hand: a named type, or one of
      the runtime's fixed annotations. */
  annValueSource(ctx: FuncCtx, ann: A.Ann): number | undefined {
    switch (ann.$name) {
      case 'a-name': return this.idSource(ctx, ann.id);
      case 'a-type-var':
      case 'a-blank':
      case 'a-any': return OP.vsConst(this.constK([OP.CONST_RT, 'Any']));
      case 'a-arrow':
      case 'a-arrow-argnames': return OP.vsConst(this.constK([OP.CONST_RT, 'Function']));
      case 'a-method': return OP.vsConst(this.constK([OP.CONST_RT, 'Method']));
      case 'a-app': return this.annValueSource(ctx, ann.ann);
      default: return undefined;
    }
  }

  private annClass(b: N.ABind): FL.AnnCheckClass {
    const h = this.host;
    return FL.annCheckClass(b, h.flatnessEnv, h.typeFlatnessEnv, h.redundantAnnChecks, h.moduleBindings, h.env);
  }

  private compileAnnChecks(ctx: FuncCtx, binds: N.ABind[]): void {
    for (const b of binds) { this.compileAnnCheck(ctx, b); }
  }

  private compileAnnCheck(ctx: FuncCtx, b: N.ABind): void {
    this.compileAnnCheckAt(ctx, b, this.idSource(ctx, b.id));
  }

  /** Mirrors annCheckStmts: none / tuple-shape / flat / suspend. */
  private compileAnnCheckAt(ctx: FuncCtx, b: N.ABind, vs: number): void {
    const cls = this.annClass(b);
    if (cls === 'none') { return; }
    if (cls === 'tuple-shape') {
      emit(ctx, OP.OP_TUPLECHK, vs, (b.ann as A.ATuple).fields.length, this.locK((b.ann as any).l));
      return;
    }
    const step = cls === 'suspend';
    const direct = this.annValueSource(ctx, b.ann);
    if (direct !== undefined) {
      emit(ctx, OP.OP_ANNCHECKV, direct, vs, this.locK(annLoc(b.ann)), step ? 1 : 0);
      if (step) { ctx.site(b, -1); }
      return;
    }
    // A structural annotation (record/tuple/refinement/dot): the JS emitter
    // builds it and runs _checkAnn; the thunk takes the value first.
    const fv = new Map<string, A.Name>(N.freevarsAnnAcc(b.ann, new Map()) as any);
    const params = this.thunkParams(fv);
    const th = this.thunkK(this.host.thunkForAnnCheck(b, params));
    const srcs = [vs, ...params.map((n) => this.idSource(ctx, n))];
    const t = ctx.newTemp();
    emit(ctx, OP.OP_THUNK, t, th, this.locK(annLoc(b.ann)), step ? 1 : 0, srcs.length, ...srcs);
    if (step) { ctx.site(b, -1); }
    ctx.freeTemp(t);
  }

  // ---------- functions ----------

  /** Entry from the JS emitter: compile a VM-tier function whose enclosing
      function is JS. Returns the function index and the captures the JS
      side must pass (in order). */
  compileRootFunction(node: N.ALam | N.AMethod): RootResult {
    const have = this.compiledByNode.get(node);
    if (have !== undefined) { return have; }
    const isMethod = N.isAMethod(node);
    const r = this.compileFunc(undefined, node.name, node.l, node.args, isMethod, node.body);
    const res: RootResult = { idx: r.idx, captures: r.ctx.upvalNames, sites: r.ctx.sites,
      slotNames: r.ctx.slotNames, arity: node.args.length };
    this.compiledByNode.set(node, res);
    return res;
  }

  hasFastForm(idx: number): boolean { return this.prog.funcs[idx].ff >= 0; }

  private siteIdx: Map<string, number> = new Map();
  /** Intern a bailout site (function, resume pc, dest, live slots) -> index. */
  siteK(funcIdx: number, pc: number, dest: number, live: number[]): number {
    const key = funcIdx + ':' + pc + ':' + dest + ':' + live.join(',');
    const have = this.siteIdx.get(key);
    if (have !== undefined) { return have; }
    const k = this.prog.sites.length;
    this.prog.sites.push([funcIdx, pc, dest, live]);
    this.siteIdx.set(key, k);
    return k;
  }

  /** Attach a fast JS form (a factory thunk index) to a compiled function. */
  setFastForm(funcIdx: number, thunk: J.JExprT): void {
    this.prog.funcs[funcIdx].ff = this.thunkK(thunk);
  }

  private compileFunc(
    parent: FuncCtx | undefined,
    name: string,
    l: Loc,
    args: N.ABind[],
    isMethod: boolean,
    body: N.AExpr
  ): { idx: number; ctx: FuncCtx } {
    // The JS emitter's TCO gate (a formal captured by a nested lambda
    // forbids the explicit loop) -- mirrored so both forms agree on which
    // self calls are tail-call-eliminated.
    const ctx = new FuncCtx(parent, name, this.locK(l), args, !TIER.argUsedInNestedLambda(args, body));
    for (const a of args) { ctx.slotFor(a.id); }
    // Argument annotation contracts, checked left to right at entry.
    this.compileAnnChecks(ctx, args);
    const ans = ctx.allocSlot();
    this.compileAExpr(ctx, body, ans, RETURN);
    const fn: VMFunc = {
      n: name,
      a: args.length,
      m: isMethod,
      s: ctx.nslots,
      u: ctx.upvals,
      c: ctx.code,
      l: ctx.loc,
      ff: -1,
    };
    // Liveness for the fast form's bailouts: at each site, the slots live
    // at the resume pc (minus the site's destination, which the resumed
    // value fills). Every live slot must have a name (a JS variable holds
    // it); a nameless live slot is a compiler bug, reported loudly.
    if (ctx.sites.size > 0) {
      const live = liveInSets(ctx.code, this.prog.dispatches, this.prog.funcs);
      for (const [key, info] of ctx.sites) {
        const set = live.get(info.pc);
        // pc === code.length only if a site is the very last thing (cannot
        // be: RET follows); treat a missing entry as empty.
        const slots: number[] = [];
        if (set !== undefined) {
          for (const sl of set) {
            if (sl === info.dest) { continue; }
            if (!ctx.slotNames.has(sl)) {
              const dbg = process.env.PYRET_VM_DEBUG ? '\n' + disassembleFunc(
                { ...this.prog, funcs: [...this.prog.funcs, fn] }, this.prog.funcs.length) : '';
              throw new InternalCompilerError('vm-compile: live slot r' + sl + ' at a suspend site in "'
                + name + '" has no binder name (pc ' + info.pc + ')' + dbg);
            }
            slots.push(sl);
          }
        }
        slots.sort((a, b) => a - b);
        info.live = slots;
        void key;
      }
    }
    const idx = this.prog.funcs.length;
    this.prog.funcs.push(fn);
    return { idx, ctx };
  }

  private tierOf(node: N.ALam | N.AMethod): TIER.Tier {
    const map = this.host.tierMap;
    if (map === undefined) {
      throw new InternalCompilerError('vm-compile: no tier map');
    }
    return TIER.tierVerdictFor(map, node, node.l.key()).tier;
  }

  // ---------- expressions ----------

  /**
   * Compile `expr`, leaving its value in slot `dest`, then transfer control
   * to `cont` (RETURN meaning "return it"). The right-nested spine is walked
   * with a loop; only nested constructs recur.
   */
  compileAExpr(ctx: FuncCtx, expr0: N.AExpr, dest: number, cont: Label): void {
    let expr = expr0;
    for (;;) {
      switch (expr.$name) {
        case 'a-type-let': {
          const bind = expr.bind;
          switch (bind.$name) {
            case 'a-type-bind': {
              const direct = this.annValueSource(ctx, bind.ann);
              if (direct !== undefined) {
                ctx.aliases.set(bind.name.key(), direct);
                break;
              }
              const slot = ctx.slotFor(bind.name);
              const fv = new Map<string, A.Name>(N.freevarsAnnAcc(bind.ann, new Map()) as any);
              const params = this.thunkParams(fv);
              const th = this.thunkK(this.host.thunkForAnn(bind.ann, bind.name.toname(), params));
              this.emitThunkCall(ctx, slot, th, expr.l, false, params);
              break;
            }
            case 'a-newtype-bind': {
              const brander = ctx.slotFor(bind.namet);
              const annSlot = ctx.slotFor(bind.name);
              emit(ctx, OP.OP_NEWTYPE, brander, annSlot,
                this.nameK(bind.name.toname()), this.locK(bind.l));
              break;
            }
            default:
              throw new InternalCompilerError('vm-compile: unknown ATypeBind');
          }
          expr = expr.body;
          continue;
        }
        case 'a-let': {
          const b = expr.bind;
          // Inline marker (ANF inliner): a comment in JS; nothing here.
          if (b.id instanceof A.SAtom && b.id.base === INLINE_MARKER_BASE) {
            expr = expr.body;
            continue;
          }
          if (expr.e.$name === 'a-val') {
            const v = expr.e.v;
            if (v.$name === 'a-undefined') {
              // A real slot, never an alias to the constant: this is the
              // LICM cache cell shape (`let cell = undefined`), which a
              // nested loop body captures and WRITES (a-dot cacheVar).
              const slot = ctx.slotFor(b.id);
              emit(ctx, OP.OP_MOVE, slot, this.valSource(ctx, v));
              this.compileAnnCheck(ctx, b);
              expr = expr.body;
              continue;
            }
            const src = this.valSource(ctx, v);
            ctx.aliases.set(b.id.key(), src);
            // An alias to a fresh temp (UNBOX/MODREF of a safe-letrec or
            // module ref): the temp is now known by this name too.
            if ((src & 3) === OP.VS_LOCAL && !ctx.slotNames.has(src >> 2)) {
              ctx.slotNames.set(src >> 2, b.id);
            }
            this.compileAnnCheckAt(ctx, b, src);
            expr = expr.body;
            continue;
          }
          const slot = ctx.slotFor(b.id);
          const next = newLabel();
          const rhsTco = this.compileLettable(ctx, expr.e, slot, next, b);
          place(ctx, next);
          // A trailing annotation check after a self tail call is dead code
          // in the JS backend (the loop `continue`s past it); the machine's
          // reused frame runs the outermost check at final exit, so it is
          // emitted -- exactly once per frame -- here.
          void rhsTco;
          this.compileAnnCheck(ctx, b);
          expr = expr.body;
          continue;
        }
        case 'a-arr-let': {
          const arr = this.idSource(ctx, expr.bind.id);
          if (expr.e.$name === 'a-val') {
            emit(ctx, OP.OP_ARRSET, arr, expr.idx, this.valSource(ctx, expr.e.v));
            expr = expr.body;
            continue;
          }
          const tmp = ctx.newTemp();
          const next = newLabel();
          this.compileLettable(ctx, expr.e, tmp, next, undefined);
          place(ctx, next);
          emit(ctx, OP.OP_ARRSET, arr, expr.idx, OP.vsLocal(tmp));
          ctx.freeTemp(tmp);
          expr = expr.body;
          continue;
        }
        case 'a-var': {
          // Every var visible to bytecode is a box (the JS emitter's
          // unboxing excludes anything a bytecode function can see).
          const slot = ctx.slotFor(expr.bind.id);
          if (expr.e.$name === 'a-val') {
            emit(ctx, OP.OP_BOX, slot, this.valSource(ctx, expr.e.v));
            expr = expr.body;
            continue;
          }
          const tmp = ctx.newTemp();
          const next = newLabel();
          this.compileLettable(ctx, expr.e, tmp, next, undefined);
          place(ctx, next);
          emit(ctx, OP.OP_BOX, slot, OP.vsLocal(tmp));
          ctx.freeTemp(tmp);
          expr = expr.body;
          continue;
        }
        case 'a-seq': {
          const tmp = ctx.newTemp();
          const next = newLabel();
          this.compileLettable(ctx, expr.e1, tmp, next, undefined);
          place(ctx, next);
          ctx.freeTemp(tmp);
          expr = expr.e2;
          continue;
        }
        case 'a-lettable': {
          const e = expr.e;
          if (e.$name === 'a-if') {
            const elseL = newLabel();
            emit(ctx, OP.OP_IF, this.valSource(ctx, e.c));
            emitRef(ctx, elseL);
            this.compileAExpr(ctx, e.t, dest, cont);
            place(ctx, elseL);
            expr = e.e;
            continue;
          }
          if (e.$name === 'a-cases') {
            expr = this.compileCases(ctx, e, dest, cont);
            continue;
          }
          this.compileLettable(ctx, e, dest, cont, undefined);
          return;
        }
        default:
          throw new InternalCompilerError('vm-compile: unknown AExpr ' + (expr as any).$name);
      }
    }
  }

  /**
   * Emits the dispatch and every branch of an `a-cases`, and returns the
   * else-branch for the caller to continue with.
   */
  private compileCases(ctx: FuncCtx, e: N.ACases, dest: number, cont: Label): N.AExpr {
    const valSrc = this.valSource(ctx, e.val);
    const dispatchIdx = this.prog.dispatches.length;
    const table: Record<string, number> = {};
    this.prog.dispatches.push(table);
    const casesLocK = this.locK(e.l);
    const elseL = newLabel();
    // Direct cases: statically-known variant layout (same gate as the JS
    // emitter's compileCasesAsync).
    const opts = this.host.options;
    const valueIsTyped = opts.typeCheck || (opts.runtimeAnnotations && opts.userAnnotations);
    const dataType = (opts.directCases && valueIsTyped) ? this.host.resolveCasesDataType(e.typ) : undefined;
    emit(ctx, OP.OP_CASES, valSrc, dispatchIdx, casesLocK);
    emitRef(ctx, elseL);
    for (const branch of e.branches) {
      table[branch.name] = ctx.code.length;
      let directVariant: any = undefined;
      let elideArity = false;
      if (dataType !== undefined) {
        const v = dataType.getVariant(branch.name);
        if (branch.$name === 'a-cases-branch') {
          if (v !== undefined && v.$name === 't-variant' && v.fields.length === branch.args.length) {
            directVariant = v;
            elideArity = true;
          }
        } else if (v !== undefined && v.$name === 't-singleton-variant') {
          elideArity = true;
        }
      }
      if (branch.$name === 'a-cases-branch') {
        if (!elideArity) {
          emit(ctx, OP.OP_CASESPRE, valSrc, branch.args.length, this.locK(branch.l), casesLocK);
        }
        if (branch.args.length > 0) {
          if (directVariant !== undefined) {
            const operands: number[] = [];
            branch.args.forEach((a, i) => {
              const [fname, ftype] = directVariant.fields[i];
              const isRefField = ftype.$name === 't-ref';
              const lookupIsRef = A.isSCasesBindRef(a.fieldType);
              const mode = (!isRefField && !lookupIsRef) ? 0
                : (1 | (isRefField ? 2 : 0) | (lookupIsRef ? 4 : 0));
              operands.push(ctx.slotFor(a.bind.id));
              operands.push(this.nameK(fname));
              operands.push(mode);
            });
            emit(ctx, OP.OP_CASESBINDD, valSrc, branch.args.length, ...operands);
          } else {
            const operands: number[] = [];
            for (const a of branch.args) {
              operands.push(ctx.slotFor(a.bind.id));
              operands.push(A.isSCasesBindRef(a.fieldType) ? 1 : 0);
            }
            emit(ctx, OP.OP_CASESBIND, valSrc, branch.args.length,
              this.newCache(OP.IC_WIDTH_CASESBIND), ...operands);
          }
          this.compileAnnChecks(ctx, branch.args.map((a) => a.bind));
        }
      } else if (!elideArity) {
        emit(ctx, OP.OP_CASESPRE, valSrc, -1, this.locK(branch.l), casesLocK);
      }
      this.compileAExpr(ctx, branch.body, dest, cont);
    }
    place(ctx, elseL);
    return e._else;
  }

  // ---------- lettables ----------

  /** Returns true when the lettable compiled to a self tail call. */
  compileLettable(ctx: FuncCtx, e: N.ALettable, dest: number, cont: Label, letBind: N.ABind | undefined): boolean {
    const h = this.host;
    switch (e.$name) {
      case 'a-val': {
        const src = this.valSource(ctx, e.v);
        if (cont === RETURN) { emit(ctx, OP.OP_RET, src); return false; }
        emit(ctx, OP.OP_MOVE, dest, src);
        break;
      }
      case 'a-id-var':
        emit(ctx, OP.OP_UNBOX, dest, this.idSource(ctx, e.id));
        break;
      case 'a-id-var-modref': {
        const hoisted = this.hoistedModuleField(ctx, e.id, e.name, true);
        if (hoisted !== undefined) { emit(ctx, OP.OP_UNBOX, dest, hoisted); break; }
        emit(ctx, OP.OP_MODVARREF, dest, this.idSource(ctx, e.id), this.nameK(e.name));
        break;
      }
      case 'a-id-letrec':
        if (e.safe) {
          emit(ctx, OP.OP_UNBOX, dest, this.idSource(ctx, e.id));
        } else {
          emit(ctx, OP.OP_LETREC, dest, this.idSource(ctx, e.id),
            this.locK(e.l), this.nameK(e.id.toname()));
        }
        break;
      case 'a-assign':
        emit(ctx, OP.OP_SETVAR, this.idSource(ctx, e.id), this.valSource(ctx, e.value), dest);
        break;
      case 'a-app': {
        const f = e._fun;
        const isSafeId = N.isAId(f) || N.isAIdSafeLetrec(f);
        const isFlat = (isSafeId || N.isAIdModref(f))
          ? FL.isFlatEnough(FL.getAppFunFlatness(f, h.flatnessEnv, h.moduleBindings, h.env))
          : false;
        const isFn = isSafeId && (h.flatnessEnv.has((f as any).id.key())
          || (!h.flatnessEnv.has((f as any).id.key()) && A.isSGlobal((f as any).id) && isFlat));
        const fsrc = this.valSource(ctx, f);
        const args = this.valSources(ctx, e.args);
        const lk = this.locK(e.l);
        const ptc = h.options.properTailCalls;
        if (isFlat) {
          // Compiled JS, bounded, never a thenable.
          emit(ctx, OP.OP_CALLFLAT, dest, fsrc, lk, isFn ? 0 : 1, args.length, ...args);
          break;
        }
        if (ptc && cont === RETURN) {
          emit(ctx, OP.OP_TAILCALL, fsrc, lk, args.length, ...args);
          return false;
        }
        // (arityForTco: a zero-arg lambda's compiled arity is 1 -- the
        // synthetic resumer -- so a zero-arg self call never TCOs; tier.ts.)
        if (TIER.isTcoSelfApp(e.appInfo, e.args.length, ctx.args.length > 0 ? ctx.args.length : 1, ctx.allowTco, ptc)) {
          // A source-tail SELF call whose continuation is not RETURN: the
          // only thing ANF puts after it is the return-annotation check,
          // which the base case's exit through the (reused) frame performs
          // -- matching the JS backend's TCO `continue`, which skips the
          // per-iteration check. EXACTLY the JS emitter's TCO predicate
          // (TIER.isTcoSelfApp, incl. allowTco): when JS emits a real call
          // here, so does the machine, and the site below exists for the
          // fast form's bailout.
          emit(ctx, OP.OP_TAILCALL, fsrc, lk, args.length, ...args);
          return true;
        }
        emit(ctx, OP.OP_CALL, dest, fsrc, lk, args.length, ...args);
        ctx.site(e, dest);
        break;
      }
      case 'a-method-app': {
        const o = this.valSource(ctx, e.obj);
        const args = this.valSources(ctx, e.args);
        const isFlatMeth = h.flatMethodApps.has(e);
        if (e.directMethod) {
          emit(ctx, OP.OP_METHCALLD, dest, o, this.nameK(e.meth), this.locK(e.l),
            isFlatMeth ? 1 : 0, args.length, ...args);
        } else {
          emit(ctx, OP.OP_METHCALL, dest, o, this.nameK(e.meth), this.locK(e.l),
            isFlatMeth ? 1 : 0, this.newCache(OP.IC_WIDTH_METHCALL), args.length, ...args);
        }
        if (!isFlatMeth) { ctx.site(e, dest); }
        break;
      }
      case 'a-prim-app': {
        const args = this.valSources(ctx, e.args);
        emit(ctx, OP.OP_PRIMAPP, dest, this.nameK(e.f), this.locK(e.l),
          e.appInfo.needsStep ? 1 : 0, args.length, ...args);
        if (e.appInfo.needsStep) { ctx.site(e, dest); }
        break;
      }
      case 'a-lam': {
        if (this.isVmTier(this.tierOf(e))) {
          const r = this.compileFunc(ctx, e.name, e.l, e.args, false, e.body);
          this.compiledByNode.set(e, { idx: r.idx, captures: r.ctx.upvalNames, sites: r.ctx.sites,
            slotNames: r.ctx.slotNames, arity: e.args.length });
          emit(ctx, OP.OP_CLOSURE, dest, r.idx);
        } else {
          const params = this.thunkParams(new Map(N.freevarsL(e) as any));
          const th = this.thunkK(h.thunkForLam(e, letBind, params));
          this.jsThunkByNode.set(e, { idx: th, params });
          this.emitThunkCall(ctx, dest, th, e.l, false, params);
        }
        break;
      }
      case 'a-method': {
        if (this.isVmTier(this.tierOf(e))) {
          const r = this.compileFunc(ctx, e.name, e.l, e.args, true, e.body);
          this.compiledByNode.set(e, { idx: r.idx, captures: r.ctx.upvalNames, sites: r.ctx.sites,
            slotNames: r.ctx.slotNames, arity: e.args.length });
          emit(ctx, OP.OP_METHOD, dest, r.idx);
        } else {
          const params = this.thunkParams(new Map(N.freevarsL(e) as any));
          const th = this.thunkK(h.thunkForMethod(e, params));
          this.jsThunkByNode.set(e, { idx: th, params });
          this.emitThunkCall(ctx, dest, th, e.l, false, params);
        }
        break;
      }
      case 'a-update': {
        const params = this.thunkParams(new Map(N.freevarsL(e) as any));
        const th = this.thunkK(h.thunkForUpdate(e, params));
        // checkRefAnns may run a user refinement: maybe-thenable.
        this.emitThunkCall(ctx, dest, th, e.l, true, params);
        ctx.site(e, dest);
        break;
      }
      case 'a-dot': {
        const o = this.valSource(ctx, e.obj);
        if (e.cacheVar !== undefined) {
          const cell = this.idSource(ctx, e.cacheVar);
          emit(ctx, OP.OP_DOTC, dest, o, this.nameK(e.field), this.locK(e.l),
            e.directField ? 1 : 0, cell);
        } else if (e.directField) {
          emit(ctx, OP.OP_DOTD, dest, o, this.nameK(e.field));
        } else {
          emit(ctx, OP.OP_DOT, dest, o, this.nameK(e.field), this.locK(e.l));
        }
        break;
      }
      case 'a-colon':
        emit(ctx, OP.OP_COLON, dest, this.valSource(ctx, e.obj),
          this.nameK(e.field), this.locK(e.l));
        break;
      case 'a-get-bang':
        emit(ctx, OP.OP_GETBANG, dest, this.valSource(ctx, e.obj),
          this.nameK(e.field), this.locK(e.l));
        break;
      case 'a-tuple-get':
        emit(ctx, OP.OP_TUPLEGET, dest, this.valSource(ctx, e.tup), e.index, this.locK(e.l));
        break;
      case 'a-if': {
        const elseL = newLabel();
        emit(ctx, OP.OP_IF, this.valSource(ctx, e.c));
        emitRef(ctx, elseL);
        this.compileAExpr(ctx, e.t, dest, cont);
        place(ctx, elseL);
        this.compileAExpr(ctx, e.e, dest, cont);
        return false;
      }
      case 'a-cases': {
        const elseExpr = this.compileCases(ctx, e, dest, cont);
        this.compileAExpr(ctx, elseExpr, dest, cont);
        return false;
      }
      case 'a-module':
        throw new InternalCompilerError('vm-compile: a-module inside a bytecode function');
      default: {
        // Value construction (a-obj, a-extend, a-tuple, a-ref, a-data-expr,
        // ...): the JS emitter's own code, as a thunk over the free variables.
        const params = this.thunkParams(new Map(N.freevarsL(e) as any));
        const th = this.thunkK(h.thunkForLettable(e, params));
        this.emitThunkCall(ctx, dest, th, (e as any).l !== undefined ? (e as any).l : A.dummyLoc, false, params);
        break;
      }
    }
    jump(ctx, cont, dest);
    return false;
  }
}

// ---------- tiny assembler ----------

function emit(ctx: FuncCtx, ...xs: number[]): void {
  for (let i = 0; i < xs.length; i++) { ctx.code.push(xs[i]); }
}

function newLabel(): Label { return { pc: -1, refs: [] }; }

function emitRef(ctx: FuncCtx, l: Label): void {
  if (l.pc >= 0) { ctx.code.push(l.pc); return; }
  l.refs.push(ctx.code.length);
  ctx.code.push(0);
}

function place(ctx: FuncCtx, l: Label): void {
  // Fallthrough peephole: a JMP to the very next instruction is dropped.
  if (ctx.code.length >= 2
      && ctx.code[ctx.code.length - 2] === OP.OP_JMP
      && l.refs.length > 0
      && l.refs[l.refs.length - 1] === ctx.code.length - 1) {
    l.refs.pop();
    ctx.code.pop();
    ctx.code.pop();
  }
  l.pc = ctx.code.length;
  for (const r of l.refs) { ctx.code[r] = l.pc; }
  l.refs = [];
}

function jump(ctx: FuncCtx, cont: Label, dest: number): void {
  if (cont === RETURN) {
    emit(ctx, OP.OP_RET, OP.vsLocal(dest));
    return;
  }
  if (cont.pc >= 0) {
    emit(ctx, OP.OP_JMP, cont.pc);
    return;
  }
  emit(ctx, OP.OP_JMP);
  emitRef(ctx, cont);
}

function annLoc(ann: A.Ann): Loc {
  if (A.isABlank(ann)) { return A.dummyLoc; }
  return (ann as any).l;
}
