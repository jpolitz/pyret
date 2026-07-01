/*
 * browser.js -- one place to launch headless Chromium for the env adapters.
 *
 * If GOOGLE_CHROME_BINARY is set, use that Chrome build; otherwise fall back to
 * Playwright's bundled Chromium (`npx playwright install chromium`). This keeps
 * local runs (system Chrome) and CI (Playwright's Chromium) both working without
 * per-env duplication.
 */
const { chromium } = require("playwright");

async function launchChromium() {
  const opts = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (process.env.GOOGLE_CHROME_BINARY) {
    opts.executablePath = process.env.GOOGLE_CHROME_BINARY;
  }
  return chromium.launch(opts);
}

module.exports = { launchChromium };
