/*
  TypeScript port of src/arr/compiler/anf-loop-compiler.arr — the code
  generator. Produces, per module, the dictionary of JS expressions
  ("requires", "provides", "nativeRequires", "theModule", "theMap") that
  js-of-pyret packages into a compiled-code-printer.

  Representation notes:
  - The Pyret `compiler-visitor` object (extended repeatedly with `.{ }`)
    is the class `CompilerVisitor`; Pyret's functional extension `obj.{f: v}`
    is `ext(obj, {f: v})`, which clones the object (preserving its
    prototype, hence all visitor methods) and overrides the given fields.
  - `sha.sha256(uri)` is node crypto's sha256 hex digest of the UTF-8 uri
    (verified byte-identical against the existing compiled output:
    _96cdfee8...__N == sha256("file:///tmp/ptest/hello.arr")).
  - `js-ids`/`effective-ids` are module-level mutable caches in the Pyret
    source (they persist across compile-module calls within one process,
    while `js-names` IS reset per module); mirrored exactly here.
  - Key-ORDER canonicalization: every site where emitted code depends on
    dict/set iteration order sorts keys first, matching sorts added to the
    Pyret compiler (anf-loop-compiler.arr clMapSd / compileFunBody vars /
    compileModule free-ids; resolve-scope.arr defined-* and final
    provides). Output is byte-identical between the two compilers; keep
    the sorts in lockstep.
*/

import { sha256 } from './sha256';
import * as A from './ast';
import * as N from './ast-anf';
import { INLINE_MARKER_BASE } from './optimize-anf';
import * as J from './js-ast';
import * as CS from './compile-structs';
import * as CL from './concat-lists';
import * as FL from './flatness';
import * as TIER from './tier';
import * as VM from './vm/vm-compile';
import * as DAG from './js-dag-utils';
import * as AU from './ast-util';
import * as T from './type-structs';
import * as SL from './srcloc';
import { jsnums } from './interop/js-numbers';
import { InternalCompilerError, raise, map2, mapGetValue, partition } from './shared';

export type Loc = SL.Loc;
export type CList<T> = CL.ConcatList<T>;
const clist = CL.clist;

const clEmpty: CList<any> = CL.clEmpty;
const clSing = CL.clSing;
const clAppend = CL.clAppend;
const clCons = CL.clCons;
const clSnoc = CL.clSnoc;

// CompileOptions by the time codegen runs has should-profile already
// applied to the locator (see compile-lib.arr), so it is treated as a
// boolean here (tested only for truthiness, as Pyret's `if` would).
export type SplitCompileOptions = Omit<CS.CompileOptions, 'shouldProfile'> & { shouldProfile: any };

export function getExp(o: any): any { return o.exp; }
export function getId(o: any): any { return o.id; }
export function getName(o: any): any { return o.name; }
export function getL(o: any): any { return o.l; }
export function getBind(o: any): any { return o.bind; }
export function oGetField(o: any): any { return o.field; }

export function clMapSd<T, U>(f: (key: string) => U, sd: Map<string, T>): CList<U> {
  // Sorted key order, in lockstep with cl-map-sd in anf-loop-compiler.arr
  let acc: CList<U> = clEmpty;
  for (const key of [...sd.keys()].sort()) {
    acc = clSnoc(acc, f(key));
  }
  return acc;
}

export function makeFunName(compiler: any, loc: Loc): string {
  return '_' + sha256(compiler.uri) + '__' + String(compiler.getLocId(loc));
}

export function typeName(str: string): string {
  return '$type$' + str;
}

// ---------- j-ast shorthands (mirroring the Pyret import aliases) ----------

const jFun = (id: string, name: string, args: CList<A.Name>, body: J.JBlockT): J.JFun => new J.JFun(id, name, args, body);
const jAsyncFun = (id: string, name: string, args: CList<A.Name>, body: J.JBlockT): J.JAsyncFun => new J.JAsyncFun(id, name, args, body);
const jAwait = (expr: J.JExprT): J.JAwait => new J.JAwait(expr);
const jVar = (name: A.Name, rhs: J.JExprT): J.JVar => new J.JVar(name, rhs);
const jId = (id: A.Name): J.JId => new J.JId(id);
const jMethod = (obj: J.JExprT, meth: string, args: CList<J.JExprT>): J.JMethod => new J.JMethod(obj, meth, args);
const jBlock = (stmts: CList<J.JStmt>): J.JBlock => new J.JBlock(stmts);
const jBlock1 = (stmt: J.JStmt): J.JBlock1 => new J.JBlock1(stmt);
const jTrue = J.jTrue;
const jFalse = J.jFalse;
const jNum = (n: any): J.JNum => new J.JNum(n);
const jStr = (s: string): J.JStr => new J.JStr(s);
const jReturn = (expr: J.JExprT): J.JReturn => new J.JReturn(expr);
const jAssign = (name: A.Name, rhs: J.JExprT): J.JAssign => new J.JAssign(name, rhs);
const jIf = (cond: J.JExprT, consq: J.JBlockT, alt: J.JBlockT): J.JIf => new J.JIf(cond, consq, alt);
const jIf1 = (cond: J.JExprT, consq: J.JBlockT): J.JIf1 => new J.JIf1(cond, consq);
const jNew = (func: J.JExprT, args: CList<J.JExprT>): J.JNew => new J.JNew(func, args);
const jApp = (func: J.JExprT, args: CList<J.JExprT>): J.JApp => new J.JApp(func, args);
const jList = (multiLine: boolean, elts: CList<J.JExprT>): J.JList => new J.JList(multiLine, elts);
const jObj = (fields: CList<J.JFieldT>): J.JObj => new J.JObj(fields);
const jDot = (obj: J.JExprT, field: string): J.JDot => new J.JDot(obj, field);
const jBracket = (obj: J.JExprT, field: J.JExprT): J.JBracket => new J.JBracket(obj, field);
const jField = (name: string, value: J.JExprT): J.JField => new J.JField(name, value);
const jDotAssign = (obj: J.JExprT, name: string, rhs: J.JExprT): J.JDotAssign => new J.JDotAssign(obj, name, rhs);
const jBracketAssign = (obj: J.JExprT, field: J.JExprT, rhs: J.JExprT): J.JBracketAssign => new J.JBracketAssign(obj, field, rhs);
const jThrow = (exp: J.JExprT): J.JThrow => new J.JThrow(exp);
const jExpr = (expr: J.JExprT): J.JExpr => new J.JExpr(expr);
const jBinop = (left: J.JExprT, op: J.JBinopT, right: J.JExprT): J.JBinop => new J.JBinop(left, op, right);
const jAnd = J.jAnd;
const jOr = J.jOr;
const jLt = J.jLt;
const jEq = J.jEq;
const jNullish = J.jNullish;
const jNeq = J.jNeq;
const jEquals = J.jEquals;
const jGeq = J.jGeq;
const jUnop = (exp: J.JExprT, op: J.JUnopT): J.JUnop => new J.JUnop(exp, op);
const jDecr = J.jDecr;
const jIncr = J.jIncr;
const jNot = J.jNot;
const jTypeof = J.jTypeof;
const jInstanceof = J.jInstanceof;
const jTernary = (test: J.JExprT, consq: J.JExprT, altern: J.JExprT): J.JTernary => new J.JTernary(test, consq, altern);
const jNull = J.jNull;
const jParens = (exp: J.JExprT): J.JParens => new J.JParens(exp);
const jSwitch = (exp: J.JExprT, branches: CList<J.JCaseT>): J.JSwitch => new J.JSwitch(exp, branches);
const jCase = (exp: J.JExprT, body: J.JBlockT): J.JCase => new J.JCase(exp, body);
const jDefault = (body: J.JBlockT): J.JDefault => new J.JDefault(body);
const jBreak = J.jBreak;
const jContinue = J.jContinue;
const jWhile = (cond: J.JExprT, body: J.JBlockT): J.JWhile => new J.JWhile(cond, body);
const jFor = (createVar: boolean, init: J.JExprT, cond: J.JExprT, update: J.JExprT, body: J.JBlockT): J.JFor =>
  new J.JFor(createVar, init, cond, update, body);
const jRawCode = (s: string): J.JRawCode => new J.JRawCode(s);
const jUndefined = J.jUndefined;
const isJAssign = J.isJAssign;
const makeLabelSequence = J.makeLabelSequence;

export function consoleLog(lst: CList<J.JExprT>): J.JExprT {
  return jApp(jId(new A.SName(A.dummyLoc, 'console.log')), lst);
}
export function consoleLogStmt(lst: CList<J.JExprT>): J.JStmt {
  return jExpr(consoleLog(lst));
}

export const isTData = T.isTData;

// ---------- data BindType ----------

export abstract class BindTypeBase {
  abstract get $name(): string;
}

export class BLet extends BindTypeBase {
  get $name(): 'b-let' { return 'b-let'; }
  constructor(public value: N.ABind) { super(); }
}

export class BArray extends BindTypeBase {
  get $name(): 'b-array' { return 'b-array'; }
  constructor(public value: N.ABind, public idx: number) { super(); }
}

export type BindType = BLet | BArray;

export function isBLet(x: any): x is BLet { return x instanceof BLet; }
export function isBArray(x: any): x is BArray { return x instanceof BArray; }

// this structure stores bindings of case dispatch objects
// so that the objects can be allocated only once in the top level, avoiding
// multiple allocations which could affect performance, particularly in recursive
// functions.
export class DispatchesBox {
  get $name(): 'dispatches-box' { return 'dispatches-box'; }
  // ref dispatches
  constructor(public dispatches: CList<J.JStmt>) {}
}

export type Dispatches = DispatchesBox;
export function isDispatchesBox(x: any): x is DispatchesBox { return x instanceof DispatchesBox; }

// ---------- js-id allocation ----------

export const jsNames = A.MakeName(0);
export const jsIds: Map<string, A.Name> = new Map();
export const effectiveIds: Map<string, boolean> = new Map();

export function freshId(id: A.Name): A.Name {
  const baseName = A.isSTypeGlobal(id) ? id.tosourcestring() : id.toname();
  const noHyphens = baseName.split('-').join('$');
  const n = jsNames.makeAtom(noHyphens);
  if (effectiveIds.has(n.tosourcestring())) { // awkward name collision!
    return freshId(id);
  } else {
    effectiveIds.set(n.tosourcestring(), true);
    return n;
  }
}

export function jsIdOf(id: A.Name): A.Name {
  const s = id.key();
  const cached = jsIds.get(s);
  if (cached !== undefined) {
    return cached;
  } else {
    const safeId = freshId(id);
    jsIds.set(s, safeId);
    return safeId;
  }
}

export function constId(name: string): A.SName {
  return new A.SName(A.dummyLoc, name);
}

export function compilerName(id: string): A.SName {
  return constId('$' + id);
}

export function formalShadowName(id: A.Name): A.Name {
  const jsId = jsIdOf(id);
  return new A.SName(A.dummyLoc, '$' + jsId.tosourcestring());
}

export const getFieldLoc: J.JExprT = jId(constId('G'));
export const throwUninitialized: J.JExprT = jId(constId('U'));
export const sourceName: J.JId = jId(constId('M'));
// the Pyret source calls this binding `undefined`
export const UNDEFINED: J.JExprT = jId(constId('D'));
export const RUNTIME: J.JId = jId(constId('R'));
export const NAMESPACE: J.JId = jId(constId('NAMESPACE'));
export const THIS: J.JExprT = jId(constId('this'));
export const ARGUMENTS: J.JExprT = jId(constId('arguments'));

export const rtNameMap: Map<string, string> = new Map([
  ['addModuleToNamespace', 'aMTN'],
  ['checkArityC', 'cAC'],
  ['checkRefAnns', 'cRA'],
  ['derefField', 'dF'],
  ['getColonFieldLoc', 'gCFL'],
  ['getDotAnn', 'gDA'],
  ['getField', 'gF'],
  ['getFieldRef', 'gFR'],
  ['getBracket', 'gB'],
  ['hasBrand', 'hB'],
  ['isActivationRecord', 'isAR'],
  ['isCont', 'isC'],
  ['isFunction', 'isF'],
  ['isMethod', 'isM'],
  ['isPyretException', 'isPE'],
  ['isPyretTrue', 'isPT'],
  ['isThenable', 'iT'],
  ['makeActivationRecord', 'mAR'],
  ['makeBoolean', 'mB'],
  ['makeBranderAnn', 'mBA'],
  ['makeCont', 'mC'],
  ['makeDataValue', 'mDV'],
  ['makeFunction', 'mF'],
  ['makeGraphableRef', 'mGR'],
  ['makeMatch', 'mM'],
  ['makeMethod', 'mMet'],
  ['makeMethodN', 'mMN'],
  ['makeObject', 'mO'],
  ['makePredAnn', 'mPA'],
  ['makeRecordAnn', 'mRA'],
  ['makeTupleAnn', 'mTA'],
  ['makeVariantConstructor', 'mVC'],
  ['namedBrander', 'nB'],
  ['profileEnter', 'pEn'],
  ['profileExit', 'pEx'],
  ['traceEnter', 'tEn'],
  ['traceErrExit', 'tErEx'],
  ['traceExit', 'tEx'],
  ['_checkAnn', '_cA'],
]);

export const jBool = (b: boolean): J.JExprT => (b ? jTrue : jFalse);

export function objOfLoc(l: Loc): J.JExprT {
  switch (l.$name) {
    case 'builtin':
      return jList(false, clist(jStr(l.moduleName)));
    case 'srcloc':
      return jList(false, clist<J.JExprT>(
        jStr(l.source),
        jNum(l.startLine),
        jNum(l.startColumn),
        jNum(l.startChar),
        jNum(l.endLine),
        jNum(l.endColumn),
        jNum(l.endChar)
      ));
    default:
      throw new InternalCompilerError('Unknown Loc in obj-of-loc');
  }
}

export function wrapWithSrcnode(l: Loc, expr: J.JExprT): J.JExprT {
  switch (l.$name) {
    case 'builtin':
      return expr;
    case 'srcloc':
      return new J.JSourcenode(l, l.source, expr);
    default:
      throw new InternalCompilerError('Unknown Loc in wrap-with-srcnode');
  }
}

export function getDictField(obj: J.JExprT, field: J.JExprT): J.JExprT {
  return jBracket(jDot(obj, 'dict'), field);
}

// Direct method dispatch: `obj.dict["m"].full_meth(obj, ...args)`. Sound only when
// `m` is statically known to be a genuine method in obj's dict (see type-flow
// directMethodOk); obj must be a JId (evaluated once). Mirrors what
// maybeMethodCall's isMethod branch does, without the runtime-helper funnel.
function directMethodDispatch(obj: J.JExprT, methname: string, args: CList<J.JExprT>): J.JExprT {
  return jApp(jDot(getDictField(obj, jStr(methname)), 'full_meth'), clCons(obj, args));
}

// Use when we're sure the field will exist
export function getFieldUnsafe(obj: J.JExprT, field: J.JExprT, locExpr: J.JExprT): J.JExprT {
  return jApp(getFieldLoc, clist(obj, field, locExpr));
}

export function getBracketUnsafe(obj: J.JExprT, field: J.JExprT, locExpr: J.JExprT): J.JExprT {
  return rtMethod('getBracket', clist(obj, field, locExpr));
}

// When the field may not exist, add source mapping so if we can't find it
// we get a useful stacktrace
export function getFieldSafe(l: Loc, obj: J.JExprT, field: J.JExprT, locExpr: J.JExprT): J.JExprT {
  return wrapWithSrcnode(l, getFieldUnsafe(obj, field, locExpr));
}

export function getBracketSafe(l: Loc, obj: J.JExprT, field: J.JExprT, locExpr: J.JExprT): J.JExprT {
  return wrapWithSrcnode(l, getBracketUnsafe(obj, field, locExpr));
}

export function getFieldRef(obj: J.JExprT, field: J.JExprT, loc: J.JExprT): J.JExprT {
  return rtMethod('getFieldRef', clist(obj, field, loc));
}

export function raiseIdExn(loc: J.JExprT, name: string): J.JExprT {
  return jApp(throwUninitialized, clist(loc, jStr(name)));
}

export function addStackFrame(exnId: A.Name, loc: J.JExprT): J.JExprT {
  return jMethod(jDot(jId(exnId), 'pyretStack'), 'push', clist(loc));
}

export function rtField(name: string): J.JExprT {
  return jDot(RUNTIME, name);
}

export function rtMethod(name: string, args: CList<J.JExprT>): J.JExprT {
  const shortName = rtNameMap.get(name);
  const rtName = shortName === undefined ? name : shortName;
  return jMethod(RUNTIME, rtName, args);
}

export function logAnd(log: CList<J.JExprT>, ret: J.JExprT): J.JExprT {
  return jBracket(jList(true, clist(consoleLog(log), ret)), jNum(1));
}

export function getField(obj: J.JExprT, field: string): J.JExprT {
  return rtMethod('getField', clist(obj, jStr(field)));
}

export function getModuleField(uri: string, which: string, name: string): J.JExprT {
  return rtMethod('getModuleField', clist<J.JExprT>(jStr(uri), jStr(which), jStr(name)));
}

export function app(l: Loc, f: J.JExprT, args: CList<J.JExprT>): J.JExprT {
  switch (l.$name) {
    case 'builtin':
      return jMethod(f, 'app', args);
    default:
      return new J.JSourcenode(l, (l as SL.Srcloc).source, jMethod(f, 'app', args));
  }
}

export function checkFun(sourcemapLoc: Loc, variableLoc: J.JExprT, f: J.JExprT): J.JStmt {
  let call: J.JExprT;
  switch (sourcemapLoc.$name) {
    case 'builtin':
      call = jMethod(rtField('ffi'), 'throwNonFunApp', clist(variableLoc, f));
      break;
    case 'srcloc':
      call = new J.JSourcenode(sourcemapLoc, sourcemapLoc.source,
        jMethod(rtField('ffi'), 'throwNonFunApp', clist(variableLoc, f)));
      break;
    default:
      throw new InternalCompilerError('Unknown Loc in check-fun');
  }
  return jIf1(jBinop(jUnop(jParens(jDot(f, 'app')), jTypeof), jNeq, jStr('function')),
    jBlock1(jExpr(call)));
}

const cExp = (exp: J.JExprT, otherStmts: CList<J.JStmt>): DAG.CExp => new DAG.CExp(exp, otherStmts);
const cField = (field: J.JFieldT, otherStmts: CList<J.JStmt>): DAG.CField => new DAG.CField(field, otherStmts);
const cBlock = (block: J.JBlockT, newCases: CList<J.JCaseT>): DAG.CBlock => new DAG.CBlock(block, newCases);

export function annLoc(ann: A.Ann): Loc {
  if (A.isABlank(ann)) { return A.dummyLoc; }
  else { return (ann as any).l; }
}

// MOVED to flatness.ts (the shared classifier seam consumed by both this
// emitter and the tier analysis in tier.ts); re-exported here so existing
// call sites keep one name. The cont compiler's copy stays frozen separately
// (byte-parity oracle).
export const isFlatEnough = FL.isFlatEnough;
export const isFunctionFlat = FL.isFunctionFlat;

// Pyret object extension `obj.{ f1: v1, ... }`: clone preserving prototype
// (visitor methods), overriding the given fields.
function ext<T extends object>(obj: T, fields: Record<string, any>): T {
  const out = Object.create(Object.getPrototypeOf(obj));
  Object.assign(out, obj, fields);
  return out as T;
}

// Box elimination for function-local `var`s. A Pyret `var` is normally compiled
// to a `{$var: value}` heap box so its mutation is visible by-reference across
// module/REPL boundaries (see the provide path's `s-local-ref`/`VbVar` case and
// `aIdVarModref`). That visibility is the ONLY thing the box buys: a `var`
// declared inside a function/lambda body can never be exported or read by
// another module/the REPL, so for it the box is pure overhead -- a plain mutable
// JS local is equivalent and far cheaper in a hot loop.
//
// This returns the `key()` set of every `var` declared in a nested scope (depth
// >= 1, i.e. inside some a-lam/a-method body). Those are unboxed at the three
// codegen sites (decl / a-assign / a-id-var). Top-level vars are left boxed:
// they escape via provides and are mutable from the REPL.
//
// CRUCIAL: a Pyret `letrec` (every local `fun`/`rec`) is desugared in anf.ts to a
// `var`-binding initialized to `undefined` plus an `s-assign` of the value (so
// `fun f` becomes `var f = undefined; f := <lam>`). Its DECLARATION is therefore
// an `AVar` -- indistinguishable here from a genuine `var` -- but its REFERENCES
// are `AIdLetrec`/`AIdSafeLetrec`, which read `.$var` rather than `AIdVar`.
//
// A letrec binding is ALSO unboxable, with one extra condition. The box's only
// letrec-specific job is the uninitialized-on-read guard for FORWARD references
// (a read that executes during letrec init, before the binding is assigned):
// `AIdLetrec` with `safe === false` reads `x.$var === undefined ? raise : x.$var`.
// A reference marked SAFE (`AIdSafeLetrec`, or `AIdLetrec safe === true`) is
// provably reached only AFTER initialization, so the box buys it nothing -- a
// plain JS binding (captured by closures the same way, so mutual recursion still
// works) is equivalent. So we unbox a nested letrec binding iff ALL its
// references are safe; a single `AIdLetrec safe===false` reference forces it to
// stay boxed. (The decl/assign already unbox via the shared `unboxedVars` set;
// the safe `aId*Letrec` read sites are updated to read `x` instead of `x.$var`.)
//
// We therefore collect candidate decls (nested AVars: genuine vars AND letrec
// decls) and SUBTRACT only the ids that have an unsafe-letrec reference. Genuine
// vars (referenced via AIdVar) are never subtracted; safe-only letrec ids survive.
// Top-level decls (depth 0) are never candidates: they escape via provides/REPL,
// and a provided `VbLetrec` reads `x.$var` by value -- unboxing would break it.
//
// Post-ANF binding atoms are globally unique (`SAtom.key()` includes a serial),
// so membership-by-key is unambiguous across the read/decl/assign sites.
//
// HYBRID MACHINE RULE: a bytecode function captures its free variables BY
// VALUE (see vm/vm-compile.ts), so a var it can see must be a box that both
// sides share. Any var/letrec binding that is DECLARED inside a VM-tier
// function, or REFERENCED anywhere lexically inside one (which includes JS
// functions nested below it -- their captures flow through the bytecode
// closure's by-value upvalues), stays boxed. Vars whose every use is on the
// JS side of the tier boundary unbox exactly as before.
function collectUnboxableVarKeys(body: N.AExpr, tierMap?: TIER.TierMap, vmTiers?: Set<string>): Set<string> {
  const candidates = new Set<string>();
  const unsafeLetrecRefs = new Set<string>();
  const mustBox = new Set<string>();
  let depth = 0;
  let vmDepth = 0;
  function isVm(node: N.ALam | N.AMethod): boolean {
    if (tierMap === undefined || vmTiers === undefined || vmTiers.size === 0) { return false; }
    return vmTiers.has(TIER.tierVerdictFor(tierMap, node, node.l.key()).tier);
  }
  const visitor: any = ext(N.defaultMapVisitor as any, {
    aVar(node: N.AVar): any {
      if (depth > 0) { candidates.add(node.bind.id.key()); }
      if (vmDepth > 0) { mustBox.add(node.bind.id.key()); }
      node.e.visit(this);
      node.body.visit(this);
      return node;
    },
    aIdLetrec(node: N.AIdLetrec): any {
      // Only the unsafe (uninitialized-guard) reads force the binding to stay
      // boxed; safe reads are fine unboxed.
      if (!node.safe) { unsafeLetrecRefs.add(node.id.key()); }
      if (vmDepth > 0) { mustBox.add(node.id.key()); }
      return node;
    },
    aIdSafeLetrec(node: N.AIdSafeLetrec): any {
      if (vmDepth > 0) { mustBox.add(node.id.key()); }
      return node;
    },
    aIdVar(node: N.AIdVar): any {
      if (vmDepth > 0) { mustBox.add(node.id.key()); }
      return node;
    },
    aAssign(node: N.AAssign): any {
      if (vmDepth > 0) { mustBox.add(node.id.key()); }
      node.value.visit(this);
      return node;
    },
    aLam(node: N.ALam): any {
      const vm = isVm(node);
      depth++;
      if (vm) { vmDepth++; }
      node.body.visit(this);
      if (vm) { vmDepth--; }
      depth--;
      return node;
    },
    aMethod(node: N.AMethod): any {
      const vm = isVm(node);
      depth++;
      if (vm) { vmDepth++; }
      node.body.visit(this);
      if (vm) { vmDepth--; }
      depth--;
      return node;
    },
  });
  body.visit(visitor);
  for (const k of unsafeLetrecRefs) { candidates.delete(k); }
  for (const k of mustBox) { candidates.delete(k); }
  return candidates;
}

export function compileAnn(ann: A.Ann, optName: string | undefined, visitor: CompilerVisitor): DAG.CExp {
  switch (ann.$name) {
    case 'a-name':
      return cExp(jId(jsIdOf(ann.id)), clEmpty);
    case 'a-type-var':
      return cExp(rtField('Any'), clEmpty);
    case 'a-arrow':
      return cExp(rtField('Function'), clEmpty);
    case 'a-arrow-argnames':
      return cExp(rtField('Function'), clEmpty);
    case 'a-method':
      return cExp(rtField('Method'), clEmpty);
    case 'a-app':
      return compileAnn(ann.ann, optName, visitor);
    case 'a-record': {
      let names: CList<J.JExprT> = clEmpty;
      let locs: CList<J.JExprT> = clEmpty;
      let fields: CList<J.JFieldT> = clEmpty;
      let others: CList<J.JStmt> = clEmpty;
      for (const field of ann.fields) {
        const compiled = compileAnn(field.ann, undefined, visitor);
        names = clSnoc(names, jStr(field.name));
        locs = clSnoc(locs, visitor.getLoc(field.l));
        fields = clSnoc(fields, jField(field.name, compiled.exp));
        others = clAppend(others, compiled.otherStmts);
      }
      return cExp(
        rtMethod('makeRecordAnn', clist<J.JExprT>(
          jList(false, names),
          jList(false, locs),
          jObj(fields),
          optName !== undefined ? jStr(optName) : jUndefined
        )),
        others
      );
    }
    case 'a-tuple': {
      let locs: CList<J.JExprT> = clEmpty;
      let fields: CList<J.JExprT> = clEmpty;
      let others: CList<J.JStmt> = clEmpty;
      for (const field of ann.fields) {
        const compiled = compileAnn(field, optName, visitor);
        locs = clSnoc(locs, visitor.getLoc(annLoc(field)));
        fields = clSnoc(fields, compiled.exp);
        others = clAppend(others, compiled.otherStmts);
      }
      return cExp(
        rtMethod('makeTupleAnn', clist<J.JExprT>(
          jList(false, locs),
          jList(false, fields),
          optName !== undefined ? jStr(optName) : jUndefined
        )),
        others
      );
    }
    case 'a-pred': {
      const exp = ann.exp;
      let name: string;
      switch (exp.$name) {
        case 's-id': name = exp.id.toname(); break;
        case 's-id-letrec': name = exp.id.toname(); break;
        default: throw new InternalCompilerError('Unknown name in a-pred in compile-ann: ' + exp.$name);
      }
      let exprToCompile: N.AVal;
      switch (exp.$name) {
        case 's-id': exprToCompile = new N.AId(exp.l, exp.id); break;
        case 's-id-letrec': exprToCompile = new N.AIdLetrec(exp.l, exp.id, exp.safe) as any; break;
        default: throw new InternalCompilerError('Unknown expr in a-pred in compile-ann: ' + (exp as any).$name);
      }
      const compiledBase = compileAnn(ann.ann, optName, visitor);
      const compiledExp = (exprToCompile as any).visit(visitor) as DAG.CExp;
      const isFlat =
        isFlatEnough(FL.annFlatness(ann.ann, visitor.flatnessEnv, visitor.typeFlatnessEnv, visitor.moduleBindings, visitor.env))
        && isFunctionFlat(visitor.flatnessEnv, (exp as any).id.key());
      const predMaker = isFlat ? 'makeFlatPredAnn' : 'makePredAnn';
      return cExp(
        rtMethod(predMaker, clist(compiledBase.exp, compiledExp.exp, jStr(name))),
        clAppend(compiledBase.otherStmts, compiledExp.otherStmts)
      );
    }
    case 'a-dot':
      return cExp(
        rtMethod('getDotAnn', clist(
          visitor.getLoc(ann.l),
          jStr(ann.obj.toname()),
          jDot(jDot(jId(jsIdOf(ann.obj)), 'dict'), 'types'),
          jStr(ann.field))),
        clEmpty);
    case 'a-blank':
      return cExp(rtField('Any'), clEmpty);
    case 'a-any':
      return cExp(rtField('Any'), clEmpty);
    default:
      throw new InternalCompilerError('Unknown ann in compile-ann: ' + (ann as any).$name);
  }
}

