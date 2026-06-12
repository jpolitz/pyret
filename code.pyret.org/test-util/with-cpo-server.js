#!/usr/bin/env node
// Run the CPO selenium (mocha) suite against a throwaway, localhost-configured
// server that this script starts on a free port and shuts down afterward.
//
// Why: the in-VM headless Chrome that mocha drives can only reach localhost. A
// server started with a public BASE_URL (e.g. a live demo) bakes that public host
// into the served editor page, so the editor's assets/jarr become unreachable from
// the test browser and every spec times out. Owning an ephemeral localhost server
// makes the tests immune to whatever BASE_URL the dev/demo .env happens to use.
//
// Usage (run from code.pyret.org/, with base .env loaded for CHROMEDRIVER_BINARY etc.):
//   node -r dotenv/config test-util/with-cpo-server.js <promise|cont> [mocha args...]
// See package.json `mocha-promise` / `mocha-cont`.

const { spawn } = require("child_process");
const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");

const backend = process.argv[2];
if (backend !== "promise" && backend !== "cont") {
  console.error("usage: with-cpo-server.js <promise|cont> [mocha args...]");
  process.exit(2);
}
const mochaArgs = process.argv.slice(3);
const jarr = backend === "promise" ? "cpo-main-promise.jarr" : "cpo-main.jarr";
const jarrPath = path.join("build", "web", "js", jarr);
if (!fs.existsSync(jarrPath)) {
  console.error(`[with-cpo-server] missing ${jarrPath} — build it first: ` +
    `make ${backend === "promise" ? "web-promise" : "web"}`);
  process.exit(2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get({ host: "127.0.0.1", port, path: "/editor", timeout: 4000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) { resolve(); } else { retry(); }
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
      function retry() {
        if (Date.now() > deadline) { reject(new Error("server did not become ready within " + timeoutMs + "ms")); }
        else { setTimeout(poll, 500); }
      }
    })();
  });
}

let server = null;
let shuttingDown = false;
function shutdown() {
  if (shuttingDown || !server) { return; }
  shuttingDown = true;
  try { process.kill(-server.pid, "SIGTERM"); }     // kill the detached process group
  catch (e) { try { server.kill("SIGTERM"); } catch (e2) { /* already gone */ } }
}
process.on("SIGINT", () => { shutdown(); process.exit(130); });
process.on("SIGTERM", () => { shutdown(); process.exit(143); });
process.on("exit", shutdown);

(async () => {
  const port = await freePort();
  const base = "http://localhost:" + port;
  const serverEnv = Object.assign({}, process.env, {
    PORT: String(port),
    BASE_URL: base,
    PYRET: base + "/js/" + jarr,
  });
  console.log(`[with-cpo-server] starting ${backend} server on ${base} (PYRET=/js/${jarr})`);
  server = spawn(process.execPath, ["src/run.js"], {
    env: serverEnv,
    stdio: ["ignore", "ignore", "inherit"],   // surface server errors, hide its chatter
    detached: true,
  });
  server.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[with-cpo-server] server exited early (code ${code}) before tests finished`);
      process.exit(1);
    }
  });

  try {
    await waitForServer(port, 90000);
  } catch (e) {
    console.error("[with-cpo-server] " + e.message);
    shutdown();
    process.exit(1);
  }
  console.log(`[with-cpo-server] server ready; running mocha against ${base}`);

  const mochaBin = require.resolve("mocha/bin/mocha");
  const mocha = spawn(process.execPath, [mochaBin, ...mochaArgs], {
    env: Object.assign({}, process.env, { BASE_URL: base }),
    stdio: "inherit",
  });
  mocha.on("exit", (code) => {
    shutdown();
    process.exit(code === null ? 1 : code);
  });
})().catch((e) => { console.error(e); shutdown(); process.exit(1); });
