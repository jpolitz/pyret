/*
 * Scratch smoke test for --env=vscode-ovsx, independent of the full node:test
 * suite (which pulls specs from code.pyret.org/test). Boots the env, injects PA,
 * waits editorReady, warms up, runs one check program, prints the result.
 *
 *   OVSX_ASSET_ROOT=/path/to/dist/web/build/web [OVSX_FAITHFUL=1] node smoke-ovsx.js
 */
const { setup, label } = require("./envs/vscode-ovsx");
const { makePlaywrightPage } = require("./shared/playwright-page");
const { warmUp, checkAllTestsPassed } = require("./shared/cpo-assertions");

(async () => {
  console.log("env:", label);
  let session;
  try {
    session = await setup();
  } catch (e) {
    console.log("RED (setup failed):", e.name + ":", e.message);
    process.exit(1);
  }
  try {
    const page = makePlaywrightPage(session.frame);
    await page.inject();
    console.log("frame found, PA injected; waiting for editorReady...");
    await page.waitFor("window.PA.editorReady()", 120000);
    console.log("editorReady OK; warming up runtime...");
    await warmUp(page);
    console.log("warmUp OK; running a check-block program...");
    await page.eval('window.PA.setDefinitions("check:\\n  2 + 2 is 4\\nend")');
    await page.eval("window.PA.clearOutput()");
    await page.eval("window.PA.run()");
    await page.waitFor("window.PA.breakDone()", 60000);
    await page.waitFor("window.PA.doneRendering()", 60000);
    await page.inject();
    await checkAllTestsPassed(page, "smoke", 20000);
    console.log("GREEN: editor booted and 'Looks shipshape'.");
  } catch (e) {
    console.log("RED (run failed):", e.name + ":", e.message);
    process.exitCode = 1;
  } finally {
    if (session) await session.cleanup();
  }
})();