export function arityCheck(locExpr: J.JExprT, arity: number, isMethod: boolean): CList<J.JStmt> {
  const len = jId(compilerName('l'));
  const iter = jId(compilerName('i'));
  const t = jId(compilerName('t'));
  return clist<J.JStmt>(
    jVar(len.id, jDot(ARGUMENTS, 'length')),
    jIf1(jBinop(len, jNeq, jNum(arity)),
      jBlock(clist<J.JStmt>(
        jVar(t.id, jNew(jId(constId('Array')), clist<J.JExprT>(len))),
        jFor(true, jAssign(iter.id, jNum(0)), jBinop(iter, jLt, len), jUnop(iter, jIncr),
          jBlock1(jExpr(jBracketAssign(t, iter, jBracket(ARGUMENTS, iter))))),
        jExpr(rtMethod('checkArityC', clist(locExpr, jNum(arity), t, jBool(isMethod))))))));
}

export const noVars = (): Map<string, A.Name> => new Map();

export function localBoundVars(kase: J.JCaseT, vars: Map<string, A.Name>): Map<string, A.Name> {
  function e(expr: J.JExprT): void {
    switch (expr.$name) {
      case 'j-sourcenode': e(expr.expr); break;
      case 'j-parens': e(expr.exp); break;
      case 'j-raw-code': break;
      case 'j-unop': e(expr.exp); break;
      case 'j-binop':
        e(expr.left);
        e(expr.right);
        break;
      case 'j-fun':
        // the body of a function contributes no *locally* bound vars
        break;
      case 'j-new':
        e(expr.func);
        expr.args.each(e);
        break;
      case 'j-app':
        e(expr.func);
        expr.args.each(e);
        break;
      case 'j-method':
        // the body of a method contributes no *locally* bound vars
        break;
      case 'j-ternary':
        e(expr.test);
        e(expr.consq);
        e(expr.altern);
        break;
      case 'j-assign': e(expr.rhs); break;
      case 'j-bracket-assign':
        e(expr.obj);
        e(expr.field);
        e(expr.rhs);
        break;
      case 'j-dot-assign':
        e(expr.obj);
        e(expr.rhs);
        break;
      case 'j-dot': e(expr.obj); break;
      case 'j-bracket':
        e(expr.obj);
        e(expr.field);
        break;
      case 'j-list':
        expr.elts.each(e);
        break;
      case 'j-obj':
        expr.fields.each(f);
        break;
      case 'j-id': break;
      case 'j-str': break;
      case 'j-num': break;
      case 'j-true': break;
      case 'j-false': break;
      case 'j-null': break;
      case 'j-undefined': break;
      case 'j-label': break;
      default:
        throw new InternalCompilerError('Unknown JExpr in local-bound-vars: ' + (expr as any).$name);
    }
  }
  function c(kase2: J.JCaseT): void {
    switch (kase2.$name) {
      case 'j-case':
        e(kase2.exp);
        b(kase2.body);
        break;
      case 'j-default':
        b(kase2.body);
        break;
      default:
        throw new InternalCompilerError('Unknown JCase in local-bound-vars: ' + (kase2 as any).$name);
    }
  }
  function f(field: J.JFieldT): void {
    e(field.value);
  }
  function s(stmt: J.JStmt): void {
    switch (stmt.$name) {
      case 'j-var':
        // Ignore all variables named $underscore#####
        if (A.isSAtom(stmt.name) && (stmt.name.base === '$underscore')) {
          e(stmt.rhs);
        } else {
          e(stmt.rhs);
          vars.set(stmt.name.key(), stmt.name);
        }
        break;
      case 'j-if1':
        e(stmt.cond);
        b(stmt.consq);
        break;
      case 'j-if':
        e(stmt.cond);
        b(stmt.consq);
        b(stmt.alt);
        break;
      case 'j-return': e(stmt.expr); break;
      case 'j-try-catch':
        b(stmt.body);
        // ignoring the exn name, because it's not a Pyret variable
        b(stmt.catch);
        break;
      case 'j-throw': e(stmt.exp); break;
      case 'j-expr': e(stmt.expr); break;
      case 'j-break': break;
      case 'j-continue': break;
      case 'j-switch':
        e(stmt.exp);
        stmt.branches.each(c);
        break;
      case 'j-while':
        e(stmt.cond);
        b(stmt.body);
        break;
      case 'j-for':
        e(stmt.init);
        e(stmt.cond);
        e(stmt.update);
        b(stmt.body);
        break;
      default:
        throw new InternalCompilerError('Unknown JStmt in local-bound-vars: ' + (stmt as any).$name);
    }
  }
  function b(blk: J.JBlockT): void {
    switch (blk.$name) {
      case 'j-block1': s(blk.stmt); break;
      case 'j-block': blk.stmts.each(s); break;
      default:
        throw new InternalCompilerError('Unknown JBlock in local-bound-vars: ' + (blk as any).$name);
    }
  }
  c(kase);
  return vars;
}

export function copyMutableDict<E>(s: Map<string, E>): Map<string, E> {
  // NOTE(ordering): Pyret's freeze().unfreeze() round-trips through the
  // hash trie and re-orders keys; this copy keeps insertion order.
  // See file header, site 2.
  return new Map(s);
}

let totalTime = 0;

function timeNow(): number { return Date.now(); }

const showStackTrace = false;

// --- Async/promise backend codegen (Stage 3) ----------------------------------
// A "completion" turns the final JExpr of a tail expression into statements.
// It lives on the compiler as `complete`; `tailPos` records whether we are in
// real function-tail position (so TCO `continue` is only emitted when valid).
export function completeReturn(v: J.JExprT): CList<J.JStmt> {
  return clSing(jReturn(v));
}

// The cross-realm-safe thenable test the async runtime itself uses
// (runtime-async.js `isThenable` = `t !== null && typeof t === "object" &&
// typeof t.then === "function"`). `t instanceof Promise` misses thenables from
// other realms (web workers / FFI), which would leak a Promise as a Pyret value
// ("Non Pyret value: Promise"). Emitted as a single short runtime call
// (`R.iT(t)`) rather than inlining the 3-condition test, so adding a
// conditional await to every non-flat call site does not bloat generated code.
function jIsThenable(t: A.Name): J.JExprT {
  return rtMethod('isThenable', clist<J.JExprT>(jId(t)));
}

// Conditional await: bind `callBase`'s result to fresh temp `t`, then `await`
// it ONLY if it actually suspended (returned a thenable). The flatness analysis
// marks a callee non-flat if it *could* be unbounded/async, but many such
// callees return a flat value synchronously in the common case — the
// arithmetic/relational runtime ops (_plus, _minus, equal-always, ...) are
// plain JS functions that return a number/bool directly and only produce a
// Promise when dispatching to a user-defined method/refinement. Unconditionally
// `await`ing them costs a microtask round-trip per call even though nothing
// suspended. Awaiting only real thenables skips that microtask on the hot
// synchronous path while preserving deep-stack safety: a genuinely-suspending
// callee returns a thenable, so we still await it (the await is what unwinds the
// JS stack into the heap). This is the same idiom the runtime loop helpers
// (eachLoop/map/fold) already use (`isThenable(res) ? await res : res`), and it
// is value/error-transparent, so TS-cont ≡ TS-promise run parity is preserved.
function callAndMaybeAwait(t: A.Name, callBase: J.JExprT): CList<J.JStmt> {
  return clist<J.JStmt>(
    jVar(t, callBase),
    jIf1(jIsThenable(t), jBlock1(jExpr(jAssign(t, jAwait(jId(t)))))));
}

// --- FewSuspend tier: guarded suspend sites over the ANF continuation ----------
//
// A 'few-suspend' function compiles to a PLAIN SYNC jFun in which each
// continuation-capturing suspend site becomes
//
//   var t = <call>;
//   if (R.iT(t)) return t.then(function(t) { <complete(t)> <continuation> });
//   <complete(t)>            // sync path: falls through to the SAME statements
//   <continuation>           // ...emitted once, in place, by the chain walker
//
// The resume closure's body is compiled FROM THE ANF CONTINUATION: the chain
// walker (compileAexprAsync) reifies "everything after the current position up
// to function exit" as the memoized thunk `compiler.rest`, so the closure and
// the sync fall-through ALIAS the same immutable J statement nodes (printing
// is pure; exactly one of the two paths executes at runtime). Zero allocation
// unless a suspension actually happens. This dissolves the ref branch's
// JS-level rewriting (tryFewSuspend): there is nothing to pattern-match,
// because the continuation is in the compiler's hands at the moment the site
// is emitted.
//
// REJECTION-SEMANTICS INVARIANT (matches driveGen's discipline exactly, and
// holds ONLY while sync-tier bodies stay try-free -- never wrap them in
// try/catch): `t.then(onF)` has no onRejected, so a rejected thenable SKIPS
// the closure and rejects the returned promise = rethrow-at-the-suspend-point
// in a body with no try/catch; a throw inside the closure rejects via .then's
// contract; a thenable returned from the closure is flattened by .then (no
// extra wrapping anywhere -- Promise.prototype.then gives all three for free).
//
// Aliasing safety (ref-proven): `var` decls inside the aliased continuation
// are closure-locals on the resume path and hoisted fn-locals on the sync
// path (both self-contained); vars declared BEFORE the site are shared by
// ordinary closure capture, so assignments behave identically either way; a
// whole aliased jSwitch is self-contained (its jBreaks are switch-local); the
// tier verdict's loopUnsafe/inCases gates guarantee no TCO `continue` and no
// mid-switch resume point can ever appear in a captured continuation, and the
// live async path emits no labels, so every construct that can appear aliases
// soundly -- nothing needs recompilation. The closure gets a fresh
// nextJFunId(), so js-dag-utils' per-JFun-id caches cannot collide. The
// closure's parameter deliberately REUSES the site temp's name: the aliased
// completion statements read `t` as the parameter inside the closure and as
// the fn-local var on the sync path.
function fewSuspendSite(compiler: CompilerVisitor, t: A.Name, callBase: J.JExprT): CList<J.JStmt> {
  const completeStmts = compiler.complete(jId(t));
  // complete = completeReturn only at real function tail, where rest() is
  // the (empty) function-exit thunk -- so no unreachable code after `return`.
  const closureBody = clAppend(completeStmts, compiler.rest());
  const resume = jFun(J.nextJFunId(), '', clSing<A.Name>(t), jBlock(closureBody));
  const guard = jIf1(jIsThenable(t),
    jBlock1(jReturn(jMethod(jId(t), 'then', clSing<J.JExprT>(resume)))));
  return clCons(jVar(t, callBase) as J.JStmt, clCons(guard as J.JStmt, completeStmts));
}

// --- Gen-fast tier: the fast JS form of a bytecode function -----------------
//
// A 'gen-fast' body is a PLAIN SYNC jFun -- the same statements the async
// emission would produce -- in which every suspend site, instead of
// awaiting, hands control to the machine when (and only when) a thenable
// actually arrives:
//
//   var t = <call>;
//   if (R.iT(t)) return R.$vm.bail($BC, idx, pc, dest, t, [slots], [live vals]);
//   <complete(t)>
//
// The machine rebuilds this function's frame at `pc` (the bytecode
// instruction after this same site) from the live slots, parks it on `t`,
// and interprets the rest of the activation. Which slots are live, and
// which JS variable holds each, the bytecode compiler already knows (see
// vm-compile.ts sites/liveness/slotNames): both forms are compiled from the
// SAME ANF, so a site's identity is the ANF node itself. A site the
// bytecode did not record is an InternalCompilerError -- the two forms
// disagreeing about where suspension can happen is a bug, never something
// to fall back from.
function vmBailExpr(compiler: CompilerVisitor, siteKey: any, t: J.JExprT, what: string): J.JExprT {
  const vf = compiler.vmFast;
  if (vf === undefined) {
    throw new InternalCompilerError('gen-fast site outside a fast-form compile (' + what + ')');
  }
  const info = vf.sites.get(siteKey);
  if (info === undefined) {
    throw new InternalCompilerError('gen-fast: bytecode recorded no suspend site for ' + what);
  }
  const slots = jList(false, CL.from_list(info.live.map((sl) => jNum(sl) as J.JExprT)));
  const vals = jList(false, CL.from_list(info.live.map((sl) => {
    const n = vf.slotNames.get(sl);
    if (n === undefined) { throw new InternalCompilerError('gen-fast: live slot r' + sl + ' has no name'); }
    return jId(jsIdOf(n)) as J.JExprT;
  })));
  return jMethod(rtField('$vm'), 'bail', clist<J.JExprT>(
    jId(VM_PROG_NAME), jNum(vf.idx), jNum(info.pc), jNum(info.dest), t, slots, vals));
}

function fastSite(compiler: CompilerVisitor, t: A.Name, callBase: J.JExprT, siteKey: any, what: string): CList<J.JStmt> {
  const guard = jIf1(jIsThenable(t), jBlock1(jReturn(vmBailExpr(compiler, siteKey, jId(t), what))));
  return clCons(jVar(t, callBase) as J.JStmt, clCons(guard as J.JStmt, compiler.complete(jId(t))));
}

// The function-exit continuation: nothing remains after the enclosing chain's
// own statements (every path through a compiled body ends in `return`).
// Installed (RESET) at EVERY compileFunBody entry -- see the CompilerVisitor
// field comment for the landmine this discipline retires.
const fnExitRest = (): CList<J.JStmt> => clEmpty as CList<J.JStmt>;

// Memoize a continuation-part thunk: compiled at most once, so the suspend
// site's resume closure (which forces it early) and the chain walker's
// fall-through emission (which forces it after the site) get the SAME
// statement nodes -- aliasing, never recompilation.
function memoStmts(f: () => CList<J.JStmt>): () => CList<J.JStmt> {
  let cached: CList<J.JStmt> | undefined;
  return () => {
    if (cached === undefined) { cached = f(); }
    return cached;
  };
}

// Shared classifier shorthand (rule 2): is this bind's annotation check a
// suspend site? Same FL.annCheckClass call as annCheckStmts and tier.ts.
function annSuspends(compiler: CompilerVisitor, b: N.ABind): boolean {
  return FL.annCheckClass(b, compiler.flatnessEnv, compiler.typeFlatnessEnv,
    compiler.redundantAnnChecks, compiler.moduleBindings, compiler.env) === 'suspend';
}

// The FewSuspend form of a suspend-class annotation check ('b = await
// _checkAnn(...)' in async/gen bodies): a guarded site whose completion
// assigns the checked value back to the binder and whose continuation is
// `restAll` (the remaining chain to function exit). Returns the site
// statements only -- the caller emits the fall-through continuation once,
// in place, right after them.
function fewSuspendAnnCheck(
  compiler: CompilerVisitor, b: N.ABind, restAll: () => CList<J.JStmt>
): CList<J.JStmt> {
  const ca = compileAnn(b.ann, undefined, compiler);
  const checkCall = rtMethod('_checkAnn',
    clist(compiler.getLoc(annLoc(b.ann)), ca.exp, jId(jsIdOf(b.id))));
  const t = freshId(compilerName('chk'));
  const siteCompiler = ext(compiler, {
    complete: (v: J.JExprT): CList<J.JStmt> => clSing<J.JStmt>(jExpr(jAssign(jsIdOf(b.id), v))),
    rest: restAll,
  });
  return clAppend(ca.otherStmts, fewSuspendSite(siteCompiler, t, checkCall));
}

// Does a let/arr-let RHS compile to the explicit-loop TCO `continue`? Same
// predicate compileAppAsync uses (shared helper TIER.isTcoSelfApp +
// inTcoLoop) -- rule 2: never a second site list. Used by the sync tiers
// (TailFlat AND FewSuspend) to elide the trailing annotation check, which is
// UNREACHABLE after `continue` (`fun f(n) -> T:` desugars a tail self-call
// to `let ans = f(...) in _checkAnn(T, ans)`); the tier walk skips that
// dead site for the same reason (tier.ts rhsTco), and a suspend-class dead
// check would otherwise leave a residual `await` in a sync body (a JS
// SyntaxError; O7 catches it at compile time). Gen/'async' bodies keep the
// (harmless) dead check so their output is unchanged.
function rhsIsTcoContinue(compiler: CompilerVisitor, rhs: N.ALettable): boolean {
  if ((compiler.fnTier !== 'tail-flat' && compiler.fnTier !== 'few-suspend' && compiler.fnTier !== 'gen-fast')
    || rhs.$name !== 'a-app' || !compiler.inTcoLoop) {
    return false;
  }
  const appRhs = rhs as N.AApp;
  return TIER.isTcoSelfApp(appRhs.appInfo, appRhs.args.length, compiler.args.length,
    compiler.allowTco, compiler.options.properTailCalls);
}

// Does this (non-tail, same-function) lettable subtree contain a
// continuation-CAPTURING suspend site? EXACTLY tier.ts's site classification,
// through the SAME shared helpers (FL.getAppFunFlatness / flatMethodApps /
// appInfo.needsStep / FL.annCheckClass / TIER.isTcoSelfApp), so the chain
// walker's thunk gating can never disagree with the verdict that admitted
// this function to the tier (a disagreement is a residual await -- O7 ICE).
// Only ever called on RHS positions, which are never function-tail, so a
// non-flat non-TCO app here always captures.
function lettableHasCapturingSite(compiler: CompilerVisitor, e: N.ALettable): boolean {
  switch (e.$name) {
    case 'a-app': {
      const f = e._fun;
      const isFlat = (N.isAId(f) || N.isAIdSafeLetrec(f) || N.isAIdModref(f))
        && isFlatEnough(FL.getAppFunFlatness(f, compiler.flatnessEnv, compiler.moduleBindings, compiler.env));
      if (isFlat) { return false; }
      if (compiler.inTcoLoop && TIER.isTcoSelfApp(e.appInfo, e.args.length,
        compiler.args.length, compiler.allowTco, compiler.options.properTailCalls)) {
        return false;  // compiles to the TCO `continue`, not a suspend site
      }
      return true;
    }
    case 'a-method-app':
      return !compiler.flatMethodApps.has(e);
    case 'a-prim-app':
      return e.appInfo.needsStep;
    case 'a-update':
      return true;
    case 'a-if':
      return exprHasCapturingSite(compiler, e.t) || exprHasCapturingSite(compiler, e.e);
    case 'a-cases': {
      // A capturing site inside a-cases forces the Gen verdict (tier.ts
      // inCases, v1 conservatism), so in a valid few-suspend body this
      // always answers false; scanned with the same classifiers anyway
      // rather than special-cased.
      for (const br of e.branches) {
        if (N.isACasesBranch(br)) {
          for (const arg of (br as N.ACasesBranch$).args) {
            if (annSuspends(compiler, arg.bind)) { return true; }
          }
        }
        if (exprHasCapturingSite(compiler, br.body)) { return true; }
      }
      return exprHasCapturingSite(compiler, e._else);
    }
    default:
      // a-lam / a-method are opaque values (their bodies are their own
      // functions with their own verdicts); everything else is a flat form.
      return false;
  }
}

function exprHasCapturingSite(compiler: CompilerVisitor, e: N.AExpr): boolean {
  let cur: N.AExpr = e;
  for (;;) {
    switch (cur.$name) {
      case 'a-type-let':
        cur = cur.body; continue;
      case 'a-let':
      case 'a-arr-let':
        if (lettableHasCapturingSite(compiler, cur.e)) { return true; }
        if (!rhsIsTcoContinue(compiler, cur.e) && annSuspends(compiler, cur.bind)) { return true; }
        cur = cur.body; continue;
      case 'a-var':
        // The async codegen emits no annCheckStmts for a-var binds (see
        // compileAexprAsync); only the RHS can be a site.
        if (lettableHasCapturingSite(compiler, cur.e)) { return true; }
        cur = cur.body; continue;
      case 'a-seq':
        if (lettableHasCapturingSite(compiler, cur.e1)) { return true; }
        cur = cur.e2; continue;
      case 'a-lettable':
        return lettableHasCapturingSite(compiler, cur.e);
      default:
        throw new InternalCompilerError('exprHasCapturingSite: unknown expr ' + (cur as any).$name);
    }
  }
}

// --- O7: post-emission residual-await scan (Stage 5) ---------------------------
// Count JAwait nodes in an emitted J AST fragment. The walk descends into
// nested SYNC JFuns (an await there is a would-be JS SyntaxError at load time)
// and SKIPS JAsyncFun bodies (awaits are legal there) -- plus nested JGenFun
// nodes by tag (their bodies were already lowered and asserted await-free at
// their own emission; yields are legal there). Scanned bodies: the Flat arms
// of compileALam/aMethod, and the Gen arm's generator body AFTER
// awaitsToYields plus its sync wrapper (see genFunStmts). With
// `skipFuelAwaits`, the fuel form `await R.checkPause()` is not counted (used
// only by the non-fatal bring-up shadow below; the O7 assertion counts
// everything, since a sync body has no fuel await either).
//
// NOTE (spec rule 1): this is an ASSERTION INPUT, never a decision procedure.
// All sync-vs-async decisions live on ANF (tier.ts + the shared classifiers);
// nothing may branch on this scan except to throw InternalCompilerError.
export function countResidualAwaits(root: any, skipFuelAwaits: boolean): number {
  let count = 0;
  function isFuelAwait(a: J.JAwait): boolean {
    const e = a.expr;
    return e instanceof J.JMethod && e.meth === 'checkPause';
  }
  function walk(x: any): void {
    if (x === null || typeof x !== 'object') { return; }
    if (x instanceof J.JAwait) {
      if (!(skipFuelAwaits && isFuelAwait(x))) { count++; }
      walk(x.expr);
      return;
    }
    if (x instanceof J.JAsyncFun) { return; }
    if ((x as any).$name === 'j-gen-fun') { return; }
    if (x instanceof CL.ConcatListBase) {
      (x as CL.ConcatList<any>).each((el: any) => walk(el));
      return;
    }
    if (x instanceof J.JBlockBase || x instanceof J.JStmtBase || x instanceof J.JExprBase
      || x instanceof J.JCaseBase || x instanceof J.JFieldBase) {
      for (const k of Object.keys(x)) { walk((x as any)[k]); }
      return;
    }
    // Anything else hanging off a node (A.Name, Loc, strings, numbers,
    // booleans, operator singletons) cannot contain a JAwait.
  }
  walk(root);
  return count;
}

// The O7 assertion proper: after emitting any sync (jFun) function body,
// a residual await means the tier/flatness verdict and the emission paths
// disagreed about some site -- a real bug in the shared classifiers or an
// emitter arm that missed its sync-tier form. Throw, never fall back, never
// re-decide (the ref branch's hasAwaits-as-decider is exactly what this
// design retires).
export function assertNoResidualAwaits(body: J.JBlockT, tier: string, l: Loc): void {
  const n = countResidualAwaits(body, false);
  if (n > 0) {
    throw new InternalCompilerError(
      'residual await in ' + tier + ' (sync) function body at ' + l.key()
      + ' (' + n + ' JAwait node(s)): tier/emission drift -- fix the shared'
      + ' classifier or the emitter arm; never fall back');
  }
}


