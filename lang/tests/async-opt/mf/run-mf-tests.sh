#!/bin/bash
# Fast soundness oracle for cross-module method flatness (promise backend).
#
# WHY: the full main2 promise suite is a ~10-minute cold rebuild AND an unreliable
# oracle for this optimization -- it only ever exercised the flat-tagged dict methods
# because the compiler *itself* happens to call them via nested run-task compiles, and
# it silently missed the cold-vs-cached flattening gap entirely. This harness instead
# EXPLICITLY calls every flat-tagged method in a leak-observable way, in seconds.
#
# For each mf-*.arr, compile three ways with the SAME ts-compiler binary:
#   (1) opt-promise  (default,                   --stack-backend promise)
#   (2) baseline     (-no-imported-method-flat,  --stack-backend promise)  <- oracle
#   (3) cont         (default,                   --stack-backend cont)
# Assert all three produce IDENTICAL output -- a method wrongly flattened (emitted
# no-await while it actually suspends, e.g. the keys-now-builds-a-tree-set trap) leaks
# a `Promise` under (1) and diverges from (2)/(3). Also assert flattening FIRED
# (fewer await-guards in (1) than (2)) -- catches "the optimization silently stopped
# working" regressions like the canonicalize-drops-methodFlatness cold-compile bug.
#
# Self-locating; exits non-zero on any failure. Overridable: NODE22, NODE, CAP.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$(cd "$HERE/../../.." && pwd)"   # tests/async-opt/mf -> lang/
cd "$LANG_DIR"
NODE22="${NODE22:-node22}"; NODE="${NODE:-node}"
command -v "$NODE22" >/dev/null 2>&1 || NODE22="$NODE"
CAP="${CAP:-4096}"
PYRET="build/ts-compiler/pyret.js"
if [ ! -f "$PYRET" ]; then echo "ERROR: $PYRET not found (run 'make ts-compiler' first)"; exit 2; fi
export NODE_PATH="$LANG_DIR/node_modules"   # standalone jarrs resolve deps here

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PY="$NODE --max-old-space-size=$CAP $PYRET --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ -no-check-mode"
CFG_P="src/scripts/standalone-configA-async.json"; CFG_C="src/scripts/standalone-configA.json"

fail=0
for arr in "$HERE"/mf-*.arr; do
  id="$(basename "$arr" .arr)"
  o="$WORK/$id-optp"; b="$WORK/$id-basep"; c="$WORK/$id-optc"; mkdir -p "$o" "$b" "$c"
  $PY --stack-backend promise                          --require-config "$CFG_P" --compiled-dir "$o" --outfile "$WORK/$id.opt.p.jarr"  --build-runnable "$arr" >/dev/null 2>&1
  $PY --stack-backend promise -no-imported-method-flat --require-config "$CFG_P" --compiled-dir "$b" --outfile "$WORK/$id.base.p.jarr" --build-runnable "$arr" >/dev/null 2>&1
  $PY --stack-backend cont                             --require-config "$CFG_C" --compiled-dir "$c" --outfile "$WORK/$id.opt.c.jarr"  --build-runnable "$arr" >/dev/null 2>&1
  oo="$($NODE22 "$WORK/$id.opt.p.jarr" 2>&1)"; ob="$($NODE22 "$WORK/$id.base.p.jarr" 2>&1)"; oc="$($NODE22 "$WORK/$id.opt.c.jarr" 2>&1)"
  og="$(grep -oh 'R.iT' "$o"/$id.arr-*module.js 2>/dev/null | wc -l)"; bg="$(grep -oh 'R.iT' "$b"/$id.arr-*module.js 2>/dev/null | wc -l)"
  if [ "$oo" = "$ob" ] && [ "$ob" = "$oc" ]; then sound="ok"; else sound="UNSOUND"; fail=1; fi
  if [ "$og" -lt "$bg" ]; then fired="fired"; else fired="DID-NOT-FIRE"; fail=1; fi
  printf "%-14s out=%-8s sound=%-8s flatten=%-12s (guards opt=%s base=%s)\n" "$id" "$oo" "$sound" "$fired" "$og" "$bg"
done
if [ "$fail" -eq 0 ]; then echo "MF-ORACLE OK"; else echo "MF-ORACLE FAILURES"; fi
exit "$fail"
