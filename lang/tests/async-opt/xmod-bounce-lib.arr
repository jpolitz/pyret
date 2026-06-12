provide *
provide-types *

# A library whose `bounce` tail-calls its FIRST-CLASS function argument. Used by
# mutual-tco-test.arr to build a mutual tail-recursion chain that crosses the
# module boundary: main's `xa` tail-calls this module's `bounce`, `bounce`
# tail-calls main's `xb`, and so on. The token minted here references a
# cross-module function value, and the token minted in main references this
# module's `bounce` value — exercising the claim that safe-for-space coverage is
# fully dynamic (cross-module / first-class), not just same-module.
#
# No return annotation, so `other(n - 1)` is a genuine tail call (a token), not a
# driven `let ans = … in _checkAnn(…)`.
fun bounce(other, n):
  if n == 0: 0
  else: other(n - 1)
  end
end
