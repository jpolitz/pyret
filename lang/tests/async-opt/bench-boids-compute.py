#!/usr/bin/env python3
# Faithful Python port of bench-boids-compute.arr (see that file). Birds are
# 4-element lists [x, y, vx, vy] read positionally to mirror the untyped
# list-destructured reads (b.first, b.rest.first, ...); mutable `var`s become
# locals + nonlocal in the nested closures (do_avg / bounce), exactly as the .arr.
# Timing brackets only run-frames, printing a checksum + "LOOP-MS <ms>".
#
# NOTE ON DETERMINISM: the .arr seeds bird positions with Pyret's `random`, whose
# PRNG we don't replicate, so the checksum here will NOT equal the Pyret 236561.
# The per-frame work is O(n^2) with the same arithmetic regardless of positions,
# so wall-clock is a faithful comparison; we fix a seed for run-to-run stability.
import math, time, random

random.seed(1234)

sqr = lambda x: x ** 2

_dimension = 500.0
_width = _dimension
_height = _dimension
_centrex = _width / 2
_centrey = _height / 2
_numberofbirds = 50
_positionspread = 1.0 * _dimension
_speedspread = 5.0
_maxspeed = 10.0
_border = _dimension / 50
_leaderborder = _border
_borderspeedchange = 0.2
_mindist = 10.0
_matchspeedwindow = 40.0
_leaderbirdrandomspeedchange = 1.0
_leadermaxspeed = 5.0
_barriers = [[100, 100], [200, 200]]
_barrierradius = 30

def uniform(start, span):
    return random.randrange(int(span * 2) + 1) + (start - span)

def birdinit(_):
    x = uniform(_centrex, _positionspread)
    y = uniform(_centrey, _positionspread)
    vx = uniform(0, _speedspread)
    vy = uniform(0, _speedspread)
    return [x, y, vx, vy]

birdlist = [birdinit(i) for i in range(0, _numberofbirds)]

world0 = {
    "ticks": 0,
    "birdlist": birdlist,
    "size": {"width": _width, "height": _height},
    "leaderbirdx": _dimension / 3,
    "leaderbirdy": _dimension / 3,
    "leaderbirdvx": 0,
    "leaderbirdvy": 0,
}

def ticker(w):
    leaderbirdx = w["leaderbirdx"]
    leaderbirdy = w["leaderbirdy"]
    leaderbirdvx = w["leaderbirdvx"]
    leaderbirdvy = w["leaderbirdvy"]

    if leaderbirdx < _leaderborder:
        leaderbirdvx = leaderbirdvx + _borderspeedchange
    if leaderbirdy < _leaderborder:
        leaderbirdvy = leaderbirdvy + _borderspeedchange
    if leaderbirdx > (_width - _leaderborder):
        leaderbirdvx = leaderbirdvx - _borderspeedchange
    if leaderbirdy > (_height - _leaderborder):
        leaderbirdvy = leaderbirdvy - _borderspeedchange

    leaderbirdvx = leaderbirdvx + uniform(0, _leaderbirdrandomspeedchange)
    leaderbirdvy = leaderbirdvy + uniform(0, _leaderbirdrandomspeedchange)

    speed = math.sqrt(sqr(leaderbirdvx) + sqr(leaderbirdvy))

    if speed > _leadermaxspeed:
        leaderbirdvx = leaderbirdvx * (_leadermaxspeed / speed)
        leaderbirdvy = leaderbirdvy * (_leadermaxspeed / speed)

    leaderbirdx = leaderbirdx + leaderbirdvx
    leaderbirdy = leaderbirdy + leaderbirdvy

    i = 0

    def update(b):
        nonlocal i
        x = b[0]
        y = b[1]
        vx = b[2]
        vy = b[3]

        if x < _border:
            vx = vx + _borderspeedchange
        if y < _border:
            vy = vy + _borderspeedchange
        if x > (_width - _border):
            vx = vx - _borderspeedchange
        if y > (_height - _border):
            vy = vy - _borderspeedchange

        leaderdiffx = leaderbirdx - x
        leaderdiffy = leaderbirdy - y
        vx = vx + (0.007 * leaderdiffx)
        vy = vy + (0.007 * leaderdiffy)

        j = 0
        avxtotal = 0
        avytotal = 0
        avcount = 0

        def do_avg(b2):
            nonlocal j, avxtotal, avytotal, avcount, vx, vy
            if j != i:
                dx = b2[0] - x
                dy = b2[1] - y
                dist = math.sqrt(sqr(dx) + sqr(dy))
                if dist < _mindist:
                    vx = vx - (dx * 0.2)
                    vy = vy - (dy * 0.2)
                if dist < _matchspeedwindow:
                    avxtotal = avxtotal + b2[2]
                    avytotal = avytotal + b2[3]
                    avcount = avcount + 1
            j = j + 1

        for b2 in birdlist:
            do_avg(b2)

        if 0 != avcount:
            avx = avxtotal / avcount
            avy = avytotal / avcount
            vx = (0.9 * vx) + (0.1 * avx)
            vy = (0.9 * vy) + (0.1 * avy)

        def bounce(barrier):
            nonlocal vx, vy
            dx = barrier[0] - x
            dy = barrier[1] - y
            dist = math.sqrt(sqr(dx) + sqr(dy))
            if dist < (_barrierradius + 15):
                vx = vx - (dx * 0.1)
                vx = vy * 0.6
                vy = vy - (dy * 0.1)
                vy = vy * 0.6

        for barrier in _barriers:
            bounce(barrier)

        new_speed = math.sqrt(sqr(vx) + sqr(vy))
        if new_speed > _maxspeed:
            vx = vx * (_maxspeed / new_speed)
            vy = vy * (_maxspeed / new_speed)

        i = i + 1
        return [b[0] + vx, b[1] + vy, vx, vy]

    return {
        "ticks": w["ticks"] + 1,
        "birdlist": [update(b) for b in w["birdlist"]],
        "size": w["size"],
        "leaderbirdx": leaderbirdx,
        "leaderbirdy": leaderbirdy,
        "leaderbirdvx": leaderbirdvx,
        "leaderbirdvy": leaderbirdvy,
    }

def run_frames(n, w, acc):
    while n != 0:
        w = ticker(w)
        acc = acc + math.floor(abs(w["leaderbirdx"]) + abs(w["leaderbirdy"]))
        n = n - 1
    return acc

t0 = time.perf_counter()
final_acc = run_frames(500, world0, 0)
loop_ms = (time.perf_counter() - t0) * 1000
print(math.floor(final_acc))
print("LOOP-MS %d" % round(loop_ms))
