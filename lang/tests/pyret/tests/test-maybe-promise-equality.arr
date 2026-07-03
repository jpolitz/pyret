#lang pyret

# Stage-6 behavioral pins for the maybe-promise equality core and iteration
# helpers (runtime-async.js). These must pass identically on BOTH backends;
# on the promise backend they additionally guard the architecture:
#   - the `if (tol)` TRUTHINESS landmine (within(0) must RAISE on roughnums,
#     via the RoughnumZeroTolerances Unknown path, on the scalar fast path
#     AND through the worklist);
#   - the Map-based seen-pairs cache (the adversarial block below is
#     pathologically slow -- O(pairs^2) -- if the cache regresses to the old
#     linear findPair scan, but stays well under 2s with the Map);
#   - the async escape: a user _equals that GENUINELY suspends must still
#     resume the (otherwise synchronous) worklist drain;
#   - member/is on scalars (the zero-closure fast path).

import equality as E

check "within(0) truthiness landmine: falsy tolerance takes the RoughnumZeroTolerances path":
  # The runtime's number branch tests `if (tol)` -- TRUTHINESS -- so an
  # exact-zero tolerance must NOT reach the comparison: roughnums under
  # within(0) raise, they do not compare equal.
  within(0)(~1, ~1) raises "Roughnum"
  within(0)(~1, 1) raises "Roughnum"
  within-abs(0)(~1, ~1) raises "Roughnum"
  within-rel(0)(~1, ~1) raises "Roughnum"

  # ...including through the worklist (compound values), not just the
  # scalar fast path:
  within(0)([list: ~1], [list: ~1]) raises "Roughnum"

  # Exact numbers under within(0) are still decided exactly:
  1 is%(within(0)) 1
  2 is-not%(within(0)) 1

  # But a ROUGH zero (~0) is a truthy JS object, so it takes the comparison
  # path -- the truthiness shape, pinned from both sides:
  ~1 is%(within-abs(~0)) ~1
  ~1 is-not%(within-abs(~0)) ~2

  # 3-valued variants report Unknown instead of raising:
  within3(0)(~1, ~1) satisfies E.is-Unknown
  within-abs3(0)(~1, ~1) satisfies E.is-Unknown
end

check "member/is on scalars: the fast path answers exactly like the worklist":
  equal-always3("cat", "dog") satisfies E.is-NotEqual
  equal-always3("cat", "cat") satisfies E.is-Equal
  equal-always3(true, false) satisfies E.is-NotEqual
  equal-always3(false, false) satisfies E.is-Equal
  equal-always3(1, 2) satisfies E.is-NotEqual
  equal-always3(1/3, 2/6) satisfies E.is-Equal
  equal-always3(~1, ~1) satisfies E.is-Unknown
  equal-always3("a", 1) satisfies E.is-NotEqual
  equal-now3("cat", "dog") satisfies E.is-NotEqual

  ("cat" == "dog") is false
  ("cat" == "cat") is true
  equal-always(1, ~1) raises "Roughnum"

  [list: 1, 2, 3].member(2) is true
  [list: 1, 2, 3].member(4) is false
  [list: "a", "b"].member("b") is true
  [list: "a", "b"].member("q") is false
  [list: 1/2, 1/3].member(2/6) is true
end

data BTree:
  | bleaf(v)
  | bnode(l, r)
end

fun mk-tree(d, v):
  if d <= 0: bleaf(v)
  else: bnode(mk-tree(d - 1, v), mk-tree(d - 1, v))
  end
end

fun mk-dag(d, t):
  if d <= 0: t
  else: mk-dag(d - 1, bnode(t, t))
  end
end

check "adversarial seen-pairs cache: ~130k distinct pairs in ONE equality call":
  # Two structurally-equal full binary trees of depth 16: every one of the
  # ~2^17 node pairs is distinct, so the seen-pairs cache grows to ~131k
  # records inside a single equal3 call. With the Map(left -> Map(right ->
  # rec)) cache this whole block is comfortably sub-2s; with the old linear
  # findPair scan the lookup work is O(pairs^2) (~8.6e9 scan steps) --
  # pathologically slow. Do not shrink the depth: 16 is what makes a cache
  # regression unmissable without making the green path slow.
  t1 = mk-tree(16, 0)
  t2 = mk-tree(16, 0)
  t1 is t2
  # NotEqual short-circuit: the drain stops at the first differing leaf and
  # the settle loop must stamp the still-pending setCache markers with the
  # final answer (and still answer false).
  t3 = mk-tree(16, 1)
  t1 is-not t3
end

check "shared-substructure DAG: second visit hits the optimistic in-progress record":
  # x_{k+1} = bnode(x_k, x_k): 2^200 abstract leaves but only ~201 distinct
  # pairs. The SECOND visit of each pair must find the cache record -- which
  # starts at the optimistic Equal before being settled -- so this terminates
  # instantly. Any regression that drops or mis-indexes records (the
  # index/settle protocol) makes this wrong or non-terminating.
  d1 = mk-dag(200, bleaf(0))
  d2 = mk-dag(200, bleaf(0))
  d1 is d2
  d3 = mk-dag(200, bleaf(1))
  d1 is-not d3
end

data MLink:
  | mlink(ref v, ref nxt)
end

check "cyclic structures terminate via the optimistic Equal cache record":
  x = mlink(1, nothing)
  y = mlink(1, nothing)
  x!{nxt: x}
  y!{nxt: y}
  equal-now(x, y) is true
  z = mlink(2, nothing)
  z!{nxt: z}
  equal-now(x, z) is false
end

fun burn(n):
  # Deep non-tail recursion through a non-flat function: consumes fuel
  # (INITIAL_GAS 500), so on the promise backend needsPause() fires somewhere
  # inside and the whole chain genuinely suspends -- making a user _equals
  # dispatch return a thenable mid-drain. On the cont backend this is just a
  # deep (stack-managed) recursion; the answers must be identical.
  if n <= 0: 0
  else: 1 + burn(n - 1)
  end
end

data Wrap:
  | wrap(v)
sharing:
  method _equals(self, other, eq):
    _ = burn(2000)
    eq(self.v, other.v)
  end
end

check "user _equals that genuinely suspends: the async escape resumes the drain":
  wrap(5) is wrap(5)
  wrap(5) is-not wrap(6)
  # several suspending dispatches inside ONE equality call:
  [list: wrap(1), wrap(2), wrap(3)] is [list: wrap(1), wrap(2), wrap(3)]
  [list: wrap(1), wrap(2)] is-not [list: wrap(1), wrap(3)]
  # recursion through the (lazily created) equalFun re-enters the drain:
  wrap([list: wrap(1), wrap(2)]) is wrap([list: wrap(1), wrap(2)])
  wrap(wrap(wrap(1))) is wrap(wrap(wrap(1)))
end

check "iteration helpers stay correct when the callback suspends mid-loop":
  fun slow-inc(x):
    _ = burn(600)
    x + 1
  end
  raw-array-map(slow-inc, [raw-array: 1, 2, 3]) is=~ [raw-array: 2, 3, 4]
  for raw-array-fold(acc from 0, elt from [raw-array: 1, 2, 3], ix from 0):
    _ = burn(600)
    acc + elt
  end is 6
  raw-array-filter(lam(x):
      _ = burn(600)
      x > 1
    end, [raw-array: 1, 2, 3]) is=~ [raw-array: 2, 3]
  raw-array-build(slow-inc, 3) is=~ [raw-array: 1, 2, 3]
end
