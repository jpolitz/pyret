# Regression test for the async/promise backend's fuel + stack model.
#
# Run under the promise backend:  make tests-promise/stack-depth.p.jarr EF=' '
# then:                           node tests-promise/stack-depth.p.jarr
#
# Each function recurses far deeper than INITIAL_GAS (500) and far deeper than
# the JS engine's native call-stack limit (~10k). It only completes if:
#   * non-flat calls are `await`ed (converting stack space to heap space), and
#   * `if (needsPause()) await checkPause()` fires often enough to unwind the
#     synchronous JS stack before it overflows.

# Deep NON-tail recursion: each frame is suspended on the heap across an await.
fun sum-to(n):
  if n == 0: 0
  else: n + sum-to(n - 1)
  end
end

# Deep TAIL recursion with an accumulator: exercises explicit-loop TCO (the
# emitted `while(true) { ... continue; }`). Should run in O(1) JS stack.
fun count-down(n, acc):
  if n == 0: acc
  else: count-down(n - 1, acc + 1)
  end
end

print(sum-to(100000))
print("\n")
print(count-down(1000000, 0))
print("\n")
