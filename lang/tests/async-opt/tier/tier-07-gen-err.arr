#lang pyret
# Gen-tier error-identity pin (Stage 5, commit "Gen tier").
# tier-boom has three capturing suspend sites (three let-bound non-flat
# calls, S = 3 > FewSuspend's S <= 2) => Gen verdict under ALL tier
# sub-flags, so the raise below fires INSIDE a generator-compiled body.
# run-gen-exec-tests.sh compares this program's complete output (error
# message + rendered stack) against the default (plain async residue)
# emission) build: they must be IDENTICAL -- generator resume frames
# ("at NAME.next (<anonymous>)") carry no location and are dropped by
# exn-stack-parser, so the rendered Pyret stack matches the async one.
# expect: tier-boom gen

fun tier-ping(n :: Number) -> Number:
  if n <= 0: 0
  else: tier-ping(n - 1)
  end
end

fun tier-boom(n :: Number) -> Number:
  a = tier-ping(n)
  b = tier-ping(a + 1)
  c = tier-ping(b + 2)
  if ((a + b) + c) > 999:
    0
  else:
    raise("gen-tier-boom")
  end
end

print(tier-boom(3))
