#lang pyret
fun f(n) block:
  var acc = 0
  fun loop(k):
    if k > 0 block:
      loop(k - 1)
      acc := acc + 1
      acc
    else: acc
    end
  end
  loop(n)
end
print(f(1000))
