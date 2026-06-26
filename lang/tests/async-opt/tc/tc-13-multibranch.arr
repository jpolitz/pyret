#lang pyret
fun f(n) block:
  var acc = 0
  fun loop(k):
    if k > 5 block:
      acc := acc + k
      loop(k - 1)
      nothing
    else if k > 0:
      acc := acc + (k * 2)
      loop(k - 1)
      nothing
    else: nothing
    end
  end
  loop(n)
  acc
end
print(f(10))
