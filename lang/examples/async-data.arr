data Point:
  | pt(x, y)
  | origin
end

fun mag(p):
  cases(Point) p:
    | pt(x, y) => num-sqrt((x * x) + (y * y))
    | origin => 0
  end
end

check:
  mag(pt(3, 4)) is 5
  mag(origin) is 0
  pt(1, 2) is pt(1, 2)
  pt(1, 2) is-not pt(2, 1)
end
