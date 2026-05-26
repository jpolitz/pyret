import file("../tests/pyret/test-compile-helper.arr") as CH
import file("../src/arr/compiler/cli-module-loader.arr") as CLI
import file("../src/arr/compiler/compile-lib.arr") as CL

check:
  print("step1\n")
  loc = CH.string-to-locator("5")
  print("step2\n")
  wlist = CL.compile-worklist(CLI.module-finder, loc, CLI.default-test-context)
  print("step3\n")
  print("wlist length: " + tostring(wlist.length()))
end
