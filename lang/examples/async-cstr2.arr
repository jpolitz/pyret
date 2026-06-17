import file("../tests/pyret/test-compile-helper.arr") as CH
import either as E

check:
  print("before compile-str\n")
  r = CH.compile-str("5")
  print("after compile-str\n")
  r satisfies E.is-right
end
