# Errors raised at machine sites, each caught with run-task so one program
# pins many shapes: arity mismatch calling bytecode from JS and from
# bytecode, applying a non-function, cases fallthrough, missing field,
# annotation failures on args / lets / cases binds, and an error inside a
# JS thunk (object extension). Output is compared against the promise build.
import either as E
fun ping(n :: Number) -> Number:
  if n < -999999999: ping(n) else: n end
end
# Gen-tier: three capturing sites.
fun g3(x, y):
  a = ping(x)
  b = ping(a)
  c = ping(b)
  c + y
end
fun show(t):
  cases(E.Either) run-task(t):
    | left(v) => print("ok: " + tostring(v) + "\n")
    | right(err) => print("err: " + tostring(exn-unwrap(err)) + "\n")
  end
end
data Box: | box(v :: Number) end
fun in-vm-1(x):
  a = ping(x)
  b = ping(a)
  c = ping(b)
  g3(c)      # arity from bytecode
end
fun in-vm-2(x):
  a = ping(x)
  b = ping(a)
  c = ping(b)
  c(1)       # non-function from bytecode
end
fun in-vm-3(x):
  a = ping(x)
  b = ping(a)
  c = ping(b)
  cases(Box) box(c):
    | box(v) => v.nope   # missing field
  end
end
fun in-vm-4(x :: String):
  a = ping(1)
  b = ping(a)
  c = ping(b)
  c
end
fun in-vm-5(x):
  a = ping(x)
  b = ping(a)
  c :: String = ping(b)
  c
end
fun in-vm-6(x):
  a = ping(x)
  b = ping(a)
  c = ping(b)
  o = {a: 1}
  o2 = o.{b: c}
  o2!a       # not a ref field
end
fun in-vm-7(x):
  a = ping(x)
  b = ping(a)
  c = ping(b)
  raise("boom-from-bytecode " + tostring(c))
end
fun in-vm-8(l):
  a = ping(1)
  b = ping(a)
  c = ping(b)
  cases(List) l:
    | link(f, r) => f
  end
end
show(lam(): g3(1, 2) end)
show(lam(): g3(1) end)
show(lam(): in-vm-1(5) end)
show(lam(): in-vm-2(5) end)
show(lam(): in-vm-3(5) end)
show(lam(): in-vm-4(5) end)
show(lam(): in-vm-5(5) end)
show(lam(): in-vm-6(5) end)
show(lam(): in-vm-7(5) end)
show(lam(): in-vm-8(empty) end)
show(lam(): in-vm-8([list: 7]) end)
