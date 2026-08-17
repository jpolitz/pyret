const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleMsgs = [];
  page.on("console", m => consoleMsgs.push(m.type() + ": " + m.text()));
  page.on("pageerror", e => consoleMsgs.push("pageerror: " + e.message));
  await page.goto("http://localhost:8977/index.html");
  await page.waitForFunction(
    () => document.getElementById("out").textContent.includes("driver done") ||
          document.getElementById("out").textContent.includes("[page error]"),
    { timeout: 60000 }
  ).catch(() => {});
  const out = await page.evaluate(() => document.getElementById("out").textContent);
  console.log("=== PAGE OUTPUT ===");
  console.log(out);
  console.log("=== CONSOLE (first 15) ===");
  console.log(consoleMsgs.slice(0, 15).join("\n"));
  await browser.close();
})();
