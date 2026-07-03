#!/bin/bash
# Version-skew + refinement-alias oracle for the `opt-facts` provides section.
#
# Part 1 (skew triple): compile a provider/importer pair (provider exports a data
# type whose methods are proven flat and serialized into the provider -static's
# optional `opt-facts` section). Then hand-tamper the provider's cached -static.js:
#   (a) strip  : delete `opt-facts` entirely      -> importer must compile+run
#                                                    conservatively (baseline guards)
#   (b) unknown: inject an unknown field inside   -> importer must still READ the
#                `opt-facts`                         known method-flatness (opt guards)
#   (c) schema : bump `schema` to 99              -> whole section ignored wholesale
#                                                    (baseline guards)
# After each tamper, ONLY the importer is recompiled (the provider cache, including
# the tampered -static, is reused -- asserted via checksum) and the run output must
# be IDENTICAL to the untampered baseline: facts are droppable, never load-bearing.
#
# Part 2 (refinement-alias pin, memory flatness-crossmodule-soundness): provider
# exports `type Nat = Number%(nat-pred)` with a NON-FLAT (recursive) predicate. The
# importer's method takes `x :: A.Nat`; that method must stay NON-flat (identical
# R.iT guard count with and without -no-method-flatness), because a cross-module
# refinement alias must never be trusted flat. A `:: Number` control twin MUST
# flatten (guard count drops), proving the assertion can detect firing at all.
#
# Self-locating; exits non-zero on any failure. Overridable: NODE22, NODE, CAP.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANG_DIR="$(cd "$HERE/../../.." && pwd)"   # tests/async-opt/mf -> lang/
cd "$LANG_DIR"
NODE22="${NODE22:-node22}"; NODE="${NODE:-node}"
command -v "$NODE22" >/dev/null 2>&1 || NODE22="$NODE"
CAP="${CAP:-4096}"
PYRET="build/ts-compiler/pyret.js"
if [ ! -f "$PYRET" ]; then echo "ERROR: $PYRET not found (run 'make ts-compiler' first)"; exit 2; fi
export NODE_PATH="$LANG_DIR/node_modules"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PY="$NODE --max-old-space-size=$CAP $PYRET --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ -no-check-mode"
CFG_P="src/scripts/standalone-configA-async.json"; CFG_C="src/scripts/standalone-configA.json"
fail=0

# ---------------------------------------------------------------- fixtures
cat > "$WORK/skew-lib.arr" <<'EOF'
provide *
data Counter:
  | counter(n :: Number) with:
    method value(self) -> Number: self.n end,
    method double(self) -> Number: self.n * 2 end
end
EOF
cat > "$WORK/skew-use.arr" <<'EOF'
import file("skew-lib.arr") as L

fun tally(c :: L.Counter) -> Number block:
  var acc = 0
  for each(i from range(0, 5)):
    acc := (acc + c.value()) + c.double()
  end
  acc
end

print(num-to-string(tally(L.counter(7))) + "\n")
EOF
cat > "$WORK/nat-lib.arr" <<'EOF'
provide *
provide-types *
fun nat-pred(n :: Number) -> Boolean:
  if n <= 0: true
  else: nat-pred(n - 1)
  end
end
type Nat = Number%(nat-pred)
EOF
cat > "$WORK/nat-use.arr" <<'EOF'
import file("nat-lib.arr") as A

data Holder:
  | holder(v :: Number) with:
    method add-nat(self, x :: A.Nat) -> Number: self.v + x end
end

fun go(h :: Holder) -> Number block:
  var acc = 0
  for each(i from range(0, 4)):
    acc := acc + h.add-nat(i)
  end
  acc
end

print(num-to-string(go(holder(3))) + "\n")
EOF
sed -e 's/x :: A.Nat/x :: Number/' -e 's/add-nat/add-num/g' "$WORK/nat-use.arr" > "$WORK/nat-ctrl.arr"

compile() { # compile <arr> <compiled-dir> <jarr> <extra-flags...>
  local arr="$1" dir="$2" jarr="$3"; shift 3
  mkdir -p "$dir"
  $PY --stack-backend promise "$@" --require-config "$CFG_P" --compiled-dir "$dir" --outfile "$jarr" --build-runnable "$arr" >/dev/null 2>&1
}
guards() { grep -oh 'R.iT' "$1"/$2-*module.js 2>/dev/null | wc -l; }

# ---------------------------------------------------------------- part 1: skew
O="$WORK/opt"; B="$WORK/base"
compile "$WORK/skew-use.arr" "$O" "$WORK/skew.opt.jarr"
compile "$WORK/skew-use.arr" "$B" "$WORK/skew.base.jarr" -no-imported-method-flat
oo="$($NODE22 "$WORK/skew.opt.jarr" 2>&1)"; ob="$($NODE22 "$WORK/skew.base.jarr" 2>&1)"
og="$(guards "$O" skew-use.arr)"; bg="$(guards "$B" skew-use.arr)"
[ -n "$oo" ] && [ "$oo" = "$ob" ] || { echo "FIXTURE: opt/base outputs differ ('$oo' vs '$ob')"; fail=1; }
[ "$og" -lt "$bg" ] || { echo "FIXTURE: cross-module flattening DID-NOT-FIRE (opt=$og base=$bg)"; fail=1; }
ls "$O"/skew-lib.arr-*-static.js >/dev/null 2>&1 || { echo "FIXTURE: no provider -static found"; fail=1; }
grep -l 'opt-facts' "$O"/skew-lib.arr-*-static.js >/dev/null 2>&1 || { echo "FIXTURE: provider -static carries no opt-facts"; fail=1; }
printf "%-16s out=%-6s guards opt=%s base=%s (fixture ok)\n" "skew-fixture" "$oo" "$og" "$bg"

