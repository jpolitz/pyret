import file("../tests/pyret/test-compile-helper.arr") as CH

check:
  print("step1\n")
  r = CH.run-str("x :: String = 5")
  print("step2\n")
  r is%(CH.output) CH.contract-error
end
