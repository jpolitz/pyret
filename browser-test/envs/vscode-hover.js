/*
 * vscode-hover.js -- environment adapter for the browser hover feature.
 *
 * Adapted from drydock's browser-test/envs/vscode.js. Boots real VS Code for
 * the Web (headless, @vscode/test-web "server only") with the vscode/ extension
 * loaded as a dev extension over the hover fixture workspace, drives it with
 * Playwright to open hover-test.arr as a TEXT editor (Monaco) -- not the CPO
 * webview -- and returns the page so a test can hover a name and read the
 * resulting `.monaco-hover` tooltip.
 *
 * The workspace's .vscode/settings.json forces `*.arr` to the default (text)
 * editor and points `pyret-parley.hover.*` at the companion Pyret server.
 */
const path = require("path");
const { open } = require("@vscode/test-web");
const { launchChromium } = require("../shared/browser");

const VSCODE_DIR = path.resolve(__dirname, "..", "..", "vscode");
const WORKSPACE = path.resolve(__dirname, "..", "vscode", "fixture-workspace");
const PORT = parseInt(process.env.VSCODE_TEST_PORT || "3199", 10);

async function setup() {
  const server = await open({
    browserType: "none",
    extensionDevelopmentPath: VSCODE_DIR,
    folderPath: WORKSPACE,
    port: PORT,
    quality: "stable",
    esm: true,
    printServerLog: false,
  });
  const endpoint = "http://localhost:" + PORT;

  const browser = await launchChromium();
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  await page.goto(endpoint, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 120000 });
  await page.waitForTimeout(4000);

  // Open hover-test.arr from the Explorer (Quick Open doesn't index the
  // in-memory test FS, but the Explorer tree does). With the workspace
  // settings forcing the default editor, this opens Monaco, not the webview.
  await page.keyboard.press("Control+Shift+E");
  await page.waitForTimeout(2000);
  const clicked = await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll(".monaco-list-row"))
      .find((x) => /hover-test\.arr/.test(x.getAttribute("aria-label") || x.textContent || ""));
    if (r) { r.scrollIntoView(); r.click(); r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true; }
    return false;
  });
  if (!clicked) throw new Error("could not find hover-test.arr in the VS Code Explorer");

  // Wait for the Monaco text editor to render the file's content.
  await page.waitForFunction(() => {
    const lines = Array.from(document.querySelectorAll(".view-line"));
    return lines.some((l) => (l.textContent || "").includes("not-zero"));
  }, undefined, { timeout: 60000, polling: 200 });

  return {
    page,
    cleanup: async () => { await browser.close(); server.dispose(); },
  };
}

module.exports = { setup, label: "vscode browser hover (Monaco + companion pyret server)" };
