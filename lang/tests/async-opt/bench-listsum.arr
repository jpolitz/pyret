#lang pyret

# Microbenchmark: list-heavy workload (library async loops + many small awaited
# calls). Mixes both optimizations: helper functions and the recursive
# range/fold drivers benefit from the fuel-check micro-opt, and the recursive
# accumulators benefit from TCO.

fun build(n :: Number, acc :: List<Number>) -> List<Number>:
  if n == 0: acc
  else: build(n - 1, link(n, acc))
  end
end

fun sum-list(l :: List<Number>, acc :: Number) -> Number:
  cases (List) l:
    | empty => acc
    | link(f, r) => sum-list(r, acc + f)
  end
end

fun sweep(k :: Number, lst :: List<Number>, total :: Number) -> Number:
  if k == 0: total
  else: sweep(k - 1, lst, total + sum-list(lst, 0))
  end
end

big = build(50000, empty)
print(sweep(400, big, 0))
print("\n")
