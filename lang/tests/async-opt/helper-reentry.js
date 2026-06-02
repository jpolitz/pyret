({
  requires: [],
  provides: {
    shorthands: {},
    values: {
      "run-reentry": ["arrow", ["String", "String", "Number", "Number"], "String"],
      "explain-expected-noise": ["arrow", [], "Nothing"]
    },
    types: {}
  },
  nativeRequires: [],
  // Raw-JS (FFI) probe for the higher-order-helper conditional-await
  // optimization. The optimized loop helpers (raw_array_map / raw_array_each /
  // eachLoop / raw-list-map, see runtime-async.js) do
  //
  //     var res = f.app(x);
  //     if (res instanceof Promise) { ...await res... }   // non-flat callback
  //     else { ...; if (needsPause()) await pause(); }     // flat callback
  //
  // i.e. they call the user callback *synchronously* and only decide whether to
  // await *after* it returns. This module supplies a raw-JS callback that
  // re-enters the same helper from inside that synchronous call -- the exact
  // "user code calls back into map" shape from async-optimization-testing.md.
  // A raw-JS callback has NO compiled per-entry fuel check, so it is the purest
  // way to test whether the helper itself bounds the re-entrant native-stack
  // descent.
  theModule: function(runtime, _, _2) {

    // No `unhandledRejection` guard is needed, which is initially surprising.
    // This test deliberately overflows the native stack, so helper Promises
    // reject mid-overflow with RangeErrors -- yet none of them ever surface as a
    // Node `unhandledRejection` event (verified: the handler fires 0 times on
    // both Node 18 and Node 24, and the run still exits 0 without the guard).
    //
    // Why: a rejected-with-no-handler Promise is turned into an
    // `unhandledRejection` event in two steps -- (1) at reject time V8 calls
    // Node's host hook `PromiseRejectCallback`, which *registers* the Promise in
    // an internal list; (2) later, that list is drained and the JS-level
    // `unhandledRejection` event is emitted (and `--unhandled-rejections=throw`
    // acts there). Here step (1) runs synchronously on the *already-exhausted*
    // stack, so the hook itself throws `Maximum call stack size exceeded` before
    // it can register the Promise -- Node prints "Exception in
    // PromiseRejectCallback" and the rejection is dropped, never reaching step
    // (2). So `--unhandled-rejections=throw` never engages; the gate stays green
    // on modern Node. The "Exception in PromiseRejectCallback" stderr lines are
    // intrinsic to overflowing the stack this hard and are harmless.

    // Classify a caught failure into a Pyret string the .arr check asserts on.
    // A native-stack overflow surfaces as a RangeError ("OVERFLOW"); anything
    // else is reported verbatim so a regression stays legible.
    //
    // NOTE (adapted for this backend): the upstream probe drove the thunk with
    // pauseStack + a nested runThunk. The async `run` here rejects a same-runtime
    // re-entry via its RUN_ACTIVE guard (run-task runs INLINE in this backend), so
    // instead we run the helper at the FFI boundary directly with `await` and let
    // the compiled call site await the Promise we return.
    function classify(e) {
      if (e instanceof RangeError) { return "OVERFLOW"; }
      else if (e instanceof Error) { return "ERR:" + e.name; }
      else if (e && e.exn) { return "PYRETERR"; }
      else { return "ERR:other"; }
    }

    // One synchronous re-entry into the named helper, passing `cont` as the
    // callback. Each helper is driven over a singleton input so it runs exactly
    // one callback application per level -> the re-entry depth equals the call
    // depth.
    function oneLevel(helperName, cont) {
      switch (helperName) {
        case "raw-array-map":  return runtime.raw_array_map(cont, [0]);
        case "raw-array-each": return runtime.raw_array_each(cont, [0]);
        case "raw-array-mapi": return runtime.raw_array_mapi(cont, [0]);
        case "each-loop":      return runtime.eachLoop(cont, 0, 1);
        default: throw new Error("unknown helper: " + helperName);
      }
    }

    // mode determines the callback's shape:
    //  - "propagate": sync callback; re-enters and RETURNS the helper's Promise,
    //                 honoring the embedder contract (await every Pyret call).
    //                 Drives the helper's `await res` (non-flat) branch, so a
    //                 re-entrant overflow surfaces as a caught failure.
    //  - "eager":     async callback that accounts fuel itself, yielding to the
    //                 event loop every `gas` levels (a manual setImmediate). This
    //                 is the "more aggressive fuel accounting" hypothesis from
    //                 async-optimization-testing.md, expressed at the callback.
    async function runReentry(helperName, mode, depth, gas) {
      var toGo, counter, cb;

      var stepSync = runtime.makeFunction(function(_x) {
        if (toGo <= 0) { return runtime.nothing; }
        toGo = toGo - 1;
        return oneLevel(helperName, cb);   // synchronous re-entry -> descent
      }, "reentry-step-sync");

      var stepEager = runtime.makeFunction(function(_x) {
        return (async function() {
          counter = counter + 1;
          if (gas > 0 && (counter % gas) === 0) {
            // Yield: unwinds the native stack back to the event loop, then
            // resumes -- bounds the descent regardless of how the helper awaits.
            await new Promise(function(r) { setImmediate(r); });
          }
          if (toGo <= 0) { return runtime.nothing; }
          toGo = toGo - 1;
          return oneLevel(helperName, cb);
        })();
      }, "reentry-step-eager");

      cb = (mode === "eager") ? stepEager : stepSync;

      toGo = depth;
      counter = 0;
      try {
        await oneLevel(helperName, cb);
        return runtime.makeString("ok");
      } catch (e) {
        return runtime.makeString(classify(e));
      }
    }

    // Print, to stderr, a heads-up that the scary RangeError spew below is the
    // test working as designed. Written to stderr so it sits right above the
    // "Exception in PromiseRejectCallback" lines it is explaining.
    function explainExpectedNoise() {
      var w = (typeof process !== "undefined" && process.stderr)
        ? function(s) { process.stderr.write(s); }
        : function(s) { runtime.stdout(s); };
      w("\n");
      w("[helper-reentry] Probing re-entrant native-stack safety of the loop helpers.\n");
      w("[helper-reentry] On this backend the helpers charge fuel every iteration, so\n");
      w("[helper-reentry] re-entry stays bounded (each case returns \"ok\"); a passing\n");
      w("[helper-reentry] run exits 0 with no RangeError spew. If a conditional-await\n");
      w("[helper-reentry] optimization later drops the per-iter fuel charge, the deep\n");
      w("[helper-reentry] cases overflow and surface as \"OVERFLOW\".\n");
      w("\n");
      return runtime.nothing;
    }

    return runtime.makeModuleReturn({
      // run-reentry(helper :: String, mode :: String, depth :: Number,
      //             gas :: Number) -> String  ("ok" | "OVERFLOW" | "ERR:..." )
      "run-reentry": runtime.makeFunction(function(helperName, mode, depth, gas) {
        return runReentry(helperName, mode, depth, gas);
      }, "run-reentry"),
      "explain-expected-noise": runtime.makeFunction(explainExpectedNoise,
        "explain-expected-noise")
    }, {});
  }
})
