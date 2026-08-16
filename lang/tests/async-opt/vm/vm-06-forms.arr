# The JS-thunk forms inside a bytecode function (data declarations are
# top-level only in Pyret, so a data value with a refined field and a ref
# field is used from bytecode instead): an object literal with methods, object extension, ref update with a
# refinement, tuples, structural (record/tuple/refined) annotation checks,
# a type alias, and a check block; plus string-dict and higher-order trove
# functions driven from bytecode.
import string-dict as SD
fun ping(n :: Number) -> Number:
  if n < -999999999: ping(n) else: n end
end
fun is-small(n): n < 100 end
type Pair = {a :: Number, b :: Number}
data Local:
  | one(v :: Number%(is-small))
  | two(v :: Number, ref w :: Number)
sharing:
  method get(self): self.v end
end
fun forms(k) block:
  a = ping(k)
  b = ping(a)
  c = ping(b)
  o = { x: c, method m(self): self.x * 2 end }
  o2 = o.{y: c + 1}
  t = two(c, c)
  t!{w: c * 10}
  tup = {c; c + 1; c + 2}
  {p; q; r} = tup
  recd :: Pair = {a: p, b: q}
  refd :: Number%(is-small) = r
  d = [SD.string-dict: "a", c, "b", c + 1]
  s = d.keys-list().foldl(lam(key, acc): acc + d.get-value(key) end, 0)
  m = map(lam(x): x + c end, [list: 1, 2, 3])
  [list: one(c).get(), t!w, o.m(), o2.y, recd.a + recd.b, refd, s, m.length(), tostring(m)]
end
print(forms(5))
print("\n")
fun forms-check(k) block:
  a = ping(k)
  b = ping(a)
  c = ping(b)
  check:
    c is 3
    c + 1 is 4
  end
  c
end
print(forms-check(3))
print("\n")
