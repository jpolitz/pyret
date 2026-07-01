provide *
import matrices as MX

# Annotation-dense numeric workload: build NxN matrices and multiply them in a
# hot loop. The matrix library (src/arr/trove/matrices.arr) is heavily typed
# (`:: Matrix`, `:: Number`, `-> Number`/`-> Matrix` on get/_times/_plus/...), so
# it exercises redundant-annotation-check elimination on real library code, unlike
# the un-annotated compute benches. Output is deterministic for cont/promise parity.

N = 10

fun mk(seed :: Number) -> MX.Matrix:
  MX.build-matrix(N, N,
    lam(i :: Number, j :: Number) -> Number:
      num-modulo((((i * 7) + (j * 3)) + seed) + 1, 17)
    end)
end

fun trace-sum(m :: MX.Matrix) -> Number:
  # sum the diagonal via get(i,i) :: Number
  fun loop(i :: Number, acc :: Number) -> Number:
    if i >= N: acc
    else: loop(i + 1, acc + m.get(i, i))
    end
  end
  loop(0, 0)
end

fun run(iters :: Number, acc :: Number) -> Number:
  if iters <= 0: acc
  else:
    a = mk(iters)
    b = mk(iters + 1)
    c = a * b
    run(iters - 1, num-modulo(acc + trace-sum(c), 1000003))
  end
end

t0 = time-now()
result = run(1500, 0)
t1 = time-now()
print(num-to-string(result) + "\n")
print("LOOP-MS " + num-to-string(t1 - t0) + "\n")
