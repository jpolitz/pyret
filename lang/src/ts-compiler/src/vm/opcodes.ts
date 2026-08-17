/*
  Opcode table and program-format constants for the hybrid bytecode machine
  ("pvm2") of the promise backend.

  This is the COMPILER side of the contract; the machine side lives in
  src/js/base/runtime-async.js (section "The hybrid bytecode machine"),
  which repeats the same ordered opcode list. tests/vm-unit-test.js diffs
  the two tables, and every emitted program carries FORMAT_VERSION so a
  stale compiled-module cache is refused loudly at load time.

  What is bytecode and what is not
  --------------------------------
  Only functions whose tier verdict is in `CompileOptions.vmTiers` (Gen by
  default) become bytecode. Everything else in the module -- the toplevel,
  flat leaves, the sync tiers -- stays the promise backend's compiled JS.
  A bytecode function is therefore always NESTED in JS somewhere up its
  lexical chain, and JS functions nest inside bytecode functions freely.
  The seam is by-value capture in both directions (sound because ANF is
  single-assignment; mutable bindings are `{"$var": v}` cells bound once,
  and the JS emitter keeps every var that crosses a tier boundary boxed).

  Instruction encoding
  --------------------
  A function's code is a flat array of small non-negative integers: an
  opcode followed by its operands. Destinations are plain local-slot
  indices. Operands that READ a value use the tagged "value source":

      vs & 3 === VS_LOCAL   -> frame locals[vs >> 2]
      vs & 3 === VS_UPVAL   -> closure upvals[vs >> 2]
      vs & 3 === VS_CONST   -> program consts[vs >> 2]
      vs & 3 === VS_GLOBAL  -> module globals[vs >> 2]

  Globals are the module's cross-module names (imports, builtins, type
  globals): the JS emitter hands their already-resolved JS variables to
  the loader as one array, so a bytecode function reads them with no
  capture and no lookup. Everything else free in a bytecode function is an
  upvalue captured by value when the closure is built -- by the enclosing
  bytecode frame (CLOSURE) or by the enclosing JS function
  (`R.$vm.mkFun($BC, idx, [captures])`).

  JS thunks
  ---------
  Value construction that has no business being interpreted -- object
  literals (whose fixed shape V8 wants to see as a literal), data
  declarations, annotation objects, and JS-tier lambdas nested inside a
  bytecode function -- is emitted by the ordinary JS code generator as a
  small JS function whose parameters are the construct's free variables,
  and the bytecode calls it (THUNK). The machine is a control machine: it
  owns calls, returns, suspension, dispatch and the hot field/annotation
  operations, and delegates the rest to the compiler that already knows
  how to emit them.
*/

// Bump when the bytecode format or opcode numbering changes; compiled
// modules cached from an older machine are then rejected on load.
export const FORMAT_VERSION = 1;

// ---------- value sources ----------

export const VS_LOCAL = 0;
export const VS_UPVAL = 1;
export const VS_CONST = 2;
export const VS_GLOBAL = 3;

export const vsLocal = (i: number): number => (i << 2) | VS_LOCAL;
export const vsUpval = (i: number): number => (i << 2) | VS_UPVAL;
export const vsConst = (i: number): number => (i << 2) | VS_CONST;
export const vsGlobal = (i: number): number => (i << 2) | VS_GLOBAL;

// ---------- upvalue descriptors (CLOSURE/METHOD inside bytecode) ----------
// (index << 2) | 0 captures the enclosing frame's local slot `index`;
// (index << 2) | 1 captures the enclosing frame's upvalue `index`;
// (index << 2) | 2 captures program constant `index` -- a name the parent
// aliased to a constant, which the nested function's FAST form still needs
// as a plain parameter (its factory receives the upvalues, nothing else).

export const uvLocal = (i: number): number => i << 2;
export const uvUpval = (i: number): number => (i << 2) | 1;
export const uvConst = (i: number): number => (i << 2) | 2;

// ---------- constant-pool descriptors ----------

export const CONST_NUM_STR = 0;   // [0, "1/3"]   -> R.makeNumberFromString(s)
export const CONST_FIXNUM = 1;    // [1, 42]      -> 42
export const CONST_STR = 2;       // [2, "abc"]
export const CONST_BOOL = 3;      // [3, true]
export const CONST_UNDEFINED = 4; // [4]          -> undefined
export const CONST_RT = 5;        // [5, "nothing"] -> R["nothing"] (a-prim-val, R.Any, ...)
export const CONST_LOC = 6;       // [6, 12]      -> L[12] (a-srcloc)

// ---------- opcodes ----------
// Order is the contract with the machine. Append only.

