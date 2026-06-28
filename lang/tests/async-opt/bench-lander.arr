#lang pyret

# Real-workload benchmark extracted from the lunar-lander simulator
# (pyret-horizon share 1gF4GvcpTnLtF0WGaYpleT12z3hlPfKu1). A rocket descends
# under gravity with player-style thrust; each frame integrates the physics and
# redraws the whole scene -- planet background, rocket, a thrust-scaled flame
# (rotated + scaled per frame), and a two-line telemetry HUD. Only `reactor`/
# `big-bang` (the DOM canvas) is dropped, and the network planet/rocket/flame
# images are replaced with synthetic shapes so it runs headless; the physics
# (commented-out in the share's "inert" section) is enabled so the simulation
# actually moves. The flame `scale`, rocket `rotate`, `overlay-align`, `above`,
# and per-frame `text` make this a render-dominated workload -- representative of
# image-heavy reactor pedagogy content. Not async-targeted.

import image as I

rectangle = I.rectangle
circle = I.circle
triangle = I.triangle
place-image = I.place-image
overlay = I.overlay
overlay-align = I.overlay-align
above = I.above
text = I.text
rotate = I.rotate
scale = I.scale
image-width = I.image-width
image-height = I.image-height

WIDTH = 800
HEIGHT = 600
GROUND-MAX = 150
delta-t = 0.05

SPACE = rectangle(WIDTH, HEIGHT, "solid", "black")
# Synthetic "planet" surface (replaces the shared Mars image): a terrain strip.
PLANET = overlay-align("middle", "bottom",
  rectangle(WIDTH, GROUND-MAX, "solid", "sienna"),
  rectangle(WIDTH, GROUND-MAX, "solid", "saddlebrown"))
BACKGROUND = overlay-align("middle", "bottom", PLANET, SPACE)

# Synthetic rocket: a body with a nose cone.
ROCKET = above(triangle(16, "solid", "red"),
  rectangle(14, 34, "solid", "silver"))
ROCKET-HALF-HEIGHT = image-height(ROCKET) / 2
# Base flame shape, scaled per frame by the thrust magnitude.
RAW-FLAMES = triangle(24, "solid", "orange")

heights = [list:
  {0; 60}, {120; 60}, {140; 70}, {180; 70}, {270; 100},
  {400; 115}, {500; 100}, {645; 100}, {800; 110} ]

fun ground-help(x, prev, rest):
  cases (List) rest:
    | empty => prev.{1}
    | link(next, tail) =>
      if x <= next.{0}:
        alpha = (x - prev.{0}) / (next.{0} - prev.{0})
        prev.{1} + ((next.{1} - prev.{1}) * alpha)
      else: ground-help(x, next, tail)
      end
  end
end
fun ground-height(x): ground-help(x, heights.first, heights.rest) end

# Lander parameters (from the share).
mass = 533
gy = -3.711

# Real physics (the share's commented-out formulas).
fun next-vy(vy, ay): vy + (ay * delta-t) end
fun next-y(y, vy): y + (vy * delta-t) end
fun a-from-f(force): force / mass end
fun sum-forces(thrust-force): (mass * gy) + thrust-force end

# A scripted thrust schedule (replaces key presses): periodic burns.
fun thrust-at(tick): if num-modulo(tick, 40) < 18: 1.4 else: 0 end end

# state = { x; y; vy; thrust; tick }
fun next-state(st):
  {x; y; vy; thrust; tk} = st
  thrust-force = thrust * num-abs(0.5 * mass * gy)
  new-ay = a-from-f(sum-forces(thrust-force))
  new-vy = next-vy(vy, new-ay)
  avg-vy = (vy + new-vy) / 2
  new-y = next-y(y, avg-vy)
  next-tick = tk + 1
  # bounce off the ground so the sim runs indefinitely
  {x2; y2; vy2} = if new-y < ground-height(x): {x; 500; 0} else: {x; new-y; new-vy} end
  {x2; y2; vy2; thrust-at(next-tick); next-tick}
end

fun draw-scene(st):
  {x; y; vy; thrust; tk} = st
  rocket-bkg = place-image(ROCKET, x, y + ROCKET-HALF-HEIGHT, BACKGROUND)
  flames = scale((0.5 * num-abs(thrust)) + 0.1, RAW-FLAMES)
  flames-half-height = image-height(flames) / 2
  with-flames =
    ask:
      | y < ground-height(x) then: rocket-bkg
      | thrust < 0 then:
        place-image(rotate(180, flames), x, (y + flames-half-height) + (2 * ROCKET-HALF-HEIGHT), rocket-bkg)
      | thrust > 0 then:
        place-image(flames, x, y - flames-half-height, rocket-bkg)
      | otherwise: rocket-bkg
    end
  overlay-align("middle", "top",
    above(
      text("Flying", 30, "white"),
      text("x = " + num-to-string-digits(x, 3)
          + ", y = " + num-to-string-digits(y, 3)
          + ", vy = " + num-to-string-digits(vy, 3), 20, "light gray")),
    with-flames)
end

st0 = {120; 500; 0; 0; 0}

# Driver: per frame integrate + redraw; image-width forces the scene to be
# realized. acc accumulates so nothing is elided.
fun run-frames(n, st, acc):
  if n == 0: acc
  else:
    st2 = next-state(st)
    img = draw-scene(st2)
    run-frames(n - 1, st2, acc + image-width(img))
  end
end

t0 = time-now()
final-acc = run-frames(6000, st0, 0)
loop-ms = time-now() - t0
print(num-to-string(num-floor(final-acc)) + "\n")
print("LOOP-MS " + num-to-string(loop-ms) + "\n")
