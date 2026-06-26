#lang pyret
fun f(n) block:
  var acc = 0
  fun loop(k):
    if k > 0 block:
      acc := acc + k
      loop(k - 1)
      acc
    else:
      if acc > 1000000: 0 else: acc end
    end
  end
  loop(n)
end
print(f(1000))
