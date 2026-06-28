#lang pyret
fun f(k):
  if k > 0 block:
    f(k - 1)
    5
  else: 10
  end
end
print(f(3))
