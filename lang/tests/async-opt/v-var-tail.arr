#lang pyret
fun sum-to(n) block:
  var acc = 0
  fun loop(k):
    if k > 0 block:
      acc := acc + k
      loop(k - 1)
    else: acc
    end
  end
  loop(n)
end
print(sum-to(2000000))
