({
  requires: [],
  nativeRequires: ["pyret-base/js/runtime"],
  provides: {
    values: {
      "make-runtime": "tany",
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
    // True iff the host runtime (the one this compiler is running on) is the
    // async backend. Used to route nested compiler-at-runtime compiles to the
    // async backend so generated code matches the runtime it will run on.
    function isAsyncBackend() {
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