export function compileAexprAsync(compiler: CompilerVisitor, e: N.AExpr): CList<J.JStmt> {
  // Walk the AExpr "chain" (let / arr-let / var / seq / type-let) ITERATIVELY,
  // accumulating each link's straight-line statements, then advance to the body.
  // The recursive form (each visitor method calling compile-aexpr-async on its
  // body) overflows the JS stack on deep straight-line programs; the cont backend
  // is iterative for the same reason. The emitted statement sequence is identical
  // to the per-node visitor logic below (aLet/aArrLet/aVar/aSeq/aTypeLet/aLettable),
  // so byte-parity is preserved. Only the tail lettable and each RHS lettable (which
  // are bounded in depth) recurse, via compile-lettable-async.
  let acc: CList<J.JStmt> = clEmpty;
  let cur: N.AExpr = e;
  // FewSuspend (dossier B.3): a chain link whose RHS contains a capturing
  // suspend site -- or whose bind annotation check suspends -- switches to
  // CONTINUATION-THUNK emission: the rest of the chain is compiled ONCE
  // through memoized thunks, so the suspend site's resume closure (built by
  // fewSuspendSite from compiler.rest) and the walker's own fall-through
  // emission ALIAS the same statement nodes. Each memoized part is emitted
  // exactly once in its natural lexical position (a suspend inside ONE
  // branch of an RHS a-if aliases the join statements that the walker emits
  // once AFTER the jIf, which the suspend-free branch falls through to).
  // Links without capturing sites keep the iterative fast path, so thunk
  // recursion depth is bounded by the verdict (S <= 2, B <= 1), never by
  // chain length.
  const fs = compiler.fnTier === 'few-suspend';
  while (true) {
    switch (cur.$name) {
      case 'a-let': {
        const b = cur.bind;
        // Inline marker (-inline-comments, set by the ANF inliner): render as a
        // `// inlined: <callee>` comment and emit no binding -- the value (callee name)
        // is read here and the never-referenced binder is dropped.
        if (b.id instanceof A.SAtom && b.id.base === INLINE_MARKER_BASE) {
          const callee = (cur.e instanceof N.AVal && (cur.e as any).v instanceof N.AStr) ? (cur.e as any).v.s : 'fn';
          acc = clAppend(acc, clSing<J.JStmt>(jExpr(jRawCode('// inlined: ' + callee))));
          cur = cur.body;
          continue;
        }
        const bindComplete = (v: J.JExprT): CList<J.JStmt> => clSing(jExpr(jAssign(jsIdOf(b.id), v)));
        const rhsTco = rhsIsTcoContinue(compiler, cur.e);
        if (fs && !rhsTco
          && (annSuspends(compiler, b) || lettableHasCapturingSite(compiler, cur.e))) {
          const outer = compiler;
          const bodyExpr = cur.body;
          // Local continuation parts, each memoized and emitted exactly once
          // below; the RHS's site emitters see the composition (ann check ++
          // rest-of-chain ++ outer rest) as compiler.rest.
          const contThunk = memoStmts(() => compileAexprAsync(outer, bodyExpr));
          const annStmts = annSuspends(outer, b)
            ? memoStmts(() => fewSuspendAnnCheck(outer, b,
              () => clAppend(contThunk(), outer.rest())))
            : memoStmts(() => annCheckStmts(outer, b));
          const restForRhs = (): CList<J.JStmt> =>
            clAppend(annStmts(), clAppend(contThunk(), outer.rest()));
          const eStmts = compileLettableAsync(ext(compiler, {
            complete: bindComplete, tailPos: false, curLetBind: new BLet(b), rest: restForRhs,
          }), cur.e);
          acc = clAppend(acc, clCons(jVar(jsIdOf(b.id), UNDEFINED) as J.JStmt, eStmts));
          // The continuation, emitted ONCE here; a resume closure built
          // inside the RHS holds these same (aliased) statement nodes.
          return clAppend(acc, clAppend(annStmts(), contThunk()));
        }
        const eStmts = compileLettableAsync(ext(compiler, { complete: bindComplete, tailPos: false, curLetBind: new BLet(b) }), cur.e);
        acc = clAppend(acc, clCons(jVar(jsIdOf(b.id), UNDEFINED) as J.JStmt, eStmts));
        if (!rhsTco) {
          acc = clAppend(acc, annCheckStmts(compiler, b));
        }
        cur = cur.body;
        continue;
      }
      case 'a-arr-let': {
        const b = cur.bind;
        const idx = cur.idx;
        const bindComplete = (v: J.JExprT): CList<J.JStmt> => clSing(jExpr(jBracketAssign(jId(jsIdOf(b.id)), jNum(idx), v)));
        const rhsTco = rhsIsTcoContinue(compiler, cur.e);
        if (fs && !rhsTco
          && (annSuspends(compiler, b) || lettableHasCapturingSite(compiler, cur.e))) {
          // Same continuation-thunk discipline as a-let (no binder jVar: the
          // destination array already exists).
          const outer = compiler;
          const bodyExpr = cur.body;
          const contThunk = memoStmts(() => compileAexprAsync(outer, bodyExpr));
          const annStmts = annSuspends(outer, b)
            ? memoStmts(() => fewSuspendAnnCheck(outer, b,
              () => clAppend(contThunk(), outer.rest())))
            : memoStmts(() => annCheckStmts(outer, b));
          const restForRhs = (): CList<J.JStmt> =>
            clAppend(annStmts(), clAppend(contThunk(), outer.rest()));
          const eStmts = compileLettableAsync(ext(compiler, {
            complete: bindComplete, tailPos: false, curLetBind: new BArray(b, idx), rest: restForRhs,
          }), cur.e);
          acc = clAppend(acc, eStmts);
          return clAppend(acc, clAppend(annStmts(), contThunk()));
        }
        const eStmts = compileLettableAsync(ext(compiler, { complete: bindComplete, tailPos: false, curLetBind: new BArray(b, idx) }), cur.e);
        acc = clAppend(acc, eStmts);
        if (!rhsTco) {
          acc = clAppend(acc, annCheckStmts(compiler, b));
        }
        cur = cur.body;
        continue;
      }
      case 'a-var': {
        const b = cur.bind;
        const temp = jsIdOf(freshId(compilerName('var_init')));
        const tempComplete = (v: J.JExprT): CList<J.JStmt> => clSing(jExpr(jAssign(temp, v)));
        const varDecl = compiler.unboxedVars.has(b.id.key())
          ? jVar(jsIdOf(b.id), jId(temp))
          : jVar(jsIdOf(b.id), jObj(clist<J.JFieldT>(jField('$var', jId(temp)))));
        if (fs && lettableHasCapturingSite(compiler, cur.e)) {
          // Continuation-thunk discipline for a suspending var-init RHS: the
          // continuation is the var declaration (reading the temp) plus the
          // rest of the chain. No annotation check on a-var binds.
          const outer = compiler;
          const bodyExpr = cur.body;
          const contThunk = memoStmts(() =>
            clCons(varDecl as J.JStmt, compileAexprAsync(outer, bodyExpr)));
          const restForRhs = (): CList<J.JStmt> => clAppend(contThunk(), outer.rest());
          const eStmts = compileLettableAsync(ext(compiler, {
            complete: tempComplete, tailPos: false, curLetBind: undefined, rest: restForRhs,
          }), cur.e);
          acc = clAppend(acc, clCons(jVar(temp, UNDEFINED) as J.JStmt, eStmts));
          return clAppend(acc, contThunk());
        }
        const eStmts = compileLettableAsync(ext(compiler, { complete: tempComplete, tailPos: false, curLetBind: undefined }), cur.e);
        acc = clAppend(acc, clSnoc(clCons(jVar(temp, UNDEFINED) as J.JStmt, eStmts), varDecl as J.JStmt));
        cur = cur.body;
        continue;
      }
      case 'a-seq': {
        const discardComplete = (v: J.JExprT): CList<J.JStmt> => clSing(jExpr(v));
        if (fs && lettableHasCapturingSite(compiler, cur.e1)) {
          const outer = compiler;
          const bodyExpr = cur.e2;
          const contThunk = memoStmts(() => compileAexprAsync(outer, bodyExpr));
          const restForRhs = (): CList<J.JStmt> => clAppend(contThunk(), outer.rest());
          const e1Stmts = compileLettableAsync(ext(compiler, {
            complete: discardComplete, tailPos: false, curLetBind: undefined, rest: restForRhs,
          }), cur.e1);
          acc = clAppend(acc, e1Stmts);
          return clAppend(acc, contThunk());
        }
        const e1Stmts = compileLettableAsync(ext(compiler, { complete: discardComplete, tailPos: false, curLetBind: undefined }), cur.e1);
        acc = clAppend(acc, e1Stmts);
        cur = cur.e2;
        continue;
      }
      case 'a-type-let': {
        const bind = cur.bind;
        if (bind.$name === 'a-type-bind') {
          const compiledAnn = compileAnn(bind.ann, bind.name.toname(), compiler);
          acc = clAppend(acc, clSnoc(compiledAnn.otherStmts, jVar(jsIdOf(bind.name), compiledAnn.exp) as J.JStmt));
        } else if (bind.$name === 'a-newtype-bind') {
          const branderId = jsIdOf(bind.namet);
          acc = clAppend(acc, clist<J.JStmt>(
            jVar(branderId, rtMethod('namedBrander', clist(jStr(bind.name.toname()), compiler.getLoc(bind.l)))),
            jVar(jsIdOf(bind.name), rtMethod('makeBranderAnn', clist<J.JExprT>(jId(branderId), jStr(bind.name.toname()))))));
        } else {
          throw new InternalCompilerError('Unknown ATypeBind in compile-aexpr-async');
        }
        cur = cur.body;
        continue;
      }
      case 'a-lettable':
        return clAppend(acc, compileLettableAsync(compiler, cur.e));
      default:
        throw new InternalCompilerError('Unknown AExpr in compile-aexpr-async: ' + (cur as any).$name);
    }
  }
}

export function annCheckStmts(compiler: CompilerVisitor, b: N.ABind): CList<J.JStmt> {
  // Re-bind `b` to the result of checking its annotation. A non-flat annotation
  // may run a user refinement (async, returns a Promise), so we await it; a flat
  // annotation's _checkAnn is synchronous. The classification (none / tuple /
  // flat / suspend) comes from the SHARED helper FL.annCheckClass -- the same
  // one the tier analysis (tier.ts) uses to decide whether this check is a
  // suspend site -- so analysis and emission can never disagree (a disagreement
  // is `await` in a sync function: a JS syntax error).
  const cls = FL.annCheckClass(b, compiler.flatnessEnv, compiler.typeFlatnessEnv,
    compiler.redundantAnnChecks, compiler.moduleBindings, compiler.env);
  switch (cls) {
    case 'none':
      // Blank/any, or the type-flow analysis proved the value is already `⊑ T`:
      // no check to emit. The value is already bound to b.id (the elided check
      // would only have re-bound the identical, brand-verified value).
      return clEmpty;
    case 'tuple-shape':
      // A tuple-destructuring bind with no field annotations: just check the tuple
      // shape/length (checkTupleBind raises "bad-tuple-bind"). This mirrors the cont
      // backend; the general tuple-ann _checkAnn gives a different ("annotation")
      // error that a few tests pin on.
      return clSing(jExpr(rtMethod('checkTupleBind',
        clist(jId(jsIdOf(b.id)), jNum((b.ann as A.ATuple).fields.length), compiler.getLoc((b.ann as any).l)))));
    default: {
      const ca = compileAnn(b.ann, undefined, compiler);
      const checkCall = rtMethod('_checkAnn',
        clist(compiler.getLoc(annLoc(b.ann)), ca.exp, jId(jsIdOf(b.id))));
      if (cls === 'suspend' && compiler.fnTier === 'gen-fast') {
        // Fast form: a suspending check bails (the value is already bound
        // to b.id; the machine discards the resumed result, dest -1).
        const t = freshId(compilerName('chk'));
        return clAppend(ca.otherStmts, clist<J.JStmt>(
          jVar(t, checkCall),
          jIf1(jIsThenable(t), jBlock1(jReturn(vmBailExpr(compiler, b, jId(t), 'ann check of ' + b.id.toname())))),
          jExpr(jAssign(jsIdOf(b.id), jId(t)))));
      }
      const checked = cls === 'flat' ? checkCall : jAwait(checkCall);
      return clSnoc(ca.otherStmts, jExpr(jAssign(jsIdOf(b.id), checked)));
    }
  }
}

export function argsOtherStmts(argCes: DAG.CExp[]): CList<J.JStmt> {
  let acc: CList<J.JStmt> = clEmpty;
  for (const ac of argCes) { acc = clAppend(acc, ac.otherStmts); }
  return acc;
}

export function compileAppAsync(compiler: CompilerVisitor, l: Loc, f: N.AVal, args: N.AVal[], appInfo: A.AppInfo): CList<J.JStmt> {
  const isSafeId = N.isAId(f) || N.isAIdSafeLetrec(f);
  // is-flat must agree with the flatness analysis (flatness.ts), which decides
  // whether the enclosing function is emitted sync (j-fun) or async (j-async-fun).
  // If they disagree we either emit `await` inside a sync function (a JS syntax
  // error) or fail to await a Promise. Resolve via the SAME helper the analysis
  // uses (getAppFunFlatness) so they can never disagree. This subsumes the
  // module-ref path and the s-global env fallback for weakened operators
  // (`_plus_nums`), which are flat globals not bound in sd.
  const isFlat = (isSafeId || N.isAIdModref(f))
    ? isFlatEnough(FL.getAppFunFlatness(f, compiler.flatnessEnv, compiler.moduleBindings, compiler.env))
    : false;
  // A flat global (incl. a weakened `_plus_nums`) is known to be a function, so the
  // dynamic isFunction guard can be skipped along with the await.
  const isFn = isSafeId && (isIdFnName(compiler.flatnessEnv, (f as any).id.key())
    || (!compiler.flatnessEnv.has((f as any).id.key()) && A.isSGlobal((f as any).id) && isFlat));
  const fCe = f.visit(compiler) as DAG.CExp;
  const argCes = args.map((a) => a.visit(compiler) as DAG.CExp);
  const compiledArgs = CL.map_list(getExp, argCes);
  const pre = clAppend(fCe.otherStmts, argsOtherStmts(argCes));
  // TCO-ness is decided by the ANF's `app-info.is-tail` (the authoritative tail
  // analysis the cont backend also trusts), NOT by the syntactic `compiler.tail-pos`
  // flag. They diverge for the return-annotation pattern: `fun f(...) -> T:` desugars
  // the tail self-call into `let ans = f(...) in _checkAnn(T, ans)`, so the call is
  // let-bound (tail-pos = false) yet still app-info.is-tail = true. Gating on tail-pos
  // there wrongly defeated TCO -> the self-call awaited+accumulated an async frame per
  // level, so a deep annotated tail loop went O(n) heap (slow, and OOM at ~20M deep).
  // `continue` skips the per-iteration _checkAnn, which is sound: the returned value is
  // the base case's already-checked value (cont's trampoline skips it identically).
  // in-tco-loop ensures the `while(true)` continue-target exists.
  // The TCO predicate itself is the SHARED helper TIER.isTcoSelfApp (also
  // used by the tier analysis to classify the site); in-tco-loop additionally
  // ensures the `while(true)` continue-target exists.
  const isTco = compiler.inTcoLoop &&
    TIER.isTcoSelfApp(appInfo, compiledArgs.length(), compiler.args.length,
      compiler.allowTco, compiler.options.properTailCalls);
  if (isTco) {
    // Explicit-loop tail-call optimization: rebind formals and loop.
    const argsList = map2((name: A.Name, exp: J.JExprT) => jAssign(name, exp) as J.JExprT, compiler.args, compiledArgs.toList());
    const [asgnPre, asgnPost] = getAssignments(argsList, argsList.length);
    return clAppend(pre, clSnoc(CL.from_list<J.JStmt>([...asgnPre, ...asgnPost]), jContinue));
  } else {
    const fnCheck: CList<J.JStmt> = isFn ? clEmpty : clSing(checkFun(l, compiler.getLoc(l), fCe.exp));
    // Safe-for-space tail call: in genuine tail position (complete-return), inside a
    // token-producing async body, calling a non-flat callee, mint a bounce token
    // instead of `return await f.app(...)`. The nearest driver (the public `.app`
    // wrapper, installed by makeTailFunction) pumps it — O(1) heap for mutual /
    // higher-order / cross-module tail recursion. A flat callee can't recurse deeply
    // (bounded), so we keep its cheap direct return and don't force a driver. The
    // token references the callee VALUE (f-ce.exp), whose `appBody` the driver calls.
    const mintToken = compiler.mintsTokens && compiler.tailPos && !isFlat;
    if (mintToken) {
      compiler.tokenCell.set('minted', true);
      const token = rtMethod('tailCall', clist<J.JExprT>(fCe.exp, jList(false, compiledArgs)));
      return clAppend(pre, clAppend(fnCheck, clSing(jReturn(token))));
    } else if (isFlat || ((compiler.fnTier === 'tail-flat' || compiler.fnTier === 'few-suspend' || compiler.fnTier === 'gen-fast') && compiler.tailPos)) {
      // Flat callee: direct call, no await. Sync tier (TailFlat/FewSuspend),
      // tail position: the callee's result (flat value OR thenable) is
      // RETURNED DIRECTLY -- the Awaitable ABI permits both, the caller's
      // conditional await handles either, and every intermediate sync tail
      // frame returns the SAME promise, so a suspended tail chain collapses
      // to O(1) heap. This direct return IS the bounce: tokens are subsumed
      // (mintsTokens is forced false for both tiers in compileFunBody, so
      // the mint branch above can never fire here). Keyed on
      // compiler.fnTier -- the node-identity tier verdict, installed
      // unconditionally at every compileFunBody entry, never inherited
      // across a function boundary. (The tier walk counts these tail sites
      // as non-capturing -- the ref's pattern C, zero capture.)
      const callBase = app(l, fCe.exp, compiledArgs);
      return clAppend(pre, clAppend(fnCheck, compiler.complete(callBase)));
    } else if (compiler.fnTier === 'few-suspend') {
      // FewSuspend capturing site: guarded return-then with the sync path
      // falling through; the resume closure is the ANF continuation (see
      // fewSuspendSite / the compileAexprAsync continuation thunks).
      const callBase = app(l, fCe.exp, compiledArgs);
      const t = freshId(compilerName('app'));
      return clAppend(pre, clAppend(fnCheck, fewSuspendSite(compiler, t, callBase)));
    } else if (compiler.fnTier === 'gen-fast') {
      // Fast form of a bytecode function: bail out to the machine on a
      // thenable (see fastSite); the site is the a-app node itself.
      const callBase = app(l, fCe.exp, compiledArgs);
      const t = freshId(compilerName('app'));
      return clAppend(pre, clAppend(fnCheck, fastSite(compiler, t, callBase, compiler.curSiteNode, 'app at ' + l.key())));
    } else {
      // Conditional await (see callAndMaybeAwait): skip the microtask when the
      // callee returned a flat value synchronously; still await real thenables.
      const callBase = app(l, fCe.exp, compiledArgs);
      const t = freshId(compilerName('app'));
      return clAppend(pre, clAppend(fnCheck,
        clAppend(callAndMaybeAwait(t, callBase), compiler.complete(jId(t)))));
    }
  }
}

export function compileMethodAppAsync(compiler: CompilerVisitor, l: Loc, obj: N.AVal, methname: string, args: N.AVal[], node?: N.AMethodApp): CList<J.JStmt> {
  const objCe = obj.visit(compiler) as DAG.CExp;
  const argCes = args.map((a) => a.visit(compiler) as DAG.CExp);
  const compiledArgs = CL.map_list(getExp, argCes);
  const pre = clAppend(objCe.otherStmts, argsOtherStmts(argCes));
  const argcount = compiledArgs.length();
  const helperName = argcount <= 7 ? 'maybeMethodCall' + String(argcount) : 'maybeMethodCall';
  const compiledObj = objCe.exp;
  // A method call proven flat dispatches to a synchronous method, so it returns a
  // value directly (never a thenable). Emit a direct call with NO conditional await
  // -- required for correctness when this sits in a now-synchronous function (a sync
  // function cannot `await`), and it also avoids the isThenable check and never mints
  // a tail token (the call is bounded). maybeMethodCall still does the dynamic
  // dispatch; only the await is elided.
  const isFlatMeth = node !== undefined && compiler.flatMethodApps.has(node);
  // Sync tier (TailFlat/FewSuspend), tail position: the method call's result
  // (value or thenable) is returned DIRECTLY -- the Awaitable ABI analogue of
  // the compileAppAsync tail direct return (see there). Must cover BOTH the
  // direct-dispatch arm and the maybeMethodCall funnel arm below; a missed
  // arm would emit a residual await in a sync body, which the O7 assertion
  // turns into an InternalCompilerError at compile time.
  const tailDirect = (compiler.fnTier === 'tail-flat' || compiler.fnTier === 'few-suspend' || compiler.fnTier === 'gen-fast') && compiler.tailPos;
  // FewSuspend, non-tail non-flat: every method-app shape below funnels into
  // ONE guarded suspend site (fewSuspendSite).
  const fewSusp = compiler.fnTier === 'few-suspend' && !tailDirect && !isFlatMeth;
  // Gen-fast: likewise one bailout site per method app (fastSite).
  const genFast = compiler.fnTier === 'gen-fast' && !tailDirect && !isFlatMeth;
  // Direct method dispatch (de-funnelled): `obj.dict["m"].full_meth(obj, args)`
  // instead of `maybeMethodCall(obj, "m", ...)`. Fires when type-flow proved the
  // receiver is a data value on which `m` is a genuine method (node.directMethod),
  // so we skip the getColonFieldLoc/isMethod/isFunction funnel and give V8 a
  // per-site constant-key call it can build an IC for. Handles every non-tail
  // shape uniformly (flat -> no await; else conditional await); the safe-for-space
  // tail-token path below still routes through maybeMethodTail.
  if (node !== undefined && node.directMethod && !(compiler.mintsTokens && compiler.tailPos)) {
    let objExpr = compiledObj;
    let preDecls: CList<J.JStmt> = clEmpty;
    if (!J.isJId(compiledObj)) {
      const objId = freshId(compilerName('obj'));
      preDecls = clSing<J.JStmt>(jVar(objId, compiledObj));
      objExpr = jId(objId);
    }
    const call = wrapWithSrcnode(l, directMethodDispatch(objExpr, methname, compiledArgs));
    if (isFlatMeth || tailDirect) {
      // Flat method: no await. Sync-tier tail position: direct return.
      return clAppend(pre, clAppend(preDecls, compiler.complete(call)));
    }
    const t = freshId(compilerName('mans'));
    if (fewSusp) {
      // FewSuspend capturing site (direct-dispatch shape).
      return clAppend(pre, clAppend(preDecls, fewSuspendSite(compiler, t, call)));
    }
    if (genFast) {
      return clAppend(pre, clAppend(preDecls, fastSite(compiler, t, call, node, 'method app .' + methname + ' at ' + l.key())));
    }
    return clAppend(pre, clAppend(preDecls, clAppend(callAndMaybeAwait(t, call), compiler.complete(jId(t)))));
  }
  if (isFlatMeth || tailDirect) {
    // Funnel arm (flat method-app, or TailFlat tail direct return). The
    // non-JId receiver is normalized to a temp here, so the two-armed
    // raw-await fallback at the bottom is never reached from a sync tier's
    // tail position.
    let objExpr = compiledObj;
    let preDecls: CList<J.JStmt> = clEmpty;
    if (!J.isJId(compiledObj)) {
      const objId = freshId(compilerName('obj'));
      preDecls = clSing<J.JStmt>(jVar(objId, compiledObj));
      objExpr = jId(objId);
    }
    const call = wrapWithSrcnode(l,
      rtMethod(helperName,
        clAppend(clist<J.JExprT>(objExpr, jStr(methname), compiler.getLoc(l)), compiledArgs)));
    return clAppend(pre, clAppend(preDecls, compiler.complete(call)));
  }
  if (compiler.mintsTokens && compiler.tailPos) {
    // Safe-for-space tail call THROUGH a method: mint a token instead of driving.
    // maybeMethodTail resolves obj.methname (obj evaluated once, as a single arg)
    // and returns a TailMethodCall (method field) or TailCall (function field);
    // the nearest driver pumps it. Same gate as compile-app-async, and it records
    // the mint so the enclosing closure/method gets a driving wrapper.
    compiler.tokenCell.set('minted', true);
    const token = wrapWithSrcnode(l,
      rtMethod('maybeMethodTail',
        clAppend(clist<J.JExprT>(compiledObj, jStr(methname), compiler.getLoc(l)), compiledArgs)));
    return clAppend(pre, clSing(jReturn(token)));
  } else if (J.isJId(compiledObj) || fewSusp || genFast) {
    // Funnel arm. FewSuspend NORMALIZES a non-JId receiver to a temp here
    // (the same preDecls pattern as the flat/tail-direct arm above), so the
    // two-armed raw-await fallback below is never reached from a sync tier:
    // ONE guarded suspend site instead of two awaits inside a jIf (the ref
    // counted that shape as 2 suspends + 1 branch; the fresh design and the
    // tier walk both make it 1 site -- dossier B.3).
    let objExpr = compiledObj;
    let preDecls: CList<J.JStmt> = clEmpty;
    if (!J.isJId(compiledObj)) {
      const objId = freshId(compilerName('obj'));
      preDecls = clSing<J.JStmt>(jVar(objId, compiledObj));
      objExpr = jId(objId);
    }
    const call = wrapWithSrcnode(l,
      rtMethod(helperName,
        clAppend(clist<J.JExprT>(objExpr, jStr(methname), compiler.getLoc(l)), compiledArgs)));
    // Conditional await: a flat (synchronous) method returns a value directly;
    // only a suspending method returns a thenable. See callAndMaybeAwait.
    const t = freshId(compilerName('mans'));
    if (fewSusp) {
      // FewSuspend capturing site (funnel shape).
      return clAppend(pre, clAppend(preDecls, fewSuspendSite(compiler, t, call)));
    }
    if (genFast) {
      return clAppend(pre, clAppend(preDecls, fastSite(compiler, t, call, node, 'method app .' + methname + ' at ' + l.key())));
    }
    return clAppend(pre, clAppend(callAndMaybeAwait(t, call), compiler.complete(jId(t))));
  } else {
    const objId = freshId(compilerName('obj'));
    const fieldId = freshId(compilerName('field'));
    const ansId = freshId(compilerName('mans'));
    const colonField = rtMethod('getColonFieldLoc', clist(jId(objId), jStr(methname), compiler.getLoc(l)));
    const checkMethod = rtMethod('isMethod', clist<J.JExprT>(jId(fieldId)));
    const branch = jIf(checkMethod,
      jBlock1(jExpr(jAssign(ansId,
        jAwait(jApp(jDot(jId(fieldId), 'full_meth'), clCons(jId(objId), compiledArgs)))))),
      jBlock(clist<J.JStmt>(
        checkFun(l, compiler.getLoc(l), jId(fieldId)),
        jExpr(jAssign(ansId, jAwait(wrapWithSrcnode(l, app(l, jId(fieldId), compiledArgs))))))));
    const decls = clist<J.JStmt>(jVar(objId, compiledObj), jVar(fieldId, colonField), jVar(ansId, UNDEFINED));
    return clAppend(pre, clAppend(decls, clCons(branch as J.JStmt, compiler.complete(jId(ansId)))));
  }
}

export function compileUpdateAsync(compiler: CompilerVisitor, l: Loc, obj: N.AVal, fields: N.AField[]): CList<J.JStmt> {
  const objCe = obj.visit(compiler) as DAG.CExp;
  const fieldCes = fields.map((fld) => fld.value.visit(compiler) as DAG.CExp);
  const pre = clAppend(objCe.otherStmts, argsOtherStmts(fieldCes));
  const fieldNames = CL.map_list((fld: N.AField) => jStr(fld.name) as J.JExprT, fields);
  const fieldLocs = CL.map_list((fld: N.AField) => compiler.getLoc(fld.l), fields);
  const fieldVals = CL.map_list(getExp, fieldCes);
  const call = rtMethod('checkRefAnns',
    clist(
      objCe.exp,
      jList(false, fieldNames),
      jList(false, fieldVals),
      jList(false, fieldLocs),
      compiler.getLoc(l),
      compiler.getLoc(obj.l)));
  if (compiler.fnTier === 'few-suspend') {
    // FewSuspend capturing site: checkRefAnns may run user refinement code
    // (always a suspend site in the tier walk); same guarded form.
    const t = freshId(compilerName('upd'));
    return clAppend(pre, fewSuspendSite(compiler, t, call));
  }
  if (compiler.fnTier === 'gen-fast') {
    const t = freshId(compilerName('upd'));
    return clAppend(pre, fastSite(compiler, t, call, compiler.curSiteNode, 'update at ' + l.key()));
  }
  return clAppend(pre, compiler.complete(jAwait(call)));
}

// Direct-cases optimization: resolve a cases `typ` annotation to the scrutinee's
// data type so the matched branch can read fields by their statically-known names.
// Returns undefined (=> fall back to the reflective codegen) for anything we can't
// resolve to concrete in-scope variant metadata. Wrapped in a try/catch so a
// resolution miss can never break compilation -- it just disables the opt locally.
function resolveCasesDataType(compiler: CompilerVisitor, typ: A.Ann): T.DataType | undefined {
  try {
    // The field LAYOUT is invariant under parametric instantiation and predicate
    // refinement, so peel those wrappers off to reach the underlying type name.
    let ann: A.Ann = typ;
    while (true) {
      if (A.isAApp(ann)) { ann = ann.ann; continue; }
      if (A.isAPred(ann)) { ann = ann.ann; continue; }
      break;
    }
    let uri: string | undefined;
    let origName: string | undefined;
    if (A.isAName(ann)) {
      const tb = compiler.typeBindings.get(ann.id.key());
      if (tb !== undefined) {
        uri = tb.origin.uriOfDefinition;
        origName = tb.origin.originalName.toname();
      } else {
        // Global (built-in) type names (e.g. List, Option) may not have a
        // type-binding in untyped programs; consult the global type origins.
        const o = compiler.env.originByTypeName(ann.id.toname());
        if (o !== undefined) { uri = o.uriOfDefinition; origName = o.originalName.toname(); }
      }
    } else if (A.isADot(ann)) {
      const mb = compiler.moduleBindings.get(ann.obj.key());
      if (mb !== undefined) { uri = mb.uri; origName = ann.field; }
    }
    if (uri === undefined || origName === undefined) { return undefined; }
    return lookupDataTypeByUri(compiler, uri, origName);
  } catch (_e) {
    return undefined;
  }
}

function lookupDataTypeByUri(compiler: CompilerVisitor, uri: string, name: string): T.DataType | undefined {
  // The module currently being compiled is not in env.allModules yet, so its own
  // data types must be looked up in the local provides.
  const de: CS.DataExport | undefined =
    uri === compiler.uri ? compiler.localDataDefs.get(name) : compiler.env.datatypeByUri(uri, name);
  if (de === undefined) { return undefined; }
  if (CS.isDAlias(de)) {
    if (de.origin.uriOfDefinition === uri) { return undefined; }
    return lookupDataTypeByUri(compiler, de.origin.uriOfDefinition, de.name);
  }
  return (de as CS.DType).typ;
}

