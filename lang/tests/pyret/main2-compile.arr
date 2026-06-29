# Compile-pipeline suite: the nested-compile / full-pipeline tests carved out of
# main2.arr (import load-lib/compile-lib/cli-module-loader/repl, or print a
# `Running ... tests` phase). These are slow per-test and host the documented
# test-repl stacktrace-pin flakes; kept separate so the execution suite stays fast.

import file("./tests/test-error-rendering.arr") as _
import file("./tests/test-contracts.arr") as _
import file("./tests/test-well-formed.arr") as _
import file("./tests/test-repl.arr") as _
import file("./tests/test-stacktrace-portable.arr") as _
import file("./tests/test-file-locators.arr") as _
import file("./tests/test-builtin-locator.arr") as _
import file("./tests/test-compile-lib.arr") as _
import file("./tests/test-include.arr") as _
import file("./tests/test-modules.arr") as _
