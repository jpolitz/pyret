#lang pyret
# Pure arithmetic on annotated Numbers: operator weakening turns +/* into the
# flat _plus_nums/_times_nums globals, the anns are flat, so both functions
# get today's Flat verdict (and MUST agree with the flatness analysis -- a
# disagreement is an InternalCompilerError at compile time).
# expect: tier-arith flat
# expect: tier-choose flat

fun tier-arith(x :: Number, y :: Number) -> Number:
  x + y
end

fun tier-choose(b) -> Number:
  if b: 1 else: 2 end
end

print(tier-arith(2, 3))
print(tier-choose(true))
