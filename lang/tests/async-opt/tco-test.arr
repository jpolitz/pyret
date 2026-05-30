#lang pyret

# Correctness tests for the async-backend tail-recursion (loop) optimization.
# These pass under both backends, but exercise the cases most likely to break
# the self-tail-call -> while(true) transformation:
#   - very deep recursion (must not run out of fuel / blow up)
#   - argument reassignment whose new values depend on old parameters (the
#     get-assignments ordering / temp logic)
#   - tail calls in if and cases branches
#   - tail calls that are NOT eligible (arity mismatch, non-tail) still correct
#   - annotations on parameters re-checked on each iteration

fun count-down(n :: Number) -> Number:
  if n == 0: 0
  else: count-down(n - 1)
  end
end

# Accumulator-style: tail call reassigns both params; new `acc` depends on old
# `acc` and `n`, new `n` depends on old `n`. Exercises get-assignments.
fun sum-to(n :: Number, acc :: Number) -> Number:
  if n == 0: acc
  else: sum-to(n - 1, acc + n)
  end
end

# Swap: new a := old b, new b := old a. The classic case where naive sequential
# assignment clobbers; get-assignments must order/temp correctly.
fun parity(a :: Number, b :: Number, n :: Number) -> Number:
  if n == 0: a
  else: parity(b, a, n - 1)
  end
end

# Tail call inside a cases branch.
data Tree:
  | leaf
  | node(v :: Number, rest :: Tree)
end

fun tree-len(t :: Tree, acc :: Number) -> Number:
  cases (Tree) t:
    | leaf => acc
    | node(_, rest) => tree-len(rest, acc + 1)
  end
end

fun build-tree(n :: Number, acc :: Tree) -> Tree:
  if n == 0: acc
  else: build-tree(n - 1, node(n, acc))
  end
end

# Mutual-ish via a single function with a flag arg (still self-recursive).
fun ping(n :: Number, flag :: Boolean) -> Number:
  if n == 0:
    if flag: 1 else: 0 end
  else:
    ping(n - 1, not(flag))
  end
end

check "deep tail recursion":
  count-down(1000000) is 0
  sum-to(100000, 0) is 5000050000
end

check "argument interdependence and swap":
  parity(7, 9, 0) is 7
  parity(7, 9, 1) is 9
  parity(7, 9, 2) is 7
  parity(7, 9, 100000) is 7   # even count -> back to a
  parity(7, 9, 100001) is 9   # odd count -> b
end

check "tail call in cases branch":
  tree-len(build-tree(50000, leaf), 0) is 50000
end

check "flag flips each iteration":
  ping(0, true) is 1
  ping(0, false) is 0
  ping(100000, true) is 1     # even -> flag unchanged -> true
  ping(100001, true) is 0     # odd -> flipped -> false
end

# Parameter annotation must still fire on a bad recursive argument. Here the
# recursive call passes a String once n hits the base-ish case, which must raise
# a contract error (annotations are re-checked every loop iteration).
fun must-stay-number(n :: Number) -> Number:
  if n == 0:
    must-stay-number("not a number")
  else:
    must-stay-number(n - 1)
  end
end

check "annotations re-checked across loop iterations":
  must-stay-number(1000) raises "Number"
end

# Soundness: a tail call whose argument is a closure capturing a parameter must
# NOT be loop-optimized (in-place mutation would corrupt the escaped closure).
# The loop must be silently disabled for these so the answer matches a non-TCO
# version. (pyret issue #1230; mirrors tail-recursion-arg-order.arr.)
fun captures(a, b):
  foo = lam(): a end
  if a == 1: b() else: captures(1, foo) end
end
fun captures-no-tco(a, b):
  foo = lam(): a end
  if a == 1: b() else: captures-no-tco(1, foo) + 0 end
end

check "closure-capturing tail call stays sound (TCO disabled)":
  captures(4, 5) is 4
  captures(4, 5) is captures-no-tco(4, 5)
  captures(7, 5) is 7
end
