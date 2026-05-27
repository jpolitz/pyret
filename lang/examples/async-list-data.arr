import lists as L

data Pair:
  | pair(a, b)
end

pairs = [list: pair(1, 2), pair(3, 4), pair(5, 6)]

fun add-pair(p):
  cases(Pair) p:
    | pair(a, b) => a + b
  end
end

check:
  L.map(add-pair, pairs) is [list: 3, 7, 11]
end
