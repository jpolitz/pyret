#!/bin/bash
# FewSuspend-tier EXECUTION pins (Stage 5, commit "FewSuspend tier").
# Complements the verdict-level harness (run-tier-tests.sh, which pins
# tier-10's `# expect:` verdicts) with runtime behavior:
#
#   1. Emission sanity (two-cache lesson: grep the jarr, occurrence counts
#      not line counts): FewSuspend peels functions off the generator
#      emission and adds guarded suspend sites, so the default build of
#      tier-10 must contain strictly FEWER `function*` AND strictly MORE
#      `if(R.iT(` guards than the -no-few-suspend build (which demotes every
#      few-suspend verdict to Gen inside tier.ts -- the ONE demotion place).
#      The `return t.then(function` resume form must appear in the default
#      build and not at all in the -no-few-suspend build.
#   2. Value pins on tier-10 (256MB cap): every fs-* shape runs BOTH guard
#      sides -- forced-sync (small n: the callee returns flat, control falls
#      through the guard) and forced-suspend (200000 > the ~500-entry fuel
#      tank: the callee returns a promise, the resume closure runs) -- plus
#      the 2M TCO loop with an off-back-edge capture and the 200000-deep
#      every-frame-suspends recursion (heap linear, JS stack fuel-bounded;
#      the cap is what a per-frame-heap regression would blow).
#   3. Rejection identity: a `raise` BEFORE the first suspend site, and a
#      `raise` AFTER the suspend point -- on the suspend path the latter runs
#      INSIDE the resume closure, whose throw must become a rejection via
#      the .then contract (driveGen-parity; rejection skips the closure =
#      rethrow-at-suspend-point in a try-free body). Each crash program must
#      produce IDENTICAL output (stdout+stderr, exit code) under the default
#      and -no-few-suspend builds. Built from heredocs because a raise ends
#      the run (tier-10 itself never raises).
#   4. A/B -no-few-suspend output parity: tier-10 itself, plus the check-mode
#      suites tests/async-opt/mutual-tco-test.arr (whose functions are
#      few-suspend verdicts -- a real fixture, found while drafting the
#      tail-flat tier) and tests/async-opt/tco-test.arr; both builds must
#      print identical output and say "Looks shipshape".
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

