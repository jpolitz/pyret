#lang pyret
fun sum-to(n) block:
  var acc = 0
  fun loop(k):
    when k > 0 block:
      doubled = k + k
      acc := acc + doubled
      loop(k - 1)
    end
  end
  loop(n)
  acc
end
print(sum-to(1000))
