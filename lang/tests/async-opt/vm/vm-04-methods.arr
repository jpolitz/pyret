# Bytecode METHODS: called from JS (maybeMethodCall / direct dispatch), from
# bytecode (METHCALL / METHCALLD), extracted with dot (curried), inside
# object literals and data variants, and branded.
fun ping(n :: Number) -> Number:
  if n < -999999999: ping(n) else: n end
end
data Counter:
  | counter(n :: Number) with:
    method bump(self, k):
      a = ping(k)
      b = ping(a)
      c = ping(b)
      counter(self.n + c)
    end,
    method twice(self, k):
      a = ping(k)
      b = ping(a)
      c = ping(b)
      self.bump(c).bump(c)
    end
end
o = {
  x: 10,
  method add(self, y):
    a = ping(y)
    b = ping(a)
    c = ping(b)
    self.x + c
  end
}
fun drive(c :: Counter, k):
  a = ping(k)
  b = ping(a)
  d = ping(b)
  c.bump(d).twice(d).n
end
print(counter(1).bump(2).n)
print("\n")
print(drive(counter(1), 3))
print("\n")
print(o.add(5))
print("\n")
f = o.add
print(f(7))
print("\n")
print(map(counter(0).bump, [list: 1, 2, 3]).map(lam(c): c.n end))
print("\n")
b = counter(4).bump(1)
print(is-counter(b))
print("\n")
