#lang pyret
fun f(n) block:
  fun loop(k):
    if k > 0 block:
      loop(k - 1)
      7
    else: 7
    end
  end
  loop(n)
end
print(f(1000))