# build <src.arr> <out.jarr> <cfg-tag: fs|nofs> <checkmode: check|nocheck>
# Compiled dir is shared per config tag, so builtins compile once per config.
build() {
  src="$1"; out="$2"; tag="$3"; check="$4"
  extra=""
  [ "$tag" = "nofs" ] && extra="-no-few-suspend"
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

# ---- crash fixtures (heredocs: a raise ends the run) ------------------------
# fs-raise-before: the raise fires at a capturing site BEFORE the fs-ping
# guard is ever reached. fs-raise-after-*: the raise sits in the continuation
# AFTER the suspend point -- on the sync build (small n) it throws through
# the guard fall-through, on the suspending build (200000) it throws inside
# the resume closure and must reject via the .then contract. All three fns
# are few-suspend verdicts (pinned below via PYRET_TIER_DEBUG on the build).
cat > "$WORK/fs-raise-before.arr" <<'EOF'
fun fs-ping(n :: Number) -> Number:
  if n <= 0: 0
  else: fs-ping(n - 1)
  end
end
fun bomb(n :: Number) -> Number:
  raise("boom-before")
end
fun fs-raise-before(n :: Number) -> Number:
  y = bomb(n)
  x = fs-ping(n)
  x + y
end
print(fs-raise-before(200000))
EOF
for variant in sync suspend; do
  n=4; [ "$variant" = "suspend" ] && n=200000
  cat > "$WORK/fs-raise-after-$variant.arr" <<EOF
fun fs-ping(n :: Number) -> Number:
  if n <= 0: 0
  else: fs-ping(n - 1)
  end
end
fun fs-raise-after(n :: Number) -> Number:
  x = fs-ping(n)
  raise("boom-after " + to-string(x + n))
end
print(fs-raise-after($n))
EOF
done

# ---- builds ----------------------------------------------------------------
T10_SRC="$HERE/tier-10-fewsuspend-exec.arr"
T10_F="$WORK/t10-fs.jarr";   PYRET_TIER_DEBUG=1 build "$T10_SRC" "$T10_F" fs nocheck || true
T10_N="$WORK/t10-nofs.jarr"; build "$T10_SRC" "$T10_N" nofs nocheck || true

# ---- 1. emission sanity ------------------------------------------------------
if [ -f "$T10_F" ] && [ -f "$T10_N" ]; then
  gf=$(grep -o 'function\*' "$T10_F" | wc -l)
  gn=$(grep -o 'function\*' "$T10_N" | wc -l)
  if [ "$gf" -lt "$gn" ]; then
    ok "few-suspend emits fewer function* than -no-few-suspend (fs=$gf nofs=$gn)"
  else
    bad "function* comparison" "fs=$gf nofs=$gn -- few-suspend emission not live"
  fi
  itf=$(grep -o 'if(R.iT(' "$T10_F" | wc -l)
  itn=$(grep -o 'if(R.iT(' "$T10_N" | wc -l)
  if [ "$itf" -gt "$itn" ]; then
    ok "guarded 'if(R.iT(' count rises (fs=$itf nofs=$itn)"
  else
    bad "if(R.iT( comparison" "fs=$itf nofs=$itn"
  fi
  rtf=$(grep -oE 'return \$[A-Za-z_]+[0-9]*\.then\(function' "$T10_F" | wc -l)
  rtn=$(grep -oE 'return \$[A-Za-z_]+[0-9]*\.then\(function' "$T10_N" | wc -l)
  if [ "$rtf" -gt 0 ] && [ "$rtn" -eq 0 ]; then
    ok "resume 'return t.then(function' form (fs=$rtf nofs=$rtn)"
  else
    bad "resume-form comparison" "fs=$rtf nofs=$rtn"
  fi
fi

# ---- 2. value pins + heap cap (both guard sides) -----------------------------
# 5 7 2 19 3 5 8 4 9 | 200001 7 2 3 200001 200004 200000 200005
# | 2000000 | 200000, print-concatenated.
T10_EXPECT="57219358492000017232000012000042000002000052000000200000"
if [ -f "$T10_F" ]; then
  out=$("$NODE" --max-old-space-size=256 "$T10_F" 2>&1)
  if [ "$out" = "$T10_EXPECT" ]; then
    ok "tier-10 value pins, both guard sides (256MB cap)"
  else
    bad "tier-10 value pins" "got: $(printf '%s' "$out" | head -c 160)"
  fi
fi
if [ -f "$T10_F" ] && [ -f "$T10_N" ]; then
  outn=$("$NODE" --max-old-space-size=256 "$T10_N" 2>&1)
  if [ "$outn" = "$T10_EXPECT" ]; then
    ok "tier-10 output parity under -no-few-suspend"
  else
    bad "tier-10 output parity under -no-few-suspend" "got: $(printf '%s' "$outn" | head -c 160)"
  fi
fi

# ---- 3. rejection identity (raise before / after the suspend point) ---------
for crash in fs-raise-before fs-raise-after-sync fs-raise-after-suspend; do
  src="$WORK/$crash.arr"
  JF="$WORK/$crash-fs.jarr"; JN="$WORK/$crash-nofs.jarr"
  PYRET_TIER_DEBUG=1 build "$src" "$JF" fs nocheck || continue
  build "$src" "$JN" nofs nocheck || continue
  # The raising fn must really be a few-suspend verdict in the default build
  # (otherwise the pin exercises nothing).
  if ! grep -Eq "^\[tier\] name=fs-raise-[a-z]+ kind=lam tier=few-suspend " "$JF.err"; then
    bad "$crash verdict" "raising fn is not few-suspend (see $crash-fs.jarr.err)"
    continue
  fi
  a=$("$NODE" "$JF" 2>&1); ra=$?
  b=$("$NODE" "$JN" 2>&1); rb=$?
  if [ $ra -ne 0 ] && [ $ra -eq $rb ] && [ "$a" = "$b" ] \
     && printf '%s' "$a" | grep -q "boom-"; then
    ok "$crash identical Pyret error A/B (rc=$ra)"
  else
    bad "$crash rejection identity" "rc $ra/$rb or output diff"
    diff <(printf '%s\n' "$b") <(printf '%s\n' "$a") | head -8 | sed 's/^/    /'
  fi
done

# ---- 4. check-mode suites A/B (mutual-tco-test's fns are few-suspend) -------
for suite in mutual-tco-test tco-test; do
  src="tests/async-opt/$suite.arr"
  JF="$WORK/$suite-fs.jarr"; JN="$WORK/$suite-nofs.jarr"
  build "$src" "$JF" fs check   || continue
  build "$src" "$JN" nofs check || continue
  a=$("$NODE" --max-old-space-size=4096 "$JF" 2>&1); ra=$?
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

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
