#lang pyret

# Pure-Pyret companion to helper-reentry.arr (the raw-JS/FFI probe).
#
# Same scenario -- a callback that re-enters the higher-order helper it was
# handed -- but here the callback is ordinary *compiled* Pyret code. Because it
# calls a helper it is non-flat, so the compiler emits it as an async function
# WITH the load-bearing per-entry fuel check (`if (needsPause()) await pause()`).
# That check is what distinguishes this from the FFI case: when fuel runs out
# `pause()` unwinds the whole native stack back to the event loop and resumes the
# continuation on a fresh stack, so the re-entrant descent is bounded and does
# NOT stack-overflow -- even though it is genuine (non-tail) recursion through
# the loop helper.
#
# Contrast with helper-reentry.arr: a raw-JS callback has no per-entry fuel
# check, never yields, and overflows the native stack at a re-entry depth of only
# ~2,500. The compiled callbacks below survive 200,000+.

import either as E

# reenter-* : the callback's body is a (non-tail) call back into the same helper
# over a singleton list -> re-entry depth == call depth == n. (Points 1 & 2 from
# async-optimization-testing.md: "the body of the callback is just a tail call
# back into one of these helpers" / "the callback is one of these helpers".)
fun reenter-map(n :: Number) -> Number block:
  when n > 0 block:
    map(reenter-map, [list: n - 1])
    nothing
  end
  0
end

fun reenter-each(n :: Number) -> Number block:
  when n > 0 block:
    each(reenter-each, [list: n - 1])
    nothing
  end
  0
end

fun reenter-fold(n :: Number) -> Number:
  fold(lam(_acc, x): if x > 0: reenter-fold(x - 1) else: 0 end end, 0, [list: n])
end

fun reenter-array-map(n :: Number) -> Number block:
  when n > 0 block:
    raw-array-map(reenter-array-map, [raw-array: n - 1])
    nothing
  end
  0
end

fun ok(thunk) -> Boolean:
  E.is-left(run-task(thunk))
end

# ---------------------------------------------------------------------------
# A compiled (fuel-checked) callback re-entering a loop helper does NOT
# stack-overflow, even 200,000 levels deep. The per-entry fuel check + pause()
# unwind keeps the native stack bounded. (The FFI equivalent overflows at ~2.5k.)
# ---------------------------------------------------------------------------
check "compiled re-entrant callback into map/each/fold is stack-safe (200k deep)":
  ok(lam(): reenter-map(200000) end) is true
  ok(lam(): reenter-each(200000) end) is true
  ok(lam(): reenter-fold(200000) end) is true
  ok(lam(): reenter-array-map(200000) end) is true
end

# ---------------------------------------------------------------------------
# The doc's "naive" case: a deep-but-bounded callback applied across a real
# list, and nested maps over nested data. Confirms normal heavy usage stays
# correct under the conditional-await optimization.
# ---------------------------------------------------------------------------
fun sum-to(n :: Number) -> Number:
  # non-flat (arithmetic + recursion) callback body, ~n deep per element
  if n <= 0: 0 else: n + sum-to(n - 1) end
end

check "deep non-flat callback over a 10k list stays correct":
  big = range(0, 10000)
  # each element maps to sum-to(50) = 1275; fold them back up.
  mapped = map(lam(_x): sum-to(50) end, big)
  fold(lam(acc, x): acc + x end, 0, mapped) is 10000 * 1275
end

check "nested map over nested lists is correct":
  # map whose callback maps -- re-entry one level deep per outer element, but
  # over real data, checked for the right answer.
  outer = map(lam(i): range(0, i) end, range(0, 200))         # list of lists
  totals = map(lam(inner): fold(lam(a, x): a + x end, 0, inner) end, outer)
  # sum_{i<200} (i*(i-1)/2)
  fold(lam(a, x): a + x end, 0, totals) is 1313400
end

check "each accumulates across a large list without yielding issues":
  var c = 0
  each(lam(x): c := c + x end, range(0, 100000))
  c is (99999 * 100000) / 2
end
