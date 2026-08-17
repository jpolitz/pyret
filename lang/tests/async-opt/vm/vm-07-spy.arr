# `spy` from bytecode functions and from JS ones: the runtime renders the
# spy location through srcloc's `format` method (a Pyret method that may
# be compiled async), so the two flavors must print the same locations
# (this pinned a promise leak in the runtime's spy renderer: "[object
# Promise]" instead of the location).
fun ping(n :: Number) -> Number:
  if n < -999999999: ping(n) else: n end
end
fun spy-vm(k):
  a = ping(k)
  b = ping(a)
  c = ping(b)
  spy "in bytecode": a, b, c end
  spy: k end
  c
end
fun spy-js(k):
  spy "in js": k end
  k + 1
end
print(spy-vm(3))
print("\n")
print(spy-js(4))
print("\n")