for mode in strip unknown schema; do
  D="$WORK/tamper-$mode"; cp -r "$O" "$D"
  ST="$(ls "$D"/skew-lib.arr-*-static.js)"
  "$NODE" -e '
    const fs = require("fs");
    const [f, mode] = process.argv.slice(1);
    const t = fs.readFileSync(f, "utf8").trim();
    if (!t.startsWith("(") || !t.endsWith(")")) { console.error("unexpected -static shape"); process.exit(2); }
    const o = JSON.parse(t.slice(1, -1));
    if (!o.provides || !o.provides["opt-facts"]) { console.error("no opt-facts to tamper"); process.exit(2); }
    if (mode === "strip") { delete o.provides["opt-facts"]; }
    else if (mode === "unknown") { o.provides["opt-facts"]["fact-kind-from-the-future"] = { "x": 1 }; }
    else if (mode === "schema") { o.provides["opt-facts"]["schema"] = 99; }
    else { process.exit(2); }
    fs.writeFileSync(f, "(" + JSON.stringify(o) + ")");
  ' "$ST" "$mode" || { echo "$mode: tamper script failed"; fail=1; continue; }
  sum_before="$(sha256sum "$ST" | cut -d' ' -f1)"
  rm -f "$D"/skew-use.arr-*                      # force ONLY the importer to recompile
  compile "$WORK/skew-use.arr" "$D" "$WORK/skew.$mode.jarr"
  sum_after="$(sha256sum "$ST" | cut -d' ' -f1)"
  out="$($NODE22 "$WORK/skew.$mode.jarr" 2>&1)"; g="$(guards "$D" skew-use.arr)"
  ok="ok"
  [ "$sum_before" = "$sum_after" ] || { ok="PROVIDER-RECOMPILED(test-void)"; fail=1; }
  [ "$out" = "$oo" ] || { ok="WRONG-OUTPUT('$out')"; fail=1; }
  case "$mode" in
    strip|schema) [ "$g" -eq "$bg" ] || { ok="NOT-CONSERVATIVE(g=$g want=$bg)"; fail=1; } ;;
    unknown)      [ "$g" -eq "$og" ] || { ok="FACTS-LOST(g=$g want=$og)"; fail=1; } ;;
  esac
  printf "%-16s out=%-6s guards=%-3s %s\n" "skew-$mode" "$out" "$g" "$ok"
done

# ------------------------------------------------- part 2: refinement-alias pin
NO="$WORK/nat-opt"; NB="$WORK/nat-nomf"; NC="$WORK/nat-cont"
compile "$WORK/nat-use.arr" "$NO" "$WORK/nat.opt.jarr"
compile "$WORK/nat-use.arr" "$NB" "$WORK/nat.nomf.jarr" -no-method-flatness
mkdir -p "$NC"
$PY --stack-backend cont --require-config "$CFG_C" --compiled-dir "$NC" --outfile "$WORK/nat.cont.jarr" --build-runnable "$WORK/nat-use.arr" >/dev/null 2>&1
no="$($NODE22 "$WORK/nat.opt.jarr" 2>&1)"; nb="$($NODE22 "$WORK/nat.nomf.jarr" 2>&1)"; ncout="$($NODE22 "$WORK/nat.cont.jarr" 2>&1)"
ng="$(guards "$NO" nat-use.arr)"; nbg="$(guards "$NB" nat-use.arr)"
ok="ok"
{ [ -n "$no" ] && [ "$no" = "$nb" ] && [ "$nb" = "$ncout" ]; } || { ok="UNSOUND-OUTPUT('$no'/'$nb'/'$ncout')"; fail=1; }
[ "$ng" -eq "$nbg" ] || { ok="ALIAS-WRONGLY-FLATTENED(g=$ng nomf=$nbg)"; fail=1; }
printf "%-16s out=%-6s guards=%s nomf=%s %s\n" "nat-alias-pin" "$no" "$ng" "$nbg" "$ok"

CO="$WORK/ctrl-opt"; CB="$WORK/ctrl-nomf"
compile "$WORK/nat-ctrl.arr" "$CO" "$WORK/ctrl.opt.jarr"
compile "$WORK/nat-ctrl.arr" "$CB" "$WORK/ctrl.nomf.jarr" -no-method-flatness
co="$($NODE22 "$WORK/ctrl.opt.jarr" 2>&1)"; cb="$($NODE22 "$WORK/ctrl.nomf.jarr" 2>&1)"
cg="$(guards "$CO" nat-ctrl.arr)"; cbg="$(guards "$CB" nat-ctrl.arr)"
ok="ok"
[ "$co" = "$cb" ] || { ok="CTRL-OUTPUT-DIVERGED"; fail=1; }
[ "$cg" -lt "$cbg" ] || { ok="CTRL-DID-NOT-FIRE(g=$cg nomf=$cbg) -- pin has no teeth"; fail=1; }
printf "%-16s out=%-6s guards=%s nomf=%s %s\n" "nat-control" "$co" "$cg" "$cbg" "$ok"

if [ "$fail" -eq 0 ]; then echo "SKEW-ORACLE OK"; else echo "SKEW-ORACLE FAILURES"; fi
exit "$fail"
