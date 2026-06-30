#lang pyret

# `data Bird` variant of bench-boids-compute: identical physics, but each bird is a
# `data Bird: bird(x,y,vx,vy)` with Number-annotated fields instead of a
# `[list: x,y,vx,vy]`. The constructor's field checks make `b.x` provably Number, so
# the upper-bound type-flow weakens do_avg's arithmetic and the function compiles
# statically flat (no async wrapper) on the promise backend. Tests the thesis that
# typed data closes the cont-vs-promise gap on an untyped list/var hot loop.

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
_barrierradius = 30

data Coord: coord(cx :: Number, cy :: Number) end

_barriers = [list: coord(100, 100), coord(200, 200)]

data Bird: bird(x :: Number, y :: Number, vx :: Number, vy :: Number) end

data World:
  world-state(
    ticks :: Number,
    birdlist :: List<Bird>,
    size,
    leaderbirdx :: Number,
    leaderbirdy :: Number,
    leaderbirdvx :: Number,
    leaderbirdvy :: Number)
end

fun uniform(start, span) -> Number:
  random((span * 2) + 1) + (start - span)
end

fun birdinit(_) -> Bird:
  x = uniform(_centrex, _positionspread)
  y = uniform(_centrey, _positionspread)
  vx = uniform(0, _speedspread)
  vy = uniform(0, _speedspread)
  bird(x, y, vx, vy)
end

birdlist = lists.range(0, _numberofbirds).map(birdinit)

world0 = world-state(
  0,
  birdlist,
  {width: _width, height: _height},
  _dimension / 3,
  _dimension / 3,
  0,
  0)

fun ticker(w :: World) -> World block:
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
  fun update(b :: Bird) -> Bird block:
    var x = b.x
    var y = b.y
    var vx = b.vx
    var vy = b.vy

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
    fun do_avg(b2 :: Bird) block:
      when j <> i block:
        dx = b2.x - x
        dy = b2.y - y
        dist = (sqr(dx) + sqr(dy)) ^ num-sqrt(_)
        when dist < _mindist block:
          vx := vx - (dx * 0.2)
          vy := vy - (dy * 0.2)
        end
        when dist < _matchspeedwindow block:
          avxtotal := avxtotal + b2.vx
          avytotal := avytotal + b2.vy
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

    fun bounce(barrier :: Coord):
      dx = barrier.cx - x
      dy = barrier.cy - y
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
    bird(b.x + vx, b.y + vy, vx, vy)
  end

  world-state(
    w.ticks + 1,
    w.birdlist.map(update),
    w.size,
    leaderbirdx,
    leaderbirdy,
    leaderbirdvx,
    leaderbirdvy)
end

fun run-frames(n :: Number, w :: World, acc :: Number):
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
