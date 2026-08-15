// brand-frames.js — wrap each raw terminal frame in the glamor-card.html brand
// frame (same wordmark/tagline/version/window chrome as og-demo.png), producing
// 1200x630 branded frames ready for ffmpeg. So the animation resolves into the
// exact static social card.
//
//   node brand-frames.js <raw-frames-dir> <out-dir> [version] [node]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FRAMES = path.resolve(process.argv[2] || 'anim-frames');
const OUT = path.resolve(process.argv[3] || 'anim-card-frames');
const VER = process.argv[4] || 'V0.4-4';
const NODE = process.argv[5] || 'OVMX';
const CARD = 'file://' + path.resolve(__dirname, 'glamor-card.html');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'], executablePath: process.env.CHROME_BIN || undefined });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })).newPage();
  await page.goto(CARD, { waitUntil: 'load' });
  await page.evaluate(({ ver, node }) => {
    document.getElementById('ver').textContent = ver;
    document.getElementById('node').textContent = node;
  }, { ver: VER, node: NODE });

  const files = fs.readdirSync(FRAMES).filter((f) => f.endsWith('.png')).sort();
  for (let i = 0; i < files.length; i++) {
    const uri = 'data:image/png;base64,' + fs.readFileSync(path.join(FRAMES, files[i])).toString('base64');
    await page.evaluate((uri) => new Promise((r) => { const img = document.getElementById('shot'); img.onload = r; img.src = uri; }), uri);
    await page.screenshot({ path: path.join(OUT, `b${String(i).padStart(4, '0')}.png`) });
  }
  console.log('branded ' + files.length + ' frames -> ' + OUT);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
