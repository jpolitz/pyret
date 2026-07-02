#!/usr/bin/env bash
# Promise-backend byte-parity test (HISTORICAL — was the primary oracle for
# the async port bring-up; red since the TS compiler gained promise-only
# codegen the .arr reference never mirrored, starting with conditional await
# in 1914009cf, and every promise-only optimization since widens the gap).
# NOT a gate. The byte gate is cont parity (parity-test.sh); promise-backend
# semantics are pinned by cross-backend run parity, the full suites, and
# per-lever A/B differentials (same TS binary, -no-<lever> vs default,
# identical output). Kept runnable for archaeology.
#
# For each program in tests/programs/, compile with BOTH:
#   - the in-tree Pyret-promise reference: build/phaseA/pyret.jarr --stack-backend promise
#   - the TypeScript-promise compiler:     build/ts-compiler/pyret.js --stack-backend promise
# using the async require-config, and compare the standalone jarr byte-for-byte.
# The jarr embeds every module's emitted JS (builtins + the program), so a
# byte-identical jarr proves byte-identical async codegen for the whole graph.
# A one-time full diff of the two compiled-promise caches double-checks the
# per-module cache files.
#
# Each compiler keeps ONE persistent compiled-promise cache for the whole suite
# (the first program compiles the 30 builtins; the rest are cache hits), so the
# suite runs in a couple of minutes instead of recompiling builtins per program.
#
# Run from the pyret-lang root (lang/):
#   bash src/ts-compiler/tests/parity-promise-test.sh

set -u
cd "$(dirname "$0")/../../.."   # lang/

NODE="node --max-old-space-size=8192"
PYRET_ARR=build/phaseA/pyret.jarr
PYRET_TS=build/ts-compiler/pyret.js
PROGRAMS_DIR=src/ts-compiler/tests/programs
WORK=build/ts-compiler/parity-promise
CACHE_A="$WORK/cache-arr"
CACHE_T="$WORK/cache-ts"
COMMON_OPTS=(--builtin-js-dir src/js/trove/
             --builtin-arr-dir src/arr/trove/
             --require-config src/scripts/standalone-configA-async.json
             --deps-file build/phaseA/bundled-node-compile-deps.js
             --stack-backend promise
             -no-display-progress)

rm -rf "$WORK"
mkdir -p "$CACHE_A" "$CACHE_T" "$WORK/out"
pass=0
fail=0
failed_programs=()

run_one() {
  local prog="$1"
  local base
  base=$(basename "$prog" .arr)
  local extra_opts=()
  if [ -f "$PROGRAMS_DIR/$base.options" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && extra_opts+=($line)
    done < "$PROGRAMS_DIR/$base.options"
  fi

  $NODE $PYRET_ARR "${COMMON_OPTS[@]}" ${extra_opts[@]+"${extra_opts[@]}"} \
        --compiled-dir "$CACHE_A" \
        --build-runnable "$prog" --outfile "$WORK/out/$base-arr.jarr" \
        > "$WORK/out/$base-arr.compile.out" 2>&1
  local cstat_a=$?
  $NODE $PYRET_TS "${COMMON_OPTS[@]}" ${extra_opts[@]+"${extra_opts[@]}"} \
        --compiled-dir "$CACHE_T" \
        --build-runnable "$prog" --outfile "$WORK/out/$base-ts.jarr" \
        > "$WORK/out/$base-ts.compile.out" 2>&1
  local cstat_t=$?

  if [ "$cstat_a" -ne "$cstat_t" ]; then
    echo "FAIL $base: compile exit codes differ (arr=$cstat_a ts=$cstat_t)"
    echo "  ts compile tail: $(tail -3 "$WORK/out/$base-ts.compile.out" | head -c 400)"
    return 1
  fi

  # If both failed to compile, compare error text (strip the Pyret-internal trailer).
  if [ "$cstat_a" -ne 0 ]; then
    sed -i '/^Pyret stack:/,$d' "$WORK/out/$base-arr.compile.out"
    sed -i '/^Pyret stack:/,$d' "$WORK/out/$base-ts.compile.out"
    if diff -u "$WORK/out/$base-arr.compile.out" "$WORK/out/$base-ts.compile.out" > "$WORK/$base.compile.diff"; then
      return 0
    else
      echo "FAIL $base: compile error output differs (see $WORK/$base.compile.diff)"
      return 1
    fi
  fi

  # The jarr embeds every module's emitted JS; byte-identity is the strong check.
  if ! cmp -s "$WORK/out/$base-arr.jarr" "$WORK/out/$base-ts.jarr"; then
    echo "FAIL $base: standalone jarr bytes differ"
    return 1
  fi
  return 0
}

shopt -s nullglob
programs=("$PROGRAMS_DIR"/*.arr)
if [ "${#programs[@]}" -eq 0 ]; then
  echo "No test programs found in $PROGRAMS_DIR"
  exit 1
fi

for prog in "${programs[@]}"; do
  if run_one "$prog"; then
    echo "ok   $(basename "$prog") (jarr byte-identical)"
    pass=$((pass+1))
  else
    fail=$((fail+1))
    failed_programs+=("$(basename "$prog")")
  fi
done

# One-time full cache comparison: every per-module -static.js / -module.js file
# the two compilers wrote into their persistent caches must match byte-for-byte.
cache_diff_fail=0
for f in "$CACHE_A"/*; do
  b=$(basename "$f")
  if [ ! -f "$CACHE_T/$b" ]; then
    echo "FAIL cache: $b present in Pyret-promise output but missing in TS output"
    cache_diff_fail=1
  elif ! cmp -s "$f" "$CACHE_T/$b"; then
    echo "FAIL cache: $b bytes differ"
    cache_diff_fail=1
  fi
done
if [ "$cache_diff_fail" -eq 0 ]; then
  echo "ok   full compiled-promise cache byte-identical ($(ls "$CACHE_A" | wc -l) files)"
else
  fail=$((fail+1))
fi

echo
echo "promise byte-parity: $pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  echo "failed: ${failed_programs[*]}"
  exit 1
fi
