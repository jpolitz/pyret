# Hybrid bytecode machine: staged, paired results

Promise backend (`--stack-backend promise`, the branch's optimized default,
"p") vs the same TS compiler with the hybrid machine on
(`--vm-tiers gen`, "h"). Everything below was measured on this box
(2 cores, node v24), PAIRED and INTERLEAVED in one session per table
(`tests/async-opt/run-hybrid-table.sh N`: rep i runs every bench p then h,
or h then p on even reps), medians of N, in-process LOOP-MS (jarr load
excluded). Both flavors share one runtime file, so a runtime change lands
on both sides of a table. Ratios < 1 favor the hybrid.

Read the numbers as a few percent of noise: the same jarr moves ~3-5%
run to run on this box; the bootstrap is the number to trust.

## Oracles (all green at the endpoint)

| oracle | result |
|---|---|
| `make vm-test` (differential harness: 6 tier-boundary programs + 14 canonical stack/tier programs, promise vs hybrid, identical stdout/stderr/exit; heap caps; verifier) | 20/20 |
| `make hybrid-bootstrap-check` (compiler built all-JS vs built hybrid, each compiling the compiler, cold caches; `cmp` of the standalones) | BYTE-IDENTICAL (25.9 MB, 164/164 modules) |
| `make ts-hybrid-pyret-test` (full `tests/pyret/main2.arr`, hybrid) | **13628 tests passed** |
| the 49 main2-exec files built and run one by one in hybrid | 49/49 shipshape |
| curated 16-bench output parity p vs h | 16/16 |
| `make vm-unit-test` (opcode table / format parity, structural verifier over caches) | ok |

## Stage 1 -- the machine as the Gen tier (`--vm-fast none`)

Every Gen-verdict function is bytecode; calls from JS enter the machine.

Curated benches, N=3 (`results/table-stage1.txt`):

benchmark                |    p_med    p_min |    h_med    h_min |    h/p  min_r | parity
bench-spell              |    2.130    2.084 |    1.995    1.945 |  0.937  0.933 | OK
bench-car-compute        |    1.966    1.959 |    2.341    2.339 |  1.191  1.194 | OK
bench-car-render         |    2.610    2.404 |    2.439    2.379 |  0.934  0.990 | OK
bench-lander             |    2.386    2.367 |    2.245    2.190 |  0.941  0.925 | OK
bench-orbital-compute    |    1.621    1.619 |    1.462    1.455 |  0.902  0.899 | OK
bench-orbital-ems        |    1.399    1.373 |    1.295    1.247 |  0.926  0.908 | OK
bench-orbital-render     |    2.379    2.364 |    2.482    2.437 |  1.043  1.031 | OK
bench-boids-compute      |    2.433    2.399 |    2.588    2.501 |  1.064  1.043 | OK
bench-boids-compute-data |    1.693    1.663 |    1.718    1.670 |  1.015  1.004 | OK
bench-boids-raster       |    2.448    2.422 |    2.490    2.481 |  1.017  1.024 | OK
bench-vec-methods        |    1.007    0.986 |    1.216    1.214 |  1.208  1.231 | OK
bench-matrix             |    1.825    1.770 |    2.108    2.076 |  1.155  1.173 | OK
bench-dtree              |    0.792    0.774 |    0.814    0.802 |  1.028  1.036 | OK
bench-kmeans             |    1.483    1.400 |    1.483    1.428 |  1.000  1.020 | OK
bench-plagiarism         |    0.799    0.734 |    0.753    0.736 |  0.942  1.003 | OK
bench-seam               |    1.922    1.801 |    1.912    1.841 |  0.995  1.022 | OK
geomean h/p (medians): 1.015 over 16 benches

Compiler bootstrap (`tests/async-opt/vm/bootstrap-time.sh 3`; each builder
compiles src/arr/compiler/pyret.arr from a cold cache, alternating):
promise 38.0s, hybrid 37.0s -> **0.974**.

Reading: the machine wins where the async backend pays per call --
recursion, method-heavy dispatch chains -- and loses ~15-20% on
straight-line and self-loop Gen bodies (car-compute, vec-methods, matrix)
where an `async function` costs one promise per CALL amortized over a
whole native loop, and interpretation is pure overhead per iteration.
Post-mortem numbers on the machine itself (`PYRET_VM_PROFILE=1`): dispatch
~17ns/instruction, ~30ns extra per bytecode->JS call (a megamorphic call
site by construction). The bytecode-only trove is half the size of the JS
one (below).

