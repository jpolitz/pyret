/*
  Support library for running code.pyret.org on the TypeScript compiler
  (lang/src/ts-compiler, bundled onto the page as window.PyretTSCompiler).

  This module adapts between the TS compiler's plain-JS world and the
  Pyret runtime world that the rest of CPO (repl-ui, error-ui, check-ui)
  expects:

    - builtin Loadables/locators for the TS compiler, built from the
      same staticModules record the page already carries;
    - a module finder for the dependency protocols CPO supports (with a
      prefetch pass, since the TS compile pipeline is synchronous);
    - a ReplExecutor that runs compiled programs through the builtin
      load-lib's run-program, so results are genuine load-lib
      ModuleResults and render exactly as they do today;
    - a bridge that converts TS compile errors (with their renderReason/
      renderFancyReason methods returning TS ErrorDisplay trees) into
      Pyret objects whose render-(fancy-)reason methods return genuine
      builtin://error-display values, so error-ui/output-ui render them
      unchanged;
    - a re-thrower that converts TS parse errors into the same Pyret
      parse exceptions the stock parser raises.
*/
({
  requires: [
    { "import-type": "builtin", name: "load-lib" },
    { "import-type": "builtin", name: "either" },
    { "import-type": "builtin", name: "error-display" }
  ],
  nativeRequires: [],
  provides: {},
  theModule: function(runtime, namespace, uri, loadLib, eitherLib, errorDisplayLib) {
    var gf = runtime.getField;
    var gmf = function(m, f) { return gf(gf(m, "values"), f); };
    // NOTE: runtime.ffi is not fully populated until the ffi builtin
    // loads, which can happen after this module instantiates; always
    // access it lazily.

    function tsCompiler() {
      if(!window.PyretTSCompiler) {
        throw new Error("The TypeScript compiler bundle (ts-compiler.js) is not loaded on this page");
      }
      return window.PyretTSCompiler;
    }

    // ---------------------------------------------------------------
    // Srcloc conversions
    // ---------------------------------------------------------------

    function tsLocToPyret(loc) {
      if(!loc) { return runtime.makeSrcloc(["unknown location"]); }
      if(loc.$name === "builtin") {
        return runtime.makeSrcloc([loc.moduleName]);
      }
      return runtime.makeSrcloc([
        loc.source,
        loc.startLine, loc.startColumn, loc.startChar,
        loc.endLine, loc.endColumn, loc.endChar
      ]);
    }

    function pyretLocToTs(pyLoc) {
      var T = tsCompiler();
      if(runtime.hasField(pyLoc, "source")) {
        return new T.srcloc.Srcloc(
          gf(pyLoc, "source"),
          runtime.num_to_fixnum(gf(pyLoc, "start-line")),
          runtime.num_to_fixnum(gf(pyLoc, "start-column")),
          runtime.num_to_fixnum(gf(pyLoc, "start-char")),
          runtime.num_to_fixnum(gf(pyLoc, "end-line")),
          runtime.num_to_fixnum(gf(pyLoc, "end-column")),
          runtime.num_to_fixnum(gf(pyLoc, "end-char")));
      }
      else {
        return new T.srcloc.Builtin(gf(pyLoc, "module-name"));
      }
    }

    // ---------------------------------------------------------------
    // ErrorDisplay conversion: TS error-display tree -> Pyret
    // builtin://error-display values
    // ---------------------------------------------------------------

    var ED = gf(errorDisplayLib, "values");
    function edc(name) { return gf(ED, name); }

    function convertEmbed(val) {
      // Pyret numbers/strings/booleans are plain JS values at runtime, so
      // primitives can be embedded directly; anything else from the TS
      // world is shown via its toString (the TS port's data classes print
      // like the Pyret originals).
      if(typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
        return edc("embed").app(val);
      }
      return edc("text").app(String(val));
    }

    function convertED(ed) {
      switch(ed.$name) {
        case "paragraph":
          return edc("paragraph").app(runtime.ffi.makeList(ed.contents.map(convertED)));
        case "bulleted-sequence":
          return edc("bulleted-sequence").app(runtime.ffi.makeList(ed.contents.map(convertED)));
        case "v-sequence":
          return edc("v-sequence").app(runtime.ffi.makeList(ed.contents.map(convertED)));
        case "h-sequence":
          return edc("h-sequence").app(runtime.ffi.makeList(ed.contents.map(convertED)), ed.sep);
        case "h-sequence-sep":
          return edc("h-sequence-sep").app(runtime.ffi.makeList(ed.contents.map(convertED)), ed.sep, ed.last);
        case "embed":
          return convertEmbed(ed.val);
        case "text":
          return edc("text").app(ed.str);
        case "loc":
          return edc("loc").app(tsLocToPyret(ed.loc));
        case "maybe-stack-loc":
          return edc("maybe-stack-loc").app(
            ed.n,
            ed.userFramesOnly,
            runtime.makeFunction(function(pyLoc) {
              return convertED(ed.contentsWithLoc(pyretLocToTs(pyLoc)));
            }, "contents-with-loc"),
            convertED(ed.contentsWithoutLoc));
        case "code":
          return edc("code").app(convertED(ed.contents));
        case "cmcode":
          return edc("cmcode").app(tsLocToPyret(ed.loc));
        case "loc-display":
          return edc("loc-display").app(tsLocToPyret(ed.loc), ed.style, convertED(ed.contents));
        case "optional":
          return edc("optional").app(convertED(ed.contents));
        case "highlight":
          return edc("highlight").app(
            convertED(ed.contents),
            runtime.ffi.makeList(ed.locs.map(tsLocToPyret)),
            ed.color);
        default:
          console.error("Unknown TS ErrorDisplay variant: ", ed);
          return edc("text").app(String(ed));
      }
    }

    // A TS CompileError -> a Pyret object renderable by error-ui. The
    // render methods are called off the data the TS error carries, and
    // produce genuine error-display values.
    function bridgeCompileError(tsError) {
      return runtime.makeObject({
        "render-fancy-reason": runtime.makeMethod0(function(_self) {
          return convertED(tsError.renderFancyReason());
        }),
        "render-reason": runtime.makeMethod0(function(_self) {
          return convertED(tsError.renderReason());
        })
      });
    }

    // The `left` payload from the TS repl is a list whose elements are
    // either CompileResult errs (with .problems) or raw problem lists
    // (from make-standalone); normalize to the shape repl-ui's
    // displayResult expects: a Pyret list of records with a `problems`
    // list of renderable errors.
    function bridgeCompileErrors(errs) {
      var asRecords = errs.map(function(e) {
        var problems;
        if(e && Array.isArray(e.problems)) { problems = e.problems; }
        else { problems = [e]; }
        return runtime.makeObject({
          "problems": runtime.ffi.makeList(problems.map(bridgeCompileError))
        });
      });
      return runtime.ffi.makeList(asRecords);
    }

    // ---------------------------------------------------------------
    // Parse errors: re-throw the TS parser's structured errors through
    // the runtime ffi, producing the same Pyret exceptions the stock
    // parse-pyret module raises. MUST be called on the Pyret stack.
    // ---------------------------------------------------------------

    function isTsParseError(e) {
      return e && e.name === "PyretParseError" && typeof e.kind === "string";
    }

    function throwPyretParseError(e) {
      var loc = tsLocToPyret(e.loc);
      switch(e.kind) {
        case "parse-error-next-token":
          return runtime.ffi.throwParseErrorNextToken(loc, e.nextToken);
        case "parse-error-eof":
          return runtime.ffi.throwParseErrorEOF(loc);
        case "parse-error-unterminated-string":
          return runtime.ffi.throwParseErrorUnterminatedString(loc);
        case "parse-error-bad-number":
          return runtime.ffi.throwParseErrorBadNumber(loc);
        case "parse-error-bad-operator":
          return runtime.ffi.throwParseErrorBadOper(loc);
        case "parse-error-bad-check-operator":
          return runtime.ffi.throwParseErrorBadCheckOper(tsLocToPyret(e.op && e.op.l ? e.op.l : e.loc));
        case "parse-error-colon-colon":
          return runtime.ffi.throwParseErrorColonColon(loc, e.nextToken);
        case "parse-error-bad-app":
          return runtime.ffi.throwParseErrorBadApp(tsLocToPyret(e.funLoc), tsLocToPyret(e.argsLoc));
        case "parse-error-bad-fun-header":
          return runtime.ffi.throwParseErrorBadFunHeader(tsLocToPyret(e.funLoc || e.loc), tsLocToPyret(e.argsLoc || e.loc));
        default:
          return runtime.ffi.throwMessageException(String(e.message || e));
      }
    }

    // ---------------------------------------------------------------
    // Builtin modules: loadables and locators from staticModules
    // ---------------------------------------------------------------

    function makeBuiltinSupport(staticModules) {
      var T = tsCompiler();
      var CS = T.compileStructs;
      var loadables = new Map();
      var locators = {};

      Object.keys(staticModules).forEach(function(modUri) {
        if(modUri.indexOf("builtin://") !== 0) { return; }
        var name = modUri.slice("builtin://".length);
        var m = staticModules[modUri];
        var raw = T.builtinModules.builtinRawLocatorFromModule(
          function() { return m; },
          function() { return JSON.stringify(m); });
        var loadable = null;
        function getLoadable() {
          if(loadable === null) {
            var provs = CS.providesFromRawProvides(modUri, {
              uri: modUri,
              values: raw.getRawValueProvides(),
              aliases: raw.getRawAliasProvides(),
              datatypes: raw.getRawDatatypeProvides(),
              modules: raw.getRawModuleProvides()
            });
            loadable = new CS.ModuleAsString(provs, CS.noBuiltins, CS.computedNone,
              CS.ok(new T.jsOfPyret.CCPString("")));
          }
          return loadable;
        }
        loadables.set(modUri, getLoadable());
        locators[modUri] = {
          getUncached: function() { return undefined; },
          needsCompile: function(_provides) { return false; },
          getModifiedTime: function() { return 0; },
          getOptions: function(options) {
            var o = Object.assign({}, options);
            o.checks = "none";
            return o;
          },
          getModule: function() {
            throw new Error("Should never fetch source for builtin module " + modUri);
          },
          getExtraImports: function() { return CS.standardImports; },
          getDependencies: function() {
            return raw.getRawDependencies().map(CS.makeDep);
          },
          getNativeModules: function() {
            return raw.getRawNativeModules().map(function(n) { return new CS.Requirejs(n); });
          },
          getGlobals: function() { return CS.standardGlobals; },
          uri: function() { return modUri; },
          name: function() { return name; },
          setCompiled: function(_loadable, _provides) { return; },
          getCompiled: function() { return getLoadable(); }
        };
      });

      return { loadables: loadables, locators: locators };
    }

    // ---------------------------------------------------------------
    // Source locators for url / url-file imports.  The TS compile
    // pipeline is synchronous, so sources are prefetched (see
    // prefetchDependencies) into sourceCache before compiling.
    // ---------------------------------------------------------------

    function maybeAppendSlash(s) {
      if(s.endsWith("/")) { return s; }
      return s + "/";
    }

    function urlResolve(path, base) {
      return new URL(path, base).href;
    }

    function dependencyUrl(dep) {
      // Returns the fetchable URL for url-flavored dependencies, or null.
      if(dep.protocol === "url") { return dep.arguments[0]; }
      if(dep.protocol === "url-file") {
        return urlResolve(dep.arguments[1], maybeAppendSlash(dep.arguments[0]));
      }
      return null;
    }

    function makeUrlLocator(url, sourceCache) {
      var T = tsCompiler();
      var CS = T.compileStructs;
      var CL = T.compileLib;
      var text = sourceCache.get(url);
      if(text === undefined) {
        throw new Error("Source for " + url + " was not prefetched before compiling");
      }
      var self = {
        getUncached: function() { return undefined; },
        needsCompile: function(_provides) { return true; },
        getModifiedTime: function() { return 0; },
        getOptions: function(options) { return options; },
        getModule: function() { return new CL.PyretString(text); },
        getExtraImports: function() { return CS.standardImports; },
        getDependencies: function() {
          return CL.getStandardDependencies(self.getModule(), url);
        },
        getNativeModules: function() { return []; },
        getGlobals: function() { return CS.standardGlobals; },
        uri: function() { return url; },
        name: function() { return url; },
        setCompiled: function(_loadable, _provides) { return; },
        getCompiled: function() { return undefined; }
      };
      return self;
    }

    // Walks the dependency graph of `code`, fetching the source of any
    // url / url-file imports (transitively) into sourceCache. Returns a
    // promise. Parse errors here are swallowed: the compile pass will
    // re-encounter and report them properly.
    function prefetchDependencies(code, fromUri, sourceCache) {
      var T = tsCompiler();
      var CL = T.compileLib;
      var CS = T.compileStructs;

      function depsOf(text, srcUri) {
        try {
          var parsed = T.parsePyret.surfaceParse(text, srcUri);
          return CL.getDependencies(new CL.PyretAst(parsed), srcUri);
        } catch(e) {
          return [];
        }
      }

      function fetchAll(deps) {
        return Promise.all(deps.map(function(dep) {
          if(!CS.isDependency(dep)) { return Promise.resolve(); }
          var url = dependencyUrl(dep);
          if(url === null || sourceCache.has(url)) { return Promise.resolve(); }
          return fetch(url).then(function(response) {
            if(!response.ok) {
              throw new Error("Failed to load " + url + ": " + response.status);
            }
            return response.text();
          }).then(function(text) {
            sourceCache.set(url, text);
            if(window.CPO && CPO.documents && typeof CodeMirror !== "undefined") {
              CPO.documents.set(url, new CodeMirror.Doc(text, "pyret"));
            }
            return fetchAll(depsOf(text, url));
          });
        }));
      }

      return fetchAll(depsOf(code, fromUri));
    }

    // ---------------------------------------------------------------
    // The module finder handed to the TS repl
    // ---------------------------------------------------------------

    function makeFinderFactory(builtinSupport, sourceCache) {
      return function makeFinder() {
        var locatorCache = {};
        return function finder(context, dep) {
          var T = tsCompiler();
          var CS = T.compileStructs;
          var CL = T.compileLib;
          function located(locator) {
            locatorCache[locator.uri()] = locator;
            return new CL.Located(locator, context);
          }
          if(CS.isBuiltin(dep)) {
            var builtinLocator = builtinSupport.locators["builtin://" + dep.modname];
            if(!builtinLocator) {
              throw new Error("Unknown module: " + dep.modname);
            }
            return located(builtinLocator);
          }
          else {
            var url = dependencyUrl(dep);
            if(url !== null) {
              if(locatorCache[url]) { return new CL.Located(locatorCache[url], context); }
              return located(makeUrlLocator(url, sourceCache));
            }
            throw new Error("The import protocol '" + dep.protocol +
              "' is not supported when running with the TypeScript compiler: " +
              dep.protocol + "://" + dep.arguments.join(":"));
          }
        };
      };
    }

    // ---------------------------------------------------------------
    // Executor over load-lib: runs compiled program text in the realm
    // ---------------------------------------------------------------

    function makeExecutor(pyRuntime) {
      var runProgramPy = gmf(loadLib, "run-program");
      return {
        run: function(realm, programJsSource, _options) {
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              runtime.runThunk(function() {
                return runProgramPy.app(
                  pyRuntime,
                  realm,
                  programJsSource,
                  runtime.makeObject({ "checks": "main" }),
                  runtime.ffi.makeList([]));
              }, function(result) {
                if(runtime.isSuccessResult(result)) {
                  resolve(result.result);
                }
                else {
                  // An error escaping run-program itself (not the
                  // program): surface the whole FailureResult.
                  reject(result);
                }
              });
            }, 0);
          });
        },
        isSuccessResult: function(moduleResult) {
          return moduleResult.val.runtime.isSuccessResult(moduleResult.val.result);
        },
        getResultRealm: function(moduleResult) {
          return moduleResult.val.realm;
        }
      };
    }

    // ---------------------------------------------------------------
    // Result plumbing: convert the TS repl's Either (or thrown error)
    // into the same runtime-result-wrapped Pyret Either that repl-ui's
    // displayResult consumes.
    // ---------------------------------------------------------------

    var pyLeft = gmf(eitherLib, "left");
    var pyRight = gmf(eitherLib, "right");

    function resolveWithEither(deferred, either) {
      runtime.runThunk(function() {
        if(either.$name === "left") {
          return pyLeft.app(bridgeCompileErrors(either.v));
        }
        else {
          return pyRight.app(either.v);
        }
      }, function(result) {
        deferred.resolve(result);
      });
    }

    function resolveWithError(deferred, err) {
      // A FailureResult rejected out of the executor passes through
      // unchanged (it is already what displayResult expects).
      if(err && runtime.isFailureResult && runtime.isFailureResult(err)) {
        deferred.resolve(err);
        return;
      }
      runtime.runThunk(function() {
        if(isTsParseError(err)) {
          return throwPyretParseError(err);
        }
        console.error("Error while compiling with the TS compiler: ", err);
        return runtime.ffi.throwMessageException(String((err && err.message) || err));
      }, function(result) {
        deferred.resolve(result);
      });
    }

    return runtime.makeJSModuleReturn({
      makeBuiltinSupport: makeBuiltinSupport,
      makeFinderFactory: makeFinderFactory,
      makeExecutor: makeExecutor,
      prefetchDependencies: prefetchDependencies,
      resolveWithEither: resolveWithEither,
      resolveWithError: resolveWithError,
      bridgeCompileErrors: bridgeCompileErrors,
      tsCompiler: tsCompiler
    });
  }
})
