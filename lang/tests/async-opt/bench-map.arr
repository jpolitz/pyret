#lang pyret

# Microbenchmark for the higher-order-helper conditional-await optimization
# (raw_list_map / raw_list_fold). The callbacks here are *flat* -- they call only
# flatness:0 builtins (num-abs / num-max), so the compiler emits them as
# non-async JS functions. Under the optimization the runtime loop helpers detect
# that `f.app(x)` returned a value (not a Promise) and skip the per-element
# `await` microtask; a non-flat (async) callback would still return a Promise and
# be awaited as before.
#
# 2000 sweeps * 20k-element list * (1 map + 1 fold) = 80M flat callback
# applications, dominated by the per-element await the optimization removes.

fun build(n :: Number, acc :: List<Number>) -> List<Number>:
  if n == 0: acc
  else: build(n - 1, link(n, acc))
  end
end

fun run(k :: Number, lst :: List<Number>, total :: Number) -> Number:
  if k == 0: total
  else:
    mapped = map(lam(x): num-abs(x) end, lst)
    m = fold(lam(acc, x): num-max(acc, x) end, 0, mapped)
    run(k - 1, lst, total + m)
  end
end

big = build(20000, empty)
print(run(2000, big, 0))
print("\n")
