# Pyret-to-TypeScript Porting Conventions

This directory contains a TypeScript port of the Pyret compiler that lives in
`src/arr/compiler`. The port is **strictly additive**: nothing under
`src/arr/`, `src/js/`, or the existing Makefile targets may change. The TS
compiler must produce compiled modules that run on the *unchanged*
`src/js/base/runtime.js` (same value representations, stack management,
module format).

## Layout

- One `.ts` file per ported `.arr` file, same base name:
  `src/arr/compiler/resolve-scope.arr` → `src/ts-compiler/src/resolve-scope.ts`.
- Compiler-support trove modules that the compiler itself uses as *data*
  (not runtime libraries) are also ported: `ast.arr`, `srcloc.arr`,
  `error-display.arr`, `pprint.arr` → `ast.ts`, `srcloc.ts`,
  `error-display.ts`, `pprint.ts`. The runtime trove (`src/arr/trove/*`)
  stays in Pyret and is still compiled BY this compiler — never ported.
- JS infrastructure that is runtime-independent is *reused, not ported*:
  `pyret-tokenizer.js`, `pyret-parser.js` (generated), `lib/jglr/rnglr.js`,
  `js-numbers.js`. They are AMD modules; load them through
  `src/interop/amd.ts`.
- Build output goes to `build/ts-compiler/` via `tsc -p .`.

## Naming

- kebab-case → camelCase for functions, methods, fields, locals
  (`check-well-formed` → `checkWellFormed`).
- Data variants become PascalCase classes (`s-block` → `SBlock`); the
  original Pyret tag is kept in a readonly `$name` field (`'s-block'`).
- Union type per Pyret `data` declaration: `type Expr = SBlock | SUserBlock | ...`.
- Type guards mirror Pyret `is-` functions: `isSBlock(x)`.
- File-level export style: plain ES module exports, no default exports.

## Data definitions

Pyret:
```pyret
data Expr:
  | s-block(l :: Loc, stmts :: List<Expr>) with:
    method label(self): "s-block" end
sharing:
  method visit(self, visitor): ... end
end
```

TypeScript:
```ts
export abstract class ExprBase {
  abstract get $name(): string;
  abstract visit(visitor: any): any;   // dispatches to visitor[camel($name)](this)
  // `sharing` methods go here
}
export class SBlock extends ExprBase {
  get $name(): 's-block' { return 's-block'; }
  constructor(public l: Loc, public stmts: Expr[]) { super(); }
  visit(visitor: any): any { return visitor.sBlock(this); }
  label(): string { return 's-block'; }
}
export type Expr = SBlock | SUserBlock | /* ... */;
export function isSBlock(x: any): x is SBlock { return x instanceof SBlock; }
```

**Visitor convention difference from Pyret:** Pyret visitors receive the
node's fields as separate arguments. In the TS port a visitor method
receives **the node itself**: `visitor.sBlock(node)`. All ported passes
must follow this convention. Default visitors are classes
(`DefaultMapVisitor`, `DefaultIterVisitor`) that passes `extend` and
selectively override.

- `default-map-visitor` method `s-block(self, l, stmts): s-block(l, stmts.map(_.visit(self)))`
  becomes `sBlock(node: SBlock): Expr { return new SBlock(node.l, node.stmts.map(s => s.visit(this))); }`
- `default-iter-visitor` methods return `boolean`.
- `dummy-loc-visitor` replaces every loc with `dummyLoc`.

## Core type mappings

