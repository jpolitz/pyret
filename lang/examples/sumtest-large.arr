fun sum(n):
  if n == 0: 0
  else: n + sum(n - 1)
  end
end
print(sum(10000))
