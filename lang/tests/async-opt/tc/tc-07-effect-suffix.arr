#lang pyret
fun cd(k) block:
  if k > 0 block:
    cd(k - 1)
    print("x")
  else: nothing
  end
end
cd(5)
