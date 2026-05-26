import file("../tests/pyret/test-compile-helper.arr") as CH

check:
  contract-errors = [list:
    "x :: String = 5",
    "x :: (String -> Number) = 5",
    "x :: Number = {x: 'not-a-num'}",
    "x :: Boolean = 'foo'",
    "x :: Boolean = 5"
  ]
  for each(program from contract-errors) block:
    print("test: " + program + "\n")
    r = CH.run-str(program)
    print("  result: " + tostring(r.success) + "\n")
    r is%(CH.output) CH.contract-error
  end
end
