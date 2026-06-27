#lang pyret
# runcap: 200
# A thin NON-recursive-looking wrapper that is nonetheless part of a cycle. `step`
# is tiny (one tail call) and non-recursive in isolation, so it is maximally
# tempting to inline -- but loop -> step -> loop is a cycle, and inlining step into
# loop turns loop's call into one whose stale is-recursive = false defeats the
# `continue` -> O(n) heap. So even an attractive thin cycle member must be left
# alone. Deep loop under the cap OOMs if step is inlined.
fun loop(n, acc): if n <= 0: acc else: step(n, acc) end end
fun step(n, acc): loop(n - 1, acc + 1) end
print(loop(9000000, 0))
