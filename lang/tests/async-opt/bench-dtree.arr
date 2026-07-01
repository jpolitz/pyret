provide *
import lists as L
import sets as Sets
import string-dict as SD
import tables as TS

# Pure-CPU benchmark extracted from the Bootstrap "ai-library-models" decision-tree
# trainer (build-tree / find-best-split / k-means-clustering). Greedy top-down
# induction: at every node it tries every feature column, finds the split that
# minimizes weighted misclassification error -- categorical columns scan each
# distinct value, quantitative columns run k-means clustering on the column to pick
# a threshold -- then recurses on both child subtables. The subtables are built with
# Table.filter-by, so the whole thing is a recursion over real Pyret Table values.
# All the Google-Sheets / charting machinery is stripped; we synthesize a
# deterministic animal-shelter table (the species/sex/pounds/tail/mammal/swims schema
# from the Decision-Tree starter file), train a tree on it, and classify it back,
# repeated over several fresh tables. Heavy on Table filter-by/get-column/row-n,
# recursion, k-means, and StringDict counting; nothing async-targeted. Output is
# deterministic for cont/promise parity.

N-ROWS = 220

#############################################################################
# k-means (verbatim from ai-library-models, used for quantitative thresholds)

fun dist(a :: Number, b :: Number) -> Number: num-abs(a - b) end

fun find-closest(val :: Number, centroids :: List<Number>) -> Number:
  centroids.rest.foldl(lam(best, current):
      if dist(val, current) < dist(val, best): current else: best end
    end, centroids.first)
end

