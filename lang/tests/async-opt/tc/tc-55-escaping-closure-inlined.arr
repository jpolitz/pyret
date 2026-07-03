#lang pyret
# A closure that captures a local, is called locally (inlined), AND escapes -- at two
# instances. `build` is inlined at both sites; each `bump` captures its own freshened
# `n`. The locally-inlined `bump(100)` and the escaped `b.f(0)` must both see the right
# capture. build(1): h=101, f(0)=1; build(1000): h=1100, f(0)=1000 -> 101+1+1100+1000 = 2202.
fun build(n):
  bump = lam(x): x + n end
  { f: bump, h: bump(100) }
end
fun run() block:
  b1 = build(1)
  b2 = build(1000)
  b1.h + b1.f(0) + b2.h + b2.f(0)
end
print(run())
