#lang pyret
# A RECURSIVE higher-order function must not be inlined (recursion guard), while the
# function argument is applied through the parameter at each level. `sum-map` folds a
# mapped function over a list recursively; sum-map(sq, [1,2,3,4]) = 1+4+9+16 = 30.
fun sum-map(f, lst):
  cases(List) lst:
    | empty => 0
    | link(first, rest) => f(first) + sum-map(f, rest)
  end
end
fun sq(n): n * n end
print(sum-map(sq, [list: 1, 2, 3, 4]))
