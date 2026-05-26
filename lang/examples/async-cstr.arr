import file("../tests/pyret/test-compile-helper.arr") as CH
import file("../src/arr/compiler/cli-module-loader.arr") as CLI
import file("../src/arr/compiler/compile-lib.arr") as CL
import file("../src/arr/compiler/compile-structs.arr") as CS

check:
  print("step1\n")
  loc = CH.string-to-locator("5")
  print("step2\n")
  wlist = CL.compile-worklist(CLI.module-finder, loc, CLI.default-test-context)
  print("step3\n")
  result = CL.compile-program(wlist, CS.default-compile-options)
  print("step4\n")
  errors = result.loadables.filter(CL.is-error-compilation)
  print("step5\n")
  print("errors length: " + tostring(errors.length()))
end