fun k-means-clustering(points :: List<Number>, n-clusters :: Number) -> List<{Number; Number}>:
  fun run-iterations(centroids, gas):
    assignments = points.map(lam(v): {val: v, center: find-closest(v, centroids)} end)
    new-centroids = centroids.map(lam(c):
        group = assignments.filter(lam(a): a.center == c end).map(lam(a): a.val end)
        if group.length() > 0:
          group.foldl(lam(acc, v): acc + v end, 0) / group.length()
        else: c
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

fun get-boundary-thresholds(intervals :: List<{Number; Number}>) -> List<Number>:
  fun find-midpoints(curr-intervals):
    cases(List) curr-intervals:
      | empty => empty
      | link(first-int, rest-int) =>
        if rest-int.length() == 0: empty
        else:
          next-int = rest-int.get(0)
          link((first-int.{1} + next-int.{0}) / 2, find-midpoints(rest-int))
        end
    end
  end
  if intervals.length() <= 1: empty
  else:
    find-midpoints(intervals.sort-by({(a, b): a.{0} < b.{0}}, {(a, b): a == b}))
  end
end

#############################################################################
# decision tree (verbatim from ai-library-models)

data DecisionTree:
  | decide(label :: String)
  | node(
      col :: String,
      is-quant :: Boolean,
      val :: Any,
      splitter :: (Any -> Boolean),
      yes :: DecisionTree,
      no :: DecisionTree)
sharing:
  method classify(self, r) -> String:
    cases(DecisionTree) self:
      | decide(lbl) => lbl
      | node(col, is-quant, val, splitter, yes, no) =>
        if splitter(r): yes.classify(r)
        else: no.classify(r)
        end
    end
  end
end

fun most-common(t, col :: String) -> String:
  vals = t.get-column(col)
  if vals.length() == 0: "unknown"
  else:
    counts = vals.foldl(lam(v, acc):
        key = to-string(v)
        cases(Option) acc.get(key):
          | none    => acc.set(key, 1)
          | some(n) => acc.set(key, n + 1)
        end
      end, [SD.string-dict: ])
    vals.foldl(lam(best, v):
        if counts.get-value(to-string(v)) > counts.get-value(to-string(best)): v
        else: best
        end
      end, vals.first)
  end
end

fun get-error-rate(t, label-col :: String) -> Number:
  total = t.length()
  if total == 0: 0
  else:
    majority = most-common(t, label-col)
    t.filter-by(label-col, lam(s): s <> majority end).length() / total
  end
end

fun weighted-error(low, high, label-col :: String) -> Number:
  (get-error-rate(low, label-col) * low.length())
    + (get-error-rate(high, label-col) * high.length())
end

data SplitInfo:
  | quant-split(col :: String, threshold :: Number, low, high, err :: Number)
  | cat-split(col :: String, val :: String, yes, no, err :: Number)
end

fun split-err(s :: SplitInfo) -> Number:
  cases(SplitInfo) s:
    | quant-split(_, _, _, _, e) => e
    | cat-split(_, _, _, _, e)   => e
  end
end

fun find-best-quant-split(t, col :: String, label-col :: String) -> Option<SplitInfo>:
  thresholds = get-boundary-thresholds(k-means-clustering(t.get-column(col), 2))
  if thresholds.length() == 0: none
  else:
    threshold = thresholds.get(0)
    low  = t.filter-by(col, lam(v): v < threshold end)
    high = t.filter-by(col, lam(v): v >= threshold end)
    if (low.length() == 0) or (high.length() == 0): none
    else:
      some(quant-split(col, threshold, low, high, weighted-error(low, high, label-col)))
    end
  end
end

fun find-best-cat-split(t, col :: String, label-col :: String) -> Option<SplitInfo>:
  possible-values = L.distinct(t.get-column(col))
  possible-values.foldl(lam(v, best-so-far):
      yes-t = t.filter-by(col, lam(val): to-string(val) == to-string(v) end)
      no-t  = t.filter-by(col, lam(val): to-string(val) <> to-string(v) end)
      if (yes-t.length() == 0) or (no-t.length() == 0): best-so-far
      else:
        err = weighted-error(yes-t, no-t, label-col)
        candidate = some(cat-split(col, to-string(v), yes-t, no-t, err))
        cases(Option) best-so-far:
          | none    => candidate
          | some(b) => if err < split-err(b): candidate else: best-so-far end
        end
      end
    end, none)
end

fun find-best-split(t, label-col :: String, cols :: List<String>) -> Option<SplitInfo>:
  current-err = get-error-rate(t, label-col) * t.length()
  cols.foldl(lam(col, best-so-far):
      first-val = t.row-n(0)[col]
      candidate =
        if is-number(first-val): find-best-quant-split(t, col, label-col)
        else:                    find-best-cat-split(t, col, label-col)
        end
      cases(Option) candidate:
        | none => best-so-far
        | some(c) =>
          if split-err(c) >= current-err: best-so-far
          else:
            cases(Option) best-so-far:
              | none    => candidate
              | some(b) => if split-err(c) < split-err(b): candidate else: best-so-far end
            end
          end
      end
    end, none)
end

fun build-tree(t, label-col :: String, cols :: List<String>) -> DecisionTree:
  unique-labels = L.distinct(t.get-column(label-col))
  if (unique-labels.length() <= 1) or (cols.length() == 0) or (t.length() == 0):
    decide(most-common(t, label-col))
  else:
    cases(Option) find-best-split(t, label-col, cols):
      | none => decide(most-common(t, label-col))
      | some(s) =>
        cases(SplitInfo) s:
          | quant-split(col, threshold, low, high, _) =>
            node(col, true, threshold, {(r): r[col] < threshold},
              build-tree(low,  label-col, cols),
              build-tree(high, label-col, cols))
          | cat-split(col, v, yes-t, no-t, _) =>
            node(col, false, v, {(r): r[col] == v},
              build-tree(yes-t, label-col, cols),
              build-tree(no-t,  label-col, cols))
        end
    end
  end
end

#############################################################################
# synthetic shelter table + driver

species-list = [list: "dog", "cat", "lizard", "rabbit", "snail", "tarantula"]
# rough per-species base weight (pounds); features get LCG noise on top
pounds-base  = [list: 50, 9, 1, 4, 1, 1]

fun gen-table(n :: Number, seed :: Number):
  fun loop(i :: Number, s :: Number, acc :: List) -> List:
    if i <= 0: acc
    else:
      s1 = num-modulo((s * 1103515245) + 12345, 2147483648)
      s2 = num-modulo((s1 * 1103515245) + 12345, 2147483648)
      s3 = num-modulo((s2 * 1103515245) + 12345, 2147483648)
      sp-idx = num-modulo(s1, 6)
      sp = species-list.get(sp-idx)
      mammal = (sp == "dog") or (sp == "cat") or (sp == "rabbit")
      tail = not(sp == "snail")
      swims = num-modulo(s2, 3) <> 0
      sex = if num-modulo(s2, 2) == 0: "male" else: "female" end
      pounds = pounds-base.get(sp-idx) + num-modulo(s3, 6)
      r = [TS.raw-row:
        {"species"; sp},
        {"sex"; sex},
        {"pounds"; pounds},
        {"tail"; tail},
        {"mammal"; mammal},
        {"swims"; swims}]
      loop(i - 1, s3, link(r, acc))
    end
  end
  TS.table-from-rows.make(raw-array-from-list(loop(n, seed, empty)))
end

feature-cols = [list: "sex", "pounds", "tail", "mammal", "swims"]

fun tree-size(t :: DecisionTree) -> Number:
  cases(DecisionTree) t:
    | decide(_) => 1
    | node(_, _, _, _, y, n) => (1 + tree-size(y)) + tree-size(n)
  end
end

fun count-correct(tbl, tree :: DecisionTree) -> Number:
  for fold(acc from 0, i from range(0, tbl.length())):
    r = tbl.row-n(i)
    if tree.classify(r) == r["species"]: acc + 1 else: acc end
  end
end

fun run(iters :: Number, seed :: Number, acc :: Number) -> Number:
  if iters <= 0: acc
  else:
    tbl = gen-table(N-ROWS, seed)
    tree = build-tree(tbl, "species", feature-cols)
    sig = tree-size(tree) + count-correct(tbl, tree)
    run(iters - 1, seed + 13, acc + sig)
  end
end

t0 = time-now()
result = run(6, 1, 0)
t1 = time-now()
print(num-to-string(result) + "\n")
print("LOOP-MS " + num-to-string(t1 - t0) + "\n")
