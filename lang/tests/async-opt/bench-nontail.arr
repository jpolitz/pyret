#lang pyret

# Microbenchmark: deep NON-tail recursion (true call tree). TCO cannot apply
# here (the recursive call is not in tail position), so this isolates the
# await-avoidance micro-optimization: every function entry runs the fuel check,
# and the common case now skips the `await` micro-op.

fun fib(n :: Number) -> Number:
  if n < 2: n
  else: fib(n - 1) + fib(n - 2)
  end
end

fun sweep(k :: Number, n :: Number, total :: Number) -> Number:
  if k == 0: total
  else: sweep(k - 1, n, total + fib(n))
  end
end

# 30 evaluations of fib(28): ~30 * 832040 calls ~= 25M non-tail calls.
print(sweep(30, 28, 0))
print("\n")
