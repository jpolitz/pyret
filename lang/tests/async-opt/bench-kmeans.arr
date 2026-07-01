provide *
import sets as Sets

# Pure-CPU benchmark extracted from the Bootstrap "ai-library-models" k-means
# clustering routine (k-means-clustering / find-closest), the engine that powers
# the library's cluster-col and decision-tree quantitative-split thresholds.
# This is Lloyd's algorithm over a 1-D list of numbers: assign each point to its
# nearest centroid (find-closest scans every centroid), recompute each centroid as
# the mean of its assigned group, and iterate to a fixpoint (gas-capped at 10).
# All the Table / Google-Sheets / charting machinery is stripped; we drive the bare
# numeric fixpoint over a deterministic pseudo-random point cloud, many times.
# Heavy on map / filter / foldl + exact-rational arithmetic and List equality;
# nothing async-targeted. Output is deterministic for cont/promise parity.

N-POINTS = 160
N-CLUSTERS = 5

fun dist(a :: Number, b :: Number) -> Number: num-abs(a - b) end

fun find-closest(val :: Number, centroids :: List<Number>) -> Number:
  centroids.rest.foldl(lam(best, current):
      if dist(val, current) < dist(val, best): current else: best end
    end, centroids.first)
end

# Verbatim port of ai-library-models' k-means-clustering, with a guard added at the
# min/max extraction so a degenerate empty cluster can't crash the bench.
fun k-means-clustering(points :: List<Number>, n-clusters :: Number) -> List<{Number; Number}>:
  fun run-iterations(centroids, gas):
    assignments = points.map(lam(v): {val: v, center: find-closest(v, centroids)} end)
    new-centroids = centroids.map(lam(c):
        group = assignments.filter(lam(a): a.center == c end).map(lam(a): a.val end)
        if group.length() > 0:
          group.foldl(lam(acc, v): acc + v end, 0) / group.length()
        else:
          c
        end
      end)
    if (new-centroids == centroids) or (gas <= 0): centroids
    else: run-iterations(new-centroids, gas - 1)
    end
  end

  final-centers = Sets.list-to-list-set(run-iterations(points.take(n-clusters), 10)).to-list()

  final-centers
    .map(lam(c):
      cluster = points.filter(lam(v): find-closest(v, final-centers) == c end).sort()
      if is-empty(cluster): none else: some({cluster.get(0); cluster.last()}) end
    end)
    .filter(lam(o): not(is-none(o)) end)
    .map(lam(o): o.value end)
    .sort-by({(a, b): a.{0} < b.{0}}, {(a, b): a == b})
end

# Deterministic LCG so the point cloud is reproducible across backends.
fun gen-points(n :: Number, seed :: Number) -> List<Number>:
  fun loop(i :: Number, s :: Number, acc :: List<Number>) -> List<Number>:
    if i <= 0: acc
    else:
      s2 = num-modulo((s * 1103515245) + 12345, 2147483648)
      loop(i - 1, s2, link(num-modulo(s2, 1000), acc))
    end
  end
  loop(n, seed, empty)
end

fun run(iters :: Number, seed :: Number, acc :: Number) -> Number:
  if iters <= 0: acc
  else:
    pts = gen-points(N-POINTS, seed)
    clusters = k-means-clustering(pts, N-CLUSTERS)
    s = clusters.foldl(lam(c, a): (a + c.{0}) + c.{1} end, 0)
    run(iters - 1, seed + 7, acc + s)
  end
end

t0 = time-now()
result = run(8, 1, 0)
t1 = time-now()
print(num-to-string(result) + "\n")
print("LOOP-MS " + num-to-string(t1 - t0) + "\n")
