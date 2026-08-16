# Mutable state across the tier boundary. A var declared in JS mutated
# inside bytecode and read back in JS; a var declared in bytecode mutated
# by a nested JS lambda (for-each body) and read back in bytecode; letrec
# siblings across tiers; a JS TCO loop whose arg is captured by a bytecode
# closure; LICM-style invariant field reads in a loop body.
fun ping(n :: Number) -> Number:
  if n < -999999999: ping(n) else: n end
end
fun outer-js() block:
  var count = 0
  fun inner-vm(k) block:
    a = ping(k)
    b = ping(a)
    c = ping(b)
    count := count + c
    count
  end
  inner-vm(1)
  inner-vm(2)
  inner-vm(3)
  count
end
print(outer-js())
print("\n")
fun outer-vm(l) block:
  a = ping(1)
  b = ping(a)
  c = ping(b)
  var total = c
  for each(x from l):
    total := total + x
  end
  fun sib-js(y): total + y end
  fun sib-vm(y):
    p = ping(y)
    q = ping(p)
    r = ping(q)
    sib-js(r) + total
  end
  sib-vm(10)
end
print(outer-vm([list: 1, 2, 3]))
print("\n")
fun tco-js(n, acc):
  f = lam(k):
    a = ping(k)
    b = ping(a)
    c = ping(b)
    c + n
  end
  if n == 0: acc else: tco-js(n - 1, link(f, acc)) end
end
print(map(lam(g): g(100) end, tco-js(3, empty)))
print("\n")
data P: | pt(x :: Number, y :: Number) end
fun loop-inv(p :: P, l):
  a = ping(1)
  b = ping(a)
  c = ping(b)
  for map(i from l): p.x + p.y + i + c end
end
print(loop-inv(pt(3, 4), [list: 1, 2, 3]))
print("\n")
