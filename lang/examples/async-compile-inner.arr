import file("../tests/pyret/test-compile-helper.arr") as CH

check:
  CH.run-str("5") is%(CH.output) CH.success
end