## Stage 2 -- fast JS forms with bailout into the machine (`--vm-fast all`, default)

Every Gen function ALSO gets a plain sync JS body whose suspend sites bail
into the machine only when a thenable actually arrives (see
src/ts-compiler/src/vm/README.md). JS callers run the fast form; the
machine runs the remainder of an activation after a real suspension and
hands back to native code at the next bottom-frame tail call;
bytecode->bytecode calls interpret (deep recursion stays on heap frames).

Curated benches, N=3 (`results/table-stage2.txt`):

benchmark                |    p_med    p_min |    h_med    h_min |    h/p  min_r | parity
bench-spell              |    2.117    2.092 |    1.743    1.660 |  0.823  0.793 | OK
bench-car-compute        |    1.967    1.920 |    1.968    1.949 |  1.001  1.015 | OK
bench-car-render         |    2.435    2.408 |    2.492    2.422 |  1.023  1.006 | OK
bench-lander             |    2.535    2.200 |    2.307    2.275 |  0.910  1.034 | OK
bench-orbital-compute    |    1.702    1.685 |    1.324    1.252 |  0.778  0.743 | OK
bench-orbital-ems        |    1.414    1.386 |    1.478    1.453 |  1.045  1.048 | OK
bench-orbital-render     |    2.453    2.434 |    2.411    2.375 |  0.983  0.976 | OK
bench-boids-compute      |    2.452    2.399 |    2.102    2.039 |  0.857  0.850 | OK
bench-boids-compute-data |    1.681    1.645 |    1.707    1.642 |  1.015  0.998 | OK
bench-boids-raster       |    2.381    2.311 |    2.142    2.137 |  0.900  0.925 | OK
bench-vec-methods        |    0.984    0.972 |    1.010    0.965 |  1.026  0.993 | OK
bench-matrix             |    1.844    1.799 |    1.730    1.704 |  0.938  0.947 | OK
bench-dtree              |    0.852    0.800 |    0.822    0.820 |  0.965  1.025 | OK
bench-kmeans             |    1.487    1.370 |    1.476    1.360 |  0.993  0.993 | OK
bench-plagiarism         |    0.804    0.792 |    0.783    0.783 |  0.974  0.989 | OK
bench-seam               |    1.892    1.808 |    1.953    1.876 |  1.032  1.038 | OK
geomean h/p (medians): 0.951 over 16 benches

Bootstrap: promise 35.7s, hybrid 34.3s -> **0.961**.

Machine profile per bench under stage 2 (executed bytecode instructions /
bailouts): orbital-ems 49k / 520, car-compute 293k / 2058, vec-methods
61k / 4367, seam 21k / 1305 -- interpretation is ~1% of the work; the
machine is a suspension mechanism, not the executor.

Measured and NOT adopted: running the callee's fast form on
bytecode->bytecode CALLs (`PYRET_VM_FAST_CALL_DEPTH`, default 0). It puts
recursion back on the JS stack where the fuel unwinds it every 500 levels
into one machine state per level: gdeep 2M levels 4.2s/1.5GB vs 2.2s/818MB
interpreting (all-JS backend 3.4-4.4s/1.6GB), and the curated benches
gained nothing (post-bailout interpretation is ~1% of their instructions).

## Deep recursion and space (stage 2)

| program | promise | hybrid |
|---|---|---|
| tier-08-gen-deep at 2M levels (Gen non-tail recursion through a TailFlat helper) | 3.4-4.4s, 1.6 GB | 2.0-2.2s, 818 MB |
| vm-02-mutual-tco (Gen<->Gen mutual TAIL recursion, 3M deep, 3 helper calls per level) | 2.5s, 513 MB | 1.35s, 165 MB |
| vm-01-cross-deep (300k levels alternating JS/bytecode per level) | 1.17s, 477 MB | 1.14s, 471 MB |
| deep-nontail (1M levels; `sum` is FewSuspend -> JS in both) | 0.79s | 0.76s |

