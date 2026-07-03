#lang pyret
# A capturing suspend INSIDE an a-cases branch (the non-flat tier-ping call is
# let-bound under the link branch, and the un-weakened `+` on the unannotated
# field keeps it mid-body): v1 conservatism says suspend-in-cases => Gen even
# though S/B are within the FewSuspend bounds (ref parity: the ref bailed on
# await-inside-switch; relaxation is a flagged follow-on).
# expect: tier-summer gen

fun tier-ping(n :: Number) -> Number:
  if n <= 0: 0
  else: tier-ping(n - 1)
  end
end

fun tier-summer(l):
  cases(List) l:
    | empty => 0
    | link(f, r) => tier-ping(f) + 1
  end
end

print(tier-summer([list: 1, 2]))
