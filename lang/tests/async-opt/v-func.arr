#lang pyret
fun loop(k, acc):
  if k == 0: acc
  else: loop(k - 1, acc + k)
  end
end
print(loop(20000000, 0))
