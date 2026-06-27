#lang pyret
# Argument evaluation ORDER must survive inlining. The three arguments each append
# to a log as a side effect; after inlining `three`, they must still evaluate
# left-to-right (the binding order ANF gave them), yielding "123". A reorder or a
# moved binding shows as a different log.
var log = ""
fun s(x :: String) block:
  log := log + x
  x
end
fun three(a, b, c): log end
fun run(): three(s("1"), s("2"), s("3")) end
print(run())
