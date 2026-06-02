#lang pyret

# Stress test for the higher-order-helper conditional-await optimization
# (runtime-async.js: raw_array_map / raw_array_each / raw_array_mapi / eachLoop;
# raw-list-map shares the identical loop shape and is covered by the pure-Pyret
# companion helper-reentry-pyret.arr).
#
# The scenario from async-optimization-testing.md: user code calls a helper with
# a callback; the helper calls the callback *synchronously* (planning to check
# for a Promise only after it returns); the callback re-enters the same helper,
# which re-enters the loop and hits the synchronous call again; this repeats and
# the native stack overflows.
#
# The callback is a raw-JS (FFI) function (helper-reentry.js) with NO compiled
# per-entry fuel check -- the purest probe of whether the *helper* bounds the
# re-entrant native-stack descent. The callback honors the embedder contract
# (it returns the helper's Promise), so a re-entrant overflow surfaces as a
# caught failure rather than being swallowed. run-reentry returns "ok" /
# "OVERFLOW" / "ERR:..".  Modes:
#   "propagate" -- callback returns the helper's Promise (helper's `await res`
#                  branch); the overflow propagates to the awaiter and is caught.
#   "eager"     -- async callback that yields to the event loop every `gas`
#                  levels: the "more aggressive fuel accounting" hypothesis.

import js-file("./helper-reentry") as R

helpers = [list: "raw-array-map", "raw-array-each", "raw-array-mapi", "each-loop"]

# Heads-up (to stderr) that the RangeError spew below is the test working -- it
# deliberately overflows the native stack. Runs before the checks.
R.explain-expected-noise()

fun reenter(helper :: String, mode :: String, depth :: Number, gas :: Number) -> String:
  R.run-reentry(helper, mode, depth, gas)
end

# ---------------------------------------------------------------------------
# Headline: a fuel-less callback that re-enters a loop helper overflows the
# native stack. The helper does NOT bound the re-entrant descent. (propagate
# mode -> the overflow is caught and reported, not silently buried.)
# ---------------------------------------------------------------------------
check "re-entrant fuel-less callback overflows every loop helper (propagate)":
  for each(h from helpers) block:
    reenter(h, "propagate", 1000, 0) is "ok"          # shallow: fine
    reenter(h, "propagate", 200000, 0) is "OVERFLOW"  # deep: native stack blows
  end
end

# ---------------------------------------------------------------------------
# The fix hypothesis (async-optimization-testing.md): "more aggressive fuel
# accounting -- call needsPause eagerly". Expressed here at the callback: an
# async callback that yields to the event loop every `gas` levels bounds the
# native stack, so an arbitrarily deep re-entry completes. Contrast gas=0 (never
# yield) which overflows just like the sync callbacks above.
# ---------------------------------------------------------------------------
check "eager periodic yield bounds the descent (the fix direction)":
  # 1,000,000-deep re-entry, yielding every 256 levels: completes cleanly.
  reenter("raw-array-map", "eager", 1000000, 256) is "ok"
  reenter("each-loop", "eager", 1000000, 256) is "ok"
  # An eager (async) callback that NEVER yields still overflows -- it is the
  # yield, not merely being async, that bounds the stack.
  reenter("raw-array-map", "eager", 200000, 0) is "OVERFLOW"
end
