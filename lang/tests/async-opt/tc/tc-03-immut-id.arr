#lang pyret
fun f(n) block:
  d = 99
  fun loop(k):
    if k > 0 block:
      loop(k - 1)
      d
    else: d
    end
  end
  loop(n)
end
print(f(1000))
