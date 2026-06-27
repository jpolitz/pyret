#lang pyret
# runcap: 200
# Deep self-recursive METHOD in tail position. A recursive method app
# (`s(...).run(...)`) is safe-for-space via the method bounce token (makeTailMethod),
# analogous to function token minting. Methods are not inlined, but this pins that
# the optimizer leaves the method-token machinery intact: deep recursion stays O(1)
# heap. runcap 200, depth 5M -> OOMs if method safe-for-space regresses; accumulator
# makes the result depth-exact.
data Stream:
  | s(n) with:
    method run(self, acc):
      if self.n <= 0: acc
      else: s(self.n - 1).run(acc + 1)
      end
    end
end
print(s(5000000).run(0))