| Pyret | TypeScript |
|---|---|
| `List<T>` | `T[]` (immutable by convention — never mutate a list you didn't create) |
| `empty` / `link(h, t)` | `[]` / `[h, ...t]` (prefer building with push on fresh arrays) |
| `Option<T>` | `T \| undefined` (`none` → `undefined`, `some(v)` → `v`) |
| `Either<L,R>` | `{ $name: 'left', v: L } \| { $name: 'right', v: R }` (helpers in `shared.ts`) |
| `StringDict<T>` (immutable) | `Map<string, T>` **plus copy discipline** (see below) |
| `MutableStringDict<T>` | `Map<string, T>` |
| `Set<String>` | `Set<string>` |
| sets of `Name` | `Map<string, Name>` keyed by `name.key()` |
| `Number` used as count/index/position | `number` |
| Pyret numeric *literal values* (e.g. `s-num.n`) | opaque `PyretNumber` (js-numbers value; see `interop/js-numbers.ts`) |
| `String` | `string` |
| `raise(<string>)` | `throw new InternalCompilerError(msg)` (in `shared.ts`) |
| `tostring(x)` | explicit: `String(...)`, `.toString()`, or `jsnums.toString` as appropriate |

**Persistent-dict discipline:** Pyret `StringDict` is persistent —
`d.set(k, v)` returns a NEW dict. Where ported code extends a dict and
*also* keeps using the original (common in scope-resolution environments),
you must copy: `const d2 = new Map(d); d2.set(k, v);`. Where the original
is dead after the set, an in-place `d.set(k, v)` is fine. Read each call
site carefully; this is the #1 source of porting bugs. For env-threading
code, prefer the helper `mapSet(d, k, v)` from `shared.ts` which copies.

**Equality discipline:** Pyret `==` is structural. Never translate it to
`===` for compound values. Names compare with `a.key() === b.key()`,
srclocs with `a.key() === b.key()` or dedicated methods (`.same(other)`),
lists of names by element. When Pyret code uses values as `string-dict`
keys via `tostring`/`.key()`, do the same.

- Pyret string `+` on doc/pretty-printing → `.append()` for `PPrintDoc`,
  plain `+` for strings.
- `for fold(...)`/`for map(...)`/`for each(...)` → loops or
  `reduce`/`map`/`forEach`, preserving evaluation ORDER (gensym calls are
  order-sensitive; generated names appear in output and parity tests
  compare output).
- `cases(T) x: | variant(a, b) => ...` → `switch (x.$name) { case 'variant': ... }`
  or `if (x instanceof Variant)`. Use `switch` on `$name` with an
  exhaustiveness `default: throw` when the Pyret cases had no `else`.

## Gensym / name counters

`gensym.arr` and `ast.arr`'s `global-names = MakeName(0)` are global,
resettable counters; `compile-module` resets both before each module.
Preserve exact call order so generated names match the Pyret compiler's
output (`$underscore4`, `tail$5`, etc.) — byte-level parity of emitted JS
is the goal wherever feasible.

## Srcloc

`Srcloc = Builtin(moduleName) | Srcloc(source, startLine, startColumn, startChar, endLine, endColumn, endChar)`.
Port all methods (`format`, `key`, `before`, `after`, `same-file`, `upto`,
`upto-end`, ...). `dummyLoc = new Builtin('dummy location')`.

## Numbers in the AST and codegen

Numeric literals must keep exact rational semantics end to end:
`parse-pyret` constructs them with js-numbers `fromString`; `js-ast.ts`'s
printer must serialize them exactly the way the Pyret compiler does (see
`j-num` handling in `js-ast.arr` / `anf-loop-compiler.arr`). Use the
shared js-numbers library (`interop/js-numbers.ts` wraps
`src/js/base/js-numbers.js`) — do NOT use JS floats for Pyret numbers.

## Output contract (must match the existing compiler)

A compiled module on disk is
`({ theMap, theModule?, nativeRequires, provides, requires })` —
see `cli-module-loader.arr` + `anf-loop-compiler.arr`. The standalone
`.jarr` bundles `{staticModules, depMap, toLoad, uris, runtimeOptions}`
through `js/trove/make-standalone.js` + requirejs exactly like the
current pipeline. Any deviation breaks `runtime.js`/`handalone.js`
loading — when in doubt, diff against output of `build/phaseA/pyret.jarr`.

## Fidelity rules

1. Port logic line by line; do not "improve" algorithms, error messages, or
   traversal order. Error message strings must match exactly (tests may
   compare renderings).
2. Keep one TS function per Pyret function, same name (camelCased), same
   argument order.
3. Comments from the Pyret source that explain *why* may be carried over;
   do not add narration comments.
4. Anything intentionally not ported yet must `throw new TODOError("...")`
   (from `shared.ts`) — never silently return wrong values.
5. `provide *` ⇒ export everything the Pyret module exported.
