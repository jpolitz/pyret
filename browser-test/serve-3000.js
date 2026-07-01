#!/usr/bin/env node
/*
 * serve-3000.js -- one authenticated origin for the browser hover demo.
 *
 * The exe.dev proxy authenticates per host:port, and a background WebSocket
 * can't perform an interactive login redirect. So we expose EVERYTHING on a
 * single port (3000) that the user authenticates once:
 *
 *   http(s)://<vm>:3000/           -> VS Code for the Web  (internal :3001)
 *   ws(s)://<vm>:3000/pyret-hover  -> pyret.jarr -serve    (internal :5555)
 *
 * A tiny reverse proxy on :3000 forwards HTTP to VS Code Web and upgrades the
 * /pyret-hover path to the companion Pyret server. The demo workspace sets
 * `pyret-parley.hover.serverUrl` to wss://<vm>:3000/pyret-hover so the hover
 * WebSocket rides the same already-authenticated origin.
 *
 *   node serve-3000.js
 *   PORT=3000 WEB_PORT=3001 HOVER_PORT=5555 node serve-3000.js
 */
const path = require("path");
const http = require("http");
const httpProxy = require("http-proxy");
const { startPyretServer } = require("./shared/pyret-server");

// @vscode/test-web is a Koa app that builds every workbench resource URL (and
// the dev-extension scheme) from `ctx.protocol`. Koa returns "http" unless the
// socket is TLS or `app.proxy` is enabled -- neither holds behind our reverse
// proxy -- so the https page ends up with http:// resources (blocked as mixed
// content, and our extension fails to load). We can't reach test-web's Koa app
// to set `app.proxy`, so patch Koa's `protocol` getter to honor
// X-Forwarded-Proto, which our proxy sets to "https" below.
(() => {
  const koaRequest = require("koa/lib/request");
  const orig = Object.getOwnPropertyDescriptor(koaRequest, "protocol");
  Object.defineProperty(koaRequest, "protocol", {
    configurable: true,
    enumerable: orig.enumerable,
    get() {
      const xf = this.get("X-Forwarded-Proto");
      if (xf) return xf.split(/\s*,\s*/, 1)[0];
      return orig.get.call(this);
    },
  });
})();
const { open } = require("@vscode/test-web");

const PORT = parseInt(process.env.PORT || "3000", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "3001", 10);
const HOVER_PORT = parseInt(process.env.HOVER_PORT || "5555", 10);
const HOVER_PATH = "/pyret-hover";

const VSCODE_DIR = path.resolve(__dirname, "..", "vscode");
const WORKSPACE = path.resolve(__dirname, "vscode", "demo-workspace");

(async () => {
  const pyret = await startPyretServer(HOVER_PORT);
  console.log(`[serve] companion Pyret hover server on ws://localhost:${HOVER_PORT}`);

  await open({
    browserType: "none",          // server only; the user points their own browser at it
    extensionDevelopmentPath: VSCODE_DIR,
    folderPath: WORKSPACE,
    port: WEB_PORT,               // internal; fronted by our proxy on PORT
    host: "127.0.0.1",
    quality: "stable",
    esm: true,
    printServerLog: false,
  });
  console.log(`[serve] VS Code for the Web (internal) on http://127.0.0.1:${WEB_PORT}`);

  const webProxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${WEB_PORT}`,
    ws: true,
    selfHandleResponse: true, // so we can rewrite the workbench HTML (below)
  });
  const hoverProxy = httpProxy.createProxyServer({ target: `ws://127.0.0.1:${HOVER_PORT}`, ws: true, ignorePath: true });
  webProxy.on("error", (e) => console.error("[serve] web proxy error:", e.message));
  hoverProxy.on("error", (e) => console.error("[serve] hover proxy error:", e.message));
  webProxy.on("proxyReq", (proxyReq) => {
    // Tell test-web's Koa app the external scheme is https so it emits https://
    // URLs (see the koa/lib/request patch above); and identity encoding so we
    // can rewrite the HTML body without gunzipping.
    proxyReq.setHeader("X-Forwarded-Proto", "https");
    proxyReq.setHeader("Accept-Encoding", "identity");
  });

  // Rewrite the workbench HTML; stream everything else untouched.
  webProxy.on("proxyRes", (proxyRes, req, res) => {
    const isHtml = (proxyRes.headers["content-type"] || "").includes("text/html");
    if (!isHtml) {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }
    const chunks = [];
    proxyRes.on("data", (c) => chunks.push(c));
    proxyRes.on("end", () => {
      let body = Buffer.concat(chunks).toString("utf8");
      // The web-worker extension host + webviews load from
      // `webEndpointUrlTemplate` = https://{{uuid}}.<host>/... . That wildcard
      // subdomain resolves on *.localhost but NOT behind the exe.dev proxy (no
      // wildcard DNS), so the extension host never loads -> no extensions ->
      // ENOPRO on the workspace + forever-spinning Explorer. Make the endpoint
      // same-origin (drop the {{uuid}}. prefix); loses cross-origin webview
      // isolation, which we don't need for a single-user hover demo.
      body = body.replace(/\{\{uuid\}\}\./g, "");
      const headers = { ...proxyRes.headers };
      delete headers["content-length"];
      headers["content-length"] = Buffer.byteLength(body);
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(body);
    });
  });

  const server = http.createServer((req, res) => {
    // @vscode/test-web (ESM build) links the stylesheet as workbench.web.main.css
    // but the build only ships workbench.web.main.internal.css -> 404 -> unstyled
    // UI. Alias the request to the real file.
    if (req.url && req.url.includes("/workbench.web.main.css")) {
      req.url = req.url.replace("/workbench.web.main.css", "/workbench.web.main.internal.css");
    }
    webProxy.web(req, res);       // all plain HTTP -> VS Code Web
  });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url || "").startsWith(HOVER_PATH)) {
      hoverProxy.ws(req, socket, head);   // /pyret-hover -> companion Pyret server
    } else {
      webProxy.ws(req, socket, head);     // VS Code Web's own websockets
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[serve] listening on http://0.0.0.0:${PORT}`);
    console.log(`[serve] open the proxied URL, open hover-test.arr, hover e.g. not-zero.`);
    console.log(`[serve] hover WebSocket path: ${HOVER_PATH} (same origin -> :${HOVER_PORT})`);
  });

  const shutdown = () => { try { pyret.stop(); } catch (_) {} try { server.close(); } catch (_) {} process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})().catch((e) => { console.error("[serve] failed:", e); process.exit(1); });
