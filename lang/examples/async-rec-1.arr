import file("../src/arr/compiler/compile-structs.arr") as CS
import file("../tests/pyret/test-compile-helper.arr") as H

check "pointless":
  print("step1\n")
  errs = H.get-compile-errs("rec _ = 5")
  print("step2\n")
  errs.first satisfies CS.is-pointless-rec
end
