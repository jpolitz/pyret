#lang pyret
fun f(n) block:
  var a = 1
  var b = 2
  fun loop(k):
    if k > 0 block:
      loop(k - 1)
      a
    else: b
    end
  end
  loop(n)
end
print(f(3))
