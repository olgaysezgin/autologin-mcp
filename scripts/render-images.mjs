// Renders the PNG assets of the website from docs/assets/logo.svg and scripts/og-image.html.
// Usage: node scripts/render-images.mjs   (needs Google Chrome, or set CHROME_PATH)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'docs', 'assets');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const executablePath = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!executablePath) throw new Error('Google Chrome not found; set CHROME_PATH.');

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage();
  const logo = pathToFileURL(path.join(assets, 'logo.svg')).href;
  for (const size of [512, 180]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.goto(logo); // an SVG without width/height fills the viewport
    const file = size === 180 ? 'apple-touch-icon.png' : `logo-${size}.png`;
    await page.screenshot({ path: path.join(assets, file), omitBackground: true });
    console.log(`wrote docs/assets/${file}`);
  }
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(root, 'scripts', 'og-image.html')).href, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.images[0]?.complete);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(assets, 'og-image.png') });
  console.log('wrote docs/assets/og-image.png');
} finally {
  await browser.close();
}
