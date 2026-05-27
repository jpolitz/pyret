({
  requires: [],
  nativeRequires: ["pyret-base/js/runtime"],
  provides: {
    values: {
      "make-runtime": "tany",
      // Returns whether *this* runtime is the async-backend variant.
      // compile-lib uses this to make inner compiles (e.g. run-to-result
      // inside test-compile-helper) inherit the host's backend choice, so
      // a host program compiled with -async-backend never has to load
      // sync-compiled inner modules onto an async runtime (the "polyglot"
      // failure mode).
      "is-async-backend": "tany"
    },
    types: {
      "Runtime": "tany"
    }
  },
  theModule: function(runtime, ns, uri, runtimeLib) {
    var get = runtime.getField;
    function applyBrand(brand, val) {
      return get(brand, "brand").app(val);
    }

    var brandRuntime = runtime.namedBrander("runtime", ["runtime-lib: runtime brander"]);
    var annRuntime = runtime.makeBranderAnn(brandRuntime, "Runtime");
    var checkRuntime = function(v) { runtime._checkAnn(["runtime"], annRuntime, v); };

    function makeRuntime() {
      return applyBrand(brandRuntime, runtime.makeObject({
        "runtime": runtime.makeOpaque(runtimeLib.makeRuntime({
          stdout: runtime.stdout,
          stderr: runtime.stderr,
          stdin: runtime.stdin
        }))
      }));
    }
    function isAsyncBackend() {
      // Sync function: just returns a plain JS boolean wrapped as Pyret.
      return runtime.makeBoolean(runtime.isAsyncBackend === true);
    }
    var values = {
      "make-runtime": runtime.makeFunction(makeRuntime, "make-runtime"),
      "is-async-backend": runtime.makeFunction(isAsyncBackend, "is-async-backend")
    };
    var types = {
      Runtime: annRuntime
    };
    var internal = {
      makeRuntime: makeRuntime,
      checkRuntime: checkRuntime,
      brandRuntime: brandRuntime
    };
    return runtime.makeModuleReturn(values, types, internal);
  }
})

