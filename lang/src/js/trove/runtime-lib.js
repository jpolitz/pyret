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
    // Returns true when this module was linked against runtime-async.js
    // (i.e., the host process is running async-backend-compiled code).
    // Used by compile-lib to default inner compiles to async-backend so
    // compiled inner code matches the cohabiting runtime.
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
      brandRuntime: brandRuntime,
      isAsyncBackend: isAsyncBackend
    };
    return runtime.makeModuleReturn(values, types, internal);
  }
})

