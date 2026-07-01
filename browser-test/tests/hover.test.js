/*
 * hover.test.js -- headless proof that hover works in the BROWSER extension.
 *
 * Boots VS Code for the Web with the vscode/ extension (envs/vscode-hover.js),
 * opens hover-test.arr as a Monaco text editor, hovers Pyret names, and asserts
 * the `.monaco-hover` tooltip shows the signature + docstring the extension got
 * from the companion `pyret.jarr -serve` over a WebSocket.
 *
 *   node --test tests/hover.test.js      (or: node run-hover.js)
 *
 * Mirrors the structure of drydock's tests/suite.test.js (node:test, one shared
 * session, before/after), but targets LSP-style hover instead of the CPO editor.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const WebSocket = require("ws");
const { startPyretServer } = require("../shared/pyret-server");

const PORT = 5555;
const FIXTURE = path.resolve(__dirname, "..", "vscode", "fixture-workspace", "hover-test.arr");

let server = null;
let session = null;

// Prime the server's compile cache with a direct query so the first in-browser
// hover doesn't pay the full ~compile latency inside Monaco's hover lifecycle.
function directHover(line, col) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:" + PORT);
    let done = false;
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({
      command: "query", query: "hover",
      compileOptions: JSON.stringify({ program: FIXTURE, "base-dir": "." }),
      queryOptions: JSON.stringify({ line, col }),
    })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "echo-err" || m.type === "echo-log") return;
      done = true; ws.close(); resolve(m);
    });
    ws.on("close", () => { if (!done) resolve(null); });
  });
}

// Deterministically place the cursor at (line, col) with Go-to-Line, invoke the
// "Show Hover" command, and wait for the hover tooltip to contain `needle`.
// Returns the tooltip's rendered text.
//
// Notes on why it's done this way (learned the hard way):
//  - Headless mouse-hover does not reliably make Monaco *request* a content
//    hover, so we trigger it explicitly with the Show Hover keybinding.
//  - Monaco recycles `.view-line` DOM nodes across scroll, so a cached element
//    handle goes stale; Go-to-Line (Ctrl+G "line:col") is position-exact.
async function hoverAt(page, line, col, needle) {
  // Dismiss any open widget and focus the editor, then wait until the previous
  // hover's content is actually gone (else waitForFunction below can match the
  // prior token's leftover text and assert against stale content).
  await page.keyboard.press("Escape");
  await page.mouse.click(400, 300).catch(() => {});
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => {
      const c = document.querySelector(".monaco-hover-content");
      return !c || !(c.innerText || "").trim();
    }, undefined, { timeout: 6000, polling: 100 })
    .catch(() => {});

  await page.keyboard.press("Control+G");
  await page.waitForTimeout(400);
  await page.keyboard.type(`${line}:${col}`);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+K");
  await page.keyboard.press("Control+I");

  await page.waitForFunction(
    (n) => {
      const c = document.querySelector(".monaco-hover-content");
      return !!c && (c.innerText || "").includes(n);
    },
    needle,
    { timeout: 40000, polling: 150 },
  );
  const text = await page.evaluate(
    () => (document.querySelector(".monaco-hover-content") || {}).innerText || "",
  );
  await page.keyboard.press("Escape"); // dismiss for the next case
  await page.waitForTimeout(200);
  return text;
}

before(async () => {
  server = await startPyretServer(PORT);
  // Warm the compile cache (also a sanity check the server answers over TCP WS).
  const warm = await directHover(11, 3);
  assert.equal(warm && warm.type, "hover-success", "companion server should answer hover over WebSocket");
  assert.equal(warm.name, "not-zero");

  const { setup, label } = require("../envs/vscode-hover");
  console.log("environment: " + label);
  session = await setup();
}, { timeout: 300000 });

after(async () => {
  if (session) await session.cleanup();
  if (server) server.stop();
});

// Standalone reference lines in hover-test.arr (1-based), col 3 lands in-token.
// The `needle` is the identifier name so waitForFunction can't latch onto a
// previous token's leftover hover text.
test("hover on an annotated, documented function (not-zero)", { timeout: 90000 }, async () => {
  const text = await hoverAt(session.page, 11, 3, "not-zero");
  assert.match(text, /not-zero\s*::/, "shows the name + signature");
  assert.match(text, /\(n :: Number\) -> Boolean/, "shows the full annotation");
  assert.match(text, /nonzero/, "shows the docstring");
});

test("hover renders a refinement-typed signature (div-refine)", { timeout: 90000 }, async () => {
  const text = await hoverAt(session.page, 26, 3, "div-refine");
  assert.match(text, /div-refine\s*::/);
  assert.match(text, /not-zero/, "refinement annotation Number%(~not-zero) is shown");
  assert.match(text, /divides the things/, "shows the docstring");
});

test("hover on a documented function without an annotation (doc-no-ann)", { timeout: 90000 }, async () => {
  const text = await hoverAt(session.page, 18, 3, "hi mom");
  assert.match(text, /hi mom/, "shows the docstring even with an inferred/blank annotation");
});
