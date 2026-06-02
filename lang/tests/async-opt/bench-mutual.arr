#lang pyret

# Deep MUTUAL tail recursion: is-even -> is-odd -> is-even -> ... N levels.
# NO return-type annotations on purpose -- a `-> Boolean` ann desugars the tail
# call to `let ans = f(...) in _checkAnn(Boolean, ans)`, which puts work after
# the call and defeats tail position on BOTH backends. Without it the self-call
# is genuinely in tail position, isolating the *cross-call* TCO question.
#
# Cont/trampoline: every tail call (self OR mutual) bounces back to the top
# trampoline loop, so the call stack stays O(1) -- safe-for-space.
#
# Promise/async: self tail calls become a `while(true){...continue}` loop (also
# O(1)), but a MUTUAL tail call is `return await is-odd(n-1)` -- which is NOT a
# JS tail call. is-even's async frame suspends (heap-allocated) holding the
# promise from is-odd, which holds the promise from is-even, ... a chain of N
# live suspended frames. GAS unwinds the *native* JS stack every INITIAL_GAS
# entries so it never overflows, but nothing can reclaim that suspended-frame
# chain until the base case resolves => O(n) heap. Expectation: cont memory is
# flat in N; promise memory grows linearly and OOMs at large N.

fun is-even(n):
  if n == 0: true
  else: is-odd(n - 1)
  end
end

fun is-odd(n):
  if n == 0: false
  else: is-even(n - 1)
  end
end

# depth=1M runs on both (cont ~137MB flat; promise ~843MB and rising). Promise
# maxRSS grows ~626 bytes/level (linear, O(n)) while cont stays flat (O(1));
# promise OOM-aborts around depth=5M. Bump `depth` to watch the divergence.
depth = 1000000
print(is-even(depth))
print("\n")
