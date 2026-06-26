#lang pyret
fun run(n) block:
  fun ev(k):
    when k > 0 block:
      od(k - 1)
    end
  end
  fun od(k):
    when k > 0 block:
      ev(k - 1)
    end
  end
  ev(n)
  "done"
end
print(run(6))
