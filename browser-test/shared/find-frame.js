/*
 * find-frame.js -- locate the Playwright frame that holds the CPO editor DOM.
 *
 * The same editor (#runButton, #output, .CodeMirror, ...) shows up as:
 *   - the main frame on code.pyret.org's /editor page,
 *   - the #embed1 child iframe of the embed host page,
 *   - the webview content frame of the vscode custom editor.
 * In every case the distinguishing marker is a #runButton, so one helper finds
 * the editor frame for all three environments.
 */
async function findEditorFrame(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 120000);
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if (await frame.evaluate(() => !!document.getElementById("runButton"))) {
          return frame;
        }
      } catch (e) {
        // frame detached / navigated mid-check; ignore and retry
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("editor frame (#runButton) not found within timeout");
}

module.exports = { findEditorFrame };
