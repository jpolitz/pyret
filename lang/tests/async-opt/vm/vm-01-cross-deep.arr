# Deep NON-tail recursion that alternates tiers on every level: `down` is
# Gen (>= 3 capturing sites: three let-bound calls to the non-flat `ping`),
# so it runs on the machine; `bounce` is TailFlat (one tail call to a
# non-flat callee) and stays JS. Each level enters the machine from JS and
# leaves it into JS: the JS stack must stay bounded (fuel at machine entry),
# and the whole thing must complete for n far beyond any JS stack.
fun ping(n :: Number) -> Number:
  if n < -999999999: ping(n) else: n end
end
fun bounce(n :: Number) -> Number:
  down(n)
end
fun down(n :: Number) -> Number:
  if n == 0: 0
  else:
    a = ping(n)
    b = ping(a)
    c = ping(b)
    1 + bounce(c - 1)
  end
end
print(down(300000))
print("\n")
