data Point:
  | pt(x, y)
end

check:
  pt(1, 2) is pt(1, 2)
  pt(1, 2) is-not pt(3, 4)
  pt(1, 2).x is 1
end
