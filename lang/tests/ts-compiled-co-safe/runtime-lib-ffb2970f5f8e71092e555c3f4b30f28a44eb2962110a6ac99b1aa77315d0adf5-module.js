({
  requires: [],
  nativeRequires: ["pyret-base/js/runtime"],
  provides: {
    values: {
      "make-runtime": "tany",
      "compiled-stack-backend": "tany"
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
    var values = {
      "make-runtime": runtime.makeFunction(makeRuntime, "make-runtime"),
      // Which control-flow backend the linked runtime implements ("cont" | "promise").
      // Lets compile-structs default the compiler to its own backend and resolve `auto`.
      "compiled-stack-backend": runtime.makeString(runtimeLib.STACK_BACKEND || "cont")
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

