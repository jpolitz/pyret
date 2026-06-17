import file("../tests/pyret/test-compile-helper.arr") as CH

check:
  print("before run-str\n")
  r = CH.run-str("x :: String = 5")
  print("after run-str: ")
  print(r.success)
end
