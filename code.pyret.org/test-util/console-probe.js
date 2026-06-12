// Diagnostic: load /editor in headless Chrome, optionally run a REPL expression,
// and dump the browser console + loader/output state. Used to debug the
// promise-backend standalone bring-up and the REPL run/render path.
//   BASE_URL=http://localhost:5999 node test-util/console-probe.js [waitMs] [EVAL_EXPR]
const webdriver = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
if (process.env.CHROMEDRIVER_BINARY) {
  chrome.setDefaultService(new chrome.ServiceBuilder(process.env.CHROMEDRIVER_BINARY).build());
}
const caps = webdriver.Capabilities.chrome();
caps.set('chromeOptions', { args: ['--headless', '--no-sandbox'] });
caps.set('loggingPrefs', { browser: 'ALL' });
caps.set('goog:loggingPrefs', { browser: 'ALL' });
const base = process.env.BASE_URL || 'http://localhost:5999';
const waitMs = parseInt(process.argv[2] || '20000', 10);
const evalExpr = process.argv[3] || process.env.EVAL_EXPR || null;

function dumpLogs(driver, label) {
  return driver.manage().logs().get('browser').then(function (logs) {
    console.log('=== BROWSER CONSOLE ' + label + ' (' + logs.length + ') ===');
    logs.forEach(function (e) { console.log('[' + e.level.name + '] ' + String(e.message).slice(0, 1500)); });
  }, function (e) { console.log('(log API error: ' + e.message + ')'); });
}

(async () => {
  const driver = new webdriver.Builder().forBrowser('chrome').withCapabilities(caps).build();
  try {
    await driver.get(base + '/editor');
    await driver.sleep(waitMs);
    const loader = await driver.executeScript(
      "var l=document.getElementById('loader'); return l? getComputedStyle(l).display : 'NO #loader';");
    console.log('BASE_URL:', base, '| #loader display:', loader, '(none = Pyret loaded)');
    await dumpLogs(driver, 'after-load');

    if (evalExpr) {
      console.log('\n>>> EVAL: ' + evalExpr);
      // mirror test-util/util.js evalPyret: set the repl-prompt CodeMirror, press Enter
      const escaped = escape(evalExpr);
      await driver.executeScript(
        "var CM=$('.repl-prompt > .CodeMirror')[0].CodeMirror;" +
        "CM.replaceRange(unescape('" + escaped + "'), {line:CM.firstLine(),ch:0}, {line:CM.lastLine()+1,ch:0});");
      await driver.executeScript(
        "(function(cm){cm.options.extraKeys.Enter(cm);})($('.repl-prompt > .CodeMirror')[0].CodeMirror)");
      await driver.sleep(6000);
      const out = await driver.executeScript(
        "var o=document.getElementById('output'); return o? o.innerText.slice(0,1500) : 'NO #output';");
      console.log('--- #output innerText ---\n' + out);
      await dumpLogs(driver, 'after-eval');
    }
  } finally {
    await driver.quit();
  }
})().catch(function (e) { console.error('PROBE ERROR:', e); process.exit(1); });
