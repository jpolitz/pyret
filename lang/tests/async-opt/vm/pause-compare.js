// Compare two PYRET_PAUSE_TRACE files (see runtime.js / runtime-async.js,
// PYRET_PAUSE_SCHEDULE). Usage:
//   node pause-compare.js [--key atloc|namedef] [--quiet] A.trace B.trace
//
// A is the reference (cont, or a vm trace); B must pause at the same event
// indices, and B's stack at each pause must match A's frame-by-frame from the
// top (innermost) after dropping A's "B:"-marked runtime-builtin frames.
// Residual (outermost) frames on either side are reported, never matched.
//
// Frame syntax: NAME@DEFLOC@ATLOC (vm) or NAME@?@ATLOC (cont). Deep stacks
// are cycle-compressed: "f1 ~ f2 x400" is the 2-cycle (f1,f2) repeated 400
// times. Comparison walks the compressed runs (whole-run fast path when both
// sides sit at aligned identical cycles), so million-frame stacks stay cheap.
// --key atloc compares ATLOC ("~" in a loc is impossible; the literal key
// "?" never wildcards); --key namedef compares NAME@DEFLOC (for vm-fast=all
// traces, whose bailed frames carry def-loc call sites).
"use strict";
const fs = require("fs");

function parseArgs(argv) {
  const out = { key: "atloc", quiet: false, files: [] };
  for (const a of argv) {
    if (a === "--quiet") { out.quiet = true; }
    else if (a.startsWith("--key")) { out.key = a.includes("=") ? a.split("=")[1] : null; }
    else if (out.key === null) { out.key = a; }
    else { out.files.push(a); }
  }
  return out;
}

function parseTrace(path) {
  const pauses = [];
  let total = null;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("P ")) {
      const bar = line.indexOf(" | ");
      const head = line.slice(2, bar).split(" ");
      const idx = Number(head[0]);
      const ev = Number(head[1].slice(1));
      const frames = [];
      const body = line.slice(bar + 3);
      if (body.length > 0) {
        for (const tok of body.split(" ; ")) {
          const m = tok.match(/^(.*) x(\d+)$/);
          if (m) { frames.push([m[1], Number(m[2])]); }
          else { frames.push([tok, 1]); }
        }
      }
      pauses.push({ idx, ev, frames });
    } else if (line.startsWith("T ")) {
      const m = line.match(/events=(\d+) pauses=(\d+)/);
      total = { events: Number(m[1]), pauses: Number(m[2]) };
    }
  }
  return { pauses, total };
}

// Project a pause's compressed frames to comparison runs:
// [{keys: [k...], reps, descs: [d...]}], builtin frames dropped.
function projectRuns(frames, key) {
  const runs = [];
  runs.truncated = false;
  for (const [desc, n] of frames) {
    // Display-cap marker: the stack continues but was not recorded.
    if (desc.startsWith("...[")) { runs.truncated = true; break; }
    const keys = [], descs = [];
    for (const g of desc.split(" ~ ")) {
      if (g.startsWith("B:")) { continue; }
      const parts = g.split("@");
      keys.push(key === "atloc" ? parts[parts.length - 1] : parts.slice(0, parts.length - 1).join("@"));
      descs.push(g);
    }
    if (keys.length > 0) { runs.push({ keys, reps: n, descs }); }
  }
  return runs;
}

function runsLength(runs) {
  let t = 0;
  for (const r of runs) { t += r.keys.length * r.reps; }
  return t;
}

function sameKeys(a, b) {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
  return true;
}

