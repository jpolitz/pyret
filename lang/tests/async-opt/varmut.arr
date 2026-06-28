#lang pyret
fun outer(reps) block:
  var total = 0
  fun inner(n) block:
    var acc = 0
    fun add-loop(k):
      when k > 0 block:
        acc := acc + k
        add-loop(k - 1)
      end
    end
    add-loop(n)
    total := total + acc
  end
  fun rep-loop(r):
    when r > 0 block:
      inner(200)
      rep-loop(r - 1)
    end
  end
  rep-loop(reps)
  total
end
print(outer(100000))
