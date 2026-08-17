#!/bin/bash
# Differential harness for the hybrid bytecode machine: every program in
# this directory (plus a few canonical stack tests) is built TWICE with the
# same TS compiler -- promise (all JS) and hybrid (-vm-tiers ${VM_TIERS:-gen})
# -- and must produce IDENTICAL stdout, stderr and exit code. Programs that
# fail to compile prove nothing and are reported as failures. Also checks
# each hybrid module actually contains bytecode (grep $vm.load), verifies
# the bytecode structurally, and runs the deep/mutual programs under a heap
# cap so a frame leak fails loudly.
# Self-locating; exits non-zero on any failure. Overridable: NODE, VM_TIERS, VM_FAST.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$(cd "$HERE/../../.." && pwd)"
cd "$LANG_DIR"
export NODE_PATH="$LANG_DIR/node_modules"
NODE="${NODE:-node}"
VM_TIERS="${VM_TIERS:-gen}"
VM_FAST="${VM_FAST:-all}"
PYRET="build/ts-compiler/pyret.js"
[ -f "$PYRET" ] || { echo "ERROR: $PYRET not found (make ts-compiler)"; exit 2; }
WORK="${WORK:-$(mktemp -d)}"
KEEP="${KEEP:-}"
[ -n "$KEEP" ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/p" "$WORK/h" "$WORK/jarr"
PY="$NODE --max-old-space-size=4096 $PYRET --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ --require-config src/scripts/standalone-configA-async.json --stack-backend promise"
PASS=0; FAIL=0
ok()  { printf "%-40s %s\n" "$1" "PASS"; PASS=$((PASS+1)); }
bad() { printf "%-40s %s\n" "$1" "FAIL${2:+ ($2)}"; FAIL=$((FAIL+1)); }

PROGS="$(ls "$HERE"/vm-*.arr) tests/async-opt/deep-nontail.arr tests/async-opt/tier/tier-07-gen-err.arr tests/async-opt/tier/tier-08-gen-deep.arr tests/async-opt/tier/tier-04-gen.arr tests/async-opt/tier/tier-05-cases.arr tests/async-opt/tier/tier-06-tco-exclusion.arr tests/async-opt/mutual-tco-test.arr tests/async-opt/tco-test.arr tests/async-opt/varmut.arr tests/async-opt/v-var.arr tests/async-opt/v-var-tail.arr tests/async-opt/v-var-when.arr tests/async-opt/v-func.arr"
# heap caps (MB) for the space-sensitive programs -- applied to the HYBRID
# run only (the promise build of vm-02 needs ~520MB: its mutual tail chain
# is bounced through tokens but every fuel suspension leaves a promise
# behind; the machine's frame reuse runs it in ~140MB).
declare -A CAP=( [vm-02-mutual-tco]=${CAP_TCO:-300} )

for src in $PROGS; do
  base=$(basename "$src" .arr)
  pj="$WORK/jarr/$base.p.jarr"; hj="$WORK/jarr/$base.h.jarr"
  if ! $PY --compiled-dir "$WORK/p" --outfile "$pj" --build-runnable "$src" >"$pj.build" 2>&1; then
    bad "$base" "promise build failed"; tail -3 "$pj.build" | sed 's/^/    /'; continue
  fi
  if ! $PY --compiled-dir "$WORK/h" --vm-tiers "$VM_TIERS" --vm-fast "$VM_FAST" --outfile "$hj" --build-runnable "$src" >"$hj.build" 2>&1; then
    bad "$base" "hybrid build failed"; tail -3 "$hj.build" | sed 's/^/    /'; continue
  fi
  if ! grep -q 'R\.\$vm\.load(' "$hj"; then bad "$base" "hybrid jarr has no bytecode"; continue; fi
  cap="${CAP[$base]:-4096}"
  $NODE --max-old-space-size=4096 "$pj" >"$pj.out" 2>"$pj.err"; pc=$?
  $NODE --max-old-space-size=$cap "$hj" >"$hj.out" 2>"$hj.err"; hc=$?
  if [ "$pc" != "$hc" ]; then bad "$base" "exit $pc vs $hc"; tail -3 "$hj.err" | sed 's/^/    /'; continue; fi
  if ! cmp -s "$pj.out" "$hj.out"; then bad "$base" "stdout differs"; diff "$pj.out" "$hj.out" | head -8 | sed 's/^/    /'; continue; fi
  if ! cmp -s "$pj.err" "$hj.err"; then bad "$base" "stderr differs"; diff "$pj.err" "$hj.err" | head -8 | sed 's/^/    /'; continue; fi
  ok "$base"
done

# The step hook: pause/resume of a bytecode stack from outside the program
# (tests/async-opt/vm/step-hook-test.js), on a --vm-fast none build so the
# deep Gen recursion is interpreted from its first instruction.
sh_src="tests/async-opt/tier/tier-08-gen-deep.arr"; sh_j="$WORK/jarr/step-hook.jarr"
if $PY --compiled-dir "$WORK/hn" --vm-tiers "$VM_TIERS" --vm-fast none --outfile "$sh_j" --build-runnable "$sh_src" >"$sh_j.build" 2>&1 \
   && $NODE tests/async-opt/vm/step-hook-test.js "$sh_j" 200000 >"$sh_j.out" 2>&1; then
  ok "step hook ($(tail -1 "$sh_j.out" | sed 's/ => PASS//' | cut -c1-70)...)"
else
  bad "step hook"; tail -3 "$sh_j.out" | sed 's/^/    /'
fi

# structural verification of every hybrid module built above
if $NODE src/ts-compiler/tests/vm-tools.js verify "$WORK/h" >"$WORK/verify.out" 2>&1; then
  ok "bytecode verifier ($(tail -1 "$WORK/verify.out"))"
else
  bad "bytecode verifier"; tail -5 "$WORK/verify.out" | sed 's/^/    /'
fi
echo "vm tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
