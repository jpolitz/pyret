provide *

fun hypot(a :: Number, b :: Number) -> Number:
  num-sqrt(num-sqr(a) + num-sqr(b))
end

fun classify(x :: Number) -> String:
  if x < 0: "neg" else if x > 10: "big" else: "mid" end
end

# var-mutating numeric accumulator via a recursive helper
fun accumulate(n :: Number) -> Number block:
  var total = 0
  var i :: Number = 0
  fun go():
    when i < n block:
      total := total + (i * 2)
      i := i + 1
      go()
    end
  end
  go()
  total
end

# An object with a custom _plus: dispatch must stay correct (operands here are
# NOT proven Number, so the op is not flattened).
data Vec: vec(x, y) with:
  method _plus(self, other): vec(self.x + other.x, self.y + other.y) end
end

v = vec(1, 2) + vec(3, 4)

main = [list:
  num-to-string(hypot(3, 4)),
  classify(-5), classify(50), classify(7),
  num-to-string(accumulate(100)),
  num-to-string(5 / 2),
  num-to-string(~6.67e-11 * 1000),
  num-to-string(v.x) + "," + num-to-string(v.y),
  num-to-string(num-floor(num-abs(-3.7)))
]
each(lam(s): print(s + "\n") end, main)
