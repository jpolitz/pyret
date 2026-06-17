add1 = lam(x): x + 1 end
double = lam(x): x * 2 end
compose = lam(f, g): lam(x): f(g(x)) end end

f = compose(add1, double)
print(f(5))  # (5*2)+1 = 11
print(f(10))  # (10*2)+1 = 21
