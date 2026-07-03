#!/bin/bash
# Tier-analysis verdict pins (Stage 5, commit "tier.ts: ANF tier analysis").
#
# The tier pass (src/ts-compiler/src/tier.ts) is EMISSION-NEUTRAL at this
# commit -- the analysis-level oracle, before any tier codegen exists, is the
# PYRET_TIER_DEBUG=1 per-function dump. For each tier-*.arr this harness
# compiles the program once (promise backend) with the dump enabled and greps
# the per-function verdict lines against the expectations declared in the
# test file's header:
#
#   # expect: <function-name> <flat|tail-flat|few-suspend|gen>
#   # expect-allowtco: <function-name> <true|false>
#
# Dump line shape (tier.ts): "[tier] name=<n> kind=<lam|method> tier=<t>
# allowTco=<b> S=<n> B=<n> tail=<n> tco=<n> ... loc=<key>".
#
# The compile itself also exercises the O7 assertion (a Flat-verdict body
# containing a residual await, or a tier/flatness disagreement, aborts the
# compile with an InternalCompilerError => build FAIL here). Additionally the
# whole run is done under PYRET_TIER_SHADOW=1 and any "[tier-shadow] MISMATCH"
# line for a test-file function is a failure.
#
# Self-locating; exits non-zero on any failure. Overridable: NODE env var.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$(cd "$HERE/../../.." && pwd)"   # tests/async-opt/tier -> lang/
cd "$LANG_DIR"
NODE="${NODE:-node}"
PYRET="build/ts-compiler/pyret.js"
if [ ! -f "$PYRET" ]; then echo "ERROR: $PYRET not found (run 'make ts-compiler' first)"; exit 2; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PY="$NODE $PYRET --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/"
CFG="src/scripts/standalone-configA-async.json"

printf "%-28s %-34s %s\n" TEST EXPECTATION VERDICT
PASS=0; FAIL=0
for arr in tests/async-opt/tier/tier-*.arr; do
  base=$(basename "$arr" .arr)
  err="$WORK/$base.err"
  # Fresh compiled dir per test so every module (and its dump) recompiles.
  PYRET_TIER_DEBUG=1 PYRET_TIER_SHADOW=1 $PY --require-config "$CFG" \
    --stack-backend promise --compiled-dir "$WORK/compiled-$base" \
    --outfile "$WORK/$base.jarr" --build-runnable "$arr" -no-check-mode \
    >/dev/null 2>"$err"
  rc=$?
  if [ $rc -ne 0 ]; then
    printf "%-28s %-34s %s\n" "$base" "(build)" "FAIL (compile rc=$rc; see below)"
    tail -5 "$err" | sed 's/^/    /'
    FAIL=$((FAIL+1))
    continue
  fi
  # Verdict expectations.
  while read -r name tier; do
    [ -n "$name" ] || continue
    if grep -Eq "^\[tier\] name=$name kind=(lam|method) tier=$tier " "$err"; then
      printf "%-28s %-34s %s\n" "$base" "$name=$tier" "PASS"; PASS=$((PASS+1))
    else
      got=$(grep -E "^\[tier\] name=$name " "$err" | head -1)
      printf "%-28s %-34s %s\n" "$base" "$name=$tier" "FAIL (got: ${got:-<no dump line>})"
      FAIL=$((FAIL+1))
    fi
  done < <(sed -n 's/^# expect: *//p' "$arr")
  # allowTco expectations.
  while read -r name tco; do
    [ -n "$name" ] || continue
    if grep -Eq "^\[tier\] name=$name kind=(lam|method) tier=[a-z-]+ allowTco=$tco " "$err"; then
      printf "%-28s %-34s %s\n" "$base" "$name allowTco=$tco" "PASS"; PASS=$((PASS+1))
    else
      got=$(grep -E "^\[tier\] name=$name " "$err" | head -1)
      printf "%-28s %-34s %s\n" "$base" "$name allowTco=$tco" "FAIL (got: ${got:-<no dump line>})"
      FAIL=$((FAIL+1))
    fi
  done < <(sed -n 's/^# expect-allowtco: *//p' "$arr")
  # Shadow mismatches naming a function defined in THIS test file are failures
  # (builtin-module lines are reported but not gating -- triage separately).
  while read -r name _; do
    [ -n "$name" ] || continue
    if grep -q "\[tier-shadow\] MISMATCH .*\"$name\"" "$err"; then
      printf "%-28s %-34s %s\n" "$base" "$name shadow" "FAIL (shadow mismatch)"
      FAIL=$((FAIL+1))
    fi
  done < <(sed -n 's/^# expect: *//p' "$arr")
done

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