export function compileCasesBranchAsync(compiler: CompilerVisitor, valId: A.Name, branch: N.ACasesBranch, casesLoc: Loc, dataType?: T.DataType): CList<J.JStmt> {
  // When the scrutinee's data type is statically known, find this branch's variant
  // and (for a normal branch) confirm its arity matches the pattern. If so we can
  // read fields directly by name and skip the runtime arity check (the $name switch
  // already committed to this variant, and the scrutinee is proven to be of the
  // cases type, so $arity always equals branch.args.length here).
  let directVariant: T.TVariant | undefined;
  let elideArity = false;
  if (dataType !== undefined) {
    const v = dataType.getVariant(branch.name);
    if (N.isACasesBranch(branch)) {
      if (v !== undefined && v.$name === 't-variant' && v.fields.length === branch.args.length) {
        directVariant = v;
        elideArity = true;
      }
    } else if (v !== undefined && v.$name === 't-singleton-variant') {
      // Singleton branch on a statically-known singleton variant: $arity is always
      // -1, so the singleton arity check never fires.
      elideArity = true;
    }
  }
  const preamble = casesPreamble(compiler, jId(valId), branch, casesLoc, elideArity);
  let bodyStmts: CList<J.JStmt>;
  if (N.isACasesBranch(branch)) {
    let fieldStmts: CList<J.JStmt>;
    if (directVariant !== undefined) {
      // Static field access: cases_val.dict["name"] with a statically-known field
      // name + mutability, dropping the $constructor.$fieldNames / $mut_fields_mask
      // reflection. derefField is elided entirely for plain immutable, non-ref
      // fields (where it is a no-op); kept (with static flags) for ref/mutable.
      fieldStmts = CL.map_list_n((i: number, arg: N.ACasesBind) => {
        const [fname, ftype] = directVariant!.fields[i];
        const isRefField = ftype.$name === 't-ref';
        const lookupIsRef = A.isSCasesBindRef(arg.fieldType);
        const field = getDictField(jId(valId), jStr(fname));
        const rhs = (!isRefField && !lookupIsRef)
          ? field
          : rtMethod('derefField', clist(field, jBool(isRefField), jBool(lookupIsRef)));
        return jVar(jsIdOf(arg.bind.id), rhs) as J.JStmt;
      }, 0, (branch as N.ACasesBranch$).args);
    } else {
      const fieldNames = freshId(compilerName('fn'));
      const getFieldNames = jVar(fieldNames, jDot(jDot(jId(valId), '$constructor'), '$fieldNames'));
      const derefFields = CL.map_list_n((i: number, arg: N.ACasesBind) => {
        const mask = jBracket(jDot(jId(valId), '$mut_fields_mask'), jNum(i));
        const field = getDictField(jId(valId), jBracket(jId(fieldNames), jNum(i)));
        return jVar(jsIdOf(arg.bind.id),
          rtMethod('derefField', clist(field, mask, jBool(A.isSCasesBindRef(arg.fieldType))))) as J.JStmt;
      }, 0, (branch as N.ACasesBranch$).args);
      fieldStmts = clCons(getFieldNames as J.JStmt, derefFields);
    }
    let annStmts: CList<J.JStmt> = clEmpty;
    for (const arg of (branch as N.ACasesBranch$).args) {
      annStmts = clAppend(annStmts, annCheckStmts(compiler, arg.bind));
    }
    bodyStmts = clAppend(fieldStmts,
      clAppend(annStmts, compileAexprAsync(compiler, branch.body)));
  } else {
    bodyStmts = compileAexprAsync(compiler, branch.body);
  }
  return clAppend(preamble, bodyStmts);
}

export function compileCasesAsync(compiler: CompilerVisitor, casesLoc: Loc, typ: A.Ann, val: N.AVal, branches: N.ACasesBranch[], _else: N.AExpr): CList<J.JStmt> {
  const valCe = val.visit(compiler) as DAG.CExp;
  const valId = freshId(compilerName('cases_val'));
  // Resolve the cases type to concrete variant metadata for direct field access
  // (promise backend; -no-direct-cases turns it off). undefined => reflective path.
  //
  // Soundness rests on the scrutinee being guaranteed of type `typ` at the matched
  // branch, so that `typ`'s static field names match the value's own. That guarantee
  // comes from EITHER the type checker (static proof) OR the scrutinee's runtime
  // _checkAnn. The latter is defeated by -no-runtime-annotations (makes _checkAnn a
  // no-op) and -no-user-annotations (strips the ann entirely), so require type-check
  // or both annotation mechanisms intact. Otherwise fall back to the reflective path
  // (which reads the value's OWN $fieldNames and so is correct regardless).
  const valueIsTyped = compiler.options.typeCheck ||
    (compiler.options.runtimeAnnotations && compiler.options.userAnnotations);
  const dataType = (compiler.options.directCases && valueIsTyped)
    ? resolveCasesDataType(compiler, typ) : undefined;
  const branchCases = CL.map_list((branch: N.ACasesBranch) =>
    jCase(jStr(branch.name),
      jBlock(clSnoc(compileCasesBranchAsync(compiler, valId, branch, casesLoc, dataType), jBreak))) as J.JCaseT, branches);
  const elseCase = jDefault(jBlock(clSnoc(compileAexprAsync(compiler, _else), jBreak)));
  const theSwitch = jSwitch(jDot(jId(valId), '$name'), clSnoc(branchCases, elseCase as unknown as J.JCaseT));
  return clAppend(valCe.otherStmts,
    clist<J.JStmt>(
      jExpr(jAssign(compiler.curApploc, compiler.getLoc(casesLoc))),
      jVar(valId, valCe.exp),
      theSwitch));
}

export function compileLettableAsync(compiler0: CompilerVisitor, e: N.ALettable): CList<J.JStmt> {
  // Compile a lettable in tail-with-completion style: the final value flows to
  // `compiler.complete`. Control-flow lettables push the completion into their
  // sub-expressions so no join point / trampoline case is needed.
  // Gen-fast: the lettable node is the suspend-site key its emitter needs.
  const compiler = compiler0.fnTier === 'gen-fast' ? ext(compiler0, { curSiteNode: e }) : compiler0;
  switch (e.$name) {
    case 'a-app':
      return compileAppAsync(compiler, e.l, e._fun, e.args, e.appInfo);
    case 'a-method-app':
      return compileMethodAppAsync(compiler, e.l, e.obj, e.meth, e.args, e);
    case 'a-prim-app': {
      const argCes = e.args.map((a) => a.visit(compiler) as DAG.CExp);
      const call = wrapWithSrcnode(e.l, rtMethod(e.f, CL.map_list(getExp, argCes)));
      if (e.appInfo.needsStep) {
        // Conditional await: skip the microtask when the prim returned a flat
        // value synchronously; still await a real thenable. See callAndMaybeAwait.
        const t = freshId(compilerName('prim'));
        if (compiler.fnTier === 'few-suspend') {
          // FewSuspend capturing site. needsStep prims capture even in tail
          // position (the tier walk counts them so -- the pattern-C tail
          // direct return covers only a-app/a-method-app; relaxing that must
          // land together with its emission, or verdict/emission drift).
          return clAppend(argsOtherStmts(argCes), fewSuspendSite(compiler, t, call));
        }
        if (compiler.fnTier === 'gen-fast') {
          return clAppend(argsOtherStmts(argCes), fastSite(compiler, t, call, e, 'prim ' + e.f + ' at ' + e.l.key()));
        }
        return clAppend(argsOtherStmts(argCes), clAppend(callAndMaybeAwait(t, call), compiler.complete(jId(t))));
      }
      return clAppend(argsOtherStmts(argCes), compiler.complete(call));
    }
    case 'a-if': {
      const condCe = e.c.visit(compiler) as DAG.CExp;
      const test = rtMethod('checkPyretTrue', clist(condCe.exp));
      const theIf = jIf(test,
        jBlock(compileAexprAsync(compiler, e.t)),
        jBlock(compileAexprAsync(compiler, e.e)));
      return clSnoc(condCe.otherStmts, theIf as J.JStmt);
    }
    case 'a-cases':
      return compileCasesAsync(compiler, e.l, e.typ, e.val, e.branches, e._else);
    case 'a-update':
      return compileUpdateAsync(compiler, e.l, e.supe, e.fields);
    case 'a-lam': {
      // Lambdas are lifted to let-RHS by ANF; use the enclosing binding (if any)
      // for the flatness lookup that decides sync vs async emission. The node
      // itself is passed for the node-identity tier-map lookup.
      const ce = compileALam(compiler, e, e.l, e.name, e.args, e.ret, e.body, compiler.curLetBind);
      return clAppend(ce.otherStmts, compiler.complete(ce.exp));
    }
    default: {
      const ce = e.visit(compiler) as DAG.CExp;
      return clAppend(ce.otherStmts, compiler.complete(ce.exp));
    }
  }
}

export function compileFunBody(
  l: Loc,
  step: A.Name,
  _funName: A.Name,
  compiler: CompilerVisitor,
  args: N.ABind[],
  optArity: number | undefined,
  body: N.AExpr,
  _shouldReportErrorFrame: boolean,
  isFlat: boolean,
  isMethod: boolean,
  canMintTokens: boolean,
  // The function's tier verdict ('async' = the legacy -no-gen-functions
  // emission path and the toplevel module fn, which is never in the tier
  // map). Inside this function it carries the tier pass's allowTco (below);
  // the CALLERS key their emission on it: 'tail-flat' and 'few-suspend'
  // bodies are sync jFuns (see compileALam / aMethod), 'gen' takes the
  // generator+wrapper emission; the fuel form below keys on it too.
  tier: TIER.Tier | 'async' | 'gen-fast' = 'async',
  // Gen tier: when provided, the arity-check statements are NOT emitted into
  // the body but handed back to the caller, which places them in the sync
  // wrapper function (genFunStmts) -- the check reads `arguments.length`,
  // which inside the generator would count the wrapper's fixed-arity
  // forwarding call, never the user's actual argument count.
  arityOut?: { stmts: CList<J.JStmt> },
  // The tier pass's allowTco for this function (verdict.allowTco); undefined
  // on the 'async' path, which computes it via the shared detector below.
  tierAllowTco?: boolean
): J.JBlockT {
  // A formal argument captured by an inner lambda forbids explicit-loop TCO
  // (the loop would clobber the captured binding). The detector itself lives
  // in tier.ts (TIER.argUsedInNestedLambda -- ONE source of truth); when a
  // tier verdict exists it already ran during the tier walk and arrives as
  // tierAllowTco, so only the legacy 'async' path re-runs it here.
  const argUsedInLambda = tier === 'async'
    ? TIER.argUsedInNestedLambda(args, body)
    : !(tierAllowTco as boolean);
  if (argUsedInLambda) {
    compiler = ext(compiler, { allowTco: false });
  }
  const apploc = freshId(compilerName('al'));
  const useLoop = !isFlat && compiler.allowTco && compiler.options.properTailCalls;
  // `mintsTokens` is true exactly when this function is allowed to emit a bounce
  // token at a non-self tail call: it must be a real closure body (canMintTokens
  // — NOT the toplevel module fn or a cases-branch fn, whose results are consumed
  // directly and never driven) AND emitted async (a sync/flat fn can't return a
  // token to its non-awaiting caller without leaking it). `tokenCell` records
  // whether the body actually minted one, so the caller (compile-a-lam) can choose
  // makeTailFunction (driver) vs makeFunction (zero overhead).
  // The sync tiers (TailFlat AND FewSuspend) never mint: a sync body must
  // never return a token to a non-driving caller, and its tail direct return
  // of the callee's (maybe-thenable) result IS the O(1) bounce -- tokens are
  // subsumed. Forcing it here (keyed on the verdict tier) leaves tokenCell
  // untouched, so the callers' maker selection stays makeFunction / makeMethod*.
  const syncTier = tier === 'tail-flat' || tier === 'few-suspend' || tier === 'gen-fast';
  const mintsTokens = canMintTokens && !isFlat && !syncTier;
  const localCompiler: CompilerVisitor = ext(compiler, {
    curStep: step,
    curApploc: apploc,
    args: args.map((a) => a.id).map(jsIdOf),
    complete: completeReturn,
    tailPos: true,
    inTcoLoop: useLoop,
    mintsTokens: mintsTokens,
    curLetBind: undefined,
    // The enclosing function's tier, for the site emitters below a function
    // boundary (tail direct returns, dead-ann-check elision). Installed
    // UNCONDITIONALLY at EVERY compileFunBody entry: since compileALam /
    // aMethod always pass their own node's verdict, a nested function can
    // never inherit an outer function's tier (the ref branch's
    // ext()-inherits-tailFlatMode generator leak stays structurally
    // impossible).
    fnTier: tier,
    // RESET the FewSuspend continuation thunk at EVERY function entry.
    // LANDMINE (risk register H; same shape as the retired ext()-inherits-
    // tailFlatMode bug): `rest` is inheritable compile state on the ext()
    // chain -- if a nested lambda compiled inside an outer function's RHS or
    // continuation ever INHERITED the outer `rest`, its suspend sites would
    // alias the OUTER function's continuation statements into the inner
    // function's resume closures (returning the outer function's values from
    // the inner one). Installing fnExitRest unconditionally here makes that
    // structurally impossible, exactly like fnTier above.
    rest: fnExitRest,
  });
  // Shadow formals, assigned immediately to the "real" arg names (mirrors the
  // cont backend; lets us reassign args for TCO without touching parameters).
  const formalArgs = args.map((arg) => new N.ABind(arg.l, formalShadowName(arg.id), arg.ann));
  const noRealArgs = args[0].id.key() === (compiler.resumer as A.Name).key();
  const copyFormalsToArgs: CList<J.JStmt> =
    noRealArgs ? clEmpty
      : CL.map_list2((formalArg: N.ABind, arg: N.ABind) => jVar(jsIdOf(arg.id), jId(formalArg.id)) as J.JStmt, formalArgs, args);
  let arityStmts: CList<J.JStmt> =
    optArity !== undefined
      ? (noRealArgs ? clEmpty : arityCheck(localCompiler.getLoc(l), optArity, isMethod))
      : clEmpty;
  if (arityOut !== undefined) {
    arityOut.stmts = arityStmts;
    arityStmts = clEmpty;
  }
  const profileEnter: CList<J.JStmt> =
    localCompiler.options.shouldProfile
      ? clSing<J.JStmt>(jExpr(rtMethod('profileEnter', clist(localCompiler.getLoc(l)))))
      : clEmpty;
  // The fast-path fuel check: only await (and unwind the JS stack) when needed.
  // TailFlat (sync) form: the body cannot await, so on fuel exhaustion it
  // RETURNS checkPause().then(re-enter by NAME with the CURRENT argument
  // values) -- the whole suspended sync tail chain unwinds by returning the
  // same promise through every frame (the O(1) bounce), and the .then
  // re-enters this function once fuel is restored (needsPause() already
  // consumed the fuel, so the re-entered call proceeds). The check sits at
  // the TOP of the `while(true)` TCO loop body, so re-entry reads the REAL
  // arg vars, which the explicit loop reassigns -- a mid-loop pause resumes
  // with the loop's current values, not the original call's. Re-entry
  // re-runs the (idempotent) arity and arg-annotation checks. The self-name
  // binding works because the emitted jFun is a NAMED function expression
  // (makeFunName is deterministic per (uri, loc), so this name and the
  // caller-side jFun name agree).
  const reEnterArgs: CList<J.JExprT> = noRealArgs
    ? CL.map_list((fa: N.ABind) => jId(fa.id) as J.JExprT, formalArgs)
    : CL.from_list(args.map((a) => jId(jsIdOf(a.id)) as J.JExprT));
  // Gen-fast: on fuel exhaustion, bail to the machine at pc 0 (function
  // entry: the arg contracts re-run there, exactly as the sync tiers'
  // re-entry by name re-runs them) with the CURRENT argument values -- the
  // explicit-loop TCO reassigns them, so a mid-loop pause resumes the loop's
  // current iteration. Bytecode slots 0..n-1 are the args in order.
  const genFastFuel = (): CList<J.JStmt> => {
    const vf = localCompiler.vmFast;
    if (vf === undefined) { throw new InternalCompilerError('gen-fast body outside a fast-form compile'); }
    const slots = noRealArgs ? [] : args.map((_a, i) => jNum(i) as J.JExprT);
    const vals = noRealArgs ? [] : args.map((a) => jId(jsIdOf(a.id)) as J.JExprT);
    return clSing<J.JStmt>(jIf1(rtMethod('needsPause', clEmpty),
      jBlock1(jReturn(jMethod(rtField('$vm'), 'bail', clist<J.JExprT>(
        jId(VM_PROG_NAME), jNum(vf.idx), jNum(0), jNum(-1), rtMethod('checkPause', clEmpty),
        jList(false, CL.from_list(slots)), jList(false, CL.from_list(vals))))))));
  };
  const fuelCheck: CList<J.JStmt> =
    isFlat ? clEmpty
      : tier === 'gen-fast'
        ? genFastFuel()
      : syncTier
        ? clSing<J.JStmt>(jIf1(rtMethod('needsPause', clEmpty),
          jBlock1(jReturn(jMethod(rtMethod('checkPause', clEmpty), 'then',
            clSing<J.JExprT>(jFun(J.nextJFunId(), '',
              clEmpty as CList<A.Name>,
              jBlock1(jReturn(jApp(jId(constId(makeFunName(localCompiler, l))), reEnterArgs))))))))))
        : clSing<J.JStmt>(jIf1(rtMethod('needsPause', clEmpty),
          jBlock1(jExpr(jAwait(rtMethod('checkPause', clEmpty))))));
  // Argument annotation contracts. Emitted at the top of the loop body so they run
  // on initial entry AND on every explicit-loop TCO re-entry — the cont backend
  // resets step to 0 on a tail self-call, so it re-checks args too (parity). A flat
  // arg ann checks synchronously; a non-flat one awaits (ann-check-stmts gates this
  // on the same flatness verdict that decided this function is sync vs async).
  let annsAndBody: CList<J.JStmt>;
  if (tier === 'few-suspend' && !noRealArgs
    && args.some((arg) => annSuspends(localCompiler, arg))) {
    // FewSuspend: a suspend-class ARG annotation is itself a capturing
    // suspend site whose continuation is "the remaining arg checks plus the
    // whole body". Compile the body FIRST, then fold the checks in REVERSE,
    // so each suspend-class check aliases its (already-compiled)
    // continuation into the resume closure while the sync path falls
    // through to the same statements. Sound inside the while(true) TCO
    // loop: the verdict guarantees no TCO `continue` exists anywhere in the
    // body when such a site exists (tier.ts sets loopUnsafe via the
    // arg-ann capture's contTco), so the aliased continuation is
    // `continue`-free.
    let acc: CList<J.JStmt> = compileAexprAsync(localCompiler, body);
    for (let i = args.length - 1; i >= 0; i--) {
      const arg = args[i];
      if (annSuspends(localCompiler, arg)) {
        const contHere = acc;
        acc = clAppend(fewSuspendAnnCheck(localCompiler, arg, () => contHere), contHere);
      } else {
        acc = clAppend(annCheckStmts(localCompiler, arg), acc);
      }
    }
    annsAndBody = acc;
  } else {
    let argAnnStmts: CList<J.JStmt> = clEmpty;
    if (!noRealArgs) {
      for (const arg of args) {
        argAnnStmts = clAppend(argAnnStmts, annCheckStmts(localCompiler, arg));
      }
    }
    annsAndBody = clAppend(argAnnStmts, compileAexprAsync(localCompiler, body));
  }
  const loopBody = clAppend(fuelCheck, annsAndBody);
  const bodyStmts: CList<J.JStmt> =
    useLoop ? clSing<J.JStmt>(jWhile(jTrue, jBlock(loopBody))) : loopBody;
  const preamble = clAppend(clAppend(profileEnter, arityStmts), copyFormalsToArgs);
  return jBlock(
    clCons(jVar(apploc, localCompiler.getLoc(l)) as J.JStmt,
      clAppend(preamble, bodyStmts)));
}

export function compileAnns(
  visitor: CompilerVisitor,
  step: A.Name,
  binds: N.ABind[],
  entryLabel: J.JExprT
): { newCases: CList<J.JCaseT>; newLabel: J.JExprT } {
  let curTarget = entryLabel;
  let newCases: CList<J.JCaseT> = clEmpty;
  for (const b of binds) {
    if (A.isABlank(b.ann) || A.isAAny(b.ann) || visitor.redundantAnnChecks.has(b.id.key())) {
      // acc unchanged: blank/any, or the type-flow analysis proved `ub ⊑ T`, so
      // no _checkAnn case is added and curTarget (the entry label) is preserved.
    } else if (A.isATuple(b.ann) && b.ann.fields.every((a) => A.isABlank(a) || A.isAAny(a))) {
      const newLabel = visitor.makeLabel();
      const newCase =
        jCase(curTarget,
          jBlock(
            clist<J.JStmt>(
              jExpr(jAssign(step, newLabel)),
              jExpr(jAssign(visitor.curApploc, visitor.getLoc(b.ann.l))),
              jExpr(rtMethod('checkTupleBind', clist(jId(jsIdOf(b.id)), jNum(b.ann.fields.length),
                visitor.getLoc(b.ann.l)))),
              jBreak
            )));
      curTarget = newLabel;
      newCases = clSnoc(newCases, newCase);
    } else if (isFlatEnough(FL.annFlatness(b.ann, visitor.flatnessEnv, visitor.typeFlatnessEnv, visitor.moduleBindings, visitor.env))) {
      const compiledAnn = compileAnn(b.ann, undefined, visitor);
      const newLabel = visitor.makeLabel();
      const newCase = jCase(curTarget,
        jBlock(clAppend(compiledAnn.otherStmts,
          clist<J.JStmt>(
            jExpr(jAssign(step, newLabel)),
            jExpr(jAssign(visitor.curApploc, visitor.getLoc((b.ann as any).l))),
            jExpr(rtMethod('_checkAnn',
              clist(visitor.getLoc((b.ann as any).l), compiledAnn.exp, jId(jsIdOf(b.id))))),
            jBreak))));
      curTarget = newLabel;
      newCases = clSnoc(newCases, newCase);
    } else {
      const annResult = freshId(compilerName('ann-check'));
      const compiledAnn = compileAnn(b.ann, undefined, visitor);
      const newLabel = visitor.makeLabel();
      const newCase = jCase(curTarget,
        jBlock(clAppend(compiledAnn.otherStmts,
          clist<J.JStmt>(
            jExpr(jAssign(step, newLabel)),
            jExpr(jAssign(visitor.curApploc, visitor.getLoc((b.ann as any).l))),
            jVar(annResult, rtMethod('_checkAnn',
              clist(visitor.getLoc((b.ann as any).l), compiledAnn.exp, jId(jsIdOf(b.id))))),
            jIf1(rtMethod('isContinuation', clist<J.JExprT>(jId(annResult))),
              jBlock(clist<J.JStmt>(
                jExpr(jAssign(visitor.curAns, jId(annResult)))))),
            jBreak))));
      curTarget = newLabel;
      newCases = clSnoc(newCases, newCase);
    }
  }
  return { newCases: newCases, newLabel: curTarget };
}

export function compileAnnotatedLet(
  visitor: CompilerVisitor,
  b: BindType,
  compiledE: DAG.CExp,
  compiledBody: DAG.CBlock
): DAG.CBlock {
  let idAssign: CList<J.JStmt>;
  if (isBLet(b)) {
    idAssign = clSing<J.JStmt>(jVar(jsIdOf(b.value.id), compiledE.exp));
  } else if (isBArray(b)) {
    idAssign = clSing<J.JStmt>(jExpr(jBracketAssign(jId(jsIdOf(b.value.id)), jNum(b.idx), compiledE.exp)));
  } else {
    return raise('Unknown ' + (b as any).value.label() + ' in compile-annotated-let');
  }
  const bind = b.value;
  if (A.isABlank(bind.ann) || A.isAAny(bind.ann) || visitor.redundantAnnChecks.has(bind.id.key())) {
    // Blank/any, or the type-flow analysis proved the value is already `⊑ T`:
    // bind the value and continue inline with no _checkAnn (and no extra
    // state-machine label). This is the same shape as a blank annotation.
    return cBlock(
      jBlock(
        clAppend(
          clAppend(
            compiledE.otherStmts,
            idAssign),
          DAG.stmtsOf(compiledBody.block))
      ),
      compiledBody.newCases
    );
  } else if (A.isATuple(bind.ann) && bind.ann.fields.every((a) => A.isABlank(a) || A.isAAny(a))) {
    const step = visitor.curStep;
    const afterAnn = visitor.makeLabel();
    const afterAnnCase = jCase(afterAnn, jBlock(DAG.stmtsOf(compiledBody.block)));
    return cBlock(
      jBlock(
        clAppend(compiledE.otherStmts,
          clAppend(idAssign,
            clist<J.JStmt>(
              jExpr(jAssign(step, afterAnn)),
              jExpr(jAssign(visitor.curApploc, visitor.getLoc(bind.ann.l))),
              jExpr(rtMethod('checkTupleBind', clist(jId(jsIdOf(bind.id)), jNum(bind.ann.fields.length),
                visitor.getLoc(bind.ann.l)))),
              jBreak
            )))),
      clCons(afterAnnCase, compiledBody.newCases));
  } else {
    const step = visitor.curStep;
    const afterAnn = visitor.makeLabel();
    const afterAnnCase = jCase(afterAnn, jBlock(DAG.stmtsOf(compiledBody.block)));
    const compiledAnn = compileAnn(bind.ann, undefined, visitor);
    const annResult = freshId(compilerName('ann-check'));
    return cBlock(
      jBlock(
        clAppend(
          clAppend(
            clAppend(compiledE.otherStmts, idAssign),
            compiledAnn.otherStmts),
          clist<J.JStmt>(
            jExpr(jAssign(step, afterAnn)),
            jExpr(jAssign(visitor.curApploc, visitor.getLoc((bind.ann as any).l))),
            jVar(annResult, rtMethod('_checkAnn',
              clist(visitor.getLoc((bind.ann as any).l), compiledAnn.exp, jId(jsIdOf(bind.id))))),
            jIf1(rtMethod('isContinuation', clist<J.JExprT>(jId(annResult))),
              jBlock(clist<J.JStmt>(
                jExpr(jAssign(visitor.curAns, jId(annResult)))))),
            jBreak
          ))),
      clCons(afterAnnCase, compiledBody.newCases));
  }
}

/*
  Iterative compilation of the ANF "linear spine".

  A long program is one right-nested chain of a-let/a-var/a-seq/...
  bodies, so the natural recursion (each node visiting its body) nests
  one full activation per statement and overflows fixed-size stacks
  (e.g. browsers) on long programs. All functions on the body-recursion
  path are written as generators that `yield` where the recursive code
  visited an AExpr body; runChain drives them with an explicit stack.
  Generators execute the same statements in the same order as the
  recursive formulation, so all side effects (label/name generation,
  dispatch tables) happen in the original order and the generated code
  is identical.
*/
export type ChainYield = { body: N.AExpr; compiler: CompilerVisitor };
export type ChainGen<T> = Generator<ChainYield, T, DAG.CBlock>;

export function* getRemainingCode(
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  body: N.AExpr,
  ans: A.Name
): ChainGen<[J.JBlockT, CList<J.JCaseT>]> {
  let compiledBody: DAG.CBlock = yield { body, compiler };
  if (optDest !== undefined) {
    compiledBody = compileAnnotatedLet(compiler, optDest, cExp(jId(ans), clEmpty), compiledBody);
  }
  return [compiledBody.block, compiledBody.newCases];
}

// Return code for opt-body and the label the caller should jump to after
// their block of code is done
export function* getNewCases(
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  optBody: N.AExpr | undefined,
  ans: A.Name
): ChainGen<[CList<J.JCaseT>, J.JExprT]> {
  if (optBody !== undefined) {
    const preBodyLabel = compiler.makeLabel();
    const [nextBlock, nextCases] = yield* getRemainingCode(compiler, optDest, optBody, ans);
    const remainingCases = clCons(jCase(preBodyLabel, nextBlock) as J.JCaseT, nextCases);
    return [remainingCases, preBodyLabel];
  } else {
    return [clEmpty, compiler.curTarget];
  }
}

export function* compileSplitMethodApp(
  l: Loc,
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  obj: N.AVal,
  methname: string,
  args: N.AVal[],
  optBody: N.AExpr | undefined
): ChainGen<DAG.CBlock> {
  const ans = compiler.curAns;
  const step = compiler.curStep;
  const compiledObj = (obj.visit(compiler) as DAG.CExp).exp;
  const compiledArgs = CL.map_list((a: N.AVal) => (a.visit(compiler) as DAG.CExp).exp, args);

  const argcount = compiledArgs.length();

  const helperName = argcount <= 7 ? 'maybeMethodCall' + String(argcount) : 'maybeMethodCall';

  if (J.isJId(compiledObj)) {
    const call = wrapWithSrcnode(l,
      rtMethod(helperName,
        clAppend(clist<J.JExprT>(compiledObj,
          jStr(methname),
          compiler.getLoc(l)),
        compiledArgs)));
    const [newCases, afterAppLabel] = yield* getNewCases(compiler, optDest, optBody, ans);
    return cBlock(jBlock(clist<J.JStmt>(
      jExpr(jAssign(step, afterAppLabel)),
      jExpr(jAssign(ans, call)),
      jBreak
    )), newCases);
  } else {
    const objId = jId(freshId(compilerName('obj')));
    const colonField = rtMethod('getColonFieldLoc', clist(objId, jStr(methname), compiler.getLoc(l)));
    const colonFieldId = jId(freshId(compilerName('field')));
    const checkMethod = rtMethod('isMethod', clist<J.JExprT>(colonFieldId));
    const [newCases, afterAppLabel] = yield* getNewCases(compiler, optDest, optBody, ans);
    return cBlock(
      jBlock(clist<J.JStmt>(
        // Update step before the call, so that if it runs out of gas, the resumer goes to the right step
        jExpr(jAssign(step, afterAppLabel)),
        jExpr(jAssign(compiler.curApploc, compiler.getLoc(l))),
        jVar(objId.id, compiledObj),
        jVar(colonFieldId.id, colonField),
        jIf(checkMethod, jBlock(clist<J.JStmt>(
          jExpr(jAssign(ans, jApp(jDot(colonFieldId, 'full_meth'),
            clCons<J.JExprT>(objId, compiledArgs))))
        )),
        jBlock(clist<J.JStmt>(
          checkFun(l, compiler.getLoc(l), colonFieldId),
          jExpr(wrapWithSrcnode(l, jAssign(ans, app(l, colonFieldId, compiledArgs))))
        ))),
        // If the answer is a cont, jump to the end of the current function
        // rather than continuing normally
        jBreak)),
      newCases);
  }
}

