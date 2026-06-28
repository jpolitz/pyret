#lang pyret
# Inlining INSIDE control-flow branches (if arms and a cases arm). The inliner must
# splice into each branch body independently and keep each branch's value correct.
# Exercises optLettable's a-if / a-cases recursion plus plugTail through branches.
data Box: | box(v) end
fun dbl(x): x + x end
fun pick(b, n): if b: dbl(n) else: dbl(n + 1) end end
fun unbox-dbl(bx): cases(Box) bx: | box(v) => dbl(v) end end
fun run(): pick(true, 5) + pick(false, 5) + unbox-dbl(box(3)) end
print(run())
