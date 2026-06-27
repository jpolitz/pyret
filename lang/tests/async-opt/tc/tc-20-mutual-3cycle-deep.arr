#lang pyret
# runcap: 200
# Recursion detection, LONGER cycle. a -> b -> c -> a is a 3-node mutual cycle
# (two forward letrec edges: a->b and b->c). None may be inlined; inlining any
# member collapses a bounce into an awaited recursive call whose stale is-recursive
# defeats the `continue`, so deep recursion goes O(n) heap -> OOM under the cap.
# Extends the 2-cycle (tc-19) to confirm the alias-resolved call graph closes
# multi-hop cycles. Accumulator makes the result depth-exact.
fun a(n, acc): if n <= 0: acc else: b(n - 1, acc + 1) end end
fun b(n, acc): if n <= 0: acc else: c(n - 1, acc + 1) end end
fun c(n, acc): if n <= 0: acc else: a(n - 1, acc + 1) end end
print(a(9000000, 0))
