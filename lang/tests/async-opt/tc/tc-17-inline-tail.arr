#lang pyret
# Inliner x tail call, TAIL-position case (the plugTail path). `finish` is a
# non-recursive call in the base-case TAIL position of a self-tail loop. The inliner
# splices finish's body in as the tail value via plugTail; this must preserve the
# result AND not mis-mark the spliced code as a tail call of `go`. Tail-position
# inlining is one-shot (not a space concern), so this is a value/correctness check
# against the cont oracle: the cross-build outputs must all agree on finish(1000)*... .
fun finish(acc :: Number) -> Number:
  acc * 2
end
fun go(n :: Number, acc :: Number) -> Number:
  if n == 0: finish(acc)
  else: go(n - 1, acc + 1)
  end
end
print(go(1000, 0))
