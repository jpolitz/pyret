### Method-heavy numeric benchmark: a 2D orbital integrator written idiomatically
### with a `Vec2` data type whose vector algebra is expressed as METHODS (the way
### a lot of real Pyret graphics/physics code is written). Each step runs ~10
### flat method calls; method-flatness compiles those methods synchronously and
### elides the per-call await. Same shape as the orbital/boids/car benches.

data Vec2:
  | vec2(x :: Number, y :: Number) with:
    method plus(self, o :: Vec2) -> Vec2: vec2(self.x + o.x, self.y + o.y) end,
    method minus(self, o :: Vec2) -> Vec2: vec2(self.x - o.x, self.y - o.y) end,
    method scale(self, k :: Number) -> Vec2: vec2(self.x * k, self.y * k) end,
    method dot(self, o :: Vec2) -> Number: (self.x * o.x) + (self.y * o.y) end,
    method magsq(self) -> Number: self.dot(self) end,
    method mag(self) -> Number: num-sqrt(self.magsq()) end
end

data Body:
  | body(pos :: Vec2, vel :: Vec2)
end

G = 4.0
DT = 0.001
SOFT = 0.05

# Acceleration on `b` from a point mass at the origin (gravity-like), via methods.
fun accel(b :: Body) -> Vec2:
  to-center = vec2(0, 0).minus(b.pos)
  r = to-center.mag() + SOFT
  inv = G / (r * r * r)
  to-center.scale(inv)
end

fun step(b :: Body) -> Body:
  a = accel(b)
  new-vel = b.vel.plus(a.scale(DT))
  new-pos = b.pos.plus(new-vel.scale(DT))
  body(new-pos, new-vel)
end

fun run(n :: Number, b :: Body, acc :: Number) -> Number:
  if n <= 0: acc
  else:
    nb = step(b)
    run(n - 1, nb, acc + nb.pos.mag())
  end
end

INIT = body(vec2(1.0, 0.0), vec2(0.0, 1.6))

t0 = time-now()
final-acc = run(300000, INIT, 0)
loop-ms = time-now() - t0
print(num-to-string(num-floor(final-acc)) + "\n")
print("LOOP-MS " + num-to-string(loop-ms) + "\n")
