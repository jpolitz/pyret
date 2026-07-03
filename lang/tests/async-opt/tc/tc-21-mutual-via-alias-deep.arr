#lang pyret
# runcap: 200
# Recursion detection THROUGH AN EXPLICIT ALIAS. `ping` reaches `pong` only via a
# local copy `alt = pong`, then calls `alt(...)`. The call's callee is `alt`, not
# `pong`, so the cycle is invisible unless the call graph follows the single-id
# alias binding (the same resolution that fixes the temp-bound forward letrec ref).
# If the alias is not followed, the ping/pong cycle is missed, a member is inlined,
# and deep recursion OOMs under the cap. Pins the alias-resolution path directly.
fun ping(n, acc):
  alt = pong
  if n <= 0: acc else: alt(n - 1, acc + 1) end
end
fun pong(n, acc): if n <= 0: acc else: ping(n - 1, acc + 1) end end
print(ping(9000000, 0))
