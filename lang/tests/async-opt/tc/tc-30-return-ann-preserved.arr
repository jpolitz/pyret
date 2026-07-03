#lang pyret
# Inlining must PRESERVE the callee's RETURN annotation check. `bad-ret` is declared
# `-> Number` but returns a String, so the return contract must reject it -- the
# inliner keeps the declared return annotation as a real check on the spliced result.
# opt-promise must raise the same error as the cont oracle; dropping the return check
# would let opt-promise return the String instead -> output diverges.
fun bad-ret(x) -> Number: "not a number" end
fun run(): bad-ret(5) end
print(run())
