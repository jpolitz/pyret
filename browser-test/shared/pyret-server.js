/*
 * pyret-server.js -- start/stop the companion `pyret.jarr -serve` process that
 * answers the browser extension's hover queries over a plain TCP WebSocket.
 *
 * This is the same server the desktop LSP forks; here we expose it on a TCP
 * port so a browser `WebSocket` (the web extension host is a Web Worker) can
 * reach it. `--port` accepts a number for TCP (as opposed to a unix socket).
 */
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

const COMPILER = path.resolve(
  __dirname, "..", "..", "lang", "build", "phaseA", "pyret.jarr",
);

// Start the server and resolve once it reports readiness over IPC.
function startPyretServer(port) {
  if (!fs.existsSync(COMPILER)) {
    return Promise.reject(new Error("compiler not found at " + COMPILER + " (run `make phaseA libA` in lang/)"));
  }
  return new Promise((resolve, reject) => {
    const child = cp.fork(COMPILER, ["-serve", "--port", String(port)], {
      stdio: [0, 1, 2, "ipc"],
      execArgv: ["-max-old-space-size=8192"],
    });
    let ready = false;
    child.on("message", (m) => {
      if (m && m.type === "success") {
        ready = true;
        resolve({
          port,
          stop() { try { child.kill(); } catch (_) { /* ignore */ } },
        });
      } else if (!ready) {
        reject(new Error("pyret server failed to start: " + JSON.stringify(m)));
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (!ready) reject(new Error(`pyret server exited early (code ${code}, signal ${signal})`));
    });
    setTimeout(() => { if (!ready) reject(new Error("pyret server start timed out")); }, 120000);
  });
}

module.exports = { startPyretServer, COMPILER };