export function isIdOccurs(target: A.Name, e: J.JExprT): boolean {
  // Returns true iff `target` occurs in `e`
  const dummyJsExpr = jNum(0);
  let found = false;
  const visitor = ext(J.defaultMapVisitor as any, {
    jId(node: J.JId): any {
      if (node.id.key() === target.key()) {
        found = true;
      }
      return dummyJsExpr;
    },
  });
  e.visit(visitor);
  return found;
}

export function getAssignments(lst: J.JExprT[], limit: number): [J.JStmt[], J.JStmt[]] {
  /*
     Find an order of assignment statements in `lst` that avoid new variables
     where `limit` is the number of round-robin attempts allowed.

     When the dependency graph is acyclic, this algorithm degenerates to
     finding a topological order.

     If the RHS of assignment statements have at most one identifier,
     it's possible that the corresponding dependency graph will have cycles,
     but there can be at most one cycle per connected component. Thus, this
     algorithm degenerates to finding topological order at most twice per
     component (one for ordering non-cycle parts, then we break the cycle
     and then another one for the ordering the rest). It guarantees that
     it will reach limit = 0 at most once per each component.

     The output is a pair of `pre` and `post` which are lists of
     assignments. The order of `post` doesn't matter.
  */
  if (lst.length === 0) {
    return [[], []];
  }
  const asgn = lst[0];
  const rest = lst.slice(1);
  if (!isJAssign(asgn)) {
    throw new InternalCompilerError('Non j-assign in get-assignments: ' + (asgn as any).$name);
  }
  if (limit === 0) {
    const tmpArg = freshId(compilerName('tmp_asgn'));
    const [pre, post] = getAssignments(rest, rest.length);
    return [
      [jVar(tmpArg, asgn.rhs), ...pre],
      [jExpr(jAssign(asgn.name, jId(tmpArg))), ...post],
    ];
  } else {
    const occursAny = rest.some((nextAsgn) => isIdOccurs(asgn.name, (nextAsgn as J.JAssign).rhs));
    if (occursAny) {
      return getAssignments([...rest, asgn], limit - 1);
    } else {
      const [pre, post] = getAssignments(rest, rest.length);
      return [[jExpr(asgn), ...pre], post];
    }
  }
}

export function* compileSplitApp(
  l: Loc,
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  f: N.AVal,
  args: N.AVal[],
  optBody: N.AExpr | undefined,
  appInfo: A.AppInfo,
  isDefinitelyFn: boolean
): ChainGen<DAG.CBlock> {
  const ans = compiler.curAns;
  const step = compiler.curStep;
  const compiledF = (f.visit(compiler) as DAG.CExp).exp;
  const compiledArgs = CL.map_list((a: N.AVal) => (a.visit(compiler) as DAG.CExp).exp, args);
  const [newCases, afterAppLabel] = yield* getNewCases(compiler, optDest, optBody, ans);
  if (appInfo.isRecursive &&
    appInfo.isTail &&
    compiler.allowTco &&
    compiler.options.properTailCalls &&
    (compiledArgs.length() === compiler.args.length)) {
    // if it's an arity mismatch, use non-TCO to handle the error
    const argsList = map2((name: A.Name, exp: J.JExprT) => jAssign(name, exp) as J.JExprT, compiler.args, compiledArgs.toList());
    const [pre, post] = getAssignments(argsList, argsList.length);
    return cBlock(
      jBlock(
        clist<J.JStmt>(
          // Update step before the call, so that if it runs out of gas,
          // the resumer goes to the right step
          jExpr(jAssign(step, jNum(0))),
          jExpr(jUnop(jId(compiler.elidedFrames), jIncr)),
          jIf1(jBinop(jUnop(rtField('RUNGAS'), jDecr), J.jLeq, jNum(0)),
            jBlock(clist<J.JStmt>(
              jExpr(jDotAssign(RUNTIME, 'EXN_STACKHEIGHT', jNum(0))),
              jExpr(jAssign(ans, rtMethod('makeCont', clEmpty)))))))
          .append(CL.from_list<J.JStmt>([...pre, ...post]))
          .append(clSing<J.JStmt>(jContinue))),
      newCases);
  } else {
    return cBlock(
      jBlock(
        // Update step before the call, so that if it runs out of gas,
        // the resumer goes to the right step
        clist<J.JStmt>(
          jExpr(jAssign(step, afterAppLabel)),
          jExpr(jAssign(compiler.curApploc, compiler.getLoc(l))))
          .append(!isDefinitelyFn
            ? clSing<J.JStmt>(checkFun(l, jId(compiler.curApploc), compiledF))
            : clSing<J.JStmt>(jExpr(jRawCode('// omitting isFunction check'))))
          .append(clist<J.JStmt>(
            jExpr(wrapWithSrcnode(l, jAssign(ans, app(l, compiledF, compiledArgs)))),
            jBreak))),
      newCases);
  }
}

export function jBlockToStmtList(b: J.JBlockT): CList<J.JStmt> {
  switch (b.$name) {
    case 'j-block': return b.stmts;
    case 'j-block1': return clSing(b.stmt);
    default:
      throw new InternalCompilerError('Unknown JBlock in j-block-to-stmt-list');
  }
}

export function* compileFlatApp(
  l: Loc,
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  f: N.AVal,
  args: N.AVal[],
  optBody: N.AExpr | undefined,
  _appInfo: A.AppInfo,
  _isDefinitelyFn: boolean
): ChainGen<DAG.CBlock> {
  const ans = compiler.curAns;
  const compiledF = (f.visit(compiler) as DAG.CExp).exp;
  const compiledArgs = CL.map_list((a: N.AVal) => (a.visit(compiler) as DAG.CExp).exp, args);

  // Generate the code for calling the function
  const callCode = clist<J.JStmt>(
    jExpr(jRawCode('// caller optimization')),
    jExpr(wrapWithSrcnode(l, jAssign(ans, app(l, compiledF, compiledArgs))))
  );

  // Compile the body of the let. We split it into two portions:
  // 1) the code that can be in the same "block" (or case region) and
  // 2) the rest of the case statements
  let remainingCode: J.JBlockT;
  let newCases: CList<J.JCaseT>;
  if (optBody !== undefined) {
    [remainingCode, newCases] = yield* getRemainingCode(compiler, optDest, optBody, ans);
  } else {
    // Special case: there is no more code after this so just jump to the
    // special last block in the function
    remainingCode = jBlock(clist<J.JStmt>(
      jExpr(jAssign(compiler.curStep, compiler.curTarget)),
      jBreak
    ));
    newCases = clEmpty;
  }

  // Now merge the code for calling the function with the next block
  // (this is basically our optimization, since we're not starting a new case
  // for the next block)
  return cBlock(
    jBlock(clAppend(callCode, jBlockToStmtList(remainingCode))),
    newCases);
}

export function* compileSplitIf(
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  cond: N.AVal,
  consq: N.AExpr,
  alt: N.AExpr,
  optBody: N.AExpr | undefined
): ChainGen<DAG.CBlock> {
  const consqLabel = compiler.makeLabel();
  const altLabel = compiler.makeLabel();
  const ans = compiler.curAns;
  const [afterIfCases, afterIfLabel] = yield* getNewCases(compiler, optDest, optBody, ans);
  const compilerAfterIf = ext(compiler, { curTarget: afterIfLabel });
  const compiledConsq: DAG.CBlock = yield { body: consq, compiler: compilerAfterIf };
  const compiledAlt: DAG.CBlock = yield { body: alt, compiler: compilerAfterIf };

  const newCases =
    clAppend(
      clAppend(
        clCons(jCase(consqLabel, compiledConsq.block) as J.JCaseT, compiledConsq.newCases),
        clCons(jCase(altLabel, compiledAlt.block) as J.JCaseT, compiledAlt.newCases)),
      afterIfCases);
  return cBlock(
    jBlock(clist<J.JStmt>(
      jExpr(jAssign(compiler.curStep,
        jTernary(rtMethod('checkPyretTrue', clist((cond.visit(compiler) as DAG.CExp).exp)),
          consqLabel, altLabel))),
      jBreak
    )),
    newCases);
}

export function* compileCasesBranch(
  compiler: CompilerVisitor,
  compiledVal: J.JExprT,
  branch: N.ACasesBranch,
  casesLoc: Loc
): ChainGen<DAG.CBlock> {
  const compiledBody: DAG.CBlock = yield { body: branch.body, compiler };
  if (compiledBody.newCases.length() < compiler.options.inlineCaseBodyLimit) {
    return compileInlineCasesBranch(compiler, compiledVal, branch, compiledBody, casesLoc);
  } else {
    const tempBranch = freshId(compilerName('temp_branch'));
    const branchArgs: N.ABind[] =
      N.isACasesBranch(branch) && branch.args.length > 0
        ? branch.args.map(getBind)
        : [new N.ABind(branch.body.l, compiler.resumer, A.aBlank)];
    const step = freshId(compilerName('step'));
    const refBindsMask: J.JExprT = N.isACasesBranch(branch)
      ? jList(false, CL.map_list((cb: N.ACasesBind) => jBool(A.isSCasesBindRef(cb.fieldType)), branch.args))
      : jList(false, clEmpty);
    const compiledBranchFun =
      compileFunBody(branch.body.l, step, tempBranch,
        ext(compiler, { allowTco: false, options: { ...compiler.options, shouldProfile: false } }),
        branchArgs, undefined, branch.body, true, false, false, false);
    const preamble = casesPreamble(compiler, compiledVal, branch, casesLoc);
    const derefFields = jExpr(jAssign(compiler.curAns, jMethod(compiledVal, '$app_fields', clist<J.JExprT>(jId(tempBranch), refBindsMask))));
    const actualApp = clist<J.JStmt>(
      jExpr(jAssign(compiler.curStep, compiler.curTarget)),
      jExpr(jAssign(compiler.curApploc, compiler.getLoc(branch.l))),
      jVar(tempBranch,
        jFun(J.nextJFunId(), makeFunName(compiler, casesLoc),
          CL.map_list((arg: N.ABind) => formalShadowName(arg.id), branchArgs), compiledBranchFun)),
      derefFields,
      jBreak);

    return cBlock(
      jBlock(clAppend(preamble, actualApp)),
      clEmpty);
  }
}

export function casesPreamble(
  compiler: CompilerVisitor,
  compiledVal: J.JExprT,
  branch: N.ACasesBranch,
  casesLoc: Loc,
  elideArity: boolean = false
): CList<J.JStmt> {
  // The direct-cases optimization elides this runtime arity check when the variant
  // and its arity are statically known to match (the check provably never fires).
  if (elideArity) { return clEmpty; }
  const constructorLoc = jDot(compiledVal, '$loc');
  switch (branch.$name) {
    case 'a-cases-branch': {
      const branchGivenArity = jNum(branch.args.length);
      const objExpectedArity = jDot(compiledVal, '$arity');
      const checker =
        jIf1(jBinop(objExpectedArity, jNeq, branchGivenArity),
          jBlock1(
            jIf(jBinop(objExpectedArity, jGeq, jNum(0)),
              jBlock1(
                jExpr(jMethod(rtField('ffi'), 'throwCasesArityErrorC',
                  clist(compiler.getLoc(branch.l), branchGivenArity,
                    objExpectedArity, compiler.getLoc(casesLoc), constructorLoc)))),
              jBlock1(
                jExpr(jMethod(rtField('ffi'), 'throwCasesSingletonErrorC',
                  clist(compiler.getLoc(branch.l), jTrue, compiler.getLoc(casesLoc), constructorLoc)))))));
      return clist<J.JStmt>(checker);
    }
    case 'a-singleton-cases-branch': {
      const checker =
        jIf1(jBinop(jDot(compiledVal, '$arity'), jNeq, jNum(-1)),
          jBlock1(
            jExpr(jMethod(rtField('ffi'), 'throwCasesSingletonErrorC',
              clist(compiler.getLoc(branch.l), jFalse, compiler.getLoc(casesLoc), constructorLoc)))));
      return clist<J.JStmt>(checker);
    }
    default:
      throw new InternalCompilerError('Unknown ACasesBranch in cases-preamble');
  }
}

export function compileInlineCasesBranch(
  compiler: CompilerVisitor,
  compiledVal: J.JExprT,
  branch: N.ACasesBranch,
  compiledBody: DAG.CBlock,
  casesLoc: Loc
): DAG.CBlock {
  const preamble = casesPreamble(compiler, compiledVal, branch, casesLoc);
  if (N.isACasesBranch(branch)) {
    const entryLabel = compiler.makeLabel();
    const annCases = compileAnns(compiler, compiler.curStep, branch.args.map(getBind), entryLabel);
    const fieldNames = jId(jsIdOf(freshId(compilerName('fn'))));
    const getFieldNames = jVar(fieldNames.id, jDot(jDot(compiledVal, '$constructor'), '$fieldNames'));
    const derefFields = CL.map_list_n((i: number, arg: N.ACasesBind) => {
      const mask = jBracket(jDot(compiledVal, '$mut_fields_mask'), jNum(i));
      const field = getDictField(compiledVal, jBracket(fieldNames, jNum(i)));
      return jVar(jsIdOf(arg.bind.id),
        rtMethod('derefField', clist(field, mask, jBool(A.isSCasesBindRef(arg.fieldType))))) as J.JStmt;
    }, 0, branch.args);
    if (annCases.newCases instanceof CL.ConcatEmpty) {
      return cBlock(jBlock(
        clAppend(
          clAppend(
            clSnoc(preamble, getFieldNames as J.JStmt),
            derefFields),
          DAG.stmtsOf(compiledBody.block))),
      compiledBody.newCases);
    } else {
      return cBlock(jBlock(
        clSnoc(
          clSnoc(
            clAppend(
              clSnoc(preamble, getFieldNames as J.JStmt),
              derefFields),
            jExpr(jAssign(compiler.curStep, entryLabel)) as J.JStmt),
          jBreak as J.JStmt)),
      clSnoc(
        clAppend(
          annCases.newCases,
          compiledBody.newCases),
        jCase(annCases.newLabel, compiledBody.block) as J.JCaseT));
    }
  } else {
    return cBlock(jBlock(clAppend(preamble, DAG.stmtsOf(compiledBody.block))), compiledBody.newCases);
  }
}

export function* compileSplitCases(
  compiler: CompilerVisitor,
  casesLoc: Loc,
  optDest: BindType | undefined,
  _typ: A.Ann,
  val: N.AVal,
  branches: N.ACasesBranch[],
  _else: N.AExpr,
  optBody: N.AExpr | undefined
): ChainGen<DAG.CBlock> {
  const compiledVal = (val.visit(compiler) as DAG.CExp).exp;
  const [afterCasesCases, afterCasesLabel] = yield* getNewCases(compiler, optDest, optBody, compiler.curAns);
  const compilerAfterCases = ext(compiler, { curTarget: afterCasesLabel });
  const compiledBranches: DAG.CBlock[] = [];
  for (const branch of branches) {
    compiledBranches.push(yield* compileCasesBranch(compilerAfterCases, compiledVal, branch, casesLoc));
  }
  const compiledElse: DAG.CBlock = yield { body: _else, compiler: compilerAfterCases };
  const branchLabels = branches.map(() => compiler.makeLabel());
  const elseLabel = compiler.makeLabel();
  let branchCases: CList<J.JCaseT> = clEmpty;
  for (let i = 0; i < branchLabels.length; i++) {
    branchCases = clAppend(
      clSnoc(branchCases, jCase(branchLabels[i], compiledBranches[i].block) as J.JCaseT),
      compiledBranches[i].newCases);
  }
  const branchElseCases =
    clAppend(
      clSnoc(branchCases, jCase(elseLabel, compiledElse.block) as J.JCaseT),
      compiledElse.newCases);
  const dispatchTable = jObj(CL.map_list2((branch: N.ACasesBranch, label: J.JExprT) => jField(branch.name, label) as J.JFieldT, branches, branchLabels));
  const dispatch = jId(freshId(compilerName('cases_dispatch')));
  compiler.dispatches.dispatches = clCons(jVar(dispatch.id, dispatchTable) as J.JStmt, compiler.dispatches.dispatches);
  // NOTE: Ignoring typ for the moment!
  const newCases = clAppend(branchElseCases, afterCasesCases);
  return cBlock(
    jBlock(clist<J.JStmt>(
      jExpr(jAssign(compiler.curApploc, compiler.getLoc(casesLoc))),
      jExpr(jAssign(compiler.curStep,
        jBinop(jBracket(dispatch, jDot(compiledVal, '$name')), J.jOr, elseLabel))),
      jBreak)),
    newCases);
}

export function* compileSplitUpdate(
  compiler: CompilerVisitor,
  loc: Loc,
  optDest: BindType | undefined,
  obj: N.AVal,
  fields: N.AField[],
  optBody: N.AExpr | undefined
): ChainGen<DAG.CBlock> {
  const ans = compiler.curAns;
  const step = compiler.curStep;
  const compiledObj = (obj.visit(compiler) as DAG.CExp).exp;
  const compiledFieldVals = CL.map_list((a: N.AField) => (a.value.visit(compiler) as DAG.CExp).exp, fields);
  const fieldNames = CL.map_list((f: N.AField) => jStr(f.name) as J.JExprT, fields);
  const fieldLocs = CL.map_list((f: N.AField) => compiler.getLoc(f.l), fields);
  const [newCases, afterUpdateLabel] = yield* getNewCases(compiler, optDest, optBody, ans);
  return cBlock(
    jBlock(clist<J.JStmt>(
      // Update step before the call, so that if it runs out of gas, the resumer goes to the right step
      jExpr(jAssign(step, afterUpdateLabel)),
      jExpr(jAssign(ans, rtMethod('checkRefAnns',
        clist(
          compiledObj,
          jList(false, fieldNames),
          jList(false, compiledFieldVals),
          jList(false, fieldLocs),
          compiler.getLoc(loc),
          compiler.getLoc(obj.l))))),
      jBreak)),
    newCases);
}

export function isIdFnName(flatnessEnv: FL.FEnv, name: string): boolean {
  return flatnessEnv.has(name);
}

export function* compileAApp(
  l: Loc,
  f: N.AVal,
  args: N.AVal[],
  compiler: CompilerVisitor,
  b: BindType | undefined,
  optBody: N.AExpr | undefined,
  appInfo: A.AppInfo
): ChainGen<DAG.CBlock> {
  const isSafeId = N.isAId(f) || N.isAIdSafeLetrec(f);
  const appCompiler = (isSafeId && isFunctionFlat(compiler.flatnessEnv, (f as any).id.key()))
    ? compileFlatApp
    : compileSplitApp;

  const isFn = isSafeId && isIdFnName(compiler.flatnessEnv, (f as any).id.key());
  return yield* appCompiler(l, compiler, b, f, args, optBody, appInfo, isFn);
}

// ---------- Gen tier: generator-based maybe-promise emission of non-flat functions ----------
//
// An `async function` ALWAYS returns a Promise, even on the (overwhelmingly
// common) dynamic path where its body never actually suspends -- so every call
// to a non-flat callee costs a Promise allocation plus a microtask hop at the
// caller's conditional await, cascading up the whole call chain. The Gen tier
// instead compiles the body EXACTLY as the legacy async path does (awaits
// intact), then mechanically lowers it: each JAwait becomes a JYield
// (awaitsToYields -- a pure J-AST -> J-AST rewrite, no decisions), the body
// becomes a `function*`, and a plain synchronous wrapper drives it: when
// nothing suspends, the first g.next() runs the body to completion and the
// wrapper returns the flat result directly -- no Promise, no microtask, and
// the caller's `R.iT` check falls through, transitively keeping the entire
// call chain synchronous. On a genuine suspension (fuel pause or a suspending
// callee) the body yields the thenable and the wrapper returns a Promise via
// R.driveGen, preserving the async ABI (functions return Awaitables), the
// fuel-based JS-stack unwinding, interruptibility, and `await` error
// semantics (a rejected thenable is thrown back into the body at the yield
// point via gen.throw) exactly. The wrapper's try/catch keeps the
// async-function guarantee that a non-flat compiled function never throws
// synchronously -- arity and contract failures reject instead (R.rejP).
//
// The sync-vs-gen decision is the tier VERDICT (tier.ts, node-identity
// tierMap; consumed in compileALam / aMethod) -- never a scan of what was
// emitted (the ref branch's hasAwaits-as-decider is exactly what this design
// retires; the only post-emission scan is the O7 assertion).

// Rewrite this function body's awaits into yields. Nested function exprs are
// already fully compiled (inner lambdas/methods converted when built), so the
// visitor does not descend into them. jLabel/jSourcenode/jRawCode/jBlock1 need
// explicit handlers: the default map visitor lacks (or mis-implements) them.
const awaitToYieldVisitor: any = ext(J.defaultMapVisitor as any, {
  jAwait(node: J.JAwait): J.JExprT { return new J.JYield(node.expr.visit(this)); },
  jFun(node: J.JFun): J.JExprT { return node; },
  jAsyncFun(node: J.JAsyncFun): J.JExprT { return node; },
  jGenFun(node: J.JGenFun): J.JExprT { return node; },
  jSourcenode(node: J.JSourcenode): J.JExprT { return new J.JSourcenode(node.loc, node.uri, node.expr.visit(this)); },
  jRawCode(node: J.JRawCode): J.JExprT { return node; },
  jLabel(node: J.JLabel): J.JExprT { return node; },
  jBlock1(node: J.JBlock1): J.JBlockT { return jBlock1(node.stmt.visit(this)); },
});

export function awaitsToYields(body: J.JBlockT): J.JBlockT {
  return body.visit(awaitToYieldVisitor);
}

// Build the generator + sync-wrapper pair for a Gen-tier function body.
// Returns the statements declaring both; the wrapper is bound to `temp`,
// which is what makeFunction / makeTailFunction / makeMethod* wrap -- so the
// wrapper is the appBody the runtime token driver pumps. Shape:
//   var $gen = function* NAME($a, $b) { <body, awaits->yields> };
//   var <temp> = function NAME($a, $b) {
//     var $g = undefined; var $r = undefined;
//     try { <arity stmts>; $g = $gen($a, $b); $r = $g.next(); }
//     catch($e) { return R.rejP($e); }
//     if ($r.done) { return $r.value; }
//     return R.driveGen($g, $r.value);
//   };
// The arity stmts come from compileFunBody's arityOut: they read
// `arguments.length`, which must see the USER's call -- i.e. the wrapper's
// frame; inside the generator it would see the wrapper's fixed-arity
// forwarding call `$gen($a, $b)` and never fail.
// The done/drive dance stays INLINED in every wrapper -- NEVER a shared
// R.runGen helper: sharing makes that helper's `gen.next()` site megamorphic
// across every generator shape in the program (measured regression on the
// ref branch; the ~12 lines per function are the accepted cost).
function genFunStmts(
  compiler: CompilerVisitor,
  l: Loc,
  temp: A.Name,
  funArgs: CList<A.Name>,
  funBody: J.JBlockT,
  arityStmts: CList<J.JStmt>
): CList<J.JStmt> {
  const genId = freshId(compilerName('gen'));
  const gVar = freshId(compilerName('g'));
  const rVar = freshId(compilerName('gr'));
  const eVar = freshId(compilerName('ge'));
  const funName = makeFunName(compiler, l);
  const loweredBody = awaitsToYields(funBody);
  // O7 (gen arm): after the awaits->yields lowering, ZERO JAwait may remain
  // anywhere in the generator body -- yields only. The lowering rightly does
  // not descend into nested sync JFuns, so a residual await can only mean an
  // await inside a nested sync function (a would-be SyntaxError at load
  // time); countResidualAwaits descends into nested sync JFuns for exactly
  // this reason, and skips nested JAsyncFun/JGenFun where awaits/yields are
  // legal. Throw, never fall back (assertion, not a decision).
  assertNoResidualAwaits(loweredBody, 'gen (generator body, post-awaitsToYields)', l);
  const theGen = new J.JGenFun(J.nextJFunId(), funName, funArgs, loweredBody);
  const tryBody = jBlock(clAppend(arityStmts, clist<J.JStmt>(
    jExpr(jAssign(gVar, jApp(jId(genId), funArgs.map((a: A.Name) => jId(a) as J.JExprT)))),
    jExpr(jAssign(rVar, jMethod(jId(gVar), 'next', clEmpty))))));
  const catchBody = jBlock1(jReturn(rtMethod('rejP', clist<J.JExprT>(jId(eVar)))));
  const wrapperBody = jBlock(clist<J.JStmt>(
    jVar(gVar, jUndefined),
    jVar(rVar, jUndefined),
    new J.JTryCatch(tryBody, eVar, catchBody),
    jIf1(jDot(jId(rVar), 'done'), jBlock1(jReturn(jDot(jId(rVar), 'value')))),
    jReturn(rtMethod('driveGen', clist<J.JExprT>(jId(gVar), jDot(jId(rVar), 'value'))))));
  // O7 (gen arm, sync wrapper): the wrapper is a plain sync JFun built
  // await-free by construction; keep the scan as belt-and-braces -- it also
  // covers the arity stmts hoisted into it via arityOut (which must never
  // contain an await: arityCheck is synchronous by design).
  assertNoResidualAwaits(wrapperBody, 'gen (sync wrapper)', l);
  const theWrapper = jFun(J.nextJFunId(), funName, funArgs, wrapperBody);
  return clist<J.JStmt>(jVar(genId, theGen), jVar(temp, theWrapper));
}

// --- Hybrid bytecode machine: the JS side of the seam --------------------------
//
// vmRootExpr compiles a VM-tier ALam/AMethod to bytecode (through the
// module's VMModuleCompiler) and returns the JS expression that builds its
// value at run time: `R.$vm.mkFun($BC, idx, [captures...])`, where the
// captures are the function's free variables that are not module globals,
// read as the JS bindings they are (boxes for vars/letrec cells -- see
// collectUnboxableVarKeys' hybrid rule).
//
// The bytecode compiler calls back through a VMHost for anything it wants
// emitted as JS (thunks): a JS-tier lambda/method nested inside bytecode, an
// object literal, a data declaration, a structural annotation, an update.
// Each thunk is a plain JS function over the construct's free variables,
// compiled by THIS emitter with a fresh per-thunk apploc, so its body is
// exactly what the JS backend would have emitted for the same construct.
export const VM_PROG_NAME = constId('$BC');

function vmThunkFun(compiler: CompilerVisitor, params: A.Name[], build: (c: CompilerVisitor) => CList<J.JStmt>): J.JExprT {
  const al = freshId(compilerName('al'));
  const c = ext(compiler, {
    curApploc: al,
    tailPos: false,
    complete: completeReturn,
    rest: fnExitRest,
    curLetBind: undefined,
    inTcoLoop: false,
    mintsTokens: false,
    allowTco: false,
    fnTier: 'flat',
  });
  const body = clCons(jVar(al, UNDEFINED) as J.JStmt, build(c));
  return jFun(J.nextJFunId(), '', CL.from_list(params.map((n) => jsIdOf(n))), jBlock(body));
}

