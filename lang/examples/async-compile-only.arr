import file("../tests/pyret/test-compile-helper.arr") as CH
import either as E

check:
  c = CH.compile-str("5")
  c satisfies E.is-right
end
