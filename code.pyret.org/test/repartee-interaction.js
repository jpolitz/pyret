// Interaction-path parity: drives the live ">>>" prompt (evalPyret →
// .echo-container → .replOutput) and checks the rendered text. Run against
// /editor2 (BASE_PAGE=/editor2) it exercises the Repartee interactions; run
// against the default /editor it exercises CPO — the same assertions, so passing
// on both is the parity statement.
//
// NOTE: each scenario gets a FRESH page (its own describe + setupMulti). CPO
// clears the interactions area when definitions are re-run (the "transparent
// REPL"); Repartee deliberately keeps past interactions (editable history). So we
// don't change definitions under a live set of interactions within one page —
// that behavioural difference is intentional, not a parity failure.
var tester = require("../test-util/util.js");

function scenario(name, defs, repls) {
  describe("Repartee interaction parity: " + name, function() {
    before(tester.setupMulti(name));
    after(tester.teardownMulti);
    tester.testRunAndUseRepl(it, name, defs, repls, {});
  });
}

scenario("arithmetic and bindings", "x = 5\nfun double(n): n * 2 end",
  [["double(x)", "10"], ["x + 1", "6"]]);

scenario("lists", "shapes = [list: 1, 2, 3]",
  [["shapes", "[list: 1, 2, 3]"], ["shapes.length()", "3"]]);

scenario("strings", "greeting = \"hi\"",
  [["greeting + \" there\"", "hi there"]]);