function makeVmHost(compiler: CompilerVisitor): VM.VMHost {
  return {
    getLocId: (l: Loc) => compiler.getLocId(l),
    flatnessEnv: compiler.flatnessEnv,
    typeFlatnessEnv: compiler.typeFlatnessEnv,
    flatMethodApps: compiler.flatMethodApps,
    flatMethods: compiler.flatMethods,
    redundantAnnChecks: compiler.redundantAnnChecks,
    moduleBindings: compiler.moduleBindings,
    env: compiler.env,
    tierMap: compiler.tierMap,
    options: compiler.options,
    resolveCasesDataType: (typ: A.Ann) => resolveCasesDataType(compiler, typ),
    thunkForLam: (node: N.ALam, letBind: N.ABind | undefined, params: A.Name[]) =>
      vmThunkFun(compiler, params, (c) => {
        const ce = compileALam(c, node, node.l, node.name, node.args, node.ret, node.body,
          letBind !== undefined ? new BLet(letBind) : undefined);
        return clSnoc(ce.otherStmts, jReturn(ce.exp) as J.JStmt);
      }),
    thunkForMethod: (node: N.AMethod, params: A.Name[]) =>
      vmThunkFun(compiler, params, (c) => {
        const ce = c.aMethod(node);
        return clSnoc(ce.otherStmts, jReturn(ce.exp) as J.JStmt);
      }),
    thunkForLettable: (node: N.ALettable, params: A.Name[]) =>
      vmThunkFun(compiler, params, (c) => {
        const ce = node.visit(c) as DAG.CExp;
        return clSnoc(ce.otherStmts, jReturn(ce.exp) as J.JStmt);
      }),
    thunkForAnnCheck: (b: N.ABind, params: A.Name[]) => {
      const v = freshId(compilerName('v'));
      return vmThunkFun(compiler, [v, ...params], (c) => {
        const ca = compileAnn(b.ann, undefined, c);
        return clSnoc(ca.otherStmts, jReturn(rtMethod('_checkAnn',
          clist(c.getLoc(annLoc(b.ann)), ca.exp, jId(jsIdOf(v))))) as J.JStmt);
      });
    },
    thunkForAnn: (ann: A.Ann, optName: string | undefined, params: A.Name[]) =>
      vmThunkFun(compiler, params, (c) => {
        const ca = compileAnn(ann, optName, c);
        return clSnoc(ca.otherStmts, jReturn(ca.exp) as J.JStmt);
      }),
    thunkForUpdate: (node: N.AUpdate, params: A.Name[]) =>
      vmThunkFun(compiler, params, (c) => {
        const objCe = node.supe.visit(c) as DAG.CExp;
        const fieldCes = node.fields.map((fld) => fld.value.visit(c) as DAG.CExp);
        const pre = clAppend(objCe.otherStmts, argsOtherStmts(fieldCes));
        const fieldNames = CL.map_list((fld: N.AField) => jStr(fld.name) as J.JExprT, node.fields);
        const fieldLocs = CL.map_list((fld: N.AField) => c.getLoc(fld.l), node.fields);
        const fieldVals = CL.map_list(getExp, fieldCes);
        const call = rtMethod('checkRefAnns',
          clist(objCe.exp, jList(false, fieldNames), jList(false, fieldVals), jList(false, fieldLocs),
            c.getLoc(node.l), c.getLoc(node.supe.l)));
        return clSnoc(pre, jReturn(call) as J.JStmt);
      }),
  };
}

// The fast JS form of a bytecode function: a plain sync jFun over the same
// ANF (compileFunBody with tier 'gen-fast'), returned by a factory thunk
// whose parameters are the function's upvalue names -- the machine builds
// it with the closure's captures (vmMakePvm), so the body's free variables
// are ordinary JS closure variables. The arity check is the wrapper's
// (arityOut discarded): the fast form is only ever called with exactly its
// arity.
function compileGenFastFun(compiler: CompilerVisitor, node: N.ALam | N.AMethod, isMethod: boolean, allowTco: boolean): J.JExprT {
  const l = node.l;
  const step = freshId(compilerName('step'));
  const temp = freshId(compilerName('temp_fast'));
  const args = node.args;
  const len = args.length;
  const effectiveArgs = (!isMethod && len === 0) ? [new N.ABind(l, compiler.resumer, A.aBlank)] : args;
  const tokenCell: Map<string, boolean> = new Map();
  const arityOut = { stmts: clEmpty as CList<J.JStmt> };
  const body = compileFunBody(l, step, temp, ext(compiler, { allowTco: true, tokenCell: tokenCell }),
    effectiveArgs, len, node.body, true, false, isMethod, false, 'gen-fast', arityOut, allowTco);
  assertNoResidualAwaits(body, 'gen-fast', l);
  if (tokenCell.has('minted')) {
    throw new InternalCompilerError('gen-fast "' + node.name + '" at ' + l.key() + ' minted a tail token');
  }
  const funArgs = CL.map_list((arg: N.ABind) => formalShadowName(arg.id), effectiveArgs);
  return jFun(J.nextJFunId(), makeFunName(compiler, l), funArgs, body);
}

function vmRootExpr(compiler: CompilerVisitor, node: N.ALam | N.AMethod, isMethod: boolean): DAG.CExp {
  const vm = compiler.vm as VM.VMModuleCompiler;
  const prevHost = vm.host;
  vm.host = makeVmHost(compiler);
  let root: VM.RootResult;
  try {
    root = vm.compileRootFunction(node);
  } finally {
    vm.host = prevHost;
  }
  if ((compiler.options as any).vmFast && !vm.hasFastForm(root.idx)) {
    const verdict = TIER.tierVerdictFor(compiler.tierMap as TIER.TierMap, node, node.l.key());
    const fastThunk = vmThunkFun(compiler, root.captures, (c) => {
      const cf = ext(c, { vmFast: { idx: root.idx, sites: root.sites, slotNames: root.slotNames } });
      return clSing<J.JStmt>(jReturn(compileGenFastFun(cf, node, isMethod, verdict.allowTco)));
    });
    vm.setFastForm(root.idx, fastThunk);
  }
  const caps = jList(false, CL.from_list(root.captures.map((n) => jId(jsIdOf(n)) as J.JExprT)));
  return cExp(
    jMethod(rtField('$vm'), isMethod ? 'mkMeth' : 'mkFun',
      clist<J.JExprT>(jId(VM_PROG_NAME), jNum(root.idx), caps)),
    clEmpty);
}

// The module's one bytecode-program declaration, prepended to the toplevel:
//   var $BC = R.$vm.load(<program>, L, [globals...], [thunks...]);
function vmProgramDecl(vm: VM.VMModuleCompiler): J.JStmt {
  vm.finish();
  const globals: J.JExprT[] = vm.globalNames.map((n) => jId(jsIdOf(n)) as J.JExprT);
  for (const g of vm.globalExprs) {
    const base = jBracket(jDot(jDot(jDot(jId(jsIdOf(g.id)), 'dict'), 'values'), 'dict'), jStr(g.name));
    // A var cell is hoisted as the CELL (its contents change; which cell it
    // is does not) -- the machine unboxes at each read.
    globals.push(base);
  }
  return jVar(VM_PROG_NAME,
    jMethod(rtField('$vm'), 'load', clist<J.JExprT>(
      jRawCode(JSON.stringify(vm.prog)),
      jId(constId('L')),
      jList(true, CL.from_list(globals)),
      jList(true, CL.from_list(vm.thunks))))) as J.JStmt;
}

export function compileALam(
  compiler: CompilerVisitor,
  node: N.ALam,
  l: Loc,
  name: string,
  args: N.ABind[],
  _ret: A.Ann,
  body: N.AExpr,
  bindOpt: BindType | undefined
): DAG.CExp {
  let isFlat: boolean;
  if (bindOpt !== undefined && isBLet(bindOpt)) {
    const bind = bindOpt.value;
    isFlat = isFunctionFlat(compiler.flatnessEnv, bind.id.key());
  } else {
    isFlat = false;
  }
  // Tier verdict for this lambda (node-identity lookup; a missing entry is an
  // InternalCompilerError -- it means a pass after tier analysis rebuilt ANF
  // nodes). The Flat verdict must agree exactly with the emitter's own
  // flatness decision above (both resolve through FL.isFunctionFlat on the
  // let-binding); assert it, never fall back.
  let verdict: TIER.TierVerdict | undefined;
  if (compiler.tierMap !== undefined) {
    verdict = TIER.tierVerdictFor(compiler.tierMap, node, l.key());
    if ((verdict.tier === 'flat') !== isFlat) {
      throw new InternalCompilerError(
        'tier/flatness disagreement for lambda "' + name + '" at ' + l.key()
        + ': tier=' + verdict.tier + ' but emitter isFlat=' + isFlat);
    }
  }
  // Hybrid machine: a VM-tier lambda compiles to bytecode; its value is
  // built by the machine from the module's program plus this scope's
  // captures (by value; see vm/vm-compile.ts).
  if (compiler.vm !== undefined && verdict !== undefined && compiler.vm.isVmTier(verdict.tier)) {
    return vmRootExpr(compiler, node, false);
  }
  // A JS-tier lambda nested in a bytecode function, met again while
  // compiling that function's FAST form: the bytecode compile already
  // emitted it as a thunk over its free variables -- build it from the
  // thunk (by-value capture is what the tier-boundary boxing rule already
  // guarantees sound) rather than emitting the whole lambda a second time.
  if (compiler.vm !== undefined && compiler.fnTier === 'gen-fast') {
    const th = compiler.vm.jsThunkByNode.get(node);
    if (th !== undefined) {
      return cExp(jApp(jBracket(jDot(jId(VM_PROG_NAME), 'thunks'), jNum(th.idx)),
        CL.from_list(th.params.map((n) => jId(jsIdOf(n)) as J.JExprT))), clEmpty);
    }
  }
  const newStep = freshId(compilerName('step'));
  const temp = freshId(compilerName('temp_lam'));
  const len = args.length;
  // NOTE: args may be empty, so we need at least one name ("resumer") for the stack convention
  const effectiveArgs =
    len > 0 ? args : [new N.ABind(l, compiler.resumer, A.aBlank)];
  // A fresh cell records whether this body actually minted a bounce token at some
  // tail position; if so the function value needs the driving `.app` wrapper
  // (makeTailFunction), otherwise it keeps app === appBody for zero overhead.
  // Gen-tier functions keep minting/participating in tail tokens exactly like
  // the legacy async fns (the tier changes the body's FORM, not the token
  // protocol; the wrapper below is the appBody the driver pumps).
  const tokenCell: Map<string, boolean> = new Map();
  // Emission tier. 'tail-flat' and 'few-suspend' get sync emissions (plain
  // jFun: tail sites return the callee's result directly and, for
  // few-suspend, each capturing site is a guarded return-then over the ANF
  // continuation -- see fewSuspendSite; fuel re-enters via
  // checkPause().then in both -- see compileFunBody); 'gen' takes the
  // generator+wrapper emission. -no-tail-flat / -no-few-suspend demote
  // inside tier.ts (the ONE demotion place -- a demoted function simply
  // arrives here with tier 'gen'); verdict === undefined is
  // -no-gen-functions (no tierMap at all): the legacy all-async emission.
  const useTailFlat = verdict !== undefined && verdict.tier === 'tail-flat';
  const useFewSuspend = verdict !== undefined && verdict.tier === 'few-suspend';
  const useSync = isFlat || useTailFlat || useFewSuspend;
  const useGen = verdict !== undefined && verdict.tier !== 'flat' && !useTailFlat && !useFewSuspend
    && compiler.options.genResidue; // residue default is plain async emission (measured 2026-07-04); -gen-residue opts back in
  const arityOut = useGen ? { stmts: clEmpty as CList<J.JStmt> } : undefined;
  const funBody = compileFunBody(l, newStep, temp, ext(compiler, { allowTco: true, tokenCell: tokenCell }), effectiveArgs, len, body, true, isFlat, false, true,
    verdict !== undefined ? verdict.tier : 'async', arityOut,
    verdict !== undefined ? verdict.allowTco : undefined);
  // O7: a sync (jFun) body must have ZERO residual awaits -- assert at compile
  // time (a miss would be a JS SyntaxError at load time). Binds the Flat,
  // TailFlat and FewSuspend emissions. If a sync-tier verdict was wrong,
  // this throw is the design working -- never a fallback to another emission.
  if (useSync) {
    assertNoResidualAwaits(funBody, verdict !== undefined ? verdict.tier : 'flat', l);
  }
  // Sync tiers never mint (mintsTokens forced false in compileFunBody);
  // tokenCell untouched is what keeps the maker below makeFunction. Tripwire,
  // not a decision: a mint here means the suppression regressed.
  if ((useTailFlat || useFewSuspend) && tokenCell.has('minted')) {
    throw new InternalCompilerError(
      (verdict as TIER.TierVerdict).tier + ' lambda "' + name + '" at ' + l.key() + ' minted a tail token');
  }
  const funArgs = CL.map_list((arg: N.ABind) => formalShadowName(arg.id), effectiveArgs);
  // Flat, TailFlat AND FewSuspend functions are plain synchronous jFuns (the
  // sync tiers' NAMED function expression is what their fuel check re-enters
  // by name). Gen-tier functions compile to a generator body plus a
  // synchronous driving wrapper (genFunStmts) so a non-suspending call
  // returns its value flat. With -no-gen-functions (verdict === undefined) a
  // non-flat body stays an async function so it can `await` non-flat calls
  // and the fuel check.
  let funStmts: CList<J.JStmt>;
  if (useGen) {
    funStmts = genFunStmts(compiler, l, temp, funArgs, funBody, arityOut!.stmts);
  } else {
    const theFun = useSync
      ? jFun(J.nextJFunId(), makeFunName(compiler, l), funArgs, funBody)
      : jAsyncFun(J.nextJFunId(), makeFunName(compiler, l), funArgs, funBody);
    funStmts = clist<J.JStmt>(jVar(temp, theFun));
  }
  const maker = tokenCell.has('minted') ? 'makeTailFunction' : 'makeFunction';
  return cExp(
    rtMethod(maker, clist<J.JExprT>(jId(temp), jStr(name))),
    funStmts);
}

export function* compileSplitPrimApp(
  l: Loc,
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  f: string,
  args: N.AVal[],
  optBody: N.AExpr | undefined
): ChainGen<DAG.CBlock> {
  const ans = compiler.curAns;
  const step = compiler.curStep;
  const compiledArgs = CL.map_list((a: N.AVal) => (a.visit(compiler) as DAG.CExp).exp, args);
  const [newCases, afterAppLabel] = yield* getNewCases(compiler, optDest, optBody, ans);
  return cBlock(
    jBlock(
      // Update step before the call, so that if it runs out of gas,
      // the resumer goes to the right step
      clist<J.JStmt>(
        jExpr(jAssign(step, afterAppLabel)),
        jExpr(jAssign(compiler.curApploc, compiler.getLoc(l))))
        .append(clist<J.JStmt>(
          jExpr(wrapWithSrcnode(l, jAssign(ans, rtMethod(f, compiledArgs)))),
          jBreak))),
    newCases);
}

export function* compileFlatPrimApp(
  l: Loc,
  compiler: CompilerVisitor,
  optDest: BindType | undefined,
  f: string,
  args: N.AVal[],
  optBody: N.AExpr | undefined
): ChainGen<DAG.CBlock> {
  const ans = compiler.curAns;
  const compiledArgs = CL.map_list((a: N.AVal) => (a.visit(compiler) as DAG.CExp).exp, args);

  // Generate the code for calling the function
  const callCode = jExpr(wrapWithSrcnode(l, jAssign(ans, rtMethod(f, compiledArgs))));

  // Compile the body of the let. We split it into two portions:
  // 1) the code that can be in the same "block" (or case region) and
  // 2) the rest of the case statements
  let remainingCode: J.JBlockT;
  let newCases: CList<J.JCaseT>;
  if (optBody !== undefined) {
    [remainingCode, newCases] = yield* getRemainingCode(compiler, optDest, optBody, ans);
  } else {
    // Special case: there is no more code after this so just jump to the
    // special last block in the function
    remainingCode = jBlock(clist<J.JStmt>(
      jExpr(jAssign(compiler.curStep, compiler.curTarget)),
      jBreak
    ));
    newCases = clEmpty;
  }

  // Now merge the code for calling the function with the next block
  // (this is basically our optimization, since we're not starting a new case
  // for the next block)
  return cBlock(
    jBlock(clCons(callCode as J.JStmt, jBlockToStmtList(remainingCode))),
    newCases);
}

export function* compileAPrimApp(
  l: Loc,
  f: string,
  args: N.AVal[],
  compiler: CompilerVisitor,
  b: BindType | undefined,
  optBody: N.AExpr | undefined,
  appInfo: A.PrimAppInfo
): ChainGen<DAG.CBlock> {
  const appCompiler = appInfo.needsStep ? compileSplitPrimApp : compileFlatPrimApp;
  return yield* appCompiler(l, compiler, b, f, args, optBody);
}

export function* compileLettable(
  compiler: CompilerVisitor,
  b: BindType | undefined,
  e: N.ALettable,
  optBody: N.AExpr | undefined,
  elseCase: (compiledE: DAG.CExp) => ChainGen<DAG.CBlock>
): ChainGen<DAG.CBlock> {
  switch (e.$name) {
    case 'a-prim-app':
      return yield* compileAPrimApp(e.l, e.f, e.args, compiler, b, optBody, e.appInfo);
    case 'a-app':
      return yield* compileAApp(e.l, e._fun, e.args, compiler, b, optBody, e.appInfo);
    case 'a-method-app':
      return yield* compileSplitMethodApp(e.l, compiler, b, e.obj, e.meth, e.args, optBody);
    case 'a-if':
      return yield* compileSplitIf(compiler, b, e.c, e.t, e.e, optBody);
    case 'a-cases':
      return yield* compileSplitCases(compiler, e.l, b, e.typ, e.val, e.branches, e._else, optBody);
    case 'a-update':
      return yield* compileSplitUpdate(compiler, e.l, b, e.supe, e.fields, optBody);
    case 'a-lam': {
      const compiledE = compileALam(compiler, e, e.l, e.name, e.args, e.ret, e.body, b);
      return yield* elseCase(compiledE);
    }
    default: {
      const compiledE: DAG.CExp = e.visit(compiler);
      return yield* elseCase(compiledE);
    }
  }
}

// ---------- the iterative chain driver (see comment above ChainYield) ----------

function chainGenFor(compiler: CompilerVisitor, node: N.AExpr): ChainGen<DAG.CBlock> {
  switch (node.$name) {
    case 'a-type-let': return aTypeLetGen(compiler, node as N.ATypeLet);
    case 'a-let': return aLetGen(compiler, node as N.ALet);
    case 'a-arr-let': return aArrLetGen(compiler, node as N.AArrLet);
    case 'a-var': return aVarGen(compiler, node as N.AVar);
    case 'a-seq': return aSeqGen(compiler, node as N.ASeq);
    case 'a-lettable': return aLettableGen(compiler, node as N.ALettable$);
    default:
      throw new InternalCompilerError('Unknown AExpr in chainGenFor: ' + (node as any).$name);
  }
}

export function runChain(compiler: CompilerVisitor, root: N.AExpr): DAG.CBlock {
  const stack: Array<ChainGen<DAG.CBlock>> = [chainGenFor(compiler, root)];
  let sendVal: DAG.CBlock | undefined = undefined;
  for (;;) {
    const g = stack[stack.length - 1];
    const r = g.next(sendVal as DAG.CBlock);
    if (r.done) {
      stack.pop();
      if (stack.length === 0) {
        return r.value;
      }
      sendVal = r.value;
    } else {
      stack.push(chainGenFor(r.value.compiler, r.value.body));
      sendVal = undefined;
    }
  }
}

function* aTypeLetGen(compiler: CompilerVisitor, node: N.ATypeLet): ChainGen<DAG.CBlock> {
  const bind = node.bind;
  switch (bind.$name) {
    case 'a-type-bind': {
      const visitedBody: DAG.CBlock = yield { body: node.body, compiler };
      const compiledAnn = compileAnn(bind.ann, bind.name.toname(), compiler);
      return cBlock(
        jBlock(
          clAppend(
            clSnoc(compiledAnn.otherStmts, jVar(jsIdOf(bind.name), compiledAnn.exp) as J.JStmt),
            DAG.stmtsOf(visitedBody.block))),
        visitedBody.newCases);
    }
    case 'a-newtype-bind': {
      const branderId = jsIdOf(bind.namet);
      const visitedBody: DAG.CBlock = yield { body: node.body, compiler };
      return cBlock(
        jBlock(
          clAppend(
            clist<J.JStmt>(
              jVar(branderId, rtMethod('namedBrander', clist<J.JExprT>(jStr(bind.name.toname()), compiler.getLoc(bind.l)))),
              jVar(jsIdOf(bind.name), rtMethod('makeBranderAnn', clist<J.JExprT>(jId(branderId), jStr(bind.name.toname()))))
            ),
            DAG.stmtsOf(visitedBody.block))),
        visitedBody.newCases);
    }
    default:
      throw new InternalCompilerError('Unknown ATypeBind in a-type-let');
  }
}

function* aLetGen(compiler: CompilerVisitor, node: N.ALet): ChainGen<DAG.CBlock> {
  return yield* compileLettable(compiler, new BLet(node.bind), node.e, node.body, function* (compiledE) {
    const compiledBody: DAG.CBlock = yield { body: node.body, compiler };
    return compileAnnotatedLet(compiler, new BLet(node.bind), compiledE, compiledBody);
  });
}

function* aArrLetGen(compiler: CompilerVisitor, node: N.AArrLet): ChainGen<DAG.CBlock> {
  return yield* compileLettable(compiler, new BArray(node.bind, node.idx), node.e, node.body, function* (compiledE) {
    const compiledBody: DAG.CBlock = yield { body: node.body, compiler };
    return compileAnnotatedLet(compiler, new BArray(node.bind, node.idx), compiledE, compiledBody);
  });
}

function* aVarGen(compiler: CompilerVisitor, node: N.AVar): ChainGen<DAG.CBlock> {
  const compiledBody: DAG.CBlock = yield { body: node.body, compiler };
  const compiledE: DAG.CExp = node.e.visit(compiler);
  // TODO: annotations here?
  const init = compiler.unboxedVars.has(node.bind.id.key())
    ? compiledE.exp
    : jObj(clist<J.JFieldT>(jField('$var', compiledE.exp)
      // NOTE(joe): This can be useful to turn on for debugging
      //                     , j-field("$name", j-str(b.id.toname()))
    ));
  return cBlock(
    jBlock(
      clCons(
        jVar(jsIdOf(node.bind.id), init) as J.JStmt,
        DAG.stmtsOf(compiledBody.block))),
    compiledBody.newCases);
}

function* aSeqGen(compiler: CompilerVisitor, node: N.ASeq): ChainGen<DAG.CBlock> {
  return yield* compileLettable(compiler, undefined, node.e1, node.e2, function* (e1Visit) {
    const e2Visit: DAG.CBlock = yield { body: node.e2, compiler };
    const firstStmt: J.JStmt = (e1Visit.exp as any) instanceof J.JStmtBase ? (e1Visit.exp as any as J.JStmt) : jExpr(e1Visit.exp);
    return cBlock(
      jBlock(clAppend(e1Visit.otherStmts, clCons(firstStmt, DAG.stmtsOf(e2Visit.block)))),
      e2Visit.newCases);
  });
}

function* aLettableGen(compiler: CompilerVisitor, node: N.ALettable$): ChainGen<DAG.CBlock> {
  return yield* compileLettable(compiler, undefined, node.e, undefined, function* (visitE) {
    return cBlock(
      jBlock(
        clAppend(
          clAppend(
            clSing<J.JStmt>(jExpr(jAssign(compiler.curStep, compiler.curTarget))),
            visitE.otherStmts),
          clist<J.JStmt>(
            jExpr(jAssign(compiler.curAns, visitE.exp)),
            jBreak))),
      clEmpty);
  });
}

// ---------- the compiler visitor ----------

export class CompilerVisitor {
  // fields installed by splitting-compiler
  uri!: string;
  addPhase!: (phase: string, data: any) => any;
  options!: SplitCompileOptions;
  flatnessEnv!: FL.FEnv;
  typeFlatnessEnv!: FL.FEnv;
  // key() set of function-local vars to compile without the {$var} box; see
  // collectUnboxableVarKeys. Populated in aProgram (empty when -no-unbox-vars).
  unboxedVars: Set<string> = new Set();
  // Method-application nodes proven flat (the receiver's data type resolves and
  // its method is flat); emitted as a direct call with NO conditional await. And
  // `a-method` nodes proven flat; emitted as a synchronous function (makeMethod,
  // not makeTailMethod). Empty unless method flatness is enabled. See aMethod,
  // compileMethodAppAsync.
  flatMethodApps!: Set<N.AMethodApp>;
  flatMethods!: Set<N.AMethod>;
  // Bind keys whose `:: T` annotation check is provably redundant (the value is
  // already known to be `⊑ T`), per the upper-bound type-flow analysis
  // (type-flow.ts). The async backend skips emitting `_checkAnn` for these,
  // treating them like a blank annotation. Empty unless ann-elision is enabled.
  // See annCheckStmts / compileAnns / compileAnnotatedLet.
  redundantAnnChecks: Set<string> = new Set();
  // Per-function tier verdicts (tier.ts; promise backend with gen-functions
  // on). Keyed by ANF NODE IDENTITY (ALam/AMethod) -- when defined, a missing
  // entry for a visited function node is an InternalCompilerError (a pass
  // after tier analysis rebuilt nodes), never a fallback. undefined =
  // -no-gen-functions legacy all-async emission (the A/B baseline).
  tierMap: TIER.TierMap | undefined = undefined;
  // The hybrid bytecode compiler for this module (vm/vm-compile.ts), when
  // options.vmTiers is non-empty and a tier map exists; installed by
  // compile-module. compileALam / aMethod route VM-tier functions to it.
  vm: VM.VMModuleCompiler | undefined = undefined;
  // While compiling the FAST JS FORM of a bytecode function ('gen-fast'
  // emission): its bytecode index, suspend-site table and slot->name map,
  // so each site can emit the bailout that hands its live values to the
  // machine (see fastSite). Installed by vmRootExpr for that compile only.
  vmFast: { idx: number; sites: Map<any, VM.SiteInfo>; slotNames: Map<number, A.Name> } | undefined = undefined;
  // The lettable node whose site is being emitted (gen-fast only): the key
  // into vmFast.sites. Installed by compileLettableAsync.
  curSiteNode: any = undefined;
  bindings!: Map<string, CS.ValueBind>;
  typeBindings!: Map<string, CS.TypeBind>;
  moduleBindings!: Map<string, CS.ModuleBind>;
  env!: CS.CompileEnvironment;
  // fields installed by compile-module
  progProvides!: A.ProvideBlock;
  // Current module's own data definitions (provides.dataDefinitions), used by the
  // direct-cases optimization to resolve in-module variant metadata (the current
  // module is not in env.allModules during its own compilation). See compileCasesAsync.
  localDataDefs!: Map<string, CS.DataExport>;
  getLoc!: (l: Loc) => J.JExprT;
  getLocId!: (l: Loc) => number;
  curApploc!: A.Name;
  resumer!: A.Name;
  allowTco!: boolean;
  dispatches!: DispatchesBox;
  // fields installed by compile-fun-body
  makeLabel!: () => J.JExprT;
  curTarget!: J.JExprT;
  curStep!: A.Name;
  curAns!: A.Name;
  args!: A.Name[];
  elidedFrames!: A.Name;
  // fields installed by the async backend's compile-fun-body / compile-lettable-async
  complete!: (v: J.JExprT) => CList<J.JStmt>;
  tailPos!: boolean;
  inTcoLoop!: boolean;
  mintsTokens!: boolean;
  tokenCell!: Map<string, boolean>;
  curLetBind!: BindType | undefined;
  // The ENCLOSING function's tier verdict ('async' = legacy -no-gen-functions
  // emission and the toplevel module fn, which is never in the tier map).
  // Installed UNCONDITIONALLY at every compileFunBody entry from the per-NODE
  // verdict -- NEVER inherited across a function boundary (the ref branch's
  // ext()-inherits-tailFlatMode generator-leak bug class stays retired).
  // Readers: the sync-tier tail-direct-return arms (compileAppAsync /
  // compileMethodAppAsync) and the dead-ann-check elision after a TCO
  // `continue` (compileAexprAsync).
  fnTier: TIER.Tier | 'async' | 'gen-fast' = 'async';
  // FewSuspend tier: the memoized CONTINUATION THUNK -- returns the
  // statements from the current chain position to FUNCTION EXIT, maintained
  // by compileAexprAsync's continuation-thunk links and consumed by
  // fewSuspendSite to build resume closures that ALIAS the statements the
  // sync path falls through to. LANDMINE (risk register H, the same shape
  // as the retired ext()-inherits-tailFlatMode generator leak): this field
  // MUST be overwritten (reset to fnExitRest) at EVERY compileFunBody entry
  // -- see the reset there -- so a nested function can never alias an OUTER
  // function's continuation into its own resume closures. Never read
  // outside the 'few-suspend' tier.
  rest: () => CList<J.JStmt> = fnExitRest;

