#lang pyret
# Inlining in EFFECT position (result discarded -> the a-seq splice path, with a
# throwaway binder). The side effect must fire exactly once per call and in order.
# `note` returns nothing and is called for effect only; the log must read "xy".
# A dropped or duplicated effect-position inline changes the log.
var log = ""
fun note(s :: String) block:
  log := log + s
  nothing
end
fun run() block:
  note("x")
  note("y")
  log
end
print(run())
