import string-dict as SD

data Wrap:
  | wr(x)
sharing:
  method _equals(self, other, recur):
    recur(self.x, other.x)
  end
end

check:
  s1 = [SD.string-dict: "a", wr(1), "b", wr(2)]
  s2 = [SD.string-dict: "a", wr(1), "b", wr(2)]
  s1 is s2
end
