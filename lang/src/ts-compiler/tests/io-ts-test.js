// Copy of tests/io-tests/io.test.js pointed at the TypeScript compiler
// (build/ts-compiler/pyret.js instead of build/phaseA/pyret.jarr), with a
// separate compiled cache and outfile so both suites can coexist.
// Run from lang/: node --test src/ts-compiler/tests/io-ts-test.js
// (node:test, like the other ts-compiler suites — see repartee-test.js.)
const glob = require('glob');
const fs = require('fs');
const cp = require('child_process');
const assert = require('assert');
const { describe, test, before, after, beforeEach, afterEach } = require('node:test');

const COMPILER_TIMEOUT = 60000; // ms, for each compiler run (including startup)
const RUN_TIMEOUT = 60000; // ms, for each program execution
const COMPILED_CODE_PATH = "compiled-ts.jarr";
const SUCCESS_EXIT_CODE = 0;
const EMPTY_MESSAGE = "";

const parse_file_for_expected_std = (f) => {
  let stdioExpected = EMPTY_MESSAGE;
  let stdInToInject = EMPTY_MESSAGE;
  let stderrExpected = EMPTY_MESSAGE;
  let compilestderrExpected = EMPTY_MESSAGE;
  let extraArgs = [];

  String(fs.readFileSync(f))
    .split("\n")
    .forEach((line) => {
      // NOTE: we expect only one instance of each to be defined. However, if more
      // than one is defined, we will use the last one.
      
      // stdin
      if (line.startsWith("###<")) {
        stdInToInject = line.slice(line.indexOf(" ")).trim() + "\n";
      }
      
      // stdout
      if(line.startsWith("###>")) {
        stdioExpected = line.slice(line.indexOf(" ")).trim();
      }

      // stderr
      if(line.startsWith("###!")) {
        stderrExpected = line.slice(line.indexOf(" ")).trim();
      }

      if(line.startsWith("###@")) {
        extraArgs = line.slice(line.indexOf(" ")).trim().split(" ");
      }

      if(line.startsWith("###*")) {
        compilestderrExpected = line.slice(line.indexOf(" ")).trim();
      }
  });

  return {
    stdioExpected: stdioExpected,
    stdInToInject: stdInToInject,
    stderrExpected: stderrExpected,
    compilestderrExpected: compilestderrExpected,
    extraArgs: extraArgs
  }
}

const try_delete_compiled_file = () => {
  try { fs.unlinkSync(COMPILED_CODE_PATH); } 
  catch {}
}


describe("IO Tests (TS compiler)", () => {
  let server;
  before(() => {
    server = cp.spawn(
      process.execPath,
      [require.resolve("http-server/bin/http-server"),
       "-p", "7999", "tests/io-tests/tests/"],
      { stdio: "ignore" },
    );
  });
  after(() => {
    server.kill('SIGTERM');
  });
  glob.sync(`tests/io-tests/tests/test-*.arr`, {}).forEach(f => {
    describe("Testing " + f, () => {
      beforeEach(() => try_delete_compiled_file());
      afterEach(() => try_delete_compiled_file());

      const {stdioExpected, stdInToInject, stderrExpected, compilestderrExpected, extraArgs} = parse_file_for_expected_std(f);

      test(`it should return io that is expected: ${stdioExpected}`, () => {
        const args = [
                        "build/ts-compiler/pyret.js",
            "--build-runnable", f, 
            "--outfile", COMPILED_CODE_PATH, 
            "--builtin-js-dir", "src/js/trove", 
            "--builtin-arr-dir","src/arr/trove", 
            "--require-config","src/scripts/standalone-configA.json",
            "--compiled-dir", "tests/ts-compiled/"
          ].concat(extraArgs);
        cp.spawnSync("bash", ["-c", "rm -rf tests/ts-compiled/library-code* tests/ts-compiled/test-*"]);
        const compileProcess = cp.spawnSync(
          process.execPath, // same node that runs this suite (node>=22; see Makefile NODE_BIN)
          args,
          {stdio: "pipe", stderr: "pipe", timeout: COMPILER_TIMEOUT});
         
        function anywhere(s) {
          return new RegExp(".*" + s + ".*", "s");
        }
         
        if(compilestderrExpected === "") {
          assert.equal(compileProcess.stderr.toString(), EMPTY_MESSAGE);
          assert.equal(compileProcess.status, SUCCESS_EXIT_CODE);
        }
        else {
          assert.match(compileProcess.stderr.toString(), anywhere(compilestderrExpected));
          assert.notEqual(compileProcess.status, SUCCESS_EXIT_CODE);
          return; // Don't try to run the program if an error was expected
        }

        const runProcess = cp.spawnSync(
          process.execPath,
          [COMPILED_CODE_PATH],
          {input: stdInToInject, stdio: 'pipe', stderr: "pipe", timeout: RUN_TIMEOUT});

        if (stderrExpected !== EMPTY_MESSAGE) {
          assert.notEqual(runProcess.status, SUCCESS_EXIT_CODE);
          assert.match(runProcess.stderr.toString(), anywhere(stderrExpected));
        }
        else {
          assert.equal(runProcess.status, SUCCESS_EXIT_CODE);
          assert.match(runProcess.stdout.toString(), anywhere(stdioExpected));
        }
      });
    });
  });
});