## Size (30-module trove + hello, this compiler, `-no-check-mode`)

| configuration | modules raw | modules gz | standalone | standalone gz |
|---|---:|---:|---:|---:|
| promise (all JS) | 6.67 MB | 990 KB | 10.34 MB | 1.57 MB |
| hybrid, `--vm-fast none` (bytecode only) | 3.26 MB (49%) | 525 KB (53%) | 6.93 MB | 1.10 MB (70%) |
| hybrid, `--vm-fast loops` (fast forms for the 25/289 looping Gen fns) | 3.33 MB | 538 KB | 6.99 MB | 1.11 MB |
| **hybrid, `--vm-fast all` (default)** | 5.94 MB (89%) | 955 KB (96%) | 9.61 MB | 1.53 MB (98%) |

The default is smaller than the all-JS build even though every Gen
function ships twice: the async residue is gone, JS-tier lambdas nested
in Gen functions are emitted once (as the thunk both forms build them
from), and bytecode is compact. The bytecode-only configuration is the
size-optimized point (half the trove) at stage-1 speed. Compiler
standalone (phaseB): 33.8 MB all-JS vs 22.7 MB bytecode-only.

## Runtime change shared by both flavors

`_checkAnn` short-circuits a passing `PPrimAnn` (primitive AND data-type
annotations) to `pred(val)` -- exactly what its five-call path computed
for that case. Landed after the stage-0 baseline; every table above has it
on both sides (it moved vec-methods p from ~1.5s to ~1.0s and spell p from
2.37s to 2.13s).

## Endpoint (all of the above landed; format v3, step hook, site table), N=3

results/table-endpoint.txt: geomean h/p **0.975**, parity 16/16.
Same shape as stage 2 except bench-spell, which read 0.82 in the stage-2
session and 1.02 here -- the PROMISE side of spell moved from ~2.1s to
~1.6s between sessions with byte-identical compiled modules (only the
shared runtime file changed, in places the promise flavor never executes),
so treat spell as noisy at the +-20% level on this box and the geomean as
"0.95-0.98". Every other bench reproduced within a few percent
(orbital-compute 0.78, boids-compute 0.85, boids-raster 0.94, matrix 0.96,
lander 0.96, car-compute 0.97; orbital-ems 1.06 and plagiarism 1.06 on the
other side, both image/dict-library dominated). Final oracle pass at this
endpoint: `make vm-test` 22/22 (also under `VM_FAST=none` and
`VM_TIERS=nonflat`), main2-exec 13202 pass, type-check suite 210/210 (both
flavors), `make vm-unit-test` ok.

## Engine portability (JSC): the same table under bun 1.3.14

