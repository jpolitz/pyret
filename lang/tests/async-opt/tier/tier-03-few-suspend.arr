#lang pyret
# tier-mid: one mid-body capturing suspend (the non-flat tier-ping call is
# let-bound, its continuation joins into `x + 1`), possibly plus the
# polymorphic `_plus` if type-flow can't prove x :: Number -- either way
# S <= 2, B = 0 => FewSuspend.
# tier-branchy: the capturing suspend sits inside ONE a-if branch whose join
# falls through to `x + 1` => S <= 2, B = 1 => FewSuspend (the measured
# bounds: S <= 2, B <= 1).
# expect: tier-mid few-suspend
# expect: tier-branchy few-suspend

fun tier-ping(n :: Number) -> Number:
  if n <= 0: 0
  else: tier-ping(n - 1)
  end
end

fun tier-mid(n :: Number) -> Number:
  x = tier-ping(n)
  x + 1
end

fun tier-branchy(n :: Number, flag) -> Number:
  x = if flag: tier-ping(n) else: 0 end
  x + 1
end

print(tier-mid(4))
print(tier-branchy(4, true))