export const OPCODE_NAMES: readonly string[] = [
  'MOVE',       // d, s                        locals[d] = read(s)
  'BOX',        // d, s                        locals[d] = {"$var": read(s)}
  'UNBOX',      // d, s                        locals[d] = read(s).$var
  'SETVAR',     // b, s, d                     read(b).$var = read(s); locals[d] = nothing
  'LETREC',     // d, s, locK, nameK           checked read of a letrec cell (throws if uninitialized)
  'MODREF',     // d, s, nameK                 read(s).dict.values.dict[name]
  'MODVARREF',  // d, s, nameK                 (as MODREF).$var
  'ARRSET',     // a, idx, s                   read(a)[idx] = read(s)
  'JMP',        // target
  'IF',         // c, elseTarget               checkPyretTrue(read(c)) ? fall through : jump
  'RET',        // s
  'CALL',       // d, f, locK, n, args...      generic call: bytecode callee pushes a frame; JS callee is applied, thenable => suspend
  'CALLFLAT',   // d, f, locK, chk, n, args... callee statically flat: always JS, never a thenable; chk=1 => typeof .app guard
  'TAILCALL',   // f, locK, n, args...         tail call: bytecode callee reuses the frame; JS callee's result is returned (fused RET)
  'METHCALL',   // d, o, nameK, locK, flat, ic, n, args...   maybeMethodCall semantics (+inline cache)
  'METHCALLD',  // d, o, nameK, locK, flat, n, args...       direct dispatch: obj.dict[name].full_meth(obj, args)
  'PRIMAPP',    // d, primK, locK, step, n, args...          R[prim](args); step=1 => thenable check
  'CLOSURE',    // d, funcIdx                  bytecode lambda (upvalues per funcs[funcIdx].u)
  'METHOD',     // d, funcIdx                  bytecode method
  'THUNK',      // d, thunkIdx, locK, step, n, args...       JS thunk call; step=1 => thenable check
  'DOT',        // d, o, nameK, locK           getFieldLoc (fast path inlined)
  'DOTD',       // d, o, nameK                 direct field: o.dict[name]
  'DOTC',       // d, o, nameK, locK, direct, cellVs   LICM-memoized read: cell ??= read; write-through to the cell's source
  'COLON',      // d, o, nameK, locK
  'GETBANG',    // d, o, nameK, locK
  'TUPLEGET',   // d, t, idx, locK
  'CASES',      // v, dispatchIdx, locK, elseTarget
  'CASESPRE',   // v, branchArity, branchLocK, casesLocK   (arity checks; -1 = singleton branch)
  'CASESBIND',  // v, n, ic, (d, isRef) * n     reflective field binding via $constructor.$fieldNames
  'CASESBINDD', // v, n, (d, nameK, mode) * n   direct: statically known field names; mode: 0 plain, 1 deref(isRef,lookupIsRef) packed as 1|(isRef<<1)|(lookupIsRef<<2)
  'ANNCHECKV',  // a, v, locK, step            _checkAnn(loc, read(a), read(v)); step=1 => thenable check
  'TUPLECHK',   // v, n, locK
  'NEWTYPE',    // dBrander, dAnn, nameK, locK
  'NOP',        // (placeholder)
] as const;

const ops: Record<string, number> = {};
OPCODE_NAMES.forEach((n, i) => { ops[n] = i; });

export const OP_MOVE = ops.MOVE;
export const OP_BOX = ops.BOX;
export const OP_UNBOX = ops.UNBOX;
export const OP_SETVAR = ops.SETVAR;
export const OP_LETREC = ops.LETREC;
export const OP_MODREF = ops.MODREF;
export const OP_MODVARREF = ops.MODVARREF;
export const OP_ARRSET = ops.ARRSET;
export const OP_JMP = ops.JMP;
export const OP_IF = ops.IF;
export const OP_RET = ops.RET;
export const OP_CALL = ops.CALL;
export const OP_CALLFLAT = ops.CALLFLAT;
export const OP_TAILCALL = ops.TAILCALL;
export const OP_METHCALL = ops.METHCALL;
export const OP_METHCALLD = ops.METHCALLD;
export const OP_PRIMAPP = ops.PRIMAPP;
export const OP_CLOSURE = ops.CLOSURE;
export const OP_METHOD = ops.METHOD;
export const OP_THUNK = ops.THUNK;
export const OP_DOT = ops.DOT;
export const OP_DOTD = ops.DOTD;
export const OP_DOTC = ops.DOTC;
export const OP_COLON = ops.COLON;
export const OP_GETBANG = ops.GETBANG;
export const OP_TUPLEGET = ops.TUPLEGET;
export const OP_CASES = ops.CASES;
export const OP_CASESPRE = ops.CASESPRE;
export const OP_CASESBIND = ops.CASESBIND;
export const OP_CASESBINDD = ops.CASESBINDD;
export const OP_ANNCHECKV = ops.ANNCHECKV;
export const OP_TUPLECHK = ops.TUPLECHK;
export const OP_NEWTYPE = ops.NEWTYPE;
export const OP_NOP = ops.NOP;

// ---------- inline-cache widths ----------

export const IC_WIDTH_METHCALL = 4;  // shape, member, callee-pvm, is-method
export const IC_WIDTH_CASESBIND = 3; // shape, $fieldNames, $mut_fields_mask

// ---------- emitted program shape ----------

export interface VMFunc {
  /** Display name, used for arity errors and stack frames. */
  n: string;
  /** Declared arity (methods: including self). */
  a: number;
  /** True for `a-method` bodies: arity errors read differently. */
  m: boolean;
  /** Number of local slots the frame needs. */
  s: number;
  /** Upvalue capture descriptors (see uvLocal/uvUpval) -- only meaningful
      when the function is created by CLOSURE/METHOD from bytecode; a
      function created from JS receives its upvalues as an array in the
      same order (see `jsUpvals`). */
  u: number[];
  /** Instruction stream. */
  c: number[];
  /** Loc index (into the module's L table) of the function itself. */
  l: number;
  /** Fast JS form: index of the factory thunk (called with the upvalues
      as arguments, returns the plain JS function), or -1 when the
      function is interpreted from the start. */
  ff: number;
}

export interface VMProgram {
  v: number;
  /** Interned strings: field names, prim names, identifier names. */
  names: string[];
  consts: any[][];
  /** Number of globals; the loader receives their values as an array. */
  nglobals: number;
  funcs: VMFunc[];
  /** cases dispatch tables: variant name -> branch pc. */
  dispatches: Array<Record<string, number>>;
  /** Length of the inline-cache array (allocated per instantiation). */
  ncaches: number;
  /** Number of JS thunks; the loader receives them as an array. */
  nthunks: number;
}