// Walk both run lists comparing element-by-element with a whole-run fast
// path. Returns {bad, pos, da, db} on mismatch, else {bad: -1}.
function compareRuns(A, B) {
  let ai = 0, aj = 0, ak = 0;   // run index, repetition, offset in group
  let bi = 0, bj = 0, bk = 0;
  let pos = 0;
  while (ai < A.length && bi < B.length) {
    const ra = A[ai], rb = B[bi];
    if (ak === 0 && bk === 0 && sameKeys(ra.keys, rb.keys)) {
      const r = Math.min(ra.reps - aj, rb.reps - bj);
      if (r > 0) {
        aj += r; bj += r; pos += r * ra.keys.length;
        if (aj === ra.reps) { ai++; aj = 0; }
        if (bj === rb.reps) { bi++; bj = 0; }
        continue;
      }
    }
    const ka = ra.keys[ak], kb = rb.keys[bk];
    if (ka !== kb) { return { bad: pos, da: ra.descs[ak], db: rb.descs[bk] }; }
    pos++;
    ak++; if (ak === ra.keys.length) { ak = 0; aj++; if (aj === ra.reps) { ai++; aj = 0; } }
    bk++; if (bk === rb.keys.length) { bk = 0; bj++; if (bj === rb.reps) { bi++; bj = 0; } }
  }
  return { bad: -1 };
}

// The keys of everything from virtual position p to the end, abbreviated.
function tailKeys(runs, fromPos, cap) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const len = r.keys.length * r.reps;
    if (pos + len <= fromPos) { pos += len; continue; }
    const label = r.keys.join(" ~ ") + (r.reps > 1 ? " x" + r.reps : "");
    out.push(label);
    if (out.length >= cap) { out.push("..."); break; }
    pos += len;
  }
  return out.join(" ; ");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.files.length !== 2) {
    console.error("usage: node pause-compare.js [--key atloc|namedef] [--quiet] A.trace B.trace");
    process.exit(2);
  }
  const A = parseTrace(args.files[0]);
  const B = parseTrace(args.files[1]);
  let fail = 0, exact = 0, prefix = 0;
  const residues = new Map();
  const note = (m) => { if (!args.quiet) { console.log(m); } };

  if (!A.total || !B.total) { console.log("FAIL: missing T line (crashed run?)"); process.exit(1); }
  if (A.total.events !== B.total.events || A.total.pauses !== B.total.pauses) {
    console.log(`FAIL: totals differ: A events=${A.total.events} pauses=${A.total.pauses}` +
      ` vs B events=${B.total.events} pauses=${B.total.pauses}`);
    fail++;
  }
  const n = Math.min(A.pauses.length, B.pauses.length);
  for (let i = 0; i < n; i++) {
    const pa = A.pauses[i], pb = B.pauses[i];
    if (pa.ev !== pb.ev) {
      note(`FAIL pause ${pa.idx}: event index ${pa.ev} vs ${pb.ev}`);
      fail++;
      continue;
    }
    const ra = projectRuns(pa.frames, args.key);
    const rb = projectRuns(pb.frames, args.key);
    const la = runsLength(ra), lb = runsLength(rb);
    const r = compareRuns(ra, rb);
    if (r.bad >= 0) {
      note(`FAIL pause ${pa.idx} @${pa.ev}: frame ${r.bad}: "${r.da}" vs "${r.db}" (depths ${la}/${lb})`);
      fail++;
      continue;
    }
    if (ra.truncated || rb.truncated) { prefix++; continue; }
    if (la === lb) { exact++; }
    else {
      prefix++;
      const side = la > lb ? "A" : "B";
      const key = side + ":" + tailKeys(la > lb ? ra : rb, Math.min(la, lb), 6);
      residues.set(key, (residues.get(key) || 0) + 1);
    }
  }
  console.log(`pauses=${n} exact=${exact} prefix=${prefix} fail=${fail}`);
  if (residues.size > 0 && !args.quiet) {
    console.log("residual outer frames (side:frames -> count):");
    const sorted = [...residues.entries()].sort((x, y) => y[1] - x[1]);
    for (const [k, c] of sorted.slice(0, 10)) { console.log(`  ${c}x ${k}`); }
    if (sorted.length > 10) { console.log(`  ... ${sorted.length - 10} more distinct residues`); }
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
