data MutCar:
  | mpair(ref car, cdr)
end

check:
  m1 = mpair("a", "b")

  cases(MutCar) m1:
    | mpair(car, cdr) => car + cdr
  end raises "ref field"

  cases(MutCar) m1:
    | mpair(ref car, cdr) => car + cdr
  end is "ab"

  cases(MutCar) m1:
    | mpair(car, ref cdr) => car + cdr
  end raises "ref field"

  cases(MutCar) m1:
    | mpair(ref car, ref cdr) => car + cdr
  end raises "non-ref field"

end

# Regression checks for the promise backend's direct (static) cases field access
# (the -no-direct-cases optimization). These must behave identically with the
# optimization on or off and in both backends -- the cont backend always uses the
# reflective path, so running this file in both backends pins the two paths
# against each other. See the direct-cases work on branch optimize-promises.

data Shape:
  | circ(radius)
  | rect(w, h)
  | dot
end

check "direct cases: in-module multi-field values, field order, and singleton":
  cases(Shape) circ(5):     | circ(r) => r | rect(w, h) => w + h | dot => 0  end is 5
  cases(Shape) rect(3, 4):  | circ(r) => r | rect(w, h) => w + h | dot => 0  end is 7
  # second positional field must be read by its own name, not by position alone
  cases(Shape) rect(3, 4):  | circ(r) => r | rect(w, h) => h     | dot => 0  end is 4
  # singleton variant (arity -1): no fields, arity check elided when static
  cases(Shape) dot:         | circ(r) => r | rect(w, h) => w     | dot => 99 end is 99
end

check "direct cases: imported types resolve their variant fields":
  cases(List) [list: 10, 20, 30]: | empty => 0 | link(f, r) => f end is 10
  cases(List) [list: 10, 20, 30]: | empty => 0 | link(f, r) => r end is [list: 20, 30]
  cases(List) empty:              | empty => -1 | link(f, r) => f end is -1
  cases(Option) some(42): | none => 0 | some(v) => v end is 42
  cases(Option) none:     | none => 7 | some(v) => v end is 7
end

check "direct cases: scrutinee not of the cases type raises the annotation error":
  # The static field access stays sound only because the scrutinee is checked to
  # be of the cases type before the switch; a mismatch must raise here, not read
  # garbage fields or fall through.
  cases(List) 5:     | empty => 0 | link(f, r) => f end raises "List"
  cases(Option) "x": | none => 0 | some(v) => v end raises "Option"
end
