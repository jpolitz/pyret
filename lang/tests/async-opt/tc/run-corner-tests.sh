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
  [tc-08]=no  [tc-09]=no  [tc-10]=yes [tc-11]=no  [tc-12]=no  [tc-13]=yes [tc-14]=no )

build () { # <compiled-dir> <config> <backend-flags> <opt-flags> <arr> <out>
  $PY --require-config "$2" $3 --compiled-dir "$1" --outfile "$6" \
      --build-runnable "$5" -no-check-mode $4 >/dev/null 2>&1
}
contin () { # <compiled-dir> <testbase> -> true if module has a TCO `continue`
  local f; f=$(ls "$1/$2".arr-*-module.js 2>/dev/null | head -1)
  [ -n "$f" ] && grep -q 'continue' "$f" && echo true || echo false
}
runjarr () { NODE_PATH="$LANG_DIR/node_modules" $NODE22 --max-old-space-size=$CAP "$1" 2>&1 | tr '\n' '|'; }

printf "%-22s %-10s %-6s %-6s %-4s %s\n" TEST OUTPUT corr fired exp VERDICT
PASS=0; FAIL=0
for arr in tests/async-opt/tc/tc-*.arr; do
  base=$(basename "$arr" .arr); id=$(echo "$base" | grep -oE '^tc-[0-9]+')
  jo="$WORK/jarr/$base.opt.p.jarr"; jb="$WORK/jarr/$base.base.p.jarr"; jc="$WORK/jarr/$base.opt.c.jarr"
  build "$D_OPT_P"  "$CFG_P" "--stack-backend promise" ""                      "$arr" "$jo"
  build "$D_BASE_P" "$CFG_P" "--stack-backend promise" "-no-effect-tail-calls" "$arr" "$jb"
  build "$D_OPT_C"  "$CFG_C" ""                        ""                      "$arr" "$jc"
  o=$(runjarr "$jo"); b=$(runjarr "$jb"); c=$(runjarr "$jc")
  co=$(contin "$D_OPT_P" "$base"); cb=$(contin "$D_BASE_P" "$base")
  corr=PASS; { [ "$o" = "$b" ] && [ "$o" = "$c" ]; } || corr=FAIL
  fired=no; { [ "$co" = true ] && [ "$cb" = false ]; } && fired=yes
  exp=${EXP[$id]}
  verdict=ok; { [ "$corr" = PASS ] && [ "$fired" = "$exp" ]; } || verdict=FAIL
  [ "$verdict" = ok ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
  printf "%-22s %-10s %-6s %-6s %-4s %s\n" "$base" "${o:0:10}" "$corr" "$fired" "$exp" "$verdict"
done
echo "----"
echo "effect-tail corner tests: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
