#lang pyret
# Inlining must PRESERVE the callee's parameter annotation check. `check-num`'s body
# ignores its argument and returns 42, so the ONLY thing that can reject a bad call
# is the `x :: Number` contract. Passing a String must raise the same contract error
# under the optimizer (opt-promise) as under the un-optimized cont oracle. If the
# inline drops the param check, opt-promise would instead return 42 -> output diverges.
fun check-num(x :: Number): 42 end
fun run(): check-num("not a number") end
print(run())
