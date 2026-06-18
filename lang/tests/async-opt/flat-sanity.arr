#lang pyret

# Correctness sanity for the flatness optimization: a flat function (cases over a
# datatype, only singleton construction -- no recursion, no arithmetic, no method
# calls) is compiled non-async, yet must behave identically. A flat refinement
# predicate (is-even-color) drives the makeFlatPredAnn fast path.

data Color: red | green | blue | cyan | magenta end

fun next-color(c :: Color) -> Color:
  cases(Color) c:
    | red => green
    | green => blue
    | blue => cyan
    | cyan => magenta
    | magenta => red
  end
end

fun two-steps(c :: Color) -> Color: next-color(next-color(c)) end

fun is-warmish(c :: Color) -> Boolean:
  cases(Color) c:
    | red => true
    | magenta => true
    | else => false
  end
end

# Flat predicate used as a refinement annotation -> makeFlatPredAnn.
fun tag-warm(c :: Color%(is-warmish)) -> Color: c end

check "flat functions behave correctly":
  next-color(red) is green
  next-color(magenta) is red
  two-steps(red) is blue
  two-steps(cyan) is red
  is-warmish(red) is true
  is-warmish(green) is false
  tag-warm(red) is red
  tag-warm(magenta) is magenta
  tag-warm(green) raises "predicate"
end

# Non-flat driver (arithmetic + recursion) calling the flat helper each iteration.
fun spin(n :: Number, c :: Color) -> Color:
  if n == 0: c
  else: spin(n - 1, two-steps(c))
  end
end

check "flat call from a non-flat loop":
  # two-steps = next-color twice; the cycle has 5 colors, so spin(n) advances 2n.
  spin(0, red) is red
  spin(1, red) is blue       # 2 steps:  red -> green -> blue
  spin(2, red) is magenta    # 4 steps:  ... -> cyan -> magenta
  spin(5, red) is red        # 10 steps: full 2 cycles
end
