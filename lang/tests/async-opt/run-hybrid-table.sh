#!/bin/bash
# Paired promise-vs-hybrid timing over the curated benches. Each rep runs
# every bench's .ts.p.jarr and .ts.h.jarr back to back (interleaved), so
# box noise hits both sides equally; reports median/min LOOP-seconds per
# side, the ratio h/p of medians, output parity, and the geomean of ratios.
# Usage: tests/async-opt/run-hybrid-table.sh [N] [bench...]   (from lang/; NODE=bun for JSC;
#   P_JARR / H_JARR = jarr path patterns with %b for the bench name, to pair any two builds)
set -u
cd "$(dirname "$0")/../.."
N="${1:-3}"; shift || true
NODE="${NODE:-node --max-old-space-size=6144}"
if [ $# -gt 0 ]; then BENCHES="$*"; else
BENCHES="bench-spell bench-car-compute bench-car-render bench-lander bench-orbital-compute bench-orbital-ems bench-orbital-render bench-boids-compute bench-boids-compute-data bench-boids-raster bench-vec-methods bench-matrix bench-dtree bench-kmeans bench-plagiarism bench-seam"
fi
median() { sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[int(NR/2)+1]:(a[NR/2]+a[NR/2+1])/2}'; }
minv()   { sort -n | head -1; }
result_of()  { sed -n '1p'; }
loopsec_of() { awk '/^LOOP-MS/{printf "%.3f", $2/1000; exit}'; }
declare -A PT HT PO HO
for b in $BENCHES; do PT[$b]=""; HT[$b]=""; done
for i in $(seq 1 "$N"); do
  for b in $BENCHES; do
    pj="${P_JARR:-tests/async-opt/%b.ts.p.jarr}"; pj="${pj//%b/$b}"
    hj="${H_JARR:-tests/async-opt/%b.ts.h.jarr}"; hj="${hj//%b/$b}"
    if [ $((i % 2)) -eq 1 ]; then order="p h"; else order="h p"; fi
    for side in $order; do
      if [ $side = p ]; then out=$($NODE "$pj" 2>/dev/null); PO[$b]=$(printf '%s\n' "$out" | result_of); PT[$b]="${PT[$b]} $(printf '%s\n' "$out" | loopsec_of)";
      else out=$($NODE "$hj" 2>/dev/null); HO[$b]=$(printf '%s\n' "$out" | result_of); HT[$b]="${HT[$b]} $(printf '%s\n' "$out" | loopsec_of)"; fi
    done
  done
done
printf "%-24s | %8s %8s | %8s %8s | %6s %6s | %s\n" benchmark p_med p_min h_med h_min h/p min_r parity
logsum=0; cnt=0
for b in $BENCHES; do
  pm=$(printf '%s\n' ${PT[$b]} | median); pmin=$(printf '%s\n' ${PT[$b]} | minv)
  hm=$(printf '%s\n' ${HT[$b]} | median); hmin=$(printf '%s\n' ${HT[$b]} | minv)
  ratio=$(awk -v h="$hm" -v p="$pm" 'BEGIN{ if(p>0) printf "%.3f", h/p; else print "-" }')
  mratio=$(awk -v h="$hmin" -v p="$pmin" 'BEGIN{ if(p>0) printf "%.3f", h/p; else print "-" }')
  parity=$([ "${PO[$b]}" = "${HO[$b]}" ] && echo OK || echo "DIFF(${PO[$b]}|${HO[$b]})")
  printf "%-24s | %8s %8s | %8s %8s | %6s %6s | %s\n" "$b" "$pm" "$pmin" "$hm" "$hmin" "$ratio" "$mratio" "$parity"
  logsum=$(awk -v s="$logsum" -v r="$ratio" 'BEGIN{print s+log(r)}'); cnt=$((cnt+1))
done
awk -v s="$logsum" -v c="$cnt" 'BEGIN{printf "geomean h/p (medians): %.3f over %d benches\n", exp(s/c), c}'
