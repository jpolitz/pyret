#lang pyret
# tier-helper: self-recursive (hence non-flat), but its only suspend-shaped
# call is the TCO self-call (`-> Number` makes it let-bound yet still
# appInfo.isTail, so it classifies as a TCO continue, and the trailing
# _checkAnn after `continue` is unreachable and not a site) => S=0 => TailFlat.
# tier-driver: single non-flat call in true tail position (no return ann, so
# the call stays the terminal lettable) => a tail direct-return site, S=0 =>
# TailFlat.
# expect: tier-helper tail-flat
# expect-allowtco: tier-helper true
# expect: tier-driver tail-flat

fun tier-helper(n :: Number) -> Number:
  if n <= 0: 0
  else: tier-helper(n - 1)
  end
end

fun tier-driver(n :: Number):
  tier-helper(n)
end

print(tier-driver(10))
