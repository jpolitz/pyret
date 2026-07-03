#!/bin/bash
# TailFlat-tier EXECUTION pins (Stage 5, commit "TailFlat tier"). Complements
# the verdict-level harness (run-tier-tests.sh, which pins tier-02's and
# tier-09's `# expect:` verdicts) with runtime behavior:
#
#   1. Emission sanity (two-cache lesson: grep the jarr before trusting
#      green): TailFlat peels functions OFF the generator emission, so the
#      default build of tier-09 must contain strictly FEWER `function*` than
#      the -no-tail-flat build (which demotes every tail-flat verdict to Gen
#      inside tier.ts -- the ONE demotion place).
#   2. Deep tail recursion that SUSPENDS periodically: tier-09's 2M-deep
#      self-TCO / mutual / 3-cycle / method chains hit the ~500-entry fuel
#      gas thousands of times, forcing the sync fuel form
#      `if (needsPause()) return checkPause().then(re-enter)` -- this pins
#      stack safety at depth, that fuel pauses don't change results (the
#      re-enter reads the CURRENT arg vars, incl. mid-TCO-loop reassignment:
#      a stale re-enter would print a wrong tf-sum), and the same-promise
#      bounce cheaply: the run is capped at 256 MB, which a suspended tail
#      chain that accumulated per-frame heap (instead of returning the ONE
#      promise through every frame) would blow.
#   3. A/B `-no-tail-flat` output parity: tier-09 itself, plus the tco-heavy
#      corner tests from tests/async-opt/tc/ (genuine-tail / mutual /
#      return-ann-deep / mutual-token-deep / method-recursion-deep), plus the
#      check-mode suites tests/async-opt/mutual-tco-test.arr (token & bounce
#      guard: raises through deep chains, cross-module, methods, HOFs) and
#      tests/async-opt/tco-test.arr (TCO loop semantics: arg interdependence,
#      ann re-checking, capture soundness). Both builds must print identical
#      output and the check-mode suites must say "Looks shipshape".
#      bench-tco.arr (40M tail iterations) is wired behind RUN_BENCH=1 to
#      keep the default run fast.
#
# Self-locating; exits non-zero on any failure. Overridable: NODE env var.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$(cd "$HERE/../../.." && pwd)"   # tests/async-opt/tier -> lang/
cd "$LANG_DIR"
export NODE_PATH="$LANG_DIR/node_modules"   # jarrs in the /tmp workdir still resolve node deps
NODE="${NODE:-node22}"   # plain node is v18 here: dies on the vega ESM require (documented landmine)
PYRET="build/ts-compiler/pyret.js"
if [ ! -f "$PYRET" ]; then echo "ERROR: $PYRET not found (run 'make ts-compiler' first)"; exit 2; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PY="$NODE $PYRET --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/"
CFG="src/scripts/standalone-configA-async.json"

PASS=0; FAIL=0
ok()  { printf "%-58s %s\n" "$1" "PASS"; PASS=$((PASS+1)); }
bad() { printf "%-58s %s\n" "$1" "FAIL${2:+ ($2)}"; FAIL=$((FAIL+1)); }

# build <src.arr> <out.jarr> <cfg-tag: tf|notf> <checkmode: check|nocheck>
# Compiled dir is shared per config tag, so builtins compile once per config.
build() {
  src="$1"; out="$2"; tag="$3"; check="$4"
  extra=""
  [ "$tag" = "notf" ] && extra="-no-tail-flat"
  ckflag="-no-check-mode"
  [ "$check" = "check" ] && ckflag=""
  # shellcheck disable=SC2086
  $PY --require-config "$CFG" --stack-backend promise \
    --compiled-dir "$WORK/compiled-$tag" \
    --outfile "$out" --build-runnable "$src" $ckflag $extra \
    >/dev/null 2>"$out.err"
  rc=$?
  if [ $rc -ne 0 ]; then
    bad "build $(basename "$src") [$tag]" "compile rc=$rc"
    tail -5 "$out.err" | sed 's/^/    /'
    return 1
  fi
  return 0
}

# ---- builds ----------------------------------------------------------------
T09_T="$WORK/t09-tf.jarr";   build "$HERE/tier-09-tailflat-deep.arr" "$T09_T" tf   nocheck || true
T09_N="$WORK/t09-notf.jarr"; build "$HERE/tier-09-tailflat-deep.arr" "$T09_N" notf nocheck || true

