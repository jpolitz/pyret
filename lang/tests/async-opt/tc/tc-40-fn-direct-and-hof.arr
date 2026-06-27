#lang pyret
# The same function `inc` is used BOTH as a direct call (inlinable) and passed as a
# first-class value to a HOF (where it is applied through a parameter). Both uses must
# stay correct: inc(5) + apply(inc, 5) = 6 + 6 = 12. Guards that making a function an
# inline target does not corrupt its first-class-value uses.
fun inc(n): n + 1 end
fun apply(f, x): f(x) end
fun run(): inc(5) + apply(inc, 5) end
print(run())
