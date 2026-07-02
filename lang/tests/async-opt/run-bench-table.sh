#!/bin/bash
# Time each benchmark on cont (.ts.jarr) vs promise (.ts.p.jarr), N runs each.
# Timing is the IN-PROCESS loop time: each bench prints "LOOP-MS <ms>" measured
# with time-now() bracketing the whole driver loop, so the ~0.5s warm jarr-load
# floor (and cold-disk first-touch) is excluded from the number. The first
# stdout line is a deterministic result used to check cont/promise output parity.
# Report median/min/max loop-seconds. Run from lang/. No builds concurrently.
set -u
cd "$(dirname "$0")/../.."   # lang/
N="${1:-5}"
NODE="node22 --max-old-space-size=6144"  # 6G < 7.8G phys (no swap); benches peak ~170MB so this is pure safety margin
BENCHES="bench-spell bench-car-compute bench-car-render bench-lander bench-orbital-compute bench-orbital-ems bench-orbital-render bench-boids-compute bench-boids-compute-data bench-boids-raster bench-vec-methods bench-matrix bench-dtree bench-kmeans bench-plagiarism bench-seam"

median() { sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[int(NR/2)+1]:(a[NR/2]+a[NR/2+1])/2}'; }
minv()   { sort -n | head -1; }
maxv()   { sort -n | tail -1; }
result_of()  { sed -n '1p'; }                                  # first line = parity result
loopsec_of() { awk '/^LOOP-MS/{printf "%.2f", $2/1000; exit}'; } # ms -> seconds

printf "%-22s %10s | %8s %8s %8s | %8s %8s %8s | %7s %6s\n" \
  "benchmark" "out" "cont_med" "cont_min" "cont_max" "prom_med" "prom_min" "prom_max" "p/c" "parity"
for b in $BENCHES; do
  cj="tests/async-opt/$b.ts.jarr"; pj="tests/async-opt/$b.ts.p.jarr"
  oc=""; op=""; ct=(); pt=()
  for i in $(seq 1 "$N"); do
    out=$($NODE "$cj" 2>/dev/null)
    [ -z "$oc" ] && oc=$(printf '%s\n' "$out" | result_of)
    ct+=("$(printf '%s\n' "$out" | loopsec_of)")
  done
  for i in $(seq 1 "$N"); do
    out=$($NODE "$pj" 2>/dev/null)
    [ -z "$op" ] && op=$(printf '%s\n' "$out" | result_of)
    pt+=("$(printf '%s\n' "$out" | loopsec_of)")
  done
  parity=$([ "$oc" = "$op" ] && echo OK || echo "DIFF")
  cm=$(printf '%s\n' "${ct[@]}" | median); cmin=$(printf '%s\n' "${ct[@]}" | minv); cmax=$(printf '%s\n' "${ct[@]}" | maxv)
  pm=$(printf '%s\n' "${pt[@]}" | median); pmin=$(printf '%s\n' "${pt[@]}" | minv); pmax=$(printf '%s\n' "${pt[@]}" | maxv)
  ratio=$(awk -v p="$pm" -v c="$cm" 'BEGIN{ if(c>0) printf "%.2f", p/c; else print "-" }')
  printf "%-22s %10s | %8s %8s %8s | %8s %8s %8s | %7s %6s\n" \
    "$b" "$oc" "$cm" "$cmin" "$cmax" "$pm" "$pmin" "$pmax" "$ratio" "$parity"
done
echo "DONE"
