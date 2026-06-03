# Backend-agnostic stack-trace tests.
#
# test-repl.arr's check-block-6 pins EXACT get-result-stacktrace frame lists
# (exact length, the bottom "interactions://" frame, and TCO-collapsed middle
# frames). Those are sensitive to HOW the stack is materialized: the cont
# backend reads it off the trampoline's ActivationRecord stack, while the
# promise backend has heap-allocated async frames and V8-inserted await frames,
# so the exact list legitimately differs (see async-transform.md "Async stack
# traces differ ..." and REPORT.md "Known divergences").
#
# These tests exercise the SAME error scenarios but assert only the properties
# that are sensible and stable on BOTH backends:
#   (1) the error is detected at all (is-failure-result),
#   (2) the INNERMOST frame (index 0) points at the actual error site,
#   (3) the user's definition-site frames are PRESENT in the trace, and
#   (4) the trace is non-trivial (>= the user frames we can name).
# They deliberately do NOT pin total length, the bottom repl-interaction frame,
# or TCO frame collapsing.
#
# Imported by tests/pyret/main2.arr, so it runs as part of the normal suite on
# BOTH backends: `make all-pyret-test` (cont) and `make all-pyret-test-promise`
# (promise).

import load-lib as L
import runtime-lib as RT
import string-dict as SD
import either as E
import file("../../../src/arr/compiler/repl.arr") as R
import file("../../../src/arr/compiler/compile-structs.arr") as CS
import file("../../../src/arr/compiler/cli-module-loader.arr") as CLI

type Either = E.Either

r = RT.make-runtime()
repl = R.make-repl(r, [SD.mutable-string-dict:], L.empty-realm(), CLI.default-test-context, lam(): CLI.module-finder end)

fun restart(src, type-check):
  i = repl.make-definitions-locator(lam(): src end, CS.standard-globals)
  repl.restart-interactions(i, CS.default-compile-options.{type-check: type-check})
end
fun next-interaction(src):
  i = repl.make-interaction-locator(lam(): src end)
  repl.run-interaction(i)
end

# Does the stack trace (a raw-array of frame strings) contain `frame`?
fun st-has(st, frame):
  raw-array-to-list(st).member(frame)
end
# How many frames?
fun st-len(st): raw-array-length(st) end
# The innermost (deepest) frame, where the error actually happened.
fun st-top(st): raw-array-get(st, 0) end

check "error in a non-tail call chain (f calls g)":
  _ = restart("fun f(o): o.x end\n" +
              "fun g(): f(5)\n end", false)
  result = next-interaction("g()")
  result.v satisfies L.is-failure-result
  st = L.get-result-stacktrace(result.v)
  # innermost frame is the `.x` lookup on line 1
  st-top(st) is "definitions://: line 1, column 10"
  # g's call site on line 2 is in the trace
  st-has(st, "definitions://: line 2, column 9") is true
  (st-len(st) >= 2) is true
end

check "error in a method call chain":
  # g calls f in NON-tail position (let-bound), so g's call-site frame is retained
  # on BOTH backends. A *tail* call to a non-flat callee is now collapsed on the
  # promise backend (safe-for-space mutual TCO bounces the frame away) but kept on
  # cont (its trace comes from a separate ActivationRecord stack) -- a legitimate,
  # spec-flagged frame-shape divergence we don't assert here. See the deep
  # non-tail-recursion note below; same family.
  _ = restart("fun f(o): o.x() end\n" +
              "fun g():\n" +
              "  ans = f({x: 5})\n" +
              "  ans\n" +
              "end", false)
  result = next-interaction("g()")
  result.v satisfies L.is-failure-result
  st = L.get-result-stacktrace(result.v)
  # innermost frame is the `o.x()` method application on line 1
  st-top(st) is "definitions://: line 1, column 10"
  # f's (non-tail) call site on line 3 is in the trace
  st-has(st, "definitions://: line 3, column 8") is true
  (st-len(st) >= 2) is true
end

check "error at the bottom of a tail-recursive function":
  _ = restart("fun len(l, acc):\n" +
              "  cases (List) l:\n" +
              "    | empty => l.notafield\n" +
              "    | link(_, r) => len(r, 1 + acc)\n" +
              "  end\n" +
              "end", false)
  result = next-interaction("len(range(0, 10), 0)")
  result.v satisfies L.is-failure-result
  st = L.get-result-stacktrace(result.v)
  # TCO may drop the middle frames, but the innermost (the bad field access)
  # must be the top frame on both backends.
  st-top(st) is "definitions://: line 3, column 15"
  (st-len(st) >= 1) is true
end

# The two loop-helper traces below assert ONLY the innermost frame (the callback's
# error site) + detection. They deliberately do NOT assert the helper call site is
# present or st-len >= 2: `f` tail-calls the helper (`.map` / `raw-list-map` are
# method-apps, now safe-for-space tokens), so f's caller frame collapses on the
# promise backend; and async await-unwinding makes the surviving frame COUNT depend
# on ambient context (the identical code shows >= 2 frames inside the aggregate
# suite but 1 standalone). Error-site + detection are the stable portable props.
check "stack trace through list .map()":
  _ = restart("fun f():\n" +
              "h = lam(x): 9() end\n" +
              "[list: 1, 2, 3].map(h)\n" +
              "end", false)
  result = next-interaction("f()")
  result.v satisfies L.is-failure-result
  st = L.get-result-stacktrace(result.v)
  # innermost: the `9()` application inside the lambda
  st-top(st) is "definitions://: line 2, column 12"
end

check "stack trace through builtins.raw-list-map":
  _ = restart("fun f():\n" +
              "h = lam(x): x.somefield end\n" +
              "builtins.raw-list-map(h, [list: 1, 2, 3])\n" +
              "end", false)
  result = next-interaction("f()")
  result.v satisfies L.is-failure-result
  st = L.get-result-stacktrace(result.v)
  st-top(st) is "definitions://: line 2, column 12"
end

check "error in a deeply non-tail recursion (sum)":
  _ = restart("fun sum(x):\n" +
              "if x == 0:\n" +
              "  9()\n" +
              "else:\n" +
              "  x + sum(x - 1)\n" +
              "end\n" +
              "end", false)
  result = next-interaction("sum(1000)")
  result.v satisfies L.is-failure-result
  st = L.get-result-stacktrace(result.v)
  # innermost: the `9()` application on line 3 — reliable on both backends.
  st-top(st) is "definitions://: line 3, column 2"
  (st-len(st) >= 1) is true
  # NOTE: depth diverges hard here. cont keeps ~1002 frames (one per non-tail
  # recursion level); the promise backend's async frames are unwound by `await`
  # before capture, so the trace collapses to just the innermost error site.
  # Both correctly pinpoint WHERE the error is, which is the portable property;
  # the number of surviving recursion frames is backend-specific, so we don't
  # assert it.
end

check "the repl still returns answers (sanity)":
  _ = restart("x = 5", false)
  result = next-interaction("x + 1")
  L.get-result-answer(result.v) is some(6)
end
