#lang pyret

# Real-workload benchmark: the per-frame `update + draw` of a boids/flocking
# big-bang program (jpolitz) -- highly representative of physics-pedagogy
# content: lots of image overlays AND lots of math. Only `big-bang`/`world`
# (the DOM canvas blit) is dropped; ticker (the O(n^2) flocking math) and drawer
# (the ~53-overlay scene tree) are driven directly for N frames. Image
# *construction* (circle/rectangle/place-image + overlay bounding-box math) runs
# headless; image-width forces it to be realized each frame. Exercises the parts
# that actually dominate real Pyret programs: higher-order list ops, closures,
# mutable vars, allocation (lists + image trees), and num-tower arithmetic --
# none of it constructed to target the async/trampoline stack machinery.

import image as I

place-image = I.place-image
circle = I.circle
rectangle = I.rectangle

sqr = num-expt(_, 2)

_dimension = ~500
_width = _dimension
_height = _dimension
_centrex = _width / 2
_centrey = _height / 2
_numberofbirds = 50
_positionspread = ~1 * _dimension
_speedspread = ~5
_maxspeed = ~10.0
_border = _dimension / 50
_leaderborder = _border
_borderspeedchange = 0.2
_mindist = ~10
_matchspeedwindow = ~40
_leaderbirdrandomspeedchange = ~1
_leadermaxspeed = ~5
_barriers = [list:[list:100,100], [list:200, 200]]
_barrierradius = 30

fun uniform(start, span):
  random((span * 2) + 1) + (start - span)
end

fun birdinit(_):
  x = uniform(_centrex, _positionspread)
  y = uniform(_centrey, _positionspread)
  vx = uniform(0, _speedspread)
  vy = uniform(0, _speedspread)
  [list:x, y, vx, vy]
end

birdlist = lists.range(0, _numberofbirds).map(birdinit)

world0 = {
  ticks: 0,
  birdlist: birdlist,
  size: {width: _width, height: _height},
  leaderbirdx: _dimension / 3,
  leaderbirdy: _dimension / 3,
  leaderbirdvx: 0,
  leaderbirdvy: 0
}