\`NODE=bun tests/async-opt/run-hybrid-table.sh 2\` (results/table-stage2-bun.txt):
geomean h/p **0.951**, parity 16/16 -- the same shape as under V8 (spell
0.80, orbital-compute 0.74, boids-compute 0.72; car-compute 1.08, seam
1.06). Both flavors run unmodified under bun.

## Tier boundary experiment: `--vm-tiers nonflat` (TailFlat + FewSuspend on the machine too)

results/table-nonflat-vs-gen.txt (N=2, both hybrid; p = gen, h = nonflat):
geomean **1.021**, parity 16/16 -- worse. The sync tiers' own emissions
(direct tail returns; guarded resume closures) are already at native
speed, and putting them on the machine only adds per-call wrappers and
bailout sites (plus bytecode to ship). Gen is the boundary; `nonflat`
stays available as a knob. (`make vm-test` passes under `VM_TIERS=nonflat`.)

## code.pyret.org: the ts-hybrid flavor and the browser suite

`make web-ts-hybrid` in code.pyret.org builds `cpo-main-ts-hybrid.jarr` --
the CPO trove compiled BY THE TS COMPILER with `--stack-backend promise
--vm-tiers gen` (unlike ts-promise, whose bundle phaseA builds), plus the
same in-browser compiler bundle; `?compiler=ts-hybrid` selects it and
cpo-main-ts.js compiles the user's program the same way.

Browser suite (`browser-test/`, the Playwright port of code.pyret.org's
mocha assertions on the real /editor page; Chrome for Testing 149):

| flavor | pass | fail | failing set |
|---|---:|---:|---|
| ts-promise | 237 | 5 | url-imports (spec file absent on this branch), big-programs x2 (240s timeouts), stop-during-load, rapid-rerun, effective-ids (editor contracts this branch's editor lacks) |
| ts-hybrid | 237 | 5 | the SAME five |

(results/browser-cpo-ts-*.txt.) The 237 mirrored upstream assertions --
check blocks, errors, images, tables, charts, type-check, REPL -- pass on
the machine-backed editor exactly as on the promise one.

CPO bundle sizes (built by the same TS compiler; min = uglify --compress):

| bundle | raw | gz | min+gz |
|---|---:|---:|---:|
| TS compiler, promise all-JS (`--vm-tiers none`) | 20.35 MB | 2.96 MB | 2.70 MB |
| TS compiler, hybrid default (`--vm-tiers gen --vm-fast all`) | 20.39 MB | 3.10 MB | 2.84 MB |
| (reference) phaseA-built ts-promise bundle shipped today | 15.85 MB | 2.50 MB | 2.28 MB |

On the CPO trove the default hybrid is size-neutral raw and +5% gzipped
(bytecode JSON gzips worse than the JS it sits next to; the CLI trove came
out 89%/96%). The bytecode-only configuration is the size play (about half),
at stage-1 speed. Note the TS-compiler-built bundles are larger than the
phaseA-built one because of the TS optimizer's inliner, independent of the
machine.

## Capabilities demonstrated

- Unbounded bytecode recursion on heap frames (gdeep 2M levels, 818 MB vs
  1.6 GB); proper tail calls between bytecode functions (vm-02, 165 MB vs
  513 MB); compiled<->bytecode alternation to any depth with suspension
  crossing both ways (vm-01, tier-08, the compiler bootstrap).
- **Pause/inspect at any interpreted instruction from outside the program**:
  `R.$vm.setHook(fn)` / global `PYRET_VM_HOOK` -- the hook sees the top
  frame (name, source loc, pc, opcode, call-site loc, live slots), the depth,
  and can materialize the whole stack lazily; returning a thenable parks
  the entire bytecode stack and resumes at the same instruction.
  `tests/async-opt/vm/step-hook-test.js` (in `make vm-test`) pauses a
  200k-deep Gen recursion 14 times at depths up to 200001, sees 2.8M
  instructions, and the program's output is unchanged (0.8s total). Under
  `--vm-fast none` every Gen-tier function is steppable from its first
  instruction; under the default, everything after a suspension is.

## Found along the way (runtime fixes, both flavors)

- `_checkAnn`'s PPrimAnn fast path (above).
- The spy renderer concatenated the srcloc `format` method's result without
  `safeCall`, printing `(at [object Promise])` whenever that method was
  compiled async (the promise build; the hybrid printed the location because
  its fast form returns synchronously) -- fixed in the runtime; pinned by
  vm-07-spy.

## Against cont (what students run today), measured on this box

The TS compiler's cont backend (`--stack-backend cont`, byte-identical to
the Pyret-hosted cont compiler's output -- the branch's parity oracle) as
the p side; three paired N=3 tables in one session (results/table-cont-vs-*.txt).
Geomeans of medians over the 16 benches:

| vs cont | geomean | notes |
|---|---:|---|
| promise (this branch's default) | **0.788** | reproduces the branch's own 0.807 |
| hybrid, pure machine (`--vm-fast none`) | **0.832** | half-size trove |
| hybrid, default (fast forms) | **0.769** | |

Per bench (median s), cont / promise / pure machine / default hybrid:
spell 2.9 / 1.6 / 2.0 / 1.8; car-compute 2.5 / 2.0 / 2.4 / 1.9;
orbital-compute 2.1 / 1.7 / 1.5 / 1.3; boids-compute-data 2.6 / 1.7 / 1.7 /
1.8; vec-methods 2.6 / 1.06 / 1.31 / 1.07; matrix 2.9 / 1.96 / 2.10 / 1.78;
dtree 1.0 / 0.79 / 0.81 / 0.78; the render benches (car-render, lander,
orbital-render, boids-raster, seam, orbital-ems) sit at 0.9-1.0 for all
three, being image-library bound.
