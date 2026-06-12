#lang pyret

# Stack-safety guard for the loop helpers (runtime-async.js: raw_array_map /
# raw_array_each / raw_array_mapi / eachLoop; raw-list-map shares the loop shape
# and is covered by the pure-Pyret companion helper-reentry-pyret.arr).
#
# The hazard (from async-optimization-testing.md): a higher-order helper calls
# its callback *synchronously* and only decides whether to `await` afterward; if
# the callback re-enters the same helper, the synchronous portions nest and the
# native stack overflows. A raw-JS (FFI) callback (helper-reentry.js) with NO
# compiled per-entry fuel check is the purest probe of whether the *helper*
# bounds that re-entrant descent.
#
# On THIS (async/promise) backend the loop helpers charge fuel UNCONDITIONALLY
# on every iteration -- `if (needsPause()) await checkPause();` runs before each
# `await f.app(...)`, regardless of whether the callback returns a value or a
# Promise. So even a fuel-less re-entrant callback is bounded: every ~INITIAL_GAS
# levels the helper awaits, unwinding the native stack back to the event loop.
# Re-entry is therefore stack-safe at any depth -> run-reentry returns "ok".
#
# This is exactly the case a future helper-loop *conditional-await* optimization
# (skip the await + the fuel charge when a flat callback returns a value) would
# reintroduce the overflow for. These checks pin the current sound behavior: if
# such an optimization drops the per-iteration fuel charge, the deep cases below
# flip from "ok" to "OVERFLOW" and this guard fails -- which is the point.
#
# run-reentry returns "ok" / "OVERFLOW" / "ERR:..".  Modes:
#   "propagate" -- sync callback that re-enters and returns the helper's Promise.
#   "eager"     -- async callback that yields every `gas` levels (gas=0 = never).

import js-file("./helper-reentry") as R

helpers = [list: "raw-array-map", "raw-array-each", "raw-array-mapi", "each-loop"]

R.explain-expected-noise()

fun reenter(helper :: String, mode :: String, depth :: Number, gas :: Number) -> String:
  R.run-reentry(helper, mode, depth, gas)
end

# ---------------------------------------------------------------------------
# A fuel-less callback re-entering a loop helper does NOT overflow: the helper's
# per-iteration needsPause()/checkPause() bounds the re-entrant native-stack
# descent, even 200k levels deep.
# ---------------------------------------------------------------------------
check "re-entrant fuel-less callback is bounded by the helper's per-iter fuel (propagate)":
  for each(h from helpers) block:
    reenter(h, "propagate", 1000, 0) is "ok"     # shallow: fine
    reenter(h, "propagate", 200000, 0) is "ok"   # deep: still bounded by the helper
  end
end

# ---------------------------------------------------------------------------
# Bounded at extreme depth, and even when the callback itself never yields
# (gas=0): on this backend it is the HELPER's fuel, not the callback's, that
# bounds the stack -- so an eager callback that never yields is still safe.
# ---------------------------------------------------------------------------
check "bounded at extreme depth and with a fuel-less (gas=0) eager callback":
  reenter("raw-array-map", "eager", 1000000, 256) is "ok"
  reenter("each-loop", "eager", 1000000, 256) is "ok"
  reenter("raw-array-map", "eager", 200000, 0) is "ok"
end
