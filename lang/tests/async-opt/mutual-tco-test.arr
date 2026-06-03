#lang pyret

# Guard test for SAFE-FOR-SPACE mutual / first-class / cross-module tail calls on
# the async (promise) backend. A non-self tail call mints an `R.tailCall` bounce
# token that the public `.app` driver pumps to a value (O(1) heap). Two things
# must hold and are asserted here:
#   (a) Deep mutual / higher-order tail recursion is CORRECT and completes without
#       OOM / stack overflow (the whole point of the feature).
#   (b) A token is NEVER observable as a Pyret value. Tokens live only in transit
#       between an `appBody` return and the driver. If one ever leaked into a
#       binding, a leaked token would be seen by `==` / arithmetic / predicates /
#       `is` / printing as a "Non Pyret value" and these checks would ERROR or
#       FAIL loudly. So every check below feeds a tail-recursion result into one
#       of those observation paths.
#
# NOTE: no return-type annotations on the mutually-recursive helpers -- a `-> T`
# ann desugars the tail call to `let ans = f(...) in _checkAnn(T, ans)`, which is
# non-tail (driven to a value, not a token) on BOTH backends. The annotated case
# is tested separately at the bottom.

import file("xmod-bounce-lib.arr") as XB

# --- plain mutual recursion: is-even <-> is-odd (genuine tail calls => tokens) -
fun is-even(n):
  if n == 0: true else: is-odd(n - 1) end
end
fun is-odd(n):
  if n == 0: false else: is-even(n - 1) end
end

# --- value-returning mutual recursion (result fed into further computation) ----
# ev-tag(n) = "E" when n even, "O" when odd; od-tag is the mirror.
fun ev-tag(n):
  if n == 0: "E" else: od-tag(n - 1) end
end
fun od-tag(n):
  if n == 0: "O" else: ev-tag(n - 1) end
end

# --- 3-cycle cross-function chain: a3 -> b3 -> c3 -> a3 -> ... (all tail) -------
fun a3(n): if n == 0: 999 else: b3(n - 1) end end
fun b3(n): if n == 0: 999 else: c3(n - 1) end end
fun c3(n): if n == 0: 999 else: a3(n - 1) end end

# --- higher-order / first-class tail call: apply-tail tail-calls its argument ---
fun apply-tail(f, x): f(x) end
fun hev(n): if n == 0: 0 else: apply-tail(hod, n - 1) end end
fun hod(n): if n == 0: 1 else: apply-tail(hev, n - 1) end end

DEPTH = 1000000   # DEPTH is even

check "deep mutual recursion is correct and yields a value, not a token":
  is-even(DEPTH) is true
  is-odd(DEPTH) is false
  is-even(DEPTH) is-not is-odd(DEPTH)
  # token-leak detector: a leaked token has no _equals / boolean nature
  (is-even(DEPTH) and not(is-odd(DEPTH))) is true
end

check "value-returning mutual recursion flows through string ops / equality":
  r = ev-tag(DEPTH)
  r is "E"
  is-string(r) is true
  string-append(r, "!") is "E!"
  ev-tag(4) is "E"
  od-tag(4) is "O"
  [list: ev-tag(100), od-tag(100)] is [list: "E", "O"]
end

check "deep 3-cycle cross-function tail chain":
  a3(DEPTH) is 999
  b3(DEPTH) is 999
  c3(DEPTH) is 999
  (a3(DEPTH) + 1) is 1000   # arithmetic on the result: a leaked token would error
end

check "higher-order / first-class tail calls (callee is a runtime value)":
  hev(DEPTH) is 0
  hod(DEPTH) is 1
  (hev(DEPTH) + hod(DEPTH)) is 1
end

check "non-tail call to a token-producing function drives to a value":
  # Each call here is in a NON-tail position (argument to a constructor / ==),
  # so the driver must have already collapsed any token to a real value.
  l = [list: is-even(100), is-odd(100), ev-tag(100)]
  l is [list: true, false, "E"]
  (ev-tag(100) == "E") is true
  num-max(a3(100), 0) is 999
end

# --- annotated mutual tail calls: non-tail on both backends (driven, O(n)) -----
# Kept shallow because this path is genuinely O(n); it just must be CORRECT.
fun aev(n :: Number) -> Number:
  if n == 0: 0 else: aod(n - 1) end
end
fun aod(n :: Number) -> Number:
  if n == 0: 1 else: aev(n - 1) end
end

check "annotated mutual tail calls drive to a value (correctness)":
  aev(1000) is 0
  aod(1000) is 1
end

# === (1) Exceptions through a deep bounce ======================================
# A raise inside an appBody must propagate through the driver loop (the await
# rejects, the loop exits via the exception) — not be swallowed, not surface as a
# token. Tested at the base AND partway down a deep chain.
fun boom-ev(n): if n == 0: raise("boom-base") else: boom-od(n - 1) end end
fun boom-od(n): if n == 0: raise("boom-base") else: boom-ev(n - 1) end end
fun mid-ev(n): if n == 333333: raise("boom-mid") else: mid-od(n - 1) end end
fun mid-od(n): if n == 333333: raise("boom-mid") else: mid-ev(n - 1) end end

