data D:
  | d(x)
sharing:
  method _equals(self, other, recur):
    recur(self.x, other.x)
  end
end

check:
  d(1) is d(1)
  d(1) is-not d(2)
end
