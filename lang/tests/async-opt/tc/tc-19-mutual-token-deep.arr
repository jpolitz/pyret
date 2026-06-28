#lang pyret
# runcap: 200
# Mutual recursion x token minting x the inliner. ping/pong are mutually recursive,
# hence non-flat, so each tail-calls the other via a safe-for-space bounce TOKEN
# (makeTailFunction driver) -- NOT a `continue` (that is only for self-recursion).
# The inliner must NOT inline either one: they are a cycle, and inlining a cycle
# member collapses the bounce into an awaited recursive call (one async frame per
# level -> O(n) heap). The bug this guards: forward letrec references (`pong`, read
# in `ping` before `pong` is defined, via the uninitialized-guarded `a-id-letrec`)
# were dropped from the optimizer's call graph, so the cycle was not detected as
# recursive and ping got inlined into pong -> pong lost its driver -> deep mutual
# recursion OOMed under the optimizer (constant space without it). runcap 200, depth
# 10M: if the cycle is inlined again this OOMs; the accumulator makes the result
# depth-exact so a bad inline that corrupts values also shows.
fun ping(n, acc): if n <= 0: acc else: pong(n - 1, acc + 1) end end
fun pong(n, acc): if n <= 0: acc else: ping(n - 1, acc + 1) end end
print(ping(10000000, 0))
