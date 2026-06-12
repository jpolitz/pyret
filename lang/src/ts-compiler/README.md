# Pyret Compiler — TypeScript Port

This directory contains a TypeScript port of the Pyret compiler that lives
in `src/arr/compiler/*.arr`. The port is **strictly additive**: nothing in
`src/arr/`, `src/js/`, or the existing build targets changed. Programs
compiled by this compiler run on the **unchanged** `src/js/base/runtime.js`
(same value representations, stack management, module and standalone
formats), and its on-disk compiled-module cache is interchangeable with the
Pyret-hosted compiler's.

## Layout

- `src/*.ts` — one file per ported `.arr` file (same base name):
  the full pipeline (`well-formed`, `resolve-scope`, `desugar*`, `anf`,
  `anf-loop-compiler`, `flatness`, `js-of-pyret`, …), the module system
  (`compile-lib`, `compile-structs`, `cli-module-loader`, `locators/`),
  the type checker (`type-check*`, `type-defaults`), and the CLI
  (`pyret.ts`, `cmdline.ts`, `server.ts`).
- Compiler-support trove modules used as *data* by the compiler were also
  ported (`ast`, `srcloc`, `error-display`, `render-error-display`,
  `pprint`); the runtime trove (`src/arr/trove/*`) stays in Pyret and is
  compiled *by* this compiler like any other module.
- Runtime-independent JS is reused, not ported: `pyret-tokenizer.js`, the
  generated `pyret-parser.js`, `lib/jglr/*`, `js-numbers.js` (loaded via
  `src/interop/amd.ts`), plus the npm `source-map` and `ws` packages.
- `CONVENTIONS.md` — the porting rules (data representation, visitors,
  Option/List/StringDict mappings, fidelity requirements).
- `tests/` — unit tests, the parity harness, and its test programs.

## Building and testing (from `lang/`)

| Target | What it does |
|---|---|
| `make ts-compiler` | Generates the parser, installs the local TypeScript toolchain, compiles to `build/ts-compiler/`, and copies the runtime support files (mirroring phaseA's layout). |
| `make ts-unit-test` | Unit tests for individual compiler modules. |
| `make ts-parity-test` | Compiles and runs each program in `tests/programs/` with **both** compilers using the same options (including `-type-check`, `-no-check-mode`, `--checks-format json`, and compile-error cases) and diffs results. |
| `make ts-pyret-test` | Builds `tests/pyret/main2.arr` (the full Pyret test suite) with the TS compiler and runs it. |
| `make ts-test` | All of the above. |
| `make ts-clean` | Removes TS build outputs and caches. |

The CLI is a drop-in for the Pyret-hosted one:

```
node build/ts-compiler/pyret.js --build-runnable foo.arr --outfile foo.jarr \
  --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ \
  --compiled-dir compiled/ --require-config src/scripts/standalone-configA.json
```

All options of `pyret.arr` are supported with identical syntax (single-dash
flags, double-dash value options) and byte-identical per-option usage text
and parse-error messages.

## Verification status

- `ts-parity-test`: 16/16 programs identical (stdout, exit codes, and
  compile-error text byte-for-byte, modulo the "Pyret stack:" trailer —
  see Deviations).
- All test entry points pass when built with this compiler, with output
  identical to the phaseA-built equivalents:
  `tests/pyret/main2.arr` (12,994 tests), `tests/pyret/regression.arr`
  (243, byte-identical output), `tests/type-check/main.arr` (210,
  byte-identical output), `tests/all.arr` (13,408, `-check-all`), and the
  io-tests (13/13 via `src/ts-compiler/tests/io-ts.test.js`, a copy of
  `tests/io-tests/io.test.js` pointed at this compiler). `parse-test`
  covers both compilers: the generated parser/tokenizer under
  `build/ts-compiler/js/` are byte-identical to phaseA's.
  Targets: `ts-regression-test`, `ts-type-check-test`, `ts-io-test`,
  `all-ts-pyret-test`.
- Note: *running* suite standalones requires `require()`-able `vega`;
  the repo's declared `vega@^6` is ESM-only, so use node ≥ 22.12 (or pin
  vega 5) to run them — this applies equally to the existing
  `make pyret-test` and is unrelated to the port.

## Known deviations (all documented at their sites)

1. **`--run` is effectively deprecated** (the public `pyret` npm command
   builds a standalone and runs it in a subprocess instead — see `npm/` at
   the repo root). The port keeps the option but takes the same
   build-then-subprocess approach; prefer `--build-runnable` + `node`.
2. **No "Pyret stack:" trailer** on compile-error exits: the Pyret-hosted
   compiler prints its *own* internal Pyret stack frames there; this
   compiler is not a Pyret program. The error text itself matches
   byte-for-byte.
3. **Iteration-order cosmetics**: Pyret's immutable string-dicts iterate in
   hash-trie order; the port uses `Map` insertion order. This changes the
   *order* (never the content) of: object-literal fields in serialized
   provides, saved-vars in activation records, the module-preamble `var`
   bindings, and `--help` option ordering.
4. **`repl.arr` is ported as a host-parameterized library** (`repl.ts`):
   the compile side (provide rewriting, globals chaining across
   interactions, locator caching) is fully implemented; the three
   runtime-realm touchpoints (`run-program`, `is-success-result`,
   `get-result-realm`) are factored into an injected `ReplExecutor` that
   the host supplies (code.pyret.org wraps load-lib; tests use a stub).
   See `tests/repl-test.js` / `make ts-repl-test`. `server.arr` is also
   ported (`--serve`).
5. The CLI re-execs node once with `--stack-size=8192` (the Pyret-hosted
   compiler recurses on the runtime's segmented stack; the port uses the
   JS stack). Set `PYRET_TS_NO_RESPAWN=1` or pass `--stack-size` yourself
   to disable.

## Browser bundling

`src/browser.ts` is a browser entry point exposing the compile pipeline
plus `repl.ts` with no live node dependencies: sha256 is pure TS
(`src/sha256.ts`), and the interop AMD modules (tokenizer, generated
parser, js-numbers, type-util, jglr) are pre-registered as source text
via `interop/amd.ts`'s `registerModuleSource` hook (see
code.pyret.org's `src/scripts/make-ts-compiler-entry.js`, which
generates the browserify entry; `make web-ts` there builds
`build/web/js/ts-compiler.js` exposing the `PyretTSCompiler` global).

Because browsers have fixed ~1MB stacks (no `--stack-size` escape
hatch), every per-statement recursion in the pipeline is implemented
iteratively: the ANF spine (`anfLinear` in `anf.ts`), the splitting
code generator (generators + the `runChain` driver in
`anf-loop-compiler.ts`), scope resolution (`desugarScopeBlock`'s step
driver), the flatness environment passes, and DAG liveness
(`computeLiveVars`). All of these preserve the exact statement/effect
order of the recursive originals, so generated code is byte-identical;
programs of at least ~5000 statements compile in-browser.

`ReplExecutor.run` may return a Promise (a browser host must thread
execution through the Pyret runtime's async trampoline), so the repl's
`restartInteractions`/`runInteraction` return Promises.