  aModule(node: N.AModule): DAG.CExp {
    const l = node.l;
    const mpSpecs = this.progProvides.specs.filter(A.isSProvideModule);
    const vpSpecs = this.progProvides.specs.filter(A.isSProvideName);
    const tpSpecs = this.progProvides.specs.filter(A.isSProvideType);
    const dpSpecs = this.progProvides.specs.filter(A.isSProvideData);
    void dpSpecs;

    let aliasFields: CList<J.JFieldT> = clEmpty;
    let aliasStmts: CList<J.JStmt> = clEmpty;
    for (const tp of tpSpecs) {
      const ns = tp.nameSpec;
      switch (ns.$name) {
        case 's-local-ref': {
          const compiled = compileAnn(new A.AName(l, ns.name), undefined, this); // TODO(Ben): should be none, or name, or as-name?
          aliasFields = clSnoc(aliasFields, jField(ns.asName.toname(), compiled.exp) as J.JFieldT);
          aliasStmts = clAppend(aliasStmts, compiled.otherStmts);
          break;
        }
        case 's-remote-ref': {
          aliasFields = clSnoc(aliasFields,
            jField(ns.asName.toname(),
              getModuleField(ns.uri, 'types', ns.name.toname())) as J.JFieldT);
          break;
        }
        default:
          throw new InternalCompilerError('Unknown NameSpec in provide-type compilation: ' + (ns as any).$name);
      }
    }

    const compiledProvides = CL.map_list((pv: A.SProvideName) => {
      const ns = pv.nameSpec;
      switch (ns.$name) {
        case 's-local-ref': {
          const valBind = mapGetValue(this.bindings, ns.name.key());
          let valExp: J.JExprT;
          if (CS.isVbLetrec(valBind.binder)) {
            valExp = jDot(jId(jsIdOf(ns.name)), '$var');
          } else if (CS.isVbVar(valBind.binder)) {
            valExp = jId(jsIdOf(ns.name));
          } else if (CS.isVbLet(valBind.binder)) {
            valExp = jId(jsIdOf(ns.name));
          } else {
            throw new InternalCompilerError('Unknown ValueBinder in provide compilation');
          }
          return jField(ns.asName.toname(), valExp) as J.JFieldT;
        }
        case 's-remote-ref': {
          const valExp = getModuleField(ns.uri, 'values', ns.name.toname());
          return jField(ns.asName.toname(), valExp) as J.JFieldT;
        }
        default:
          throw new InternalCompilerError('Unknown NameSpec in provide compilation: ' + (ns as any).$name);
      }
    }, vpSpecs);

    const typesFields = aliasFields; // + data-fields;
    const typesStmts = aliasStmts; // + data-stmts

    const compiledModuleProvides = CL.map_list((pm: A.SProvideModule) => {
      const ns = pm.nameSpec;
      switch (ns.$name) {
        case 's-local-ref': {
          const compiled = jId(jsIdOf(ns.name));
          return jField(ns.asName.toname(), compiled) as J.JFieldT;
        }
        case 's-remote-ref':
          return jField(ns.asName.toname(), jBracket(rtField('modules'), jStr(ns.uri))) as J.JFieldT;
        default:
          throw new InternalCompilerError('Unknown NameSpec in provide-module compilation: ' + (ns as any).$name);
      }
    }, mpSpecs);

    const compiledAnswer: DAG.CExp = node.answer.visit(this);
    const compiledChecks: DAG.CExp = node.checks.visit(this);
    return cExp(
      rtMethod('makeObject', clist<J.JExprT>(
        jObj(clist<J.JFieldT>(
          jField('answer', compiledAnswer.exp),
          jField('namespace', NAMESPACE),
          jField('locations', jId(constId('L'))),
          jField('defined-modules',
            jObj(
              CL.map_list((dm: N.ADefinedModule) => jField(dm.name, jId(jsIdOf(dm.value))) as J.JFieldT, node.definedModules))),
          jField('defined-values',
            jObj(
              CL.map_list((dv: N.ADefinedValue) => {
                switch (dv.$name) {
                  case 'a-defined-value': {
                    const compiledVal = (dv.value.visit(this) as DAG.CExp).exp;
                    return jField(dv.name, compiledVal) as J.JFieldT;
                  }
                  case 'a-defined-var':
                    return jField(dv.name, jId(jsIdOf(dv.id))) as J.JFieldT;
                  default:
                    throw new InternalCompilerError('Unknown ADefinedValue in a-module');
                }
              }, node.definedValues))),
          jField('defined-types',
            jObj(
              CL.map_list((dt: N.ADefinedType) => {
                const compiledAnn = compileAnn(dt.typ, undefined, this).exp;
                return jField(dt.name, compiledAnn) as J.JFieldT;
              }, node.definedTypes))),
          jField('provide-plus-types',
            rtMethod('makeObject', clist<J.JExprT>(jObj(clist<J.JFieldT>(
              jField('values', rtMethod('makeObject', clist<J.JExprT>(jObj(compiledProvides)))),
              jField('types', jObj(typesFields)),
              jField('modules', jObj(compiledModuleProvides))
            ))))),
          jField('checks', compiledChecks.exp))))),

      clAppend(
        clAppend(typesStmts, compiledAnswer.otherStmts),
        compiledChecks.otherStmts));
  }

  // The async backend compiles each AExpr ("chain") shape in tail-with-completion
  // style. The chain SPINE is walked iteratively inside compile-aexpr-async (to keep
  // JS stack depth bounded on deep straight-line programs, like the cont backend);
  // these visitor methods just delegate to it so there is a single implementation
  // and they stay byte-consistent if ever invoked via `.visit`.
  aTypeLet(node: N.ATypeLet): DAG.CBlock {
    return cBlock(jBlock(compileAexprAsync(this, node)), clEmpty);
  }

  aLet(node: N.ALet): DAG.CBlock {
    return cBlock(jBlock(compileAexprAsync(this, node)), clEmpty);
  }

  aArrLet(node: N.AArrLet): DAG.CBlock {
    return cBlock(jBlock(compileAexprAsync(this, node)), clEmpty);
  }

  aVar(node: N.AVar): DAG.CBlock {
    return cBlock(jBlock(compileAexprAsync(this, node)), clEmpty);
  }

  aSeq(node: N.ASeq): DAG.CBlock {
    return cBlock(jBlock(compileAexprAsync(this, node)), clEmpty);
  }

  aIf(_node: N.AIf): never {
    return raise('Impossible: a-if directly in compiler-visitor should never happen');
  }

  aCases(_node: N.ACases): never {
    return raise('Impossible: a-cases directly in compiler-visitor should never happen');
  }

  aUpdate(_node: N.AUpdate): never {
    return raise('Impossible: a-update directly in compiler-visitor should never happen');
  }

  aLettable(node: N.ALettable$): DAG.CBlock {
    // Tail position: the lettable's value flows to the current completion.
    return cBlock(jBlock(compileAexprAsync(this, node)), clEmpty);
  }

  aAssign(node: N.AAssign): DAG.CExp {
    const visitValue: DAG.CExp = node.value.visit(this);
    const assignStmt: J.JStmt = this.unboxedVars.has(node.id.key())
      ? jExpr(jAssign(jsIdOf(node.id), visitValue.exp)) as J.JStmt
      : jExpr(jDotAssign(jId(jsIdOf(node.id)), '$var', visitValue.exp)) as J.JStmt;
    return cExp(rtField('nothing'), clSnoc(visitValue.otherStmts, assignStmt));
  }

  aApp(_node: N.AApp): never {
    return raise('Impossible: a-app directly in compiler-visitor should never happen');
  }

  aPrimApp(node: N.APrimApp): DAG.CExp {
    const visitArgs = node.args.map((a) => a.visit(this) as DAG.CExp);
    const setLoc = clist<J.JStmt>(
      jExpr(jAssign(this.curApploc, this.getLoc(node.l)))
    );
    return cExp(rtMethod(node.f, CL.map_list(getExp, visitArgs)), setLoc);
  }

  aRef(node: N.ARef): DAG.CExp {
    if (node.ann === undefined) {
      return cExp(rtMethod('makeGraphableRef', clEmpty), clEmpty);
    } else {
      return raise('Cannot handle annotations in refs yet');
    }
  }

  aObj(node: N.AObj): DAG.CExp {
    const visitFields = node.fields.map((f) => f.visit(this) as DAG.CField);
    // Emit the dict as an adopt-ready `{__proto__: R.$dictProto, …}` literal:
    // the runtime's PObject constructor recognizes the shared dict prototype
    // and adopts the (always fresh) literal without its normalizing copy, and
    // V8 gives literals with a non-null prototype fast shape-tracked
    // properties, where the old null-proto copy target was permanently
    // dictionary-mode. `__proto__` is a reserved name in Pyret (cannot be a
    // record key), so the marker field can never collide, and the quoted
    // `"__proto__"` key is still the prototype-setting literal form per spec.
    const protoField = jField('__proto__', rtField('$dictProto'));
    return cExp(rtMethod('makeObject', clist<J.JExprT>(jObj(clCons(protoField as J.JFieldT, CL.map_list(oGetField, visitFields))))), clEmpty);
  }

  aGetBang(node: N.AGetBang): DAG.CExp {
    const visitObj: DAG.CExp = node.obj.visit(this);
    return cExp(rtMethod('getFieldRef', clist(visitObj.exp, jStr(node.field), this.getLoc(node.l))), visitObj.otherStmts);
  }

  aExtend(node: N.AExtend): DAG.CExp {
    const visitObj: DAG.CExp = node.supe.visit(this);
    const visitFields = node.fields.map((f) => f.visit(this) as DAG.CField);
    return cExp(rtMethod('extendObj', clist(this.getLoc(node.l), visitObj.exp, jObj(CL.map_list(oGetField, visitFields)))),
      clEmpty);
  }

  aDot(node: N.ADot): DAG.CExp {
    const visitObj: DAG.CExp = node.obj.visit(this);
    // A type-flow-proven plain data field (`directField`) reads straight from the
    // dict -- no getField call, method-curry check, or missing/non-object guard,
    // and each site is its own low-polymorphism access instead of the megamorphic
    // getField funnel. Same soundness basis as directCases.
    const baseRead = node.directField
      ? getDictField(visitObj.exp, jStr(node.field))
      : getFieldSafe(node.l, visitObj.exp, jStr(node.field), this.getLoc(node.l));
    const stmts = clSnoc(visitObj.otherStmts, jExpr(jAssign(this.curApploc, this.getLoc(node.l))) as J.JStmt);
    if (node.cacheVar !== undefined) {
      // Cross-iteration write-once memoization of a loop-invariant immutable
      // field read (ANF optimizer LICM): evaluate getField the first time the
      // read is reached -- while the cell is still nullish -- and reuse it on
      // every later iteration. Emitted as `cacheVar ?? (cacheVar = getField(...))`,
      // i.e. the value form of `cacheVar ??= getField(...)`: a cached iteration
      // does a single nullish load and NO store. The read stays at its original
      // program point, so a preceding raise/effect (or a zero-trip loop) still
      // wins -- unlike hoisting the read to the preheader, which reorders
      // exceptions.
      const cv = jId(jsIdOf(node.cacheVar));
      const cached = jParens(jBinop(cv, jNullish, jParens(jAssign(jsIdOf(node.cacheVar), baseRead))));
      return cExp(cached, stmts);
    }
    return cExp(baseRead, stmts);
  }

  aColon(node: N.AColon): DAG.CExp {
    const visitObj: DAG.CExp = node.obj.visit(this);
    return cExp(rtMethod('getColonFieldLoc', clist(visitObj.exp, jStr(node.field), this.getLoc(node.l))),
      visitObj.otherStmts);
  }

  aMethod(node: N.AMethod): DAG.CExp {
    const step = freshId(compilerName('step'));
    const tempFull = freshId(compilerName('temp_full'));
    const len = node.args.length;
    // A method proven flat (its body is bounded and never suspends) is emitted as a
    // SYNCHRONOUS function -- no Promise alloc per call, and callers can skip the
    // conditional await (see compileMethodAppAsync). Mirrors compile-a-lam's flat
    // path. Otherwise the method participates in safe-for-space bouncing: a tail
    // call inside the body (to a function OR another method) mints a token, and the
    // body is wrapped with makeTailMethod (a driving full_meth) when it does. The
    // token-cell records it, exactly like compile-a-lam.
    const isFlat = this.flatMethods.has(node);
    // Tier verdict (node-identity; missing entry = InternalCompilerError) --
    // the Flat verdict must agree exactly with the flatMethods decision above
    // (both come from the same node-identity set). See compileALam.
    let verdict: TIER.TierVerdict | undefined;
    if (this.tierMap !== undefined) {
      verdict = TIER.tierVerdictFor(this.tierMap, node, node.l.key());
      if ((verdict.tier === 'flat') !== isFlat) {
        throw new InternalCompilerError(
          'tier/flatness disagreement for method "' + node.name + '" at ' + node.l.key()
          + ': tier=' + verdict.tier + ' but emitter isFlat=' + isFlat);
      }
    }
    if (this.vm !== undefined && verdict !== undefined && this.vm.isVmTier(verdict.tier)) {
      return vmRootExpr(this, node, true);
    }
    if (this.vm !== undefined && this.fnTier === 'gen-fast') {
      const th = this.vm.jsThunkByNode.get(node);
      if (th !== undefined) {
        return cExp(jApp(jBracket(jDot(jId(VM_PROG_NAME), 'thunks'), jNum(th.idx)),
          CL.from_list(th.params.map((n) => jId(jsIdOf(n)) as J.JExprT))), clEmpty);
      }
    }
    const funArgs = CL.map_list((a: N.ABind) => formalShadowName(a.id), node.args);
    const tokenCell: Map<string, boolean> = new Map();
    // Emission tier -- same discipline as compileALam: 'tail-flat' and
    // 'few-suspend' get the sync jFun emission; 'gen' takes the
    // generator+wrapper; the verdict is looked up per NODE, never
    // inherited compile state (retires the ref's ext()-mode-flag bug class).
    const useTailFlat = verdict !== undefined && verdict.tier === 'tail-flat';
    const useFewSuspend = verdict !== undefined && verdict.tier === 'few-suspend';
    const useSync = isFlat || useTailFlat || useFewSuspend;
    const useGen = verdict !== undefined && verdict.tier !== 'flat' && !useTailFlat && !useFewSuspend
      && this.options.genResidue; // residue default is plain async emission (measured 2026-07-04); -gen-residue opts back in
    const arityOut = useGen ? { stmts: clEmpty as CList<J.JStmt> } : undefined;
    const fullInner =
      compileFunBody(node.l, step, tempFull, ext(this, { allowTco: true, tokenCell: tokenCell }), node.args, len, node.body, true, isFlat, true, true,
        verdict !== undefined ? verdict.tier : 'async', arityOut,
        verdict !== undefined ? verdict.allowTco : undefined);
    // O7: same assertion as compileALam's sync-tier arms (see there).
    if (useSync) {
      assertNoResidualAwaits(fullInner, verdict !== undefined ? verdict.tier : 'flat', node.l);
    }
    // Sync-tier mint tripwire, as in compileALam.
    if ((useTailFlat || useFewSuspend) && tokenCell.has('minted')) {
      throw new InternalCompilerError(
        (verdict as TIER.TierVerdict).tier + ' method "' + node.name + '" at ' + node.l.key() + ' minted a tail token');
    }
    // Gen-tier methods get the generator + sync-wrapper emission (genFunStmts);
    // flat, tail-flat AND few-suspend methods are plain synchronous jFuns
    // (the sync tiers' named function expression is their fuel re-enter
    // target); -no-gen-functions keeps the legacy async emission. Gen-tier
    // methods keep the token protocol exactly as async methods did (the
    // wrapper is the full_methBody the driver pumps); sync-tier methods
    // never mint.
    const fullStmts: CList<J.JStmt> = useGen
      ? genFunStmts(this, node.l, tempFull, funArgs, fullInner, arityOut!.stmts)
      : clist<J.JStmt>(jVar(tempFull, useSync
        ? jFun(J.nextJFunId(), makeFunName(this, node.l), funArgs, fullInner)
        : jAsyncFun(J.nextJFunId(), makeFunName(this, node.l), funArgs, fullInner)));
    // A flat method never mints a token (isFlat forces mintsTokens=false), so
    // makeMethod is always correct for it.
    const maker = tokenCell.has('minted') ? 'makeTailMethod' : 'makeMethod';
    const methodExpr = len < 9
      ? rtMethod(maker + String(len - 1), clist<J.JExprT>(jId(tempFull), jStr(node.name)))
      : rtMethod(maker + 'N', clist<J.JExprT>(jId(tempFull), jStr(node.name)));
    return cExp(methodExpr, fullStmts);
  }

  aVal(node: N.AVal$): DAG.CaseResults {
    return node.v.visit(this);
  }

  aField(node: N.AField): DAG.CField {
    const visitV: DAG.CExp = node.value.visit(this);
    return cField(jField(node.name, visitV.exp), visitV.otherStmts);
  }

  aTuple(node: N.ATuple): DAG.CExp {
    const visitVals = node.fields.map((v) => v.visit(this) as DAG.CExp);
    return cExp(rtMethod('makeTuple', clist<J.JExprT>(jList(false, CL.map_list(getExp, visitVals)))), clEmpty);
  }

  aTupleGet(node: N.ATupleGet): DAG.CExp {
    const visitName: DAG.CExp = node.tup.visit(this);
    return cExp(rtMethod('getTuple', clist(visitName.exp, jNum(node.index), this.getLoc(node.l))), clEmpty);
  }

  aArray(node: any): DAG.CExp {
    const visitVals: DAG.CExp[] = node.values.map((v: N.AVal) => v.visit(this) as DAG.CExp);
    const otherStmts = visitVals.reduceRight((acc: CList<J.JStmt>, v: DAG.CExp) => clAppend(v.otherStmts, acc), clEmpty as CList<J.JStmt>);
    return cExp(jList(false, CL.map_list(getExp, visitVals)), otherStmts);
  }

  aSrcloc(node: N.ASrcloc): DAG.CExp {
    return cExp(this.getLoc(node.loc), clEmpty);
  }

  aNum(node: N.ANum): DAG.CExp {
    if (typeof node.n === 'number') {
      return cExp(jParens(jNum(node.n)), clEmpty);
    } else {
      return cExp(rtMethod('makeNumberFromString', clist<J.JExprT>(jStr(String(node.n)))), clEmpty);
    }
  }

  aStr(node: N.AStr): DAG.CExp {
    return cExp(jParens(jStr(node.s)), clEmpty);
  }

  aBool(node: N.ABool): DAG.CExp {
    return cExp(jParens(node.b ? jTrue : jFalse), clEmpty);
  }

  aUndefined(_node: N.AUndefined): DAG.CExp {
    return cExp(UNDEFINED, clEmpty);
  }

  aPrimVal(node: N.APrimVal): DAG.CExp {
    return cExp(rtField(node.name), clEmpty);
  }

  aId(node: N.AId): DAG.CExp {
    return cExp(jId(jsIdOf(node.id)), clEmpty);
  }

  aIdModref(node: N.AIdModref): DAG.CExp {
    return cExp(
      jBracket(
        jDot(
          jDot(
            jDot(jId(jsIdOf(node.id)), 'dict'),
            'values'),
          'dict'),
        jStr(node.name)), clEmpty);
  }

  aIdVarModref(node: N.AIdVarModref): DAG.CExp {
    return cExp(
      jDot(jBracket(
        jDot(
          jDot(
            jDot(jId(jsIdOf(node.id)), 'dict'),
            'values'),
          'dict'),
        jStr(node.name)), '$var'), clEmpty);
  }

  aIdVar(node: N.AIdVar): DAG.CExp {
    if (this.unboxedVars.has(node.id.key())) {
      return cExp(jId(jsIdOf(node.id)), clEmpty);
    }
    return cExp(jDot(jId(jsIdOf(node.id)), '$var'), clEmpty);
  }

  aIdSafeLetrec(node: N.AIdSafeLetrec): DAG.CExp {
    const s = jId(jsIdOf(node.id));
    // Unboxed safe-letrec: read the bare JS binding (see collectUnboxableVarKeys).
    const read = this.unboxedVars.has(node.id.key()) ? s : jDot(s, '$var');
    return cExp(read, clEmpty);
  }

  aIdLetrec(node: N.AIdLetrec): DAG.CExp {
    const s = jId(jsIdOf(node.id));
    // An unboxed letrec id has only safe references (collectUnboxableVarKeys
    // excludes any id with an unsafe ref), so the `read` is the bare binding; the
    // unsafe branch below only fires for still-boxed ids. Written generally so
    // both branches stay correct regardless.
    const read = this.unboxedVars.has(node.id.key()) ? s : jDot(s, '$var');
    if (node.safe) {
      return cExp(read, clEmpty);
    } else {
      return cExp(
        jTernary(
          jBinop(read, jEq, UNDEFINED),
          raiseIdExn(this.getLoc(node.l), node.id.toname()),
          read),
        clEmpty);
    }
  }

  aDataExpr(node: N.ADataExpr): DAG.CExp {
    const self = this;
    const l = node.l;
    const name = node.name;
    const namet = node.namet;
    const variants = node.variants;
    const shared = node.shared;

    function brandName(base: string): string {
      return jsIdOf(compilerName('brand-' + base)).toname();
    }
    void brandName;

    const visitSharedFields = CL.map_list((f: N.AField) => f.visit(self) as DAG.CField, shared);
    const sharedFields = visitSharedFields.map(oGetField);
    const externalBrand = jId(jsIdOf(namet));

    function makeBrandPredicate(loc: Loc, b: J.JExprT, predName: string): J.JFieldT {
      const val = freshId(compilerName('val'));
      return jField(
        predName,
        rtMethod('makeFunction', clist<J.JExprT>(
          jFun(J.nextJFunId(),
            makeFunName(self, l),
            clist(val),
            jBlock(
              clSnoc(
                arityCheck(self.getLoc(loc), 1, false),
                jReturn(rtMethod('makeBoolean', clist(rtMethod('hasBrand', clist<J.JExprT>(jId(val), b))))) as J.JStmt)
            )
          ),
          jStr(predName + '-Tester')
        ))
      );
    }
    void makeBrandPredicate;

    function makeVariantConstructor(
      l2: Loc,
      baseId: A.Name,
      brandsId: A.Name,
      members: N.AVariantMember[],
      reflName: J.JExprT,
      reflRefFieldsMask: J.JExprT,
      reflFields: J.JExprT,
      constructorId: J.JExprT
    ): DAG.CExp {
      const nonblankAnns = members.filter((m) => !A.isABlank(m.bind.ann) && !A.isAAny(m.bind.ann));
      let anns: CList<J.JExprT> = clEmpty;
      let others: CList<J.JStmt> = clEmpty;
      for (const m of nonblankAnns) {
        const compiled = compileAnn(m.bind.ann, undefined, self);
        anns = clSnoc(anns, compiled.exp);
        others = clAppend(others, compiled.otherStmts);
      }
      const compiledLocs = CL.map_list((m: N.AVariantMember) => self.getLoc((m.bind.ann as any).l), nonblankAnns);
      const compiledVals = CL.map_list((m: N.AVariantMember) => jStr(jsIdOf(m.bind.id).tosourcestring()) as J.JExprT, nonblankAnns);

      // NOTE(joe 6-14-2014): We cannot currently statically check for if an annotation
      // is a refinement because of type aliases.  So, we use checkAnnArgs, which takes
      // a continuation and manages all of the stack safety of annotation checking itself.

      // NOTE(joe 5-26-2015): This has been moved to a hybrid static/dynamic solution by
      // passing the check off to a runtime function that uses JavaScript's Function
      // to only do the refinement check once.
      return cExp(
        rtMethod('makeVariantConstructor', clist<J.JExprT>(
          self.getLoc(l2),
          // NOTE(joe): Thunked at the JS level because compiled-anns might contain
          // references to rec ids that should be resolved later
          jFun(J.nextJFunId(), '$synthesizedConstructor_' + baseId.toname(), clEmpty, jBlock1(jReturn(jList(false, anns)))),
          jList(false, compiledVals),
          jList(false, compiledLocs),
          jList(false, CL.map_list((m: N.AVariantMember) => jBool(N.isAMutable(m.memberType)), members)),
          jList(false, CL.map_list((m: N.AVariantMember) => jStr(jsIdOf(m.bind.id).tosourcestring()) as J.JExprT, members)),
          reflRefFieldsMask,
          jId(baseId),
          jId(brandsId),
          reflName,
          reflFields,
          constructorId
        )),
        clEmpty);
    }

    function compileVariant(v: N.AVariant): { stmts: CList<J.JStmt>; constructor: J.JFieldT; predicate: J.JFieldT } {
      const vname = v.name;
      const variantBaseId = jsIdOf(compilerName(vname + '-base'));
      const variantBrand = rtMethod('namedBrander', clist<J.JExprT>(jStr(vname), self.getLoc(v.l)));
      const variantBrandId = jsIdOf(compilerName(vname + '-brander'));
      const variantBrandObjId = jsIdOf(compilerName(vname + '-brands'));
      const variantBrands = jObj(clEmpty);
      const visitWithFields = v.withMembers.map((wm) => wm.visit(self) as DAG.CField);

      const reflBaseFields: CList<J.JFieldT> =
        N.isASingletonVariant(v)
          ? clEmpty
          : clist<J.JFieldT>(
            jField('$fieldNames',
              jList(false, CL.map_list((m: N.AVariantMember) => jStr(m.bind.id.toname()) as J.JExprT, (v as N.AVariant$).members))));

      const fId = constId('f');
      const reflName = jStr(vname);

      const reflRefFieldsMaskId = jsIdOf(compilerName(vname + '_mutablemask'));
      const reflRefFieldsMask: J.JExprT =
        N.isASingletonVariant(v)
          ? jList(false, clEmpty)
          : jList(false,
            CL.map_list((m: N.AVariantMember) => (N.isAMutable(m.memberType) ? jTrue : jFalse) as J.JExprT, (v as N.AVariant$).members));

      const reflFieldsId = jsIdOf(compilerName(vname + '_getfields'));
      const reflFields: J.JExprT =
        N.isAVariant(v)
          ? jFun(J.nextJFunId(), 'singleton_variant',
            clist<A.Name>(constId('f')), jBlock1(jReturn(jApp(jId(fId),
              CL.map_list((m: N.AVariantMember) =>
                getDictField(THIS, jStr(m.bind.id.toname())), v.members)))))
          : jFun(J.nextJFunId(), 'variant',
            clist<A.Name>(constId('f')), jBlock1(jReturn(jApp(jId(fId), clEmpty))));

      function memberCount(v2: N.AVariant): number {
        switch (v2.$name) {
          case 'a-variant': return v2.members.length;
          case 'a-singleton-variant': return 0;
          default:
            throw new InternalCompilerError('Unknown AVariant in member-count');
        }
      }

      const matchField = jField('_match', rtMethod('makeMatch', clist<J.JExprT>(reflName, jNum(memberCount(v)))));

      const stmts =
        visitWithFields.reduceRight((acc: CList<J.JStmt>, vf: DAG.CField) => clAppend(vf.otherStmts, acc),
          clist<J.JStmt>(
            jVar(reflFieldsId, reflFields),
            jVar(reflRefFieldsMaskId, reflRefFieldsMask),
            jVar(variantBaseId, jObj(reflBaseFields
              .append(sharedFields)
              .append(CL.map_list(oGetField, visitWithFields))
              .append(clist<J.JFieldT>(matchField)))),
            jVar(variantBrandId, variantBrand),
            jVar(variantBrandObjId, variantBrands),
            jExpr(jBracketAssign(
              jId(variantBrandObjId),
              jDot(externalBrand, '_brand'),
              jTrue)),
            jExpr(jBracketAssign(
              jId(variantBrandObjId),
              jDot(jId(variantBrandId), '_brand'),
              jTrue))
          ));
      const predicate = jField(A.makeCheckerName(vname), getFieldUnsafe(jId(variantBrandId), jStr('test'), self.getLoc(v.l))); // make-brand-predicate(v.l, j-dot(j-id(variant-brand-id), "_brand"), A.make-checker-name(vname))

      switch (v.$name) {
        case 'a-variant': {
          const constrVname = jsIdOf(constId(vname));
          const compiledConstr =
            makeVariantConstructor(v.l, variantBaseId, variantBrandObjId, v.members,
              reflName, jId(reflRefFieldsMaskId), jId(reflFieldsId), jId(variantBaseId));
          return {
            stmts: clSnoc(
              clAppend(stmts, compiledConstr.otherStmts),
              jVar(constrVname, compiledConstr.exp) as J.JStmt),
            constructor: jField(vname, jId(constrVname)),
            predicate: predicate,
          };
        }
        case 'a-singleton-variant': {
          return {
            stmts: stmts,
            constructor: jField(vname, rtMethod('makeDataValue', clist<J.JExprT>(jId(variantBaseId), jId(variantBrandObjId), reflName, jId(reflFieldsId), jNum(-1), jId(reflRefFieldsMaskId), jId(variantBaseId), jFalse, self.getLoc(v.l)))),
            predicate: predicate,
          };
        }
        default:
          throw new InternalCompilerError('Unknown AVariant in compile-variant');
      }
    }

    const variantPieces = variants.map(compileVariant);

    let headerStmts: CList<J.JStmt> = clEmpty;
    for (const piece of variantPieces) {
      headerStmts = clAppend(headerStmts, piece.stmts);
    }
    let objFields: CList<J.JFieldT> = clEmpty;
    for (const piece of variantPieces) {
      objFields = clAppend(objFields, clist<J.JFieldT>(piece.predicate, piece.constructor));
    }

    const dataPredicate = jField(name, getFieldUnsafe(externalBrand, jStr('test'), this.getLoc(l))); // make-brand-predicate(l, j-dot(external-brand, "_brand"), name)

    const dataObject = rtMethod('makeObject', clist<J.JExprT>(jObj(clCons(dataPredicate as J.JFieldT, objFields))));

    return cExp(dataObject, headerStmts);
  }
}

