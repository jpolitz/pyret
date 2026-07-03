#lang pyret
# TailFlat execution corpus (Stage 5, commit "TailFlat tier") + verdict pins
# (picked up by run-tier-tests.sh's tier-*.arr glob).
#
# Shapes (params carry `:: Number` so operator weakening keeps `==`/`-`/`+`
# flat -- unannotated arithmetic is a capturing _minus/_equals site and lands
# in FewSuspend instead, see tf-mixed below):
#   tf-sum        self-TCO accumulator with `-> Number` (TCO continue + dead
#                 trailing check): the fuel re-enter must read the loop's
#                 CURRENT arg vars -- a stale re-enter recomputes from the
#                 original args and yields a wrong sum or diverges.
#   m-ev / m-od   deep MUTUAL tail recursion, no return anns: every call is a
#                 tail direct return; at 2M depth the ~500-entry fuel gas
#                 forces thousands of checkPause().then(re-enter) bounces, so
#                 this pins stack safety AND that pauses don't change results
#                 (the suspended chain returns the same promise through every
#                 sync frame -- O(1) heap per bounce).
#   cyc-a/b/c     3-cycle tail chain (non-self re-enter targets).
#   Counter.run   METHOD self tail call (tail method-app direct return
#                 through the aMethod emission arm).
#   use-it/outer-driver  a TailFlat TCO loop whose tail returns the result of
#                 an UNANNOTATED function argument, and a TailFlat function
#                 that closes over a Gen-tier lambda (`f`) calling a
#                 FewSuspend-or-Gen helper (`bump`) -- the nested-function-
#                 inherits-the-outer-tier bug class (ref branch) would give
#                 `f` the tail-flat fuel re-enter and leak a raw generator.
#
# expect: tf-sum tail-flat
# expect-allowtco: tf-sum true
# expect: m-ev tail-flat
# expect: m-od tail-flat
# expect: cyc-a tail-flat
# expect: cyc-b tail-flat
# expect: cyc-c tail-flat
# expect: run tail-flat
# expect: use-it tail-flat
# expect: outer-driver tail-flat
# expect: bump gen
# expect: f gen

fun tf-sum(n :: Number, acc :: Number) -> Number:
  if n == 0: acc
  else: tf-sum(n - 1, acc + n)
  end
end

fun m-ev(n :: Number):
  if n == 0: true
  else: m-od(n - 1)
  end
end
fun m-od(n :: Number):
  if n == 0: false
  else: m-ev(n - 1)
  end
end

fun cyc-a(n :: Number): if n == 0: 111 else: cyc-b(n - 1) end end
fun cyc-b(n :: Number): if n == 0: 222 else: cyc-c(n - 1) end end
fun cyc-c(n :: Number): if n == 0: 333 else: cyc-a(n - 1) end end

data Counter:
  | ctr
sharing:
  method run(self, n :: Number): if n == 0: "done" else: self.run(n - 1) end end
end

fun bump(k):
  if k == 0: 0
  else: bump(k - 1) + 1
  end
end

fun use-it(f, n :: Number):
  if n == 0: f(400)
  else: use-it(f, n - 1)
  end
end

fun outer-driver(n :: Number):
  f = lam(k): bump(k) + bump(k) + bump(k) end
  use-it(f, n)
end

DEPTH = 2000000

# TCO loop, ~4000 mid-loop fuel re-enters at default gas: 1 + 2 + ... + 2M.
print(tf-sum(DEPTH, 0))
# Deep mutual tail direct-return chains (result also fed through boolean and
# arithmetic ops: a leaked token / raw promise would error loudly).
print(m-ev(DEPTH))
print(m-od(DEPTH))
print(m-ev(DEPTH + 1))
print(m-ev(DEPTH) and not(m-od(DEPTH)))
# 3-cycle: DEPTH mod 3 == 2 -> lands in cyc-c from cyc-a.
print(cyc-a(DEPTH))
print(cyc-b(DEPTH))
# Method self tail chain.
print(ctr.run(1000000))
print(string-append(ctr.run(1000000), "!"))
# TailFlat TCO loop tail-returning an unannotated function argument's result;
# nested Gen lambda inside a TailFlat function (tier never inherited).
print(outer-driver(100000))
print(outer-driver(0))
