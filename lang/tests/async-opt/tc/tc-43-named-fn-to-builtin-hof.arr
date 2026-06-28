#lang pyret
# A named user function passed to a built-in (cross-module) HOF. `map` lives in
# another module, so `sq` is not inlined into it -- it crosses as a first-class value
# and is applied per element. map(sq, [1,2,3,4]) = [list: 1, 4, 9, 16]. The printed
# list must match the cont oracle exactly.
fun sq(n): n * n end
print(map(sq, [list: 1, 2, 3, 4]))
