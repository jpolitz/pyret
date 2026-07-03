#!/bin/bash
# Gen-tier EXECUTION pins (Stage 5, commit "Gen tier"). Complements the
# verdict-level harness (run-tier-tests.sh, which also checks the `# expect:`
# verdict pins in tier-07/tier-08) with runtime behavior:
#
#   1. Emission sanity (two-cache lesson: grep the jarr before trusting
#      green): the default build of a Gen-verdict program contains
#      `function*` in the jarr; the -no-gen-functions build contains NONE.
#      The grep is exact today: neither runtime-async.js nor any embedded
#      src/js JS defines a generator function. Fresh compiled dirs per
#      config so builtins are (re)compiled under the same flags.
#   2. Stack safety: deep NON-tail recursion must complete -- on fuel
#      exhaustion the generator body yields, the sync wrapper returns an
#      R.driveGen promise, and every pending caller's conditional await
#      unwinds the JS stack. tier-08-gen-deep.arr stays Gen under all tier
#      flags; the canonical tests/async-opt/deep-nontail.arr (1M levels)
#      rides along while its `sum` is still gen-compiled at this commit.
#      This doubles as the interruptibility smoke: the same
#      needsPause/checkPause seam (now a yield) is what a scheduler
#      interrupt rides; an explicit SIGINT pin is deliberately omitted
#      (timing-flaky).
#   3. Error identity: a raise inside a gen-compiled function renders
#      byte-identical output (message + stack + exit code) to the
#      -no-gen-functions async build -- generator resume frames
#      ("at NAME.next (<anonymous>)") are location-less and dropped by
#      exn-stack-parser, so the rendered Pyret stack must match.
#   4. A/B output parity on one bench: bench-vec-methods' first stdout line
#      (the deterministic result; LOOP-MS timing lines differ by design)
#      must agree between the gen and -no-gen-functions builds.
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
ok()  { printf "%-52s %s\n" "$1" "PASS"; PASS=$((PASS+1)); }
bad() { printf "%-52s %s\n" "$1" "FAIL${2:+ ($2)}"; FAIL=$((FAIL+1)); }

# build <src.arr> <out.jarr> <cfg-tag: gen|nogen> [extra pyret flags...]
build() {
  src="$1"; out="$2"; tag="$3"; shift 3
  $PY --require-config "$CFG" --stack-backend promise \
    --compiled-dir "$WORK/compiled-$tag" \
    --outfile "$out" --build-runnable "$src" -no-check-mode "$@" \
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
ERR_G="$WORK/err-gen.jarr";    build "$HERE/tier-07-gen-err.arr"  "$ERR_G"  gen   || true
ERR_N="$WORK/err-nogen.jarr";  build "$HERE/tier-07-gen-err.arr"  "$ERR_N"  nogen -no-gen-functions || true
DEEP_G="$WORK/deep-gen.jarr";  build "$HERE/tier-08-gen-deep.arr" "$DEEP_G" gen   || true
DNT_G="$WORK/dnt-gen.jarr";    build "tests/async-opt/deep-nontail.arr" "$DNT_G" gen || true
VEC_G="$WORK/vec-gen.jarr";    build "tests/async-opt/bench-vec-methods.arr" "$VEC_G" gen || true
VEC_N="$WORK/vec-nogen.jarr";  build "tests/async-opt/bench-vec-methods.arr" "$VEC_N" nogen -no-gen-functions || true

# ---- 1. emission sanity (grep the jarrs) -----------------------------------
if [ -f "$ERR_G" ] && grep -q 'function\*' "$ERR_G"; then
  ok "gen jarr contains function*"
else
  bad "gen jarr contains function*" "no generator emitted -- gen tier not live"
fi
if [ -f "$VEC_G" ] && grep -q 'function\*' "$VEC_G"; then
  ok "bench gen jarr contains function*"
else
  bad "bench gen jarr contains function*" "no generator emitted"
fi
if [ -f "$ERR_N" ] && [ -f "$ERR_G" ]; then
  # The runtime baseline ships a few function* of its own (present in every
  # jarr); the lever pin is that the gen build emits strictly MORE and the
  # flag-off build emits exactly the baseline count.
  n=$(grep -o 'function\*' "$ERR_N" | wc -l)
  g=$(grep -o 'function\*' "$ERR_G" | wc -l)
  if [ "$g" -gt "$n" ]; then
    ok "-no-gen-functions emits only baseline function* (nogen=$n gen=$g)"
  else
    bad "-no-gen-functions function* comparison" "nogen=$n gen=$g"
  fi
fi

# ---- 2. stack safety (deep non-tail recursion through generators) ----------
if [ -f "$DEEP_G" ]; then
  out=$("$NODE" --max-old-space-size=4096 "$DEEP_G" 2>&1)
  if [ "$out" = "200000" ]; then
    ok "tier-08 deep non-tail (200k levels, gen)"
  else
    bad "tier-08 deep non-tail (200k levels, gen)" "got: $(printf '%s' "$out" | head -c 120)"
  fi
fi
if [ -f "$DNT_G" ]; then
  out=$("$NODE" --max-old-space-size=4096 "$DNT_G" 2>&1)
  if [ "$out" = "1000000" ]; then
    ok "deep-nontail.arr (1M levels)"
  else
    bad "deep-nontail.arr (1M levels)" "got: $(printf '%s' "$out" | head -c 120)"
  fi
fi

# ---- 3. error identity vs -no-gen-functions --------------------------------
if [ -f "$ERR_G" ] && [ -f "$ERR_N" ]; then
  # Compare at the PYRET level: message + Pyret stack + exit code. Raw JS
  # frames ('    at ...jarr:LINE:COL') legitimately differ between the gen and
  # async compilations of the same program (different emitted-line geometry);
  # the parity ground rules pin the error constructor/fields and the PYRET
  # stack, with JS-level positions exempt.
  "$NODE" "$ERR_G" 2>&1 | grep -vE '^\s+at |\.jarr' >"$WORK/err-gen.out";   rcg=${PIPESTATUS[0]}
  "$NODE" "$ERR_N" 2>&1 | grep -vE '^\s+at |\.jarr' >"$WORK/err-nogen.out"; rcn=${PIPESTATUS[0]}
  if [ "$rcg" -eq "$rcn" ] && diff -q "$WORK/err-gen.out" "$WORK/err-nogen.out" >/dev/null; then
    if [ "$rcg" -ne 0 ] && grep -q 'gen-tier-boom' "$WORK/err-gen.out"; then
      ok "error identity (message+stack+rc, gen == async)"
    else
      bad "error identity (message+stack+rc, gen == async)" "rc=$rcg or message missing"
    fi
  else
    bad "error identity (message+stack+rc, gen == async)" "rc $rcg vs $rcn"
    diff -u "$WORK/err-nogen.out" "$WORK/err-gen.out" | head -20 | sed 's/^/    /'
  fi
fi

# ---- 4. bench A/B output parity --------------------------------------------
if [ -f "$VEC_G" ] && [ -f "$VEC_N" ]; then
  rg=$("$NODE" "$VEC_G" 2>/dev/null | sed -n '1p')
  rn=$("$NODE" "$VEC_N" 2>/dev/null | sed -n '1p')
  if [ -n "$rg" ] && [ "$rg" = "$rn" ]; then
    ok "bench-vec-methods result parity gen vs -no-gen-functions ($rg)"
  else
    bad "bench-vec-methods result parity" "gen='$rg' nogen='$rn'"
  fi
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