check "raise through a deep mutual bounce propagates (base and mid-chain)":
  boom-ev(1000000) raises "boom-base"
  boom-od(1000001) raises "boom-base"
  mid-ev(1000000) raises "boom-mid"          # raises after ~666667 bounces
  mid-od(1000000) raises "boom-mid"
end

# === (2) Cross-MODULE mutual tail recursion ====================================
# main's xa tail-calls the lib's `bounce` (cross-module token), `bounce`
# tail-calls main's xb (first-class token), xb tail-calls the lib's `bounce`, …
# The whole chain bounces across the module boundary — verifying coverage is
# fully dynamic via the function value, not same-module only.
fun xa(n): XB.bounce(xb, n) end
fun xb(n): XB.bounce(xa, n) end

check "cross-MODULE mutual tail recursion (main <-> lib <-> main) is correct":
  xa(1000000) is 0
  xb(1000000) is 0
  xa(0) is 0
  (xa(1000000) + 7) is 7            # result usable in arithmetic => not a leaked token
end

# === (3) Mutual tail calls INSIDE cases branches ===============================
# The tail call sits inside a `cases` branch (data dispatch) — the common shape
# of interpreters / state machines, and a distinct codegen path
# (compile-cases-branch-async). Depth comes from `n`, not a deep structure, so
# this isolates frame-O(1) from data size.
data Dir: | up | down end
fun climb(d, n):
  cases(Dir) d:
    | up => if n == 0: 0 else: descend(d, n - 1) end
    | down => if n == 0: 0 else: descend(d, n - 1) end
  end
end
fun descend(d, n):
  cases(Dir) d:
    | up => if n == 0: 0 else: climb(d, n - 1) end
    | down => if n == 0: 0 else: climb(d, n - 1) end
  end
end

check "mutual tail recursion inside cases branches is correct (and O(1))":
  climb(up, 1000000) is 0
  climb(down, 1000000) is 0
  descend(up, 999999) is 0
end

# === (4) Accumulator + permuted multi-arg threaded through the bounce ==========
# Verifies the value built up across the bounce is exact, and the token's args
# array carries several (and reordered) arguments correctly.
fun sum-ev(n, acc): if n == 0: acc else: sum-od(n - 1, acc + n) end end
fun sum-od(n, acc): if n == 0: acc else: sum-ev(n - 1, acc + n) end end
fun rot-a(x, y, z, n): if n == 0: [list: x, y, z] else: rot-b(y, z, x, n - 1) end end
fun rot-b(x, y, z, n): if n == 0: [list: x, y, z] else: rot-a(y, z, x, n - 1) end end

check "accumulator and permuted multi-arg threaded through a mutual bounce":
  sum-ev(1000000, 0) is 500000500000       # 1 + 2 + … + 1000000
  sum-od(100, 0) is 5050
  rot-a(1, 2, 3, 3) is [list: 1, 2, 3]      # left-rotate, period 3
  rot-a(1, 2, 3, 1) is [list: 2, 3, 1]
  rot-a(1, 2, 3, 1000000) is [list: 2, 3, 1]   # 1000000 mod 3 = 1
end

# === (6) Loop helper driving a token-producing callback ========================
# The callback lambda's body tail-calls a mutually-recursive function, so the
# lambda is itself token-producing (its `.app` is the driver). map/fold must
# drive it to a value — exercising the conditional-await in raw_array/list
# helpers against a callback whose `.app` returns a promise.
fun count-ev(n, acc): if n == 0: acc else: count-od(n - 1, acc + 1) end end
fun count-od(n, acc): if n == 0: acc else: count-ev(n - 1, acc + 1) end end

check "a loop helper drives a token-producing callback to a value":
  [list: 10, 20, 30].map(lam(x): count-ev(x, 0) end) is [list: 10, 20, 30]
  map(lam(x): count-ev(x, 0) end, [list: 7, 8]) is [list: 7, 8]
  (for fold(acc from 0, x from [list: 100, 200, 300]): count-ev(x, acc) end) is 600
end

# === Methods: mutual recursion THROUGH methods (the known gap) =================
# Methods are PMethod (meth/full_meth), not PFunction with .app/.appBody, so a
# method-app in tail position drives to a value instead of minting a token —
# correct and matching cont, but O(n) heap (depth kept modest). This pins the
# current behavior; if methods later mint tokens, these stay green and a memory
# check would flip to O(1).
data PingPong:
  | pp
sharing:
  method ev(self, n): if n == 0: "even" else: self.od(n - 1) end end,
  method od(self, n): if n == 0: "odd" else: self.ev(n - 1) end end
end

check "mutual recursion through methods is correct (driven to a value, O(n))":
  pp.ev(100000) is "even"
  pp.od(100000) is "odd"
  pp.ev(100001) is "odd"
  pp.od(100001) is "even"
end
