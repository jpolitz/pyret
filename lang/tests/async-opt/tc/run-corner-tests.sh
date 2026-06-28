#!/bin/bash
# Differential test harness for the tail-call-in-effect-position optimization
# (src/ts-compiler/src/ast-util.ts, SetTailVisitor.sIfElse).
#
# For each tc-*.arr: compile three ways with the SAME ts-compiler binary --
#   (1) optimized   (default,                 promise backend)
#   (2) baseline    (-no-effect-tail-calls,   promise backend)  <- ground-truth oracle
#   (3) optimized   (default,                 cont backend)
# Assert all three produce identical output (the optimization must never change a
# program's result), and check whether OUR rule fired (a TCO `continue` present in
# the optimized build but not the baseline) against the per-test expectation.
#
# Self-locating: works from any cwd / in CI. Exits non-zero on any failure.
# Overridable: NODE22, NODE env vars (default node22/node); CAP heap cap MB.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$(cd "$HERE/../../.." && pwd)"   # tests/async-opt/tc -> lang/
cd "$LANG_DIR"
NODE22="${NODE22:-node22}"
NODE="${NODE:-node}"
# Standalones run under node22 locally; fall back to plain node (e.g. CI installs
# a single node and no `node22` binary).
command -v "$NODE22" >/dev/null 2>&1 || NODE22="$NODE"
CAP="${CAP:-4096}"
PYRET="build/ts-compiler/pyret.js"
if [ ! -f "$PYRET" ]; then echo "ERROR: $PYRET not found (run 'make ts-compiler' first)"; exit 2; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
D_OPT_P="$WORK/opt-promise"; D_BASE_P="$WORK/base-promise"; D_OPT_C="$WORK/opt-cont"
mkdir -p "$D_OPT_P" "$D_BASE_P" "$D_OPT_C" "$WORK/jarr"

PY="$NODE --max-old-space-size=$CAP $PYRET --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/"
CFG_P="src/scripts/standalone-configA-async.json"
CFG_C="src/scripts/standalone-configA.json"

# expected "our rule fired" per test id (see README.md for the rationale)
declare -A EXP=(
  [tc-01]=yes [tc-02]=yes [tc-03]=yes [tc-04]=yes [tc-05]=no  [tc-06]=no  [tc-07]=no
  [tc-08]=no  [tc-09]=no  [tc-10]=yes [tc-11]=no  [tc-12]=no  [tc-13]=yes [tc-14]=no
  [tc-15]=no  [tc-16]=no  [tc-17]=no  [tc-18]=no  [tc-19]=no
  [tc-20]=no  [tc-21]=no  [tc-22]=no  [tc-23]=no  [tc-24]=no  [tc-25]=no
  [tc-26]=no  [tc-27]=no  [tc-28]=no  [tc-29]=no  [tc-30]=no  [tc-31]=no
  [tc-32]=no  [tc-33]=no  [tc-34]=no  [tc-35]=no  [tc-36]=no  [tc-37]=no
  [tc-38]=no  [tc-39]=no  [tc-40]=no  [tc-41]=no  [tc-42]=no  [tc-43]=no
  [tc-44]=no  [tc-45]=no  [tc-46]=no  [tc-47]=no  [tc-48]=no  [tc-49]=no
  [tc-50]=no  [tc-51]=no  [tc-52]=no  [tc-53]=no
  [tc-54]=no  [tc-55]=no  [tc-56]=no  [tc-57]=no )

build () { # <compiled-dir> <config> <backend-flags> <opt-flags> <arr> <out>
  $PY --require-config "$2" $3 --compiled-dir "$1" --outfile "$6" \
      --build-runnable "$5" -no-check-mode $4 >/dev/null 2>&1
}
contin () { # <compiled-dir> <testbase> -> true if module has a TCO `continue`
  local f; f=$(ls "$1/$2".arr-*-module.js 2>/dev/null | head -1)
  [ -n "$f" ] && grep -q 'continue' "$f" && echo true || echo false
}
# Per-test run-time heap cap, in MB. The space-sensitive tests (deep tail loops)
# need a tight cap so that a TCO regression -- which only leaks frames, leaving the
# RESULT correct right up until it exhausts memory -- turns into an OOM (output
# mismatch) instead of silently passing. A test opts in with a `# runcap: N` header;
# everything else uses the global CAP.
runcap_of () { grep -oiE 'runcap:[[:space:]]*[0-9]+' "$1" | grep -oE '[0-9]+' | head -1; }
runjarr () { local cap="${2:-$CAP}"; NODE_PATH="$LANG_DIR/node_modules" $NODE22 --max-old-space-size="$cap" "$1" 2>&1 | tr '\n' '|'; }

printf "%-22s %-10s %-6s %-6s %-4s %s\n" TEST OUTPUT corr fired exp VERDICT
PASS=0; FAIL=0
for arr in tests/async-opt/tc/tc-*.arr; do
  base=$(basename "$arr" .arr); id=$(echo "$base" | grep -oE '^tc-[0-9]+')
  jo="$WORK/jarr/$base.opt.p.jarr"; jb="$WORK/jarr/$base.base.p.jarr"; jc="$WORK/jarr/$base.opt.c.jarr"
  build "$D_OPT_P"  "$CFG_P" "--stack-backend promise" ""                      "$arr" "$jo"
  build "$D_BASE_P" "$CFG_P" "--stack-backend promise" "-no-effect-tail-calls" "$arr" "$jb"
  build "$D_OPT_C"  "$CFG_C" ""                        ""                      "$arr" "$jc"
  rc=$(runcap_of "$arr"); rc="${rc:-$CAP}"
  o=$(runjarr "$jo" "$rc"); b=$(runjarr "$jb" "$rc"); c=$(runjarr "$jc" "$rc")
  co=$(contin "$D_OPT_P" "$base"); cb=$(contin "$D_BASE_P" "$base")
  # For tests that RAISE, the error message + location + offending value must match
  # across builds, but the trailing "Pyret stack:" trace legitimately differs -- the
  # promise backend elides async tail frames (see commit b535468f1). Strip it before
  # comparing so an annotation/error preserved identically still counts as equal,
  # while a dropped check (value instead of error) still shows as a mismatch.
  on=$(printf '%s' "$o" | sed 's/Pyret stack:.*//')
  bn=$(printf '%s' "$b" | sed 's/Pyret stack:.*//')
  cn=$(printf '%s' "$c" | sed 's/Pyret stack:.*//')
  corr=PASS; { [ "$on" = "$bn" ] && [ "$on" = "$cn" ]; } || corr=FAIL
  fired=no; { [ "$co" = true ] && [ "$cb" = false ]; } && fired=yes
  exp=${EXP[$id]}
  verdict=ok; { [ "$corr" = PASS ] && [ "$fired" = "$exp" ]; } || verdict=FAIL
  [ "$verdict" = ok ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
  printf "%-22s %-10s %-6s %-6s %-4s %s\n" "$base" "${o:0:10}" "$corr" "$fired" "$exp" "$verdict"
done
echo "----"
echo "effect-tail corner tests: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
