provide *
import string-dict as SD
import lists as L

# Fast soundness oracle for cross-module method flatness. Every flat-tagged builtin
# dict method is CALLED and its result USED in a leak-observable way (summed / printed
# / compared), so a method wrongly flattened (emitted no-await while it actually
# suspends -- the keys-now-builds-a-tree-set trap) leaks a `Promise` here instead of a
# value. The EXCLUDED methods (keys / keys-now / merge / map-keys / == ) are exercised
# too, so their result must also stay a real value. Output is deterministic; the 3-way
# differential runner asserts opt-promise == baseline == cont.

fun frozen-ops(sd :: SD.StringDict<Number>) -> Number block:
  var acc = 0
  for each(k from sd.keys-list()):            # keys-list (flat) -> List
    when sd.has-key(k):                        # has-key (flat)
      acc := acc + sd.get-value(k)             # get-value (flat) + arithmetic
    end
  end
  acc := acc + sd.count()                      # count (flat)
  # excluded / must stay correct: keys (tree-set), map-keys (callback), == (_equals)
  acc := acc + sd.keys().size()                # keys -> Set.size
  ms = sd.map-keys(lam(k :: String): string-length(k) end)  # map-keys (callback)
  acc := acc + L.foldl(lam(n, a): a + n end, 0, ms)
  acc := acc + (if sd == sd: 1 else: 0 end)    # _equals (excluded)
  acc
end

# A TYPED MutableStringDict param -- its receiver resolves, so its methods actually
# flatten. This is the exact shape of the original keys-now leak (compile-lib dict-map):
# keys-now must stay guarded here or it leaks a Promise into `.size()`.
fun mutable-ops(m :: SD.MutableStringDict<Number>) -> Number block:
  var acc = m.count-now()                        # count-now (flat)
  acc := acc + m.keys-now().size()               # keys-now (EXCLUDED: tree-set) on TYPED recv
  for each(k from m.keys-list-now()):            # keys-list-now (flat) -> List
    acc := acc + m.get-value-now(k)              # get-value-now (flat)
  end
  acc
end

fun build-and-read() -> Number block:
  msd = [SD.mutable-string-dict: ]
  for each(w from [list: "aa", "bb", "aa", "cc", "bb", "aa"]):
    old = cases(Option) (msd.get-now(w)):       # get-now (flat)
      | none => 0
      | some(v) => v
    end
    msd.set-now(w, old + 1)                      # set-now (flat)
  end
  frozen = msd.freeze()                          # freeze (flat) -> StringDict
  mutable-ops(msd) + frozen-ops(frozen)
end

result = build-and-read()
print(num-to-string(result) + "\n")
