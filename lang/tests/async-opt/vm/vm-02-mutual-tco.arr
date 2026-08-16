# Mutual TAIL recursion between two Gen-tier functions (each has three
# let-bound non-flat calls before its tail call; NO return annotation, which
# would make the tail call a let-bound one on both backends), 3M deep. On the machine
# this is TAILCALL frame reuse: O(1) frames. Run under a tight heap cap by
# the harness; a frame leak fails loudly.
fun ping(n :: Number) -> Number:
  if n < -999999999: ping(n) else: n end
end
fun even-loop(n :: Number, acc :: Number):
  a = ping(n)
  b = ping(a)
  c = ping(b)
  if c == 0: acc else: odd-loop(c - 1, acc + 1) end
end
fun odd-loop(n :: Number, acc :: Number):
  a = ping(n)
  b = ping(a)
  c = ping(b)
  if c == 0: acc else: even-loop(c - 1, acc + 2) end
end
print(even-loop(3000000, 0))
print("\n")
