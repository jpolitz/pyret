#!/bin/bash
# Pause-schedule correspondence harness (see the vm README, "Pause schedules").
#
# For every program: build cont, vm(nonflat,none,-no-opt*), vm(nonflat,all,
# -no-opt*), and promise(default opts); run each under several deterministic
# pause schedules (PYRET_PAUSE_SCHEDULE) with stack tracing; then check
#   answers: stdout+exit identical across every config and schedule,
#   stacks:  cont vs vm-none traces agree (pause-compare.js, at-loc key),
#            vm-none vs vm-all traces agree (namedef key).
# Self-locating; exits non-zero on any failure.
# Overridable: NODE, SCHEDULES, PROGS, WORK, KEEP.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$(cd "$HERE/../../.." && pwd)"
cd "$LANG_DIR"
export NODE_PATH="$LANG_DIR/node_modules"
NODE="${NODE:-node}"
PYRET="build/ts-compiler/pyret.js"
[ -f "$PYRET" ] || { echo "ERROR: $PYRET not found (make ts-compiler)"; exit 2; }
WORK="${WORK:-$(mktemp -d)}"
KEEP="${KEEP:-}"
[ -n "$KEEP" ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/cc" "$WORK/hn" "$WORK/ha" "$WORK/hp" "$WORK/jarr" "$WORK/out"

PY="$NODE --max-old-space-size=4096 $PYRET --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/"
# Ann elision stays ON: elided checks never charge fuel (event-neutral), and
# without it a return-annotated tail call is not `cont === RETURN`, so the
# machine loses TAILCALL frame reuse and annotated TCO loops stack frames.
NOOPT="-no-optimize -no-licm -no-direct-fields -no-method-flatness -no-op-weakening"
# Force every cases branch inline in the correspondence builds: the cont
# backend lifts a branch whose body exceeds inline-case-body-limit steps into
# a function (one fuel charge per dispatch); the machine always runs branches
# inline (no charge).
INLINE="--inline-case-body-limit 1000000"
CONT_CFG="--require-config src/scripts/standalone-configA.json --stack-backend cont $INLINE"
ASYNC_CFG="--require-config src/scripts/standalone-configA-async.json --stack-backend promise"

SCHEDULES="${SCHEDULES:-fixed:97 list:3,10,50,7 lcg:42:2:300 lcg:7:2:50}"
# Deep-recursion programs: a cont pause costs O(depth) (full unwind+rebuild,
# and the trace walks the stack), so pause more sparsely -- but the interval
# also bounds the cont backend's JS stack growth between pauses (that is what
# GAS=500 is for), so it cannot exceed ~1000.
DEEP_SCHEDULES="${DEEP_SCHEDULES:-fixed:997 lcg:42:300:1500}"
# Also the high-event-count loop suites: tens of millions of fuel events, so
# dense schedules mean millions of pauses and multi-GB traces.
deep_prog() { case "$1" in vm-01-cross-deep|vm-02-mutual-tco|deep-nontail|tier-08-gen-deep|stack-depth|mutual-tco-test|tco-test|varmut|v-var|v-var-tail|v-var-when|v-func) return 0;; *) return 1;; esac; }
PROGS="${PROGS:-$(ls "$HERE"/vm-*.arr) tests/async-opt/tier/tier-04-gen.arr tests/async-opt/tier/tier-05-cases.arr tests/async-opt/tier/tier-06-tco-exclusion.arr tests/async-opt/tier/tier-07-gen-err.arr tests/async-opt/mutual-tco-test.arr tests/async-opt/tco-test.arr tests/async-opt/varmut.arr tests/async-opt/v-var.arr tests/async-opt/v-var-tail.arr tests/async-opt/v-var-when.arr tests/async-opt/v-func.arr}"

PASS=0; FAIL=0
ok()  { printf "%-58s %s\n" "$1" "PASS"; PASS=$((PASS+1)); }
bad() { printf "%-58s %s\n" "$1" "FAIL${2:+ ($2)}"; FAIL=$((FAIL+1)); }

