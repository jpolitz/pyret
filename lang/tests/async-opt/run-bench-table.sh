#!/bin/bash
# Time each benchmark on cont (.ts.jarr) vs promise (.ts.p.jarr), N runs each,
# report median/min/max wall-clock (seconds) and verify cont/promise output parity.
# Run from lang/. No builds may run concurrently (contaminates timings).
set -u
cd "$(dirname "$0")/../.."   # lang/
N="${1:-5}"
NODE="node22 --max-old-space-size=6144"  # 6G < 7.8G phys (no swap); benches peak ~170MB so this is pure safety margin
BENCHES="bench-spell bench-car-compute bench-car-render bench-lander bench-orbital-compute bench-orbital-ems bench-orbital-render bench-boids-compute bench-boids-raster"

median() { sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[int(NR/2)+1]:(a[NR/2]+a[NR/2+1])/2}'; }
minv()   { sort -n | head -1; }
maxv()   { sort -n | tail -1; }

printf "%-22s %8s | %8s %8s %8s | %8s %8s %8s | %7s %6s\n" \
  "benchmark" "out" "cont_med" "cont_min" "cont_max" "prom_med" "prom_min" "prom_max" "p/c" "parity"
for b in $BENCHES; do
  cj="tests/async-opt/$b.ts.jarr"; pj="tests/async-opt/$b.ts.p.jarr"
  # parity: capture output of one run each
  oc=$($NODE "$cj" 2>/dev/null); op=$($NODE "$pj" 2>/dev/null)
  parity=$([ "$oc" = "$op" ] && echo OK || echo "DIFF")
  ct=(); pt=()
  for i in $(seq 1 "$N"); do
    t=$( { /usr/bin/time -f "%e" $NODE "$cj" >/dev/null; } 2>&1 ); ct+=("$t")
  done
  for i in $(seq 1 "$N"); do
    t=$( { /usr/bin/time -f "%e" $NODE "$pj" >/dev/null; } 2>&1 ); pt+=("$t")
  done
  cm=$(printf '%s\n' "${ct[@]}" | median); cmin=$(printf '%s\n' "${ct[@]}" | minv); cmax=$(printf '%s\n' "${ct[@]}" | maxv)
  pm=$(printf '%s\n' "${pt[@]}" | median); pmin=$(printf '%s\n' "${pt[@]}" | minv); pmax=$(printf '%s\n' "${pt[@]}" | maxv)
  ratio=$(awk -v p="$pm" -v c="$cm" 'BEGIN{ if(c>0) printf "%.2f", p/c; else print "-" }')
  printf "%-22s %8s | %8s %8s %8s | %8s %8s %8s | %7s %6s\n" \
    "$b" "$oc" "$cm" "$cmin" "$cmax" "$pm" "$pmin" "$pmax" "$ratio" "$parity"
done
echo "DONE"
