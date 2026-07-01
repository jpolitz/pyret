provide *

# Pure-CPU benchmark extracted from the classic CS019 "seam carving" assignment
# (content-aware image resizing). Carving one vertical seam means: build the energy
# matrix from the brightness matrix (img-energy, a nested map-triplets over every
# 3x3 neighbourhood), run the seam dynamic program bottom-up (energy-seams, a foldr
# over rows that propagates lowest-weight seams via best-of-3), pick the global
# best-seam, then drop one pixel per row from both the colour and brightness
# matrices (remove-seam). remove-seams repeats that n times on a progressively
# narrower image. All the image-loading / bitmap / Google-Drive support machinery
# is stripped; we bake in a deterministic pseudo-random brightness matrix and carry
# a parallel "colour" matrix of numbers (seam removal is content-agnostic), then
# carve n seams over several images. Heavy on map2/map3/foldr + list rebuilding and
# num-sqrt; nothing async-targeted. Output is deterministic for cont/promise parity.

WIDTH = 32
HEIGHT = 24
N-SEAMS = 6

# weight: the total energy of all the pixels in the seam
# positions: the x offsets of the seam at each column of an image
data Seam:
  | seam(weight :: Number, positions :: List)
end

data Triple:
  | triple(a :: Any, b :: Any, c :: Any)
end

fun energy(a :: Number, b :: Number, c :: Number,
           d :: Number, e :: Number, f :: Number,
           g :: Number, h :: Number, i :: Number) -> Number:
  xenergy = (a + ((2 * d) + g)) - (c + ((2 * f) + i))
  yenergy = (a + ((2 * b) + c)) - (g + ((2 * h) + i))
  num-sqrt((xenergy * xenergy) + (yenergy * yenergy))
end

fun map-triplets(proc :: (Any, Any, Any -> Any), lst :: List, edge :: Any) -> List:
  cases(List) lst:
    | empty => empty
    | link(_, rest) =>
      map3(proc,
        link(edge, lst.take(lst.length() - 1)),
        lst,
        rest.append([list: edge]))
  end
end

fun drop-at(lst :: List, pos :: Number) -> List:
  if pos == 0: lst.rest else: link(lst.first, drop-at(lst.rest, pos - 1)) end
end

fun img-energy(img :: List) -> List:
  map-triplets(lam(prev-row, curr-row, next-row):
      map-triplets(lam(prev, curr, next):
          energy(prev.a, curr.a, next.a,
            prev.b, curr.b, next.b,
            prev.c, curr.c, next.c)
        end,
        map3(triple, prev-row, curr-row, next-row),
        triple(0, 0, 0))
    end,
    img,
    repeat(img.first.length(), 0))
end

fun best-seam(seams :: List) -> Seam:
  for fold(best from seams.first, elem from seams.rest):
    if elem.weight < best.weight: elem else: best end
  end
end

fun best-of-3(left :: Option, center :: Seam, right :: Option) -> Seam:
  fun to-list(ms):
    cases(Option) ms: | some(s) => [list: s] | none => empty end
  end
  best-seam(to-list(left).append(link(center, to-list(right))))
end

fun energy-seams(img :: List) -> List:
  width = img.first.length()
  img.foldr(lam(row, seams):
      map3(lam(e, s, pos):
          seam(e + s.weight, link(pos, s.positions))
        end,
        row,
        map-triplets(lam(l, c, r): best-of-3(l, c.value, r) end,
          seams.map(some),
          none),
        range(0, width))
    end,
    repeat(width, seam(0, empty)))
end

fun remove-seam(img :: List, s :: Seam) -> List:
  map2(drop-at, img, s.positions)
end

fun remove-seams(colors :: List, brightnesses :: List, n :: Number) -> List:
  if n == 0: colors
  else:
    min-seam = best-seam(energy-seams(img-energy(brightnesses)))
    remove-seams(remove-seam(colors, min-seam),
      remove-seam(brightnesses, min-seam),
      n - 1)
  end
end

# Deterministic LCG matrix generator: brightness values in [0, 765] (the RGB-sum
# range of the original). The "colour" matrix carries the same numbers; seam removal
# treats it opaquely, so its element type is irrelevant to the work performed.
fun gen-matrix(w :: Number, h :: Number, seed :: Number) -> List<List<Number>>:
  var s = seed
  for map(_r from range(0, h)):
    for map(_c from range(0, w)) block:
      s := num-modulo((s * 1103515245) + 12345, 2147483648)
      num-modulo(s, 766)
    end
  end
end

fun matrix-sum(m :: List<List<Number>>) -> Number:
  m.foldl(lam(row, acc): acc + row.foldl(lam(v, a): a + v end, 0) end, 0)
end

fun run(iters :: Number, seed :: Number, acc :: Number) -> Number:
  if iters <= 0: acc
  else:
    brightnesses = gen-matrix(WIDTH, HEIGHT, seed)
    colors = gen-matrix(WIDTH, HEIGHT, seed)
    carved = remove-seams(colors, brightnesses, N-SEAMS)
    run(iters - 1, seed + 101, acc + matrix-sum(carved))
  end
end

t0 = time-now()
result = run(2, 1, 0)
t1 = time-now()
print(num-to-string(result) + "\n")
print("LOOP-MS " + num-to-string(t1 - t0) + "\n")
