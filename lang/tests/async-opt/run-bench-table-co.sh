#!/bin/bash
# Like run-bench-table.sh, but adds the EXPERIMENTAL "cont-optimized" variant
# (.ts.co.jarr): the cont backend built with -cont-optimize, which runs the
# normally promise-only ANF optimizations (optimizer middle-end + operator
# weakening + method-flatness pre-pass) on cont too. Reports, per bench:
#   cont (frozen)  |  cont-optimized  |  promise  | ratios + output parity.
# Timing is the in-process LOOP-MS (jarr-load floor excluded). Run from lang/,
# no builds concurrently.
set -u
cd "$(dirname "$0")/../.."   # lang/
N="${1:-5}"
NODE="node22 --max-old-space-size=6144"
BENCHES="bench-spell bench-car-compute bench-car-render bench-lander bench-orbital-compute bench-orbital-ems bench-orbital-render bench-boids-compute bench-boids-compute-data bench-boids-raster bench-vec-methods bench-matrix bench-dtree bench-kmeans bench-plagiarism bench-seam"

median() { sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[int(NR/2)+1]:(a[NR/2]+a[NR/2+1])/2}'; }
minv()   { sort -n | head -1; }
result_of()  { sed -n '1p'; }
loopsec_of() { awk '/^LOOP-MS/{printf "%.2f", $2/1000; exit}'; }

printf "%-24s %10s | %8s %8s | %8s %8s | %8s %8s | %6s %6s %6s | %s\n" \
  "benchmark" "out" "cont_med" "cont_min" "co_med" "co_min" "prom_med" "prom_min" \
  "co/c" "p/c" "co/p" "parity(c,co,p)"
for b in $BENCHES; do
  cj="tests/async-opt/$b.ts.jarr"; coj="tests/async-opt/$b.ts.co.jarr"; pj="tests/async-opt/$b.ts.p.jarr"
  oc=""; oco=""; op=""; ct=(); cot=(); pt=()
  for i in $(seq 1 "$N"); do
    out=$($NODE "$cj" 2>/dev/null); [ -z "$oc" ] && oc=$(printf '%s\n' "$out" | result_of); ct+=("$(printf '%s\n' "$out" | loopsec_of)")
  done
  for i in $(seq 1 "$N"); do
    out=$($NODE "$coj" 2>/dev/null); [ -z "$oco" ] && oco=$(printf '%s\n' "$out" | result_of); cot+=("$(printf '%s\n' "$out" | loopsec_of)")
  done
  for i in $(seq 1 "$N"); do
    out=$($NODE "$pj" 2>/dev/null); [ -z "$op" ] && op=$(printf '%s\n' "$out" | result_of); pt+=("$(printf '%s\n' "$out" | loopsec_of)")
  done
  parity="OK"
  [ "$oc" = "$oco" ] || parity="co-DIFF"
  [ "$oc" = "$op" ] || parity="${parity},p-DIFF"
  cm=$(printf '%s\n' "${ct[@]}" | median); cmin=$(printf '%s\n' "${ct[@]}" | minv)
  com=$(printf '%s\n' "${cot[@]}" | median); comin=$(printf '%s\n' "${cot[@]}" | minv)
  pm=$(printf '%s\n' "${pt[@]}" | median); pmin=$(printf '%s\n' "${pt[@]}" | minv)
  r_coc=$(awk -v a="$com" -v c="$cm" 'BEGIN{if(c>0)printf "%.2f",a/c; else print "-"}')
  r_pc=$(awk -v p="$pm" -v c="$cm" 'BEGIN{if(c>0)printf "%.2f",p/c; else print "-"}')
  r_cop=$(awk -v a="$com" -v p="$pm" 'BEGIN{if(p>0)printf "%.2f",a/p; else print "-"}')
  printf "%-24s %10s | %8s %8s | %8s %8s | %8s %8s | %6s %6s %6s | %s\n" \
    "$b" "$oc" "$cm" "$cmin" "$com" "$comin" "$pm" "$pmin" "$r_coc" "$r_pc" "$r_cop" "$parity"
done
echo "DONE"
