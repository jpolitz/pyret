import lists as L

fun double(x): x * 2 end

print(L.map(double, [list: 1, 2, 3, 4, 5]))
print(L.filter(lam(x): x > 2 end, [list: 1, 2, 3, 4, 5]))
print(L.fold(lam(acc, x): acc + x end, 0, [list: 1, 2, 3, 4, 5]))