export function mkAbbrevs(l: Loc): CList<J.JStmt> {
  const loc = constId('loc');
  const name = constId('name');
  return clist<J.JStmt>(
    jVar(constId('G'), rtField('getFieldLoc')),
    jVar(constId('U'), jFun(J.nextJFunId(), 'throw_error', clist<A.Name>(loc, name),
      jBlock1(jExpr(jMethod(rtField('ffi'), 'throwUninitializedIdMkLoc',
        clist<J.JExprT>(jId(loc), jId(name))))))),
    jVar(constId('M'), jStr((l as SL.Srcloc).source)),
    jVar(constId('D'), rtField('undefined'))
  );
}

export function importKey(i: A.ImportType): string {
  return AU.importToDep(i).key();
}

export function compileTypeVariant(variant: T.TypeVariant): J.JExprT {
  switch (variant.$name) {
    case 't-variant': {
      const compiledMembers = jList(false, CL.map_list(([memName, typ]: T.VariantField) => {
        if (T.isTRef(typ)) {
          return jList(true, clist<J.JExprT>(jStr('ref'), jStr(memName), compileProvidedType(typ.typ))) as J.JExprT;
        } else {
          return jList(true, clist<J.JExprT>(jStr(memName), compileProvidedType(typ))) as J.JExprT;
        }
      }, variant.fields));
      const compiledWithMembers = jObj(clMapSd((memName: string) =>
        compileTypeMember(memName, mapGetValue(variant.withFields, memName)) as J.JFieldT, variant.withFields));
      return jList(true, clist<J.JExprT>(jStr(variant.name), compiledMembers, compiledWithMembers));
    }
    case 't-singleton-variant': {
      const compiledWithMembers = jObj(clMapSd((memName: string) =>
        compileTypeMember(memName, mapGetValue(variant.withFields, memName)) as J.JFieldT, variant.withFields));
      return jList(true, clist<J.JExprT>(jStr(variant.name), compiledWithMembers));
    }
    default:
      throw new InternalCompilerError('Unknown TypeVariant in compile-type-variant');
  }
}

export function compileTypeMember(name: string, typ: T.Type): J.JFieldT {
  return jField(name, compileProvidedType(typ));
}

export function compileProvidedData(de: CS.DataExport): J.JExprT {
  switch (de.$name) {
    case 'd-alias':
      return jList(false,
        clist<J.JExprT>(jStr('data-alias'),
          compileOrigin(de.origin),
          jStr(de.name)));
    case 'd-type': {
      const typ = de.typ;
      switch (typ.$name) {
        case 't-data':
          return jList(false,
            clist<J.JExprT>(jStr('data'),
              compileOrigin(de.origin),
              jStr(typ.name),
              jList(false, CL.map_list((p: T.Type) => jStr((p as T.TVar).id.key()) as J.JExprT, typ.params)),
              jList(false, CL.map_list(compileTypeVariant, typ.variants)),
              jObj(clMapSd((memName: string) =>
                compileTypeMember(memName, mapGetValue(typ.fields, memName)) as J.JFieldT, typ.fields))));
        default:
          throw new InternalCompilerError('Unknown DataType in compile-provided-data');
      }
    }
    default:
      throw new InternalCompilerError('Unknown DataExport in compile-provided-data');
  }
}

export function compileProvidedType(typ: T.Type): J.JExprT {
  switch (typ.$name) {
    case 't-name': {
      const modName = typ.moduleName;
      switch (modName.$name) {
        case 'local':
          return jObj(clist<J.JFieldT>(
            jField('tag', jStr('name')),
            jField('origin', jObj(clist<J.JFieldT>(jField('import-type', jStr('$ELF'))))),
            jField('name', jStr(typ.id.toname())))); // TODO: toname or key?
        case 'module-uri':
          return jObj(clist<J.JFieldT>(
            jField('tag', jStr('name')),
            jField('origin', jObj(clist<J.JFieldT>(jField('import-type', jStr('uri')), jField('uri', jStr(modName.uri))))),
            jField('name', jStr(typ.id.toname())))); // TODO: toname or key?
        case 'dependency':
          return raise("Dependency-origin names in provided-types shouldn't be possible");
        default:
          throw new InternalCompilerError('Unknown NameOrigin in compile-provided-type');
      }
    }
    case 't-var':
      return jList(true, clist<J.JExprT>(jStr('tid'), jStr(typ.id.key()))); // NOTE(joe): changed to .key()
    case 't-arrow':
      return jList(true,
        clist<J.JExprT>(jStr('arrow'),
          jList(true, CL.map_list(compileProvidedType, typ.args)), compileProvidedType(typ.ret)));
    case 't-app':
      return jList(false,
        clist<J.JExprT>(jStr('tyapp'), compileProvidedType(typ.onto),
          jList(true, CL.map_list(compileProvidedType, typ.args))));
    case 't-top':
      return jStr('tany');
    case 't-bot':
      return jStr('tbot');
    case 't-record':
      return jList(false,
        clist<J.JExprT>(jStr('record'), jObj(clMapSd((key: string) =>
          compileTypeMember(key, mapGetValue(typ.fields, key)) as J.JFieldT, typ.fields))));
    case 't-tuple':
      return jList(false,
        clist<J.JExprT>(jStr('tuple'), jList(false, CL.map_list(compileProvidedType, typ.elts))));
    case 't-forall':
      return jList(true,
        clist<J.JExprT>(jStr('forall'),
          jList(false, CL.map_list((p: T.Type) => jStr((p as T.TVar).id.key()) as J.JExprT, typ.introduces)),
          compileProvidedType(typ.onto)));
      // | t-ref(_, _) =>
      // | t-existential(_, _) =>
    case 't-data-refinement':
      return jList(true,
        clist<J.JExprT>(jStr('data%'), compileProvidedType(typ.dataType), jStr(typ.variantName)));
    default:
      return jTernary(jFalse, jStr(String(typ)), jStr('tany'));
  }
}

export function srclocToRaw(l: Loc): J.JExprT {
  switch (l.$name) {
    case 'builtin':
      return jList(true, clist<J.JExprT>(jStr(l.moduleName)));
    case 'srcloc':
      return jList(true, clist<J.JExprT>(jStr(l.source), jNum(l.startLine), jNum(l.startColumn), jNum(l.startChar), jNum(l.endLine), jNum(l.endColumn), jNum(l.endChar)));
    default:
      throw new InternalCompilerError('Unknown Srcloc in srcloc-to-raw');
  }
}

export function compileOrigin(bo: CS.BindOrigin): J.JExprT {
  return jObj(clist<J.JFieldT>(
    jField('local-bind-site', srclocToRaw(bo.localBindSite)),
    jField('definition-bind-site', srclocToRaw(bo.definitionBindSite)),
    jField('new-definition', jBool(bo.newDefinition)),
    jField('uri-of-definition', jStr(bo.uriOfDefinition))
  ));
}

export function compileProvides(provides: CS.Provides): J.JExprT {
  const moduleFields = clMapSd((m: string) =>
    jField(m, jObj(clist<J.JFieldT>(jField('uri', jStr(mapGetValue(provides.modules, m)))))) as J.JFieldT,
  provides.modules);
  const valueFields = clMapSd((v: string) => {
    const ve = mapGetValue(provides.values, v);
    switch (ve.$name) {
      case 'v-alias':
        return jField(v, jObj(clist<J.JFieldT>(
          jField('bind', jStr('alias')),
          jField('origin', compileOrigin(ve.origin)),
          jField('original-name', jStr(ve.originalName)),
          jField('typ', jBool(false))
        ))) as J.JFieldT;
      case 'v-just-type':
        return jField(v, jObj(clist<J.JFieldT>(
          jField('bind', jStr('let')),
          jField('origin', compileOrigin(ve.origin)),
          jField('typ', compileProvidedType(ve.t))
        ))) as J.JFieldT;
      case 'v-var':
        return jField(v, jObj(clist<J.JFieldT>(
          jField('bind', jStr('var')),
          jField('origin', compileOrigin(ve.origin)),
          jField('typ', compileProvidedType(ve.t))
        ))) as J.JFieldT;
      case 'v-fun':
        return jField(v, jObj(clist<J.JFieldT>(
          jField('bind', jStr('fun')),
          jField('origin', compileOrigin(ve.origin)),
          jField('flatness', ve.flatness !== undefined ? jNum(ve.flatness) : jFalse),
          jField('name', jStr(ve.name)),
          jField('typ', compileProvidedType(ve.t))
        ))) as J.JFieldT;
      default:
        throw new InternalCompilerError('Unknown ValueExport in compile-provides');
    }
  }, provides.values);
  const dataFields = clMapSd((d: string) =>
    jField(d, compileProvidedData(mapGetValue(provides.dataDefinitions, d))) as J.JFieldT,
  provides.dataDefinitions);
  const aliasFields = clMapSd((a: string) =>
    jField(a, compileProvidedType(mapGetValue(provides.aliases, a))) as J.JFieldT,
  provides.aliases);
  // Optimization-facts section (rule 3; see CS.OPT_FACTS_SCHEMA for the reader's
  // skew rules): a separate, OPTIONAL, schema-tagged top-level `opt-facts` object,
  // emitted only when non-empty, with sorted keys for deterministic bytes. Today it
  // carries one fact kind, `method-flatness` { dataName: { methodName: flatness } },
  // attached to DTypes by getFlatProvides in this same compile. Only THIS (async)
  // serializer emits it -- cont's compileProvides (anf-loop-compiler.ts) is
  // untouched, so cont provides bytes are unchanged (byte-parity oracle intact).
  const methodFlatnessFields: J.JFieldT[] = [];
  for (const d of [...provides.dataDefinitions.keys()].sort()) {
    const de = mapGetValue(provides.dataDefinitions, d);
    if (CS.isDType(de) && de.methodFlatness.size > 0) {
      const methFields = [...de.methodFlatness.keys()].sort().map((meth) =>
        jField(meth, jNum(mapGetValue(de.methodFlatness, meth))) as J.JFieldT);
      methodFlatnessFields.push(jField(d, jObj(CL.clist(...methFields))) as J.JFieldT);
    }
  }
  const baseProvidesFields = clist<J.JFieldT>(
    jField('modules', jObj(moduleFields)),
    jField('values', jObj(valueFields)),
    jField('datatypes', jObj(dataFields)),
    jField('aliases', jObj(aliasFields))
  );
  const allProvidesFields = methodFlatnessFields.length === 0
    ? baseProvidesFields
    : clAppend(baseProvidesFields, clist<J.JFieldT>(
      jField('opt-facts', jObj(clist<J.JFieldT>(
        jField('schema', jNum(CS.OPT_FACTS_SCHEMA)),
        jField('method-flatness', jObj(CL.clist(...methodFlatnessFields)))
      ))) as J.JFieldT));
  return jObj(allProvidesFields);
}

// Pyret lists.sort-by (the non-stable variant used by compile-module):
// quicksort on the first element; equal elements come out in reverse order
// of appearance (they are accumulated with cons and not re-sorted).
function sortBy<T>(lst: T[], cmp: (a: T, b: T) => boolean, eq: (a: T, b: T) => boolean): T[] {
  if (lst.length === 0) { return []; }
  const pivot = lst[0];
  // builds up three lists, split according to cmp and eq
  const areLt: T[] = [];
  const areEq: T[] = [];
  const areGt: T[] = [];
  for (const e of lst) {
    if (cmp(e, pivot)) { areLt.unshift(e); }
    else if (eq(e, pivot)) { areEq.unshift(e); }
    else { areGt.unshift(e); }
  }
  const less = sortBy(areLt, cmp, eq);
  const equal = areEq;
  const greater = sortBy(areGt, cmp, eq);
  return [...less, ...equal, ...greater];
}

interface ModuleSpec {
  id: A.Name;
  inputId: A.Name;
  imp: A.SImport;
}

export function compileModule(
  self: CompilerVisitor,
  l: Loc,
  progProvides: A.ProvideBlock,
  importsIn: A.Import[],
  prog: N.AExpr,
  freevarsIn: Map<string, A.Name>,
  provides: CS.Provides,
  env: CS.CompileEnvironment
): Map<string, J.JExprT> {
  jsNames.reset();
  // NOTE(ordering): Pyret's freevars.unfreeze() re-orders keys into hash
  // trie order; this copy keeps the Map's insertion order. See header, site 3.
  const freevars = new Map(freevarsIn);

  const imports = sortBy(
    importsIn.filter(A.isSImport) as A.SImport[],
    (i1, i2) => importKey(i1.file) < importKey(i2.file),
    (i1, i2) => importKey(i1.file) === importKey(i2.file)
  );

  for (const i of imports) {
    switch (i.$name) {
      case 's-import':
        freevars.delete(i.name.key());
        break;
      default:
        break;
    }
  }

  const freeIds = [...freevars.keys()].sort()
    .map((k) => mapGetValue(freevars, k));
  const moduleAndGlobalBinds = partition(A.isSAtom, freeIds);
  const globalBinds = CL.map_list((n: A.Name) => {
    let maybeOrigin: CS.BindOrigin | undefined;
    let which: string;
    switch (n.$name) {
      case 's-module-global':
        maybeOrigin = env.originByModuleName(n.toname());
        which = 'modules';
        break;
      case 's-global':
        maybeOrigin = env.originByValueName(n.toname());
        which = 'values';
        break;
      case 's-type-global':
        maybeOrigin = env.originByTypeName(n.toname());
        which = 'types';
        break;
      default:
        throw new InternalCompilerError('Unknown global name in compile-module: ' + n.$name);
    }

    let uri: string;
    let name: string;
    if (maybeOrigin !== undefined) {
      uri = maybeOrigin.uriOfDefinition;
      name = maybeOrigin.originalName.toname();
    } else {
      return raise(n.toname() + ' not found');
    }

    return jVar(jsIdOf(n), getModuleField(uri, which, name)) as J.JStmt;
  }, moduleAndGlobalBinds.isFalse);
  // MARK(joe): need to do something below for modules that come from
  // a context like "include"
  const moduleBinds = CL.map_list((n: A.Name) => {
    let which: string;
    let uri: string;
    let lookupName: A.Name;
    if (self.bindings.has(n.key())) {
      const valBind = mapGetValue(self.bindings, n.key());
      which = 'values';
      uri = valBind.origin.uriOfDefinition;
      lookupName = valBind.origin.originalName;
    } else if (self.typeBindings.has(n.key())) {
      const typBind = mapGetValue(self.typeBindings, n.key());
      which = 'types';
      uri = typBind.origin.uriOfDefinition;
      lookupName = typBind.origin.originalName;
    } else if (self.moduleBindings.has(n.key())) {
      const modBind = mapGetValue(self.moduleBindings, n.key());
      which = 'modules';
      uri = modBind.origin.uriOfDefinition;
      lookupName = modBind.origin.originalName;
    } else {
      throw new InternalCompilerError('No binding found for ' + n.key() + ' in compile-module');
    }
    return jVar(jsIdOf(n), getModuleField(uri, which, lookupName.toname())) as J.JStmt;
  }, moduleAndGlobalBinds.isTrue);
  function cleanImportName(name: A.Name): A.Name {
    return jsIdOf(name);
  }
  const modIds = imports.map((i) => cleanImportName(i.name));
  const moduleLocators = imports.map((i) => AU.importToDep(i.file));
  const filenames = imports.map((i) => {
    const file = i.file;
    switch (file.$name) {
      case 's-const-import':
        return 'trove/' + file.mod;
      case 's-special-import': {
        const typ = file.kind;
        const args = file.args;
        if (typ === 'my-gdrive') {
          return '@my-gdrive/' + args[0];
        } else if (typ === 'shared-gdrive') {
          return '@shared-gdrive/' + args[0] + '/' + args[1];
        } else if (typ === 'js-http') {
          return '@js-http/' + args[0];
        } else if (typ === 'gdrive-js') {
          return '@gdrive-js/' + args[0] + '/' + args[1];
        } else {
          // NOTE(joe): under new module loading, this doesn't actually matter
          // NOTE(joe): yes it does, this is how we get a serialized rep of
          // the dependencies for the next time we need to check it
          return new CS.Dependency(typ, args).key();
        }
      }
      default:
        throw new InternalCompilerError('Unknown ImportType in compile-module');
    }
  });
  void filenames;
  // this needs to be freshened to support multiple repl interactions with the "same" source
  const moduleId = freshId(compilerName((l as SL.Srcloc).source)).tosourcestring();
  const moduleRef = (name: string): J.JExprT => jBracket(rtField('modules'), jStr(name));
  void moduleRef;
  const inputIds = CL.map_list((i: A.Name) => {
    if (A.isSAtom(i) && (i.base === '$import')) { return jsNames.makeAtom('$$import'); }
    else { return jsIdOf(compilerName(i.toname())); }
  }, modIds);
  const casesDispatches = new DispatchesBox(clEmpty);
  function wrapModules(modules: ModuleSpec[], bodyName: A.Name, bodyFun: J.JExprT): J.JBlockT {
    const modInputNames = CL.map_list((m: ModuleSpec) => m.inputId, modules);
    const modInputIds = modInputNames.map(jId);
    const modInputIdsList = modInputIds.toList();
    void modInputIdsList;
    const modValIds = modules.map(getId);
    void modValIds;
    const moduleVal = constId('moduleVal');
    return jBlock(
      CL.map_list((m: ModuleSpec) => jVar(m.id, jId(m.inputId)) as J.JStmt, modules)
        .append(casesDispatches.dispatches)
        .append(moduleBinds)
        .append(clist<J.JStmt>(
          jVar(bodyName, bodyFun),
          // body-fun is an async function; await it directly (no trampoline).
          jVar(moduleVal, jAwait(jApp(jId(bodyName), clEmpty))),
          jExpr(jBracketAssign(rtField('modules'), jStr(moduleId), jId(moduleVal))),
          jReturn(jId(moduleVal)))));
  }
  const moduleSpecs: ModuleSpec[] = [];
  const inputIdsList = inputIds.toList();
  for (let i = 0; i < imports.length; i++) {
    moduleSpecs.push({ id: modIds[i], inputId: inputIdsList[i], imp: imports[i] });
  }
  let locations: CList<J.JExprT> = clEmpty;
  let locCount = 0;
  const locCache: Map<string, number> = new Map();
  const LOCS = constId('L');
  function getLocId(loc: Loc): number {
    const asStr = loc.key();
    const cached = locCache.get(asStr);
    if (cached !== undefined) {
      return cached;
    } else {
      const ans = locCount;
      locCache.set(asStr, ans);
      locCount = locCount + 1;
      locations = clSnoc(locations, objOfLoc(loc));
      return ans;
    }
  }
  function getLoc(loc: Loc): J.JExprT {
    return jBracket(jId(LOCS), jNum(getLocId(loc)));
  }

  function wrapNewModule(compiler: CompilerVisitor, moduleBody: J.JBlockT): Map<string, J.JExprT> {
    const moduleLocatorsAsJs = CL.map_list((m: CS.AnyDependency) => {
      switch (m.$name) {
        case 'builtin':
          return jObj(clist<J.JFieldT>(
            jField('import-type', jStr('builtin')),
            jField('name', jStr(m.modname)))) as J.JExprT;
        case 'dependency':
          return jObj(clist<J.JFieldT>(
            jField('import-type', jStr('dependency')),
            jField('protocol', jStr(m.protocol)),
            jField('args', jList(true, CL.map_list((s: string) => jStr(s) as J.JExprT, m.arguments))))) as J.JExprT;
        default:
          throw new InternalCompilerError('Unknown Dependency in wrap-new-module');
      }
    }, moduleLocators);
    const providesObj = compileProvides(provides);
    const theModule = jAsyncFun(J.nextJFunId(), makeFunName(compiler, l),
      clist<A.Name>(RUNTIME.id, NAMESPACE.id, sourceName.id).append(inputIds), moduleBody);
    const moduleAndMap = theModule.toUglySourcemap(provides.fromUri, 1, 1, provides.fromUri);
    const out = new Map<string, J.JExprT>();
    out.set('requires', jList(true, moduleLocatorsAsJs));
    out.set('provides', providesObj);
    out.set('nativeRequires', jList(true, clEmpty));
    out.set('theModule',
      compiler.options.collectAll
        ? theModule
        : (compiler.options.moduleEval === false
          ? jRawCode(moduleAndMap.code)
          : jStr(moduleAndMap.code)));
    out.set('theMap', jStr(moduleAndMap.map));
    return out;
  }

  const step = freshId(compilerName('step'));
  const toplevelName = freshId(compilerName('toplevel'));
  const apploc = freshId(compilerName('al'));
  const resumer = compilerName('resumer');
  const resumerBind = new N.ABind(l, resumer, A.aBlank);
  // Hybrid machine: one bytecode compiler per module, holding the program
  // every VM-tier function of this module compiles into. Its globals are the
  // module's cross-module names -- exactly the free ids declared as JS vars
  // above (globalBinds/moduleBinds) plus the imports -- handed to the loader
  // as their JS variables. Created only when the option asks for bytecode
  // and a tier map exists; otherwise the emitter's output is unchanged.
  const vmTiers: string[] = (self.options as any).vmTiers || [];
  let vm: VM.VMModuleCompiler | undefined = undefined;
  if (vmTiers.length > 0 && self.tierMap !== undefined) {
    const externals: A.Name[] = [];
    for (const n of freeIds) { externals.push(n); }
    for (const i of imports) { externals.push(i.name); }
    // The host is installed per root by vmRootExpr; this placeholder is
    // never used for compilation.
    vm = new VM.VMModuleCompiler(makeVmHost(self as CompilerVisitor), externals, vmTiers);
  }
  const bodyCompiler: CompilerVisitor = ext(self, {
    progProvides: progProvides,
    getLoc: getLoc,
    getLocId: getLocId,
    curApploc: apploc,
    resumer: resumer,
    allowTco: false,
    dispatches: casesDispatches,
    localDataDefs: provides.dataDefinitions,
    vm: vm,
  });
  // The toplevel module fn is called directly (`await bodyName()`) and its result
  // is the module value, not driven through a `.app` wrapper, so it must NEVER mint
  // a token: can-mint-tokens = false. A tail-position call at program top drives to
  // a value via the callee's own `.app`.
  const visitedBody0 = compileFunBody(l, step, toplevelName,
    bodyCompiler, // resumer gets js-id-of'ed in compile-fun-body
    [resumerBind], undefined, prog, true, false, false, false);
  // Prepend the bytecode program (if any function of this module compiled to
  // it): `var $BC = R.$vm.load(...)` as the toplevel's first statement, so
  // its thunks see every module-level binding lexically and every
  // `R.$vm.mkFun($BC, ...)` below it finds the program.
  const visitedBody = (vm !== undefined && vm.prog.funcs.length > 0)
    ? jBlock(clCons(vmProgramDecl(vm), jBlockToStmtList(visitedBody0)))
    : visitedBody0;
  const toplevelFun = jAsyncFun(J.nextJFunId(), makeFunName(bodyCompiler, l), clist<A.Name>(formalShadowName(resumer)), visitedBody);
  const defineLocations = jVar(LOCS, jList(true, locations));
  // NOTE: as in the Pyret source, wrap-modules' j-block sits directly in
  // statement position of the outer block; it prints as its statements.
  const moduleBody = jBlock(
    //                    [clist: j-expr(j-str("use strict"))] +
    clSnoc(
      clAppend(
        clSnoc(mkAbbrevs(l), defineLocations as J.JStmt),
        globalBinds),
      wrapModules(moduleSpecs, toplevelName, toplevelFun) as unknown as J.JStmt));
  return wrapNewModule(bodyCompiler, moduleBody);
}

// Eventually maybe we should have a more general "optimization-env" instead of
// flatness-env. For now, leave it since our design might change anyway.

export class SplittingCompiler extends CompilerVisitor {
  private $provides: CS.Provides;

  constructor(
    env: CS.CompileEnvironment,
    addPhase: (phase: string, data: any) => any,
    flatnessEnvs: FL.FlatnessEnv,
    provides: CS.Provides,
    postEnv: CS.ComputedEnvironment,
    options: SplitCompileOptions,
    redundantAnnChecks: Set<string> = new Set(),
    tierMap?: TIER.TierMap
  ) {
    super();
    this.uri = provides.fromUri;
    this.addPhase = addPhase;
    this.options = options;
    this.flatnessEnv = flatnessEnvs[0];
    this.typeFlatnessEnv = flatnessEnvs[1];
    this.flatMethodApps = flatnessEnvs[2];
    this.flatMethods = flatnessEnvs[3];
    this.redundantAnnChecks = redundantAnnChecks;
    this.tierMap = tierMap;
    // Pyret accesses these fields directly; a computed-none here would be a
    // field-not-found error there too.
    this.bindings = (postEnv as CS.ComputedEnv).bindings;
    this.typeBindings = (postEnv as CS.ComputedEnv).typeBindings;
    this.moduleBindings = (postEnv as CS.ComputedEnv).moduleBindings;
    this.env = env;
    this.$provides = provides;
  }

  aProgram(node: N.AProgram): Map<string, J.JExprT> {
    totalTime = 0;
    // This achieves nothing with our current code-gen, so it's a waste of time
    // simplified = body.visit(remove-useless-if-visitor)
    // add-phase("Remove useless ifs", simplified)
    const freevars = N.freevarsProg(new N.AProgram(node.l, node.provides, node.imports, node.body));
    this.addPhase('Freevars-e', freevars);
    // Function-local var box elimination (promise backend codegen knob). Gated
    // on -no-unbox-vars; see collectUnboxableVarKeys.
    this.unboxedVars = this.options.unboxVars
      ? collectUnboxableVarKeys(node.body, this.tierMap, new Set(this.options.vmTiers))
      : new Set();
    this.addPhase('Unboxable vars: ' + this.unboxedVars.size, undefined);
    const ans = compileModule(this, node.l, node.provides, node.imports, node.body, freevars as Map<string, A.Name>, this.$provides, this.env);
    this.addPhase('Total simplification: ' + String(totalTime), undefined);
    return ans;
  }
}

export function splittingCompiler(
  env: CS.CompileEnvironment,
  addPhase: (phase: string, data: any) => any,
  flatnessEnvs: FL.FlatnessEnv,
  provides: CS.Provides,
  postEnv: CS.ComputedEnvironment,
  options: SplitCompileOptions,
  redundantAnnChecks: Set<string> = new Set(),
  tierMap?: TIER.TierMap
): SplittingCompiler {
  return new SplittingCompiler(env, addPhase, flatnessEnvs, provides, postEnv, options, redundantAnnChecks, tierMap);
}
