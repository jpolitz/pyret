#lang pyret
# A nested lambda closes over and MUTATES a local `var` of the inlined function.
# After inlining `make-acc`, the freshened `total` must be the same binding the
# nested `add` reads and assigns -- otherwise the mutations are lost or aliased.
# make-acc(100): 100 + 5 + 10 = 115.
fun make-acc(init) block:
  var total = init
  add = lam(x) block:
    total := total + x
    total
  end
  add(5)
  add(10)
  total
end
print(make-acc(100))
