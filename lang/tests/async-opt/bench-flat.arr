#lang pyret

# Microbenchmark targeted at the flatness optimization's *call-site* win
# (avoiding `await` on calls to flat functions). The hot loop calls flat builtin
# functions -- num-modulo / num-abs / num-max / num-min, each annotated
# flatness:0 -- referenced as plain globals (a safe id), so the optimization can
# both (a) skip the await at the call site and (b) rely on these being
# synchronous. The arithmetic ops (==, -) that drive the loop counter are
# non-flat and stay awaited; everything else here is a flat call.
#
#   - without the optimization: each flat-builtin call is `await f.app(...)` --
#     a microtask round-trip even though the builtin returns synchronously.
#   - with it: each is an ordinary synchronous `f.app(...)` -- no await, no
#     microtask. (This is the same treatment the default/trampoline backend gives
#     calls to flat functions: no isCont check.)
#
# 12 flat-builtin calls per iteration vs 2 arithmetic ops, so the loop is
# dominated by flat calls. num-modulo keeps the values small (fixnums), so the
# arithmetic itself stays cheap and the await overhead is what dominates.

fun spin(n :: Number, x :: Number) -> Number:
  if n == 0:
    x
  else:
    a0 = num-modulo(x, 97)
    a1 = num-abs(a0)
    a2 = num-max(a1, 3)
    a3 = num-min(a2, 91)
    a4 = num-modulo(a3, 89)
    a5 = num-abs(a4)
    a6 = num-max(a5, 5)
    a7 = num-min(a6, 83)
    a8 = num-modulo(a7, 79)
    a9 = num-abs(a8)
    a10 = num-max(a9, 7)
    a11 = num-min(a10, 71)
    spin(n - 1, a11)
  end
end

# 20,000,000 iterations * 12 flat-builtin calls = 240M flat calls.
print(spin(20000000, 12345))
print("\n")
