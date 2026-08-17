/*
 * playwright-page.js
 *
 * A `page` adapter (see cpo-assertions.js) backed by a Playwright Frame -- the
 * frame that holds the CPO editor document (a top-level page, or the inner
 * iframe of a vscode webview). Implements inject/eval/waitFor by evaluating
 * JS strings in that frame.
 */
const { SOURCE } = require("./page-assertions");

function makePlaywrightPage(frame) {
  return {
    // Define window.PA in the frame (idempotent).
    async inject() {
      await frame.evaluate(SOURCE);
    },
    // Evaluate an expression string in the frame and return the JSON value.
    async eval(expr) {
      // Wrap so a bare expression (e.g. "window.PA.run()") is returned.
      return frame.evaluate(new Function("return (" + expr + ");"));
    },
    // Poll an expression until truthy or timeout (ms).
    async waitFor(expr, timeout) {
      await frame.waitForFunction(
        new Function("return !!(" + expr + ");"),
        undefined,
        { timeout: timeout || 30000, polling: 100 }
      );
    },
  };
}

module.exports = { makePlaywrightPage };
