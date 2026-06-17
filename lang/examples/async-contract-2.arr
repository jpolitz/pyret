import file("../tests/pyret/test-compile-helper.arr") as CH

check:
  print("Test 1\n")
  r1 = CH.run-str("x :: String = 5")
  print("R1 done\n")
  r1 is%(CH.output) CH.contract-error
  print("Test 2\n")
  r2 = CH.run-str("x :: Number = {x: 'not-a-num'}")
  print("R2 done\n")
  r2 is%(CH.output) CH.contract-error
end
