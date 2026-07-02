provide *

# Annotation-heavy compute: every helper is fully typed (param + return anns) and
# dispatches with `cases(T)` over typed data. This is the workload redundant
# annotation-check elimination targets (the existing compute benches are
# un-annotated, so they can't show it). Output is deterministic for cont/promise
# parity; LOOP-MS brackets only the driver loop.

data Tree:
  | leaf
  | node(v :: Number, l :: Tree, r :: Tree)
end

fun lcg(seed :: Number, a :: Number, c :: Number, m :: Number) -> Number:
  raw = (seed * a) + c
  raw - (num-floor(raw / m) * m)
end

fun build(n :: Number, seed :: Number) -> Tree:
  if n <= 0:
    leaf
  else:
    node(seed,
      build(n - 1, lcg(seed, 1103515245, 12345, 1000000)),
      build(n - 1, lcg(seed, 22695477, 1, 1000003)))
  end
end

fun tree-sum(t :: Tree) -> Number:
  cases(Tree) t:
    | leaf => 0
    | node(v, l, r) => v + tree-sum(l) + tree-sum(r)
  end
end

fun tree-depth(t :: Tree) -> Number:
  cases(Tree) t:
    | leaf => 0
    | node(v, l, r) =>
      dl = tree-depth(l)
      dr = tree-depth(r)
      1 + num-max(dl, dr)
  end
end

fun run(iters :: Number, acc :: Number) -> Number:
  if iters <= 0:
    acc
  else:
    t = build(12, iters)
    run(iters - 1, acc + num-modulo(tree-sum(t) + tree-depth(t), 100003))
  end
end

t0 = time-now()
result = run(120, 0)
t1 = time-now()
print(num-to-string(result) + "\n")
print("LOOP-MS " + num-to-string(t1 - t0) + "\n")
