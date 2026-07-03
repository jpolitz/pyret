#lang pyret
# Three capturing suspend sites (three let-bound non-flat calls) exceed the
# measured FewSuspend bound (S <= 2) => Gen.
# expect: tier-busy gen

fun tier-ping(n :: Number) -> Number:
  if n <= 0: 0
  else: tier-ping(n - 1)
  end
end

fun tier-busy(n :: Number) -> Number:
  a = tier-ping(n)
  b = tier-ping(a)
  c = tier-ping(b)
  (a + b) + c
end

print(tier-busy(3))