fun ticker(w) block:
  var leaderbirdx = w.leaderbirdx
  var leaderbirdy = w.leaderbirdy
  var leaderbirdvx = w.leaderbirdvx
  var leaderbirdvy = w.leaderbirdvy

  when leaderbirdx < _leaderborder:
    leaderbirdvx := leaderbirdvx + _borderspeedchange
  end
  when leaderbirdy < _leaderborder:
    leaderbirdvy := leaderbirdvy + _borderspeedchange
  end
  when leaderbirdx > (_width - _leaderborder):
    leaderbirdvx := leaderbirdvx - _borderspeedchange
  end
  when leaderbirdy > (_height - _leaderborder):
    leaderbirdvy := leaderbirdvy - _borderspeedchange
  end

  leaderbirdvx := leaderbirdvx + uniform(0, _leaderbirdrandomspeedchange)
  leaderbirdvy := leaderbirdvy + uniform(0, _leaderbirdrandomspeedchange)

  speed = (num-expt(leaderbirdvx, 2) + num-expt(leaderbirdvy, 2)) ^ num-sqrt(_)

  when speed > (_leadermaxspeed) block:
    leaderbirdvx := leaderbirdvx * (_leadermaxspeed / speed)
    leaderbirdvy := leaderbirdvy * (_leadermaxspeed / speed)
  end

  leaderbirdx := (leaderbirdx + leaderbirdvx)
  leaderbirdy := (leaderbirdy + leaderbirdvy)

  var i = 0
  fun update(b) block:
    var x = b.first
    var y = b.rest.first
    var vx = b.rest.rest.first
    var vy = b.rest.rest.rest.first

    when x < _border:
      vx := vx + _borderspeedchange
    end
    when y < _border:
      vy := vy + _borderspeedchange
    end
    when x > (_width - _border):
      vx := vx - _borderspeedchange
    end
    when y > (_height - _border):
      vy := vy - _borderspeedchange
    end

    leaderdiffx = (leaderbirdx - x)
    leaderdiffy = (leaderbirdy - y)
    vx := vx + (0.007 * leaderdiffx)
    vy := vy + (0.007 * leaderdiffy)

    var j = 0
    var avxtotal = 0
    var avytotal = 0
    var avcount = 0
    fun do_avg(b2) block:
      when j <> i block:
        dx = b2.first - x
        dy = b2.rest.first - y
        dist = (sqr(dx) + sqr(dy)) ^ num-sqrt(_)
        when dist < _mindist block:
          vx := vx - (dx * 0.2)
          vy := vy - (dy * 0.2)
        end
        when dist < _matchspeedwindow block:
          avxtotal := avxtotal + b2.rest.rest.first
          avytotal := avytotal + b2.rest.rest.rest.first
          avcount := avcount + 1
        end
      end
      j := (j + 1)
    end

    lists.each(do_avg, birdlist)

    when 0 <> avcount block:
      avx = avxtotal / avcount
      avy = avytotal / avcount
      vx := (0.9 * vx) + (0.1 * avx)
      vy := (0.9 * vy) + (0.1 * avy)
    end

    fun bounce(barrier):
      dx = barrier.first - x
      dy = barrier.rest.first - y
      dist = (sqr(dx) + sqr(dy)) ^ num-sqrt(_)
      when dist < (_barrierradius + 15) block:
        vx := vx - (dx * 0.1)
        vx := vy * 0.6
        vy := vy - (dy * 0.1)
        vy := vy * 0.6
      end
    end
    lists.each(bounce, _barriers)

    new-speed = (sqr(vx) + sqr(vy)) ^ num-sqrt(_)
    when new-speed > _maxspeed block:
      vx := vx * (_maxspeed / new-speed)
      vy := vy * (_maxspeed / new-speed)
    end

    i := i + 1
    [list:
      b.first + vx,
      b.rest.first + vy,
      vx,
      vy ]
  end

  {
    ticks: w.ticks + 1,
    birdlist: w.birdlist.map(update),
    size: w.size,
    leaderbirdx: leaderbirdx,
    leaderbirdy: leaderbirdy,
    leaderbirdvx: leaderbirdvx,
    leaderbirdvy: leaderbirdvy
  }
end

background = rectangle(_width, _height, "solid", "black")

with-barriers =
  for lists.fold(img from background, barrier from _barriers):
    place-image(circle(_barrierradius, "solid", "blue"), barrier.first, barrier.rest.first, img)
  end

fun drawer(w):
  with-boids =
    for lists.fold(img from with-barriers, boid from w.birdlist):
      place-image(circle(5, "solid", "yellow"), boid.first, boid.rest.first, img)
    end
  place-image(circle(5, "solid", "white"), w.leaderbirdx, w.leaderbirdy, with-boids)
end

# Driver: per frame run the ticker (the O(n^2) flocking physics) ONLY -- no
# drawer / image construction. Accumulate a number derived from the world state
# each frame so the ticker work cannot be elided. Isolates the compute cost
# (num-tower math + mutable vars + nested closures over `var` boxes) -- the part
# the cont vs promise backends diverge on (the mutable-var hot-loop tax).
fun run-frames(n, w, acc):
  if n == 0: acc
  else:
    w2 = ticker(w)
    run-frames(n - 1, w2, acc + num-floor(num-abs(w2.leaderbirdx) + num-abs(w2.leaderbirdy)))
  end
end

t0 = time-now()
final-acc = run-frames(500, world0, 0)
loop-ms = time-now() - t0
print(num-to-string(num-floor(final-acc)) + "\n")
print("LOOP-MS " + num-to-string(loop-ms) + "\n")
