#lang pyret
# Nested inlining: a -> b -> c -> d, a chain of small non-recursive helpers. The
# inliner recurses into each spliced body, so the whole chain should collapse into
# one function. Pure value check against the cont oracle -- any mistake in the
# recursive splice (lost +1, wrong nesting) changes the result.
fun d(x): x + 1 end
fun c(x): d(x) + 1 end
fun b(x): c(x) + 1 end
fun a(x): b(x) + 1 end
print(a(10))
