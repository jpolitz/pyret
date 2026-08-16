#!/bin/bash
# Paired bootstrap timing: the compiler-as-JS (phaseB-tsp) vs the
# compiler-as-hybrid (phaseB-tsh) each compile src/arr/compiler/pyret.arr
# from a COLD compiled dir, alternating, N reps. The compiler is ~40k lines
# of Pyret; this is the biggest real workload available. Prints wall
# seconds per run and the medians. Run from lang/ after
# `make phaseB-tsp phaseB-tsh`. Usage: bootstrap-time.sh [N]
set -u
cd "$(dirname "$0")/../../.."
N="${1:-3}"
NODE="node --max-old-space-size=8192"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
run() { # <builder-dir> <tag>
  local out="$W/$2"; rm -rf "$out"; mkdir -p "$out/compiled"
  local s=$(date +%s.%N)
  $NODE "$1/pyret.jarr" --outfile "$out/pyret.jarr" --build-runnable src/arr/compiler/pyret.arr \
    --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ --compiled-dir "$out/compiled/" \
    --deps-file build/phaseA/bundled-node-compile-deps.js --stack-backend promise -no-check-mode \
    --require-config src/scripts/standalone-configA-async.json >/dev/null 2>&1 || echo "FAIL $2"
  local e=$(date +%s.%N)
  awk -v s="$s" -v e="$e" 'BEGIN{printf "%.1f", e-s}'
}
P=""; H=""
for i in $(seq 1 "$N"); do
  if [ $((i % 2)) -eq 1 ]; then p=$(run build/phaseB-tsp p); h=$(run build/phaseB-tsh h); else h=$(run build/phaseB-tsh h); p=$(run build/phaseB-tsp p); fi
  echo "rep $i: promise ${p}s  hybrid ${h}s"
  P="$P $p"; H="$H $h"
done
med() { printf '%s\n' $1 | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[int(NR/2)+1]:(a[NR/2]+a[NR/2+1])/2}'; }
pm=$(med "$P"); hm=$(med "$H")
awk -v p="$pm" -v h="$hm" 'BEGIN{printf "bootstrap medians: promise %.1fs hybrid %.1fs  h/p %.3f\n", p, h, h/p}'
