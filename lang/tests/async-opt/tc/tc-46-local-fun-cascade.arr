#lang pyret
# A LOCAL `fun` defined inside an inlinable function. Inlining `compute` splices its
# body -- including the nested `helper` definition -- and the recursive splice should
# then inline `helper`'s two calls too (cascade). All binders of the nested def must
# be freshened. compute(3) = helper(3) + helper(4) = 9 + 16 = 25.
fun compute(n):
  fun helper(k): k * k end
  helper(n) + helper(n + 1)
end
print(compute(3))
