#lang pyret
# A higher-order helper is itself directly named and inlinable, but the call THROUGH
# its function parameter is not. Inlining `apply-twice` splices `f(f(x))` into the
# caller; the `f` calls (f now bound to inc) must remain dynamic applications, not be
# re-inlined. apply-twice(inc, 10) = inc(inc(10)) = 12.
fun inc(n): n + 1 end
fun apply-twice(f, x): f(f(x)) end
print(apply-twice(inc, 10))
