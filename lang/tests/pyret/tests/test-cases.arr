import either as DF-E

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

# Regression for refinement base-type propagation (type-flow.ts): a value that
# passed `Number%(p)` is a Number for downstream ub purposes (so a later `:: Number`
# elides), but the refinement's OWN check is never elided (p still runs and raises).

fun el-is-small(n :: Number) -> Boolean: n < 100 end

fun el-use-refined(x :: Number%(el-is-small)) -> Number:
  y :: Number = x   # ub(x) = Number (the refinement's base) -> this check elides
  y + 1
end

check "ann-elision: refinement base type propagates; refinement check still fires":
  el-use-refined(5) is 6
  el-use-refined(500) raises ""   # el-is-small fails -> the param refinement raises
end

# Regression for following type ALIASES to a refinement base (type-flow.ts):
# `type T = Number%(p)` resolves to base Number for ub (so a downstream `:: Number`
# elides), while the alias's own refinement check is still never elided. This is
# the matrices.arr `NonZeroNat`/`Nat` pattern.

type ElNZ = Number%(el-is-small)

fun el-use-alias(x :: ElNZ) -> Number:
  y :: Number = x   # ub(x) = Number via the alias's base -> this check elides
  y + 1
end

check "ann-elision: aliased refinement base propagates; alias check still fires":
  el-use-alias(5) is 6
  el-use-alias(500) raises ""   # el-is-small fails through the alias -> raises
end

# Soundness-basis pin for method-call flatness (-no-method-flatness,
# flatness.ts + type-flow.ts): the analysis assumes a value satisfying `:: T`
# carries T's ORIGINAL methods, so a `:: T`-checked receiver may dispatch to
# the statically analyzed (possibly flattened) method. That assumption holds
# because functional extend `obj.{m: ...}` that OVERRIDES a method STRIPS the
# data brand: the extended object can no longer pass a `:: T` check, so no
# checked receiver ever carries an override. Pin both halves: (a) the extended
# value fails the annotation; (b) with NO intervening annotation, a call on the
# extended value dispatches to the OVERRIDE (i.e. the optimization must never
# re-route an unchecked receiver to the original method). These must behave
# identically with method flatness on or off and in both backends.

data FeBox:
  | febox(v :: Number) with:
    method get(self) -> Number: self.v end
end

fun fe-checked-get(x :: FeBox) -> Number: x.get() end

check "functional-extend-strips-brand":
  b = febox(3)
  b.get() is 3
  b2 = b.{get: method(self) -> Number: 42 end}
  # (b) no annotation between the extend and the call: Pyret semantics dispatch
  # to the override. If method flatness wrongly treated b2 as a FeBox receiver,
  # a flattened direct dispatch could answer 3 here.
  b2.get() is 42
  # (a) the override stripped the brand, so the `:: FeBox`-checked path raises
  # -- which is exactly why a checked receiver always has the original methods.
  fe-checked-get(b) is 3
  fe-checked-get(b2) raises "FeBox"
end

# Regression checks for the promise backend's direct (static) cases field access
# (the -no-direct-cases optimization). These must behave identically with the
# optimization on or off and in both backends -- the cont backend always uses the
# reflective path, so running this file in both backends pins the two paths
# against each other.

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

# Regression checks for the promise backend's direct field access / direct
# method dispatch (the -no-direct-fields optimization, type-flow tagDirectFields).
# These must behave identically with the optimization on or off and in both
# backends -- the cont backend always uses the reflective getField /
# maybeMethodCall path, so running this file in both backends pins the paths
# against each other.

data DfTree:
  | dfleaf(val :: Number) with:
    method sum(self) -> Number: self.val end
  | dfnode(left :: DfTree, right :: DfTree) with:
    # `self` here is known to be the dfnode variant, so self.left/self.right are
    # per-variant direct reads (they are NOT in the cross-variant intersection:
    # dfleaf has neither).
    method sum(self) -> Number: self.left.sum() + self.right.sum() end
end

check "direct fields: per-variant self.field inside a variant's own method":
  t = dfnode(dfleaf(1), dfnode(dfleaf(2), dfleaf(3)))
  t.sum() is 6
  dfleaf(7).sum() is 7
end

check "direct fields: cross-module field access via the imported DataType":
  # Either's `left`/`right` variants both carry `v`, so a `:: Either`-annotated
  # value's `.v` is a direct read resolved through env.datatypeByUri.
  e1 :: DF-E.Either = DF-E.left(5)
  e2 :: DF-E.Either = DF-E.right("ok")
  e1.v is 5
  e2.v is "ok"
end

