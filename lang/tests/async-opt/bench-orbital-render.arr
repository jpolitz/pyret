#lang pyret

# Real-workload benchmark extracted from the "SolarSystem" orbital simulation
# (code.pyret.org share 1tbd-RFUP7bGBZpX3_i1WSBXyywwzUpoS). An n-body gravity
# integrator: every tick computes the O(n^2) pairwise gravitational forces over a
# StringDict of bodies, integrates position/velocity (Euler), and -- in the
# render configuration -- rasterizes each body and its accumulated trace onto a
# scene. Only `big-bang`/`reactor` (the DOM canvas) is dropped; the per-frame
# physics (update-objs) and rendering (draw-sim) are driven directly for N
# frames. Network planet/moon images are replaced with synthetic circles so it
# runs headless and deterministically. Exercises StringDict fold/rebuild,
# record update, float arithmetic (sqrt/sqr/div), and -- when rendering --
# place-image/overlay image-tree construction. Not constructed to target the
# async/trampoline machinery.

import image as I
include string-dict

place-image = I.place-image
circle = I.circle
overlay = I.overlay
rectangle = I.rectangle
image-width = I.image-width

RENDER = true

type Pos2D = { px :: Number, py :: Number }
type Vel2D = { vx :: Number, vy :: Number }
type Acc2D = { ax :: Number, ay :: Number }
type Force2D = { fx :: Number, fy :: Number }

fun next-lin(val :: Number, d-val-dt :: Number, delta-t :: Number) -> Number:
  val + (d-val-dt * delta-t)
end

fun next-pos(pos, vel, delta-t):
  { px: next-lin(pos.px, vel.vx, delta-t), py: next-lin(pos.py, vel.vy, delta-t) }
end

fun next-vel(vel, acc, delta-t):
  { vx: next-lin(vel.vx, acc.ax, delta-t), vy: next-lin(vel.vy, acc.ay, delta-t) }
end

fun distance-between(pos1, pos2):
  num-sqrt(num-sqr(pos1.px - pos2.px) + num-sqr(pos1.py - pos2.py))
end

G = ~6.67430e-11

fun f-g-on-obj1(obj1, obj2):
  if obj2.test-mass: { fx: 0, fy: 0 }
  else:
    dist = distance-between(obj1.pos, obj2.pos)
    f-g = (G * obj1.mass * obj2.mass) / num-sqr(dist)
    { fx: f-g * ((obj2.pos.px - obj1.pos.px) / dist),
      fy: f-g * ((obj2.pos.py - obj1.pos.py) / dist) }
  end
end

fun sigma-f(force1, force2):
  { fx: force1.fx + force2.fx, fy: force1.fy + force2.fy }
end

fun acc-from-force(force, mass):
  { ax: force.fx / mass, ay: force.fy / mass }
end

fun update-obj(delta-t, objs, name, names):
  target = objs.get-value(name)
  total-force = for fold(force from { fx: 0, fy: 0 }, obj-name from names):
    if obj-name == name: force
    else: sigma-f(force, f-g-on-obj1(target, objs.get-value(obj-name)))
    end
  end
  acc = acc-from-force(total-force, target.mass)
  new-vel = next-vel(target.vel, acc, delta-t)
  new-pos = next-pos(target.pos, new-vel, delta-t)
  target.{ pos: new-pos, vel: new-vel }
end

fun update-objs(delta-t, objs):
  names = objs.keys-list()
  for fold(ans from [string-dict: ], name from names):
    ans.set(name, update-obj(delta-t, objs, name, names))
  end
end

fun offset-obj(obj, pos, vel):
  obj.{
    pos: { px: obj.pos.px + pos.px, py: obj.pos.py + pos.py },
    vel: { vx: obj.vel.vx + vel.vx, vy: obj.vel.vy + vel.vy }
  }
end

# --- physical constants (from the SolarSystem share) ---
m-sun = ~1.988416e30
m-earth = ~5.9722e24
m-moon = ~7.346e22
r-earth = ~6378e3
r-earth-aphelion = ~152.10e9
v-earth-aphelion = ~29.29e3
r-moon-apogee = ~405507e3
v-moon-apogee = ~0.964e3

moon0 = {
  name: "Moon", mass: m-moon,
  pos: { px: r-moon-apogee, py: 0 }, vel: { vx: 0, vy: v-moon-apogee },
  image: circle(3, "solid", "white"), trace: circle(2, "solid", "white"),
  test-mass: false
}
earth0 = {
  name: "Earth", mass: m-earth,
  pos: { px: 0, py: 0 }, vel: { vx: 0, vy: (moon0.vel.vy * moon0.mass) / (-1 * m-earth) },
  image: circle(10, "solid", "blue"), trace: circle(4, "solid", "blue"),
  test-mass: false
}
earth = offset-obj(earth0, { px: r-earth-aphelion, py: 0 }, { vx: 0, vy: v-earth-aphelion })
moon = offset-obj(moon0, earth.pos, earth.vel)
sun = {
  name: "Sun", mass: m-sun,
  pos: { px: 0, py: 0 },
  vel: { vx: 0, vy: ((earth.vel.vy * earth.mass) + (moon.vel.vy * moon.mass)) / (-1 * m-sun) },
  image: circle(16, "solid", "yellow"), trace: circle(20, "solid", "yellow"),
  test-mass: false
}

