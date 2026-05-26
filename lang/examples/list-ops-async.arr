import lists as L
fun double(x): x * 2 end
fun is-even(x): num-modulo(x, 2) == 0 end

xs = [list: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
print(L.map(double, xs))
print(L.filter(is-even, xs))
print(L.fold(lam(acc, x): acc + x end, 0, xs))