data DfHelper:
  | dfhelp(n :: Number) with:
    # A with: member whose value is a plain FUNCTION, not a method: obj.dict["bump"]
    # is a PFunction (.app), not a PMethod (.full_meth). Direct method dispatch must
    # NOT fire for it (recordMember resolves the method bind node, so only genuine
    # methods enter the direct-dispatch sets); the maybeMethodCall function branch
    # must still handle it.
    bump: lam(x :: Number) -> Number: x + 1 end
end

check "direct fields: a plain-function-valued with: member is not direct-dispatched":
  h = dfhelp(0)
  h.bump(41) is 42
end

data DfCell:
  | dfcell(v :: Number) with:
    method get(self) -> Number: self.v end
end

fun df-checked-get(c :: DfCell) -> Number:
  # This call site IS eligible for direct dispatch (receiver ub is DfCell, `get`
  # on its only variant) -- and stays sound because the `:: DfCell` check runs
  # before it on every entry.
  c.get()
end

check "direct fields: functional extend still dispatches to the override":
  c = dfcell(3)
  c.get() is 3
  c2 = c.{get: method(self) -> Number: 42 end}
  # Unannotated receiver: the extended value's ub is not DfCell (a-extend is
  # Any), so no direct dispatch may be tagged here; the override must win.
  c2.get() is 42
  # Annotated path: the extend stripped the brand, so the direct-dispatch-tagged
  # call in df-checked-get can never see an overridden receiver -- the `:: DfCell`
  # check raises first.
  df-checked-get(c) is 3
  df-checked-get(c2) raises "DfCell"
end

# Stage-7 object-representation pins (promise runtime's flat-dict extendWith +
# shared dictProto, runtime-async.js). Functional extend builds the extended
# dict FLAT in one merged pass (it used to layer a prototype and let the
# PObject constructor re-flatten it), and record dicts share one empty
# prototype object instead of prototype null. These pins hold the observable
# contract fixed across that representation change -- and across backends: the
# cont runtime keeps the old chain-then-flatten construction, so running this
# file in both backends pins the two implementations against each other.

check "functional extend: enumeration order (extension fields first)":
  o = {x: 1, y: 2}
  torepr(o) is "{x: 1, y: 2}"
  # All-new extension: the NEW fields enumerate FIRST, then the old fields in
  # their original order -- the exact insertion sequence the historical
  # layered construction produced (own props first, then unshadowed proto
  # props, flattened in for-in order).
  torepr(o.{z: 3}) is "{z: 3, x: 1, y: 2}"
  # An overridden field takes its position in the EXTENSION, not the original.
  torepr(o.{y: 9, z: 3}) is "{y: 9, z: 3, x: 1}"
  # Chained extends compose the same rule at each step.
  torepr(o.{z: 3}.{x: 10}) is "{x: 10, z: 3, y: 2}"
end

check "functional extend: all-new fields KEEP the data brand":
  b = febox(3)
  b2 = b.{note: "hi"}
  # b2 is a plain object now (data values extend to plain objects via the
  # updateDict virtual dispatch), but an all-new-fields extension KEEPS the
  # brands, so the `:: FeBox` check still passes and the original methods are
  # intact alongside the new field.
  fe-checked-get(b2) is 3
  b2.get() is 3
  b2.note is "hi"
  # Contrast (the strips side is pinned in "functional-extend-strips-brand"):
  # overriding ANY existing field -- a plain data field included -- strips.
  fe-checked-get(b.{v: 5}) raises "FeBox"
end

check "functional extend: updating a ref field is an error":
  m = mpair("a", "b")
  m.{car: "x"} raises "Cannot update ref field"
  # Extending AROUND a ref field is fine, and the ref itself is aliased into
  # the extended object -- not rebuilt -- so updates through the original are
  # visible in the extension.
  m2 = m.{cdr: "c"}
  m2.cdr is "c"
  m2!car is "a"
  m!{car: "z"}
  m2!car is "z"
end

check "functional extend: structural equality over extended records":
  o = {x: 1, y: 2}
  # Extended-vs-literal and extended-vs-extended pairs exercise the
  # same-dict-proto fast path of structural equality (compare own keys); the
  # answers must be identical if the slow chain-walking path runs instead.
  (o.{y: 9} == {x: 1, y: 9}) is true
  (o.{z: 3} == {x: 1, y: 2, z: 3}) is true
  ({x: 1, y: 2, z: 3} == o.{z: 3}) is true
  (o.{z: 3} == o.{z: 3}) is true
  (o.{z: 3} == o.{z: 4}) is false
  (o.{z: 3} == o) is false
end
