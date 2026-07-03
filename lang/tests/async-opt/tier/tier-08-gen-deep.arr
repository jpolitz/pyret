#lang pyret
# Gen-tier stack-safety pin (Stage 5, commit "Gen tier"): deep NON-tail
# recursion in a function that stays Gen under ALL tier flags (four capturing
# suspend sites per level -- above the FewSuspend S <= 2 bound), so this file
# keeps exercising the generator emission even after the TailFlat/FewSuspend
# commits land (unlike tests/async-opt/deep-nontail.arr, whose single-site
# `sum` migrates to FewSuspend). The JS stack must stay bounded by GAS: on
# fuel exhaustion the generator body yields, the sync wrapper returns an
# R.driveGen promise, and every pending caller's conditional await unwinds
# the whole stack -- same discipline as the async emission, via yields.
#
# idf is non-flat only through its (never-taken) self-call, so calls to it
# are non-flat app sites (capturing when let-bound mid-body) while it
# computes the identity -- gdeep(n) == n, checked below.
# expect: gdeep gen

fun idf(x :: Number) -> Number:
  if x < -999999999: idf(x)
  else: x
  end
end

fun gdeep(n :: Number) -> Number:
  if n == 0: 0
  else:
    a = gdeep(n - 1)
    b = idf(a)
    c = idf(b)
    1 + idf(c)
  end
end

print(gdeep(200000))
print("\n")