# ---- 1. emission sanity: tail-flat peels functions off the generator form --
if [ -f "$T09_T" ] && [ -f "$T09_N" ]; then
  # Occurrence counts, not line counts: a jarr is a few huge lines, so
  # `grep -c` saturates and reads equal on both builds.
  t=$(grep -o 'function\*' "$T09_T" | wc -l)
  n=$(grep -o 'function\*' "$T09_N" | wc -l)
  if [ "$t" -lt "$n" ]; then
    ok "tail-flat emits fewer function* than -no-tail-flat (tf=$t notf=$n)"
  else
    bad "function* comparison" "tf=$t notf=$n -- tail-flat emission not live"
  fi
fi

# ---- 2. deep suspending tail chains: results + stack + O(1)-heap cap -------
T09_EXPECT="2000001000000truefalsefalsetrue333111donedone!12001200"
if [ -f "$T09_T" ]; then
  out=$("$NODE" --max-old-space-size=256 "$T09_T" 2>&1)
  if [ "$out" = "$T09_EXPECT" ]; then
    ok "tier-09 deep suspending tail chains (2M, 256MB cap)"
  else
    bad "tier-09 deep suspending tail chains" "got: $(printf '%s' "$out" | head -c 160)"
  fi
fi

# ---- 3. A/B -no-tail-flat output parity ------------------------------------
if [ -f "$T09_T" ] && [ -f "$T09_N" ]; then
  outn=$("$NODE" --max-old-space-size=256 "$T09_N" 2>&1)
  if [ "$outn" = "$T09_EXPECT" ]; then
    ok "tier-09 output parity under -no-tail-flat"
  else
    bad "tier-09 output parity under -no-tail-flat" "got: $(printf '%s' "$outn" | head -c 160)"
  fi
fi

# TCO-heavy corner tests (print programs; run-corner-tests.sh's pattern).
for tc in tc-11-genuine-tail tc-12-mutual tc-15-return-ann-deep \
          tc-19-mutual-token-deep tc-38-method-recursion-deep; do
  src="tests/async-opt/tc/$tc.arr"
  JT="$WORK/$tc-tf.jarr"; JN="$WORK/$tc-notf.jarr"
  build "$src" "$JT" tf nocheck   || continue
  build "$src" "$JN" notf nocheck || continue
  a=$("$NODE" --max-old-space-size=4096 "$JT" 2>&1); ra=$?
  b=$("$NODE" --max-old-space-size=4096 "$JN" 2>&1); rb=$?
  if [ $ra -eq 0 ] && [ $ra -eq $rb ] && [ "$a" = "$b" ]; then
    ok "$tc A/B parity (tail-flat vs -no-tail-flat)"
  else
    bad "$tc A/B parity" "rc $ra/$rb or output diff"
    diff <(printf '%s\n' "$b") <(printf '%s\n' "$a") | head -8 | sed 's/^/    /'
  fi
done

# Check-mode suites: identical output AND all checks pass in BOTH builds.
for suite in mutual-tco-test tco-test; do
  src="tests/async-opt/$suite.arr"
  JT="$WORK/$suite-tf.jarr"; JN="$WORK/$suite-notf.jarr"
  build "$src" "$JT" tf check   || continue
  build "$src" "$JN" notf check || continue
  a=$("$NODE" --max-old-space-size=4096 "$JT" 2>&1); ra=$?
  b=$("$NODE" --max-old-space-size=4096 "$JN" 2>&1); rb=$?
  if [ $ra -eq 0 ] && [ $ra -eq $rb ] && [ "$a" = "$b" ] \
     && printf '%s' "$a" | grep -q "Looks shipshape"; then
    ok "$suite.arr shipshape + A/B parity"
  else
    bad "$suite.arr shipshape + A/B parity" "rc $ra/$rb"
    { printf '%s\n' "$a" | grep -iE "shipshape|failed|error" | head -3
      diff <(printf '%s\n' "$b") <(printf '%s\n' "$a") | head -8; } | sed 's/^/    /'
  fi
done

# Optional: the 40M-iteration TCO bench (deterministic printed sum).
if [ "${RUN_BENCH:-0}" = "1" ]; then
  src="tests/async-opt/bench-tco.arr"
  JT="$WORK/bench-tco-tf.jarr"; JN="$WORK/bench-tco-notf.jarr"
  if build "$src" "$JT" tf nocheck && build "$src" "$JN" notf nocheck; then
    a=$("$NODE" "$JT" 2>&1 | sed -n '1p')
    b=$("$NODE" "$JN" 2>&1 | sed -n '1p')
    if [ -n "$a" ] && [ "$a" = "$b" ]; then
      ok "bench-tco result parity ($a)"
    else
      bad "bench-tco result parity" "tf='$a' notf='$b'"
    fi
  fi
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