for src in $PROGS; do
  base=$(basename "$src" .arr)
  cj="$WORK/jarr/$base.cont.jarr"; nj="$WORK/jarr/$base.vmnone.jarr"
  aj="$WORK/jarr/$base.vmall.jarr"; pj="$WORK/jarr/$base.popt.jarr"
  if ! $PY $CONT_CFG --compiled-dir "$WORK/cc" --outfile "$cj" --build-runnable "$src" >"$cj.build" 2>&1; then
    bad "$base" "cont build failed"; tail -3 "$cj.build" | sed 's/^/    /'; continue
  fi
  if ! $PY $ASYNC_CFG --vm-tiers nonflat --vm-fast none $NOOPT $INLINE --compiled-dir "$WORK/hn" --outfile "$nj" --build-runnable "$src" >"$nj.build" 2>&1; then
    bad "$base" "vm-none build failed"; tail -3 "$nj.build" | sed 's/^/    /'; continue
  fi
  if ! $PY $ASYNC_CFG --vm-tiers nonflat --vm-fast all $NOOPT $INLINE --compiled-dir "$WORK/ha" --outfile "$aj" --build-runnable "$src" >"$aj.build" 2>&1; then
    bad "$base" "vm-all build failed"; tail -3 "$aj.build" | sed 's/^/    /'; continue
  fi
  if ! $PY $ASYNC_CFG --vm-tiers gen --vm-fast all --compiled-dir "$WORK/hp" --outfile "$pj" --build-runnable "$src" >"$pj.build" 2>&1; then
    bad "$base" "popt build failed"; tail -3 "$pj.build" | sed 's/^/    /'; continue
  fi

  if deep_prog "$base"; then SCHED_SET="$DEEP_SCHEDULES"; else SCHED_SET="$SCHEDULES"; fi

  # Baseline (no schedule) answers, cont as reference.
  $NODE "$cj" >"$WORK/out/$base.ref.out" 2>"$WORK/out/$base.ref.err"; refc=$?
  probfail=""
  for cfg in cont vmnone vmall popt; do
    case $cfg in cont) j=$cj;; vmnone) j=$nj;; vmall) j=$aj;; popt) j=$pj;; esac
    for sch in BASE $SCHED_SET; do
      tag="$base.$cfg.$(echo $sch | tr ':,' '__')"
      env=""
      if [ "$sch" != "BASE" ]; then
        PYRET_PAUSE_SCHEDULE="$sch" PYRET_PAUSE_TRACE="$WORK/out/$tag.trace" \
          $NODE "$j" >"$WORK/out/$tag.out" 2>"$WORK/out/$tag.err"; rc=$?
      else
        $NODE "$j" >"$WORK/out/$tag.out" 2>"$WORK/out/$tag.err"; rc=$?
      fi
      if [ "$rc" != "$refc" ]; then probfail="exit $cfg/$sch=$rc ref=$refc"; break 2; fi
      if ! cmp -s "$WORK/out/$tag.out" "$WORK/out/$base.ref.out"; then probfail="stdout $cfg/$sch"; break 2; fi
    done
  done
  if [ -n "$probfail" ]; then bad "$base answers" "$probfail";
    diff "$WORK/out/$tag.out" "$WORK/out/$base.ref.out" 2>/dev/null | head -5 | sed 's/^/    /'
  else ok "$base answers (4 configs x 5 runs)"; fi

  for sch in $SCHED_SET; do
    sf=$(echo $sch | tr ':,' '__')
    r=$($NODE "$HERE/pause-compare.js" --quiet "$WORK/out/$base.cont.$sf.trace" "$WORK/out/$base.vmnone.$sf.trace" 2>&1 | tail -1)
    case "$r" in *fail=0*) ok "$base cont~vm-none $sch [$r]";;
      *) bad "$base cont~vm-none $sch" "$r";
         $NODE "$HERE/pause-compare.js" "$WORK/out/$base.cont.$sf.trace" "$WORK/out/$base.vmnone.$sf.trace" 2>&1 | head -4 | sed 's/^/    /';;
    esac
    r=$($NODE "$HERE/pause-compare.js" --quiet --key namedef "$WORK/out/$base.vmnone.$sf.trace" "$WORK/out/$base.vmall.$sf.trace" 2>&1 | tail -1)
    case "$r" in *fail=0*) ok "$base vm-none~vm-all $sch [$r]";;
      *) bad "$base vm-none~vm-all $sch" "$r";
         $NODE "$HERE/pause-compare.js" --key namedef "$WORK/out/$base.vmnone.$sf.trace" "$WORK/out/$base.vmall.$sf.trace" 2>&1 | head -4 | sed 's/^/    /';;
    esac
  done
done

echo "pause tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
