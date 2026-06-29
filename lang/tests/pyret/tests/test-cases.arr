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

# Regression checks for the promise backend's redundant annotation-check
# elimination (the -no-ann-elision optimization, type-flow.ts). These must
# behave identically with the optimization on or off and in both backends -- the
# cont backend never elides, so running this file in both pins the two paths.
# See the upper-bound type-flow work on branch type-flow.

data ElBox: | elbox(v :: Number) end

fun el-pos(n :: Number) -> Boolean: n > 0 end
type ElPos = Number%(el-pos)

fun el-id-tree(t :: ElBox) -> ElBox:
  # cases(ElBox) re-checks the scrutinee `:: ElBox`; with t already `:: ElBox`
  # that re-check is elided, but the result is unchanged.
  cases(ElBox) t: | elbox(v) => elbox(v) end
end

fun el-mk(n :: Number) -> ElBox: elbox(n) end

check "ann-elision: elided scrutinee/return checks preserve behavior":
  el-id-tree(elbox(5)) is elbox(5)
  el-mk(7) is elbox(7)
  el-mk(7) satisfies is-elbox
  # scrutinee genuinely not of the type must still raise even though the
  # desugared scrutinee re-check is a candidate for elision
  el-id-tree(5) raises "ElBox"
end

check "ann-elision: a refinement check is NEVER elided (flat-restriction)":
  # `y :: ElPos = x` with x already `:: Number` must still RUN el-pos and raise
  # on a non-positive value -- the value being of Number's brand does not make
  # the refinement redundant. If elision wrongly fired, f(-3) would return -3.
  fun f(x :: Number) -> Number:
    y :: ElPos = x
    y
  end
  f(5) is 5
  f(-3) raises ""
end

check "ann-elision: a var of changing type is not given a stale type":
  var vv = 5
  vv := "now a string"
  vv is "now a string"
end

check "ann-elision: reassigned function var keeps its result check (no stale return type)":
  # g's first value returns a String; binding its result `:: Number` must RAISE.
  # If the flow-insensitive return-type tag were trusted across the reassignment,
  # the check would be wrongly elided and the String would slip through.
  var g = lam(x :: Number) -> String: num-to-string(x) end
  fun use-g() -> Number:
    r :: Number = g(5)
    r
  end
  use-g() raises "Number"
  g := lam(x :: Number) -> Number: x end
  use-g() is 5
end

# Regression checks for cases-branch field-type refinement (type-flow.ts): a
# matched variant's field binds take the variant's declared field types, which
# lets return checks on cases-returning functions elide. Must behave identically
# in both backends and with -no-ann-elision.

data ElColor: | el-red | el-green(shade :: Number) end

fun el-describe(c :: ElColor) -> Number:
  # shade :: Number is known from the variant; the compiler-inserted else throws
  # (contributes no type), so the result is Number and `-> Number` elides.
  cases(ElColor) c:
    | el-red => 0
    | el-green(shade) => shade
  end
end

data ElBox2: | el-bnum(n :: Number) | el-bstr(s :: String) end

fun el-get-num(b :: ElBox2) -> Number:
  # branch field types are Number and String; their join is Any, so the
  # `-> Number` return check must NOT be elided and el-bstr must raise.
  cases(ElBox2) b:
    | el-bnum(n) => n
    | el-bstr(s) => s
  end
end

check "ann-elision: cases-field refinement is correct and sound":
  el-describe(el-red) is 0
  el-describe(el-green(7)) is 7
  el-get-num(el-bnum(5)) is 5
  el-get-num(el-bstr("hi")) raises "Number"
end
