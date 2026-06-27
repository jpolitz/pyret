#lang pyret
# An argument must be evaluated EXACTLY ONCE even if the parameter is used many
# times in the callee body. ANF binds the argument to a temp before the call, and
# inlining must reuse that temp -- not substitute the argument EXPRESSION for each
# use. `gen` counts its calls; `twice` uses its parameter twice. Correct: gen runs
# once (calls = 1), r = 7 + 7 = 14 -> "14/1". A re-substituting inline reruns gen
# (calls = 2) -> "14/2".
var calls = 0
fun gen() block:
  calls := calls + 1
  7
end
fun twice(x): x + x end
fun run() block:
  r = twice(gen())
  num-to-string(r) + "/" + num-to-string(calls)
end
print(run())
