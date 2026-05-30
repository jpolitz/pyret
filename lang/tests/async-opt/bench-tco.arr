#lang pyret

# Microbenchmark: tight self-tail-recursive accumulator loop.
# This is the case the TCO optimization targets directly: without it, every
# iteration is `return await self.app(...)` (a fresh async frame + an await);
# with it, the iteration is an in-place reassignment + `continue` in one frame.

fun sum-to(n :: Number, acc :: Number) -> Number:
  if n == 0: acc
  else: sum-to(n - 1, acc + n)
  end
end

fun sweep(k :: Number, n :: Number, total :: Number) -> Number:
  if k == 0: total
  else: sweep(k - 1, n, total + sum-to(n, 0))
  end
end

# 200 sweeps of a 200k-deep tail loop = 40M tail iterations.
print(sweep(200, 200000, 0))
print("\n")
