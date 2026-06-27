#lang pyret
# Inliner x CSE interaction. `get-x` reads an immutable record field; inlining it at
# three sites exposes three identical `p.x` reads, which the following CSE pass
# collapses. The composed result must stay correct (5 + 5 + 5 = 15). Guards that
# inlining-then-CSE on field reads neither changes the value nor drops a read.
fun get-x(p): p.x end
fun run():
  p = {x: 5, y: 9}
  get-x(p) + get-x(p) + p.x
end
print(run())
