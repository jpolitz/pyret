#lang pyret
# Deep NON-tail recursion: builds n pending additions on the heap (O(n) frames).
# Stack-safety test for the async backend: the JS stack must stay bounded by GAS
# (periodic await-unwind), never overflowing regardless of n.
fun sum(n :: Number) -> Number:
  if n == 0: 0
  else: 1 + sum(n - 1)
  end
end
print(sum(1000000))
print("\n")