# Newton's-cannonball bodies (8-body config): a heavy Earth plus 7 test masses
# launched horizontally at increasing speeds.
too-slow1 = {
  name: "TooSlow-1", mass: 1,
  pos: { px: 0, py: -1 * (r-earth + 1000) }, vel: { vx: 1000, vy: 0 },
  image: circle(10, "solid", "red"), trace: circle(1, "solid", "red"),
  test-mass: true
}
fun cannonball(nm, vx0, col):
  too-slow1.{ name: nm, vel: { vx: vx0, vy: 0 },
    image: circle(10, "solid", col), trace: circle(1, "solid", col) }
end

type SolObj = Any
type Sim = {
  system :: StringDict,
  system-width :: Number,
  delta-t :: Number,
  show-ticks :: Number,
  bkg :: I.Image,
  trace :: I.Image,
  trace-behind :: Boolean
}

fun draw-sim(sim, trace :: Boolean) -> I.Image:
  bkg = sim.trace
  width = image-width(bkg)
  height = I.image-height(bkg)
  px-per-m = num-min(width, height) / sim.system-width
  keys = sim.system.keys-list().sort()
  partitioned = keys.partition({(name): sim.system.get-value(name).test-mass})
  shadow keys = partitioned.is-false + partitioned.is-true
  for fold(cur from bkg, name from keys):
    obj = sim.system.get-value(name)
    place-image(if trace: obj.trace else: obj.image end,
      (width / 2) + (obj.pos.px * px-per-m),
      (height / 2) + (obj.pos.py * px-per-m),
      cur)
  end
end

max-radius = 1.2 * (r-earth-aphelion + r-moon-apogee)

sim-ems = {
  system: [string-dict: "Sun", sun, "Earth", earth, "Moon", moon ],
  delta-t: 60 * 60 * 24,
  show-ticks: 1,
  system-width: 2 * max-radius,
  bkg: rectangle(600, 600, "solid", "black"),
  trace: rectangle(600, 600, "solid", "transparent"),
  trace-behind: true
}

sim-newton = {
  system: [string-dict:
      "Earth", earth0.{ image: circle(60, "solid", "blue"), vel: { vx: 0, vy: 0 },
        trace: I.empty-image },
      "TooSlow1", too-slow1,
      "TooSlow2", cannonball("TooSlow2", 3000, "orange"),
      "TooSlow3", cannonball("TooSlow3", 5000, "crimson"),
      "TooFast1", cannonball("TooFast1", 9000, "cyan"),
      "TooFast2", cannonball("TooFast2", 11000, "blue"),
      "TooFast3", cannonball("TooFast3", 13000, "navy"),
      "Orbit", cannonball("Orbit", 7912, "green")
    ],
  delta-t: 5,
  show-ticks: 12,
  system-width: 3 * r-earth,
  bkg: rectangle(600, 600, "solid", "black"),
  trace: rectangle(600, 600, "solid", "transparent"),
  trace-behind: false
}

SIM = sim-newton

# Driver: per frame run `show-ticks` physics sub-steps; in the render config also
# rasterize the accumulating trace and the body scene (image-width forces the
# image tree to be realized). acc accumulates a value so nothing is elided.
fun run-frames(n :: Number, sim, acc :: Number) -> Number:
  if n == 0: acc
  else:
    new-system = for fold(sys from sim.system, _ from range(0, sim.show-ticks)):
      update-objs(sim.delta-t, sys)
    end
    if RENDER:
      new-trace = draw-sim(sim.{ system: new-system }, true)
      sim2 = sim.{ system: new-system, trace: new-trace }
      drawn = draw-sim(sim2, false)
      final = if sim2.trace-behind: overlay(overlay(drawn, sim2.trace), sim2.bkg)
        else: overlay(overlay(sim2.trace, drawn), sim2.bkg) end
      run-frames(n - 1, sim2, acc + image-width(final))
    else:
      sum = for fold(s from 0, name from new-system.keys-list()):
        s + new-system.get-value(name).pos.px
      end
      run-frames(n - 1, sim.{ system: new-system }, acc + num-floor(num-abs(sum) / 1e9))
    end
  end
end

t0 = time-now()
final-acc = run-frames(300, SIM, 0)
loop-ms = time-now() - t0
print(num-to-string(num-floor(final-acc)) + "\n")
print("LOOP-MS " + num-to-string(loop-ms) + "\n")
