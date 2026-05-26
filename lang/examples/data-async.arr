data Point:
  | pt(x, y)
end

fun magnitude(p):
  cases(Point) p:
    | pt(x, y) => num-sqrt((x * x) + (y * y))
  end
end

origin = pt(0, 0)
p1 = pt(3, 4)
print(magnitude(p1))
print(magnitude(origin))
