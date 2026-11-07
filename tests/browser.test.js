'use strict';
/* End-to-end run in a real Chromium: the built site (dist/) served by serve.js, with
   generated test images from a small local server. It covers what jsdom cannot:
   the Content-Security-Policy actually being enforced, real IntersectionObserver paging,
   real focus handling, chunk files fetched under their hashed names, and a clean console.

   Not part of `npm test` because it needs a browser:
       npm i --no-save playwright && npx playwright install chromium
       npm run build && npm run test:browser
   Without Playwright it prints a notice and exits 0. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.log('SKIPPED: Playwright is not installed (see the comment at the top of this file).'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ is missing: run `npm run build` first.');
  process.exit(2);
}

/* ── generated fixtures: a valid PNG of any size/colour, no files needed ── */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, r, g, b) {
  const row = Buffer.alloc(w * 3 + 1);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
/* a 160x90, half-second VP8 clip (3 KB), so a video card can be tested without any file */
const WEBM = Buffer.from('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', 'base64');
const fixtures = http.createServer((req, res) => {
  if (/^\/vid\/clip\.webm/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': WEBM.length, 'Cache-Control': 'no-store' });
    res.end(WEBM); return;
  }
  const big = /^\/big\/(\d+)x(\d+)\.png/.exec(req.url);          /* a picture of any size: /big/1200x800.png */
  if (big) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(png(Number(big[1]), Number(big[2]), 90, 140, 200)); return;
  }
  const m = /^\/img\/(\d+)\.png/.exec(req.url);
  if (!m) { res.writeHead(404); res.end('nope'); return; }
  const n = Number(m[1]);
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  res.end(png(160, 100, (n * 37) % 256, (n * 91) % 256, (n * 53) % 256));
});

function startSite() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'serve.js'), 'dist', '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /:(\d+)\s*$/m.exec(out); if (m) resolve({ child, port: Number(m[1]) }); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => reject(new Error('serve.js exited (' + c + '): ' + out)));
    setTimeout(() => reject(new Error('serve.js did not start')), 8000);
  });
}

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n' + name); }

(async () => {
  await new Promise((r) => fixtures.listen(0, '127.0.0.1', r));
  const FX = 'http://127.0.0.1:' + fixtures.address().port;
  const { child, port } = await startSite();
  const BASE = 'http://127.0.0.1:' + port + '/';
  const browser = await chromium.launch();
  let exit = 0;
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const problems = [], requests = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('request', (r) => requests.push(r.url()));
    const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });
    const img = (n) => FX + '/img/' + n + '.png';
    const many = (n, tag) => Array.from({ length: n }, (_, i) => img(i % 40) + '?' + tag + i);

    section('FIRST VISIT');
    await page.goto(BASE, { waitUntil: 'load' });
    ok(await page.isVisible('#consentBanner'), 'consent banner is shown');
    ok((await page.evaluate(() => localStorage.length)) === 0, 'nothing is stored before a choice');
    ok(!requests.some((u) => /\/chunks\//.test(u)), 'no chunk is fetched for the first paint');
    ok(await page.evaluate(() => document.activeElement === document.body), 'the banner does not steal focus');
    const bg = await page.evaluate(() => getComputedStyle(document.body, '::after').backgroundImage);
    ok(/image-set|url\(/.test(bg) && /bg-1920/.test(bg), 'the wallpaper (AVIF/WebP, content-hashed) is applied', bg.slice(0, 120));

    section('CONSENT');
    await page.click('#themeToggleLabel');
    ok((await page.getAttribute('html', 'data-theme')) === 'moon' && (await page.evaluate(() => localStorage.getItem('bv-theme'))) === null, 'theme switches, and is not stored yet');
    await page.click('#consentAllow');
    ok(!(await page.isVisible('#consentBanner')) && (await page.evaluate(() => localStorage.getItem('bv-theme'))) === 'moon', 'Allow stores the theme and closes the banner');
    await page.reload({ waitUntil: 'load' });
    ok((await page.getAttribute('html', 'data-theme')) === 'moon' && !(await page.isVisible('#consentBanner')), 'theme is restored, banner stays closed');
    await page.click('#themeToggleLabel');

    section('LOADING MEDIA');
    requests.length = 0;
    await page.fill('#bulkArea', many(8, 'a').concat([FX + '/img/missing.png']).join('\n'));
    await wait(() => document.getElementById('bulkTally').textContent.trim() === '9 URLs');
    await page.click('#bulkLoadBtn');
    await wait(() => document.querySelectorAll('img.card-img').length === 8 && document.querySelectorAll('.card-err').length === 1);
    ok((await page.evaluate(() => Array.from(document.querySelectorAll('img.card-img')).filter((i) => i.naturalWidth > 0).length)) === 8, '8 images decode, the missing one ends as a failed card');
    ok(await page.evaluate(() => Array.from(document.querySelectorAll('img.card-img')).every((i) => i.alt && i.alt.length > 2)), 'every image has alt text');
    ok(requests.some((u) => /\/chunks\/video-card\.[0-9a-f]{10}\.js$/.test(u)), 'the missing image tried the other format, which fetched chunks/video-card.<hash>.js (allowed by the CSP)', requests.filter((u) => /chunks/.test(u)));
    ok(!requests.some((u) => /edit-mode|common-notes|retry-failed/.test(u)), 'no unused chunk was fetched');
    ok(await page.evaluate(() => document.querySelectorAll('.card-pending').length === 0), 'no loading placeholder is left behind');

    section('A VIDEO LINK THAT CANNOT BE PLAYED');
    await page.click('#appendMode');
    await page.fill('#bulkArea', FX + '/vid/none.mp4');
    await page.click('#bulkLoadBtn');
    await wait(() => document.querySelectorAll('.card-err').length === 2);
    ok((await page.locator('.card-err small').last().textContent()) === FX + '/vid/none.mp4', 'it ends as a failed card that shows the link');
    await page.click('#appendMode');

    section('EDIT PANEL');
    const edit = page.locator('.card .tedit').first();
    await edit.focus(); await edit.click();
    await page.waitForSelector('#editPanel.visible');
    ok((await page.evaluate(() => document.activeElement.id)) === 'epBrightness', 'focus moves into the panel');
    await page.keyboard.press('ArrowRight');
    ok((await page.textContent('#epBrightnessVal')) === '101%', 'sliders work from the keyboard');
    await page.keyboard.press('Escape');
    await wait(() => !document.getElementById('editPanel').classList.contains('visible'));
    ok(await page.evaluate(() => document.activeElement.classList.contains('tedit')), 'Esc closes it and focus returns to Edit');
    await wait(() => getComputedStyle(document.getElementById('editPanel')).visibility === 'hidden');   // after its slide-out transition
    ok(true, 'the closed panel ends up visibility:hidden, so it is out of the tab order and the accessibility tree');

    section('A TURNED PICTURE AND THE EDIT BAR');
    /* Turning a picture in Edit mode must not clip it, let it spill out of its card or over the card's own
       buttons, and the Edit bar (along the bottom of the window) must not hide the card being edited. */
    await page.fill('#bulkArea', [FX + '/big/1200x800.png?t0', FX + '/vid/clip.webm', FX + '/big/800x1200.png?t2'].join('\n'));
    await page.click('#bulkLoadBtn');
    await wait(() => document.querySelectorAll('img.card-img').length === 2 && document.querySelectorAll('video.card-video').length === 1);
    const setRange = (id, v) => page.evaluate(([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, [id, v]);
    const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    /* Wait until card i has stopped moving (a picture finishing its layout, the page finishing a scroll), as a person would. */
    const calm = async (i) => {
      let last = '', same = 0;
      for (let n = 0; n < 50 && same < 3; n++) {
        const now = await page.evaluate((i) => { const r = document.querySelectorAll('#gallery .vslot')[i].querySelector('.card').getBoundingClientRect(); return [r.top, r.bottom, scrollY].map(Math.round).join(','); }, i);
        same = now === last ? same + 1 : 0; last = now;
        await page.waitForTimeout(40);
      }
    };
    const layout = (i) => page.evaluate((i) => {
      const card = document.querySelectorAll('#gallery .vslot')[i].querySelector('.card');
      const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      const bar = document.getElementById('editPanel');
      const buttons = Array.from(card.querySelectorAll('.card-toolbar button')).map((b) => {
        const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (y < 0 || y > innerHeight) return { name: b.textContent.trim(), reachable: null };     /* scrolled out of the window: nothing covers it */
        const hit = document.elementFromPoint(x, y);
        const who = hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\s+/).join('.') : '') : 'nothing';
        return { name: b.textContent.trim(), reachable: !!hit && (hit === b || b.contains(hit)), by: who };
      });
      return { box: R(card.querySelector('.card-img-box')), media: R(card.querySelector('img.card-img, video.card-video')), card: R(card),
               bar: bar && bar.classList.contains('visible') ? R(bar) : null, top: R(document.getElementById('topbar')).b, buttons };
    }, i);
    const judge = (g, editing) => {
      const t = 1.5, bad = [], m = g.media, b = g.box;
      if (m.l < b.l - t || m.r > b.r + t || m.t < b.t - t || m.b > b.b + t) bad.push('the picture leaves its box');
      const covered = g.buttons.filter((x) => x.reachable === false);
      if (covered.length) bad.push('covered card buttons: ' + covered.map((x) => x.name).join(', ') + ' by ' + covered[0].by);
      if (editing) {
        if (!g.bar) bad.push('the Edit bar is not open');
        else {
          const top = Math.max(0, g.top);                                  /* a phone-sized window lets the top bar scroll away while editing */
          if (g.bar.t - top >= 360 && (g.card.b > g.bar.t + t || g.card.t < top - t)) bad.push('the card is not fully above the Edit bar (card ' + Math.round(g.card.t) + '–' + Math.round(g.card.b) + ', bar starts at ' + Math.round(g.bar.t) + ', top bar ends at ' + Math.round(g.top) + ')');
        }
      }
      return bad;
    };
    const wrongEditing = [], wrongDone = [];
    for (const [sizeName, sizeVal] of [['Medium', 3], ['1/Screen', 7], ['Max', 10]]) {
      await setRange('sizer', sizeVal); await frames();
      for (let i = 0; i < 3; i++) {
        for (const angle of [90, 45]) {
          const tag = sizeName + ', ' + (i === 1 ? 'video' : 'image ' + (i + 1)) + ', ' + angle + '°';
          await page.locator('#gallery .vslot').nth(i).locator('.tedit').click();
          await page.waitForSelector('#editPanel.visible');
          await setRange('epRotate', angle); await calm(i);
          judge(await layout(i), true).forEach((p) => wrongEditing.push(tag + ': ' + p));
          await page.click('#epDone'); await calm(i);
          judge(await layout(i), false).forEach((p) => wrongDone.push(tag + ': ' + p));
        }
      }
    }
    ok(wrongEditing.length === 0, 'while editing: a turned image or video (3 sizes, 90° and 45°) stays inside its box, no card button is covered, the whole card is above the Edit bar', wrongEditing.slice(0, 4));
    ok(wrongDone.length === 0, 'after Done: it still stays inside its box and every card button (Copy Link, Edit, Note, Remove) is reachable', wrongDone.slice(0, 4));

    section('MORE EDIT BAR CASES');
    await setRange('sizer', 3); await frames();
    await page.locator('#gallery .vslot').nth(0).locator('.tedit').click();
    await page.waitForSelector('#editPanel.visible');
    await page.locator('#gallery .vslot').nth(2).locator('.tedit').click();
    await wait(() => { const s = document.querySelectorAll('#gallery .vslot'); return s[2].querySelector('.card.editing') && document.querySelectorAll('#gallery .card.editing').length === 1; });
    await calm(2);
    ok(judge(await layout(2), true).length === 0, 'pressing Edit on another card moves the bar to it: that card is fully above the bar', judge(await layout(2), true));
    ok((await page.evaluate(() => document.activeElement.id)) === 'epBrightness', 'and focus is in the bar');
    await page.setViewportSize({ width: 900, height: 700 }); await calm(2);
    ok(judge(await layout(2), true).length === 0, 'making the window smaller while editing keeps the card above the bar', judge(await layout(2), true));
    await page.setViewportSize({ width: 1440, height: 900 }); await frames();
    await page.keyboard.press('Escape');
    await wait(() => !document.getElementById('editPanel').classList.contains('visible'));
    ok(await page.evaluate(() => getComputedStyle(document.body).paddingBottom === '0px' && !document.querySelector('.card.editing') && !document.querySelector('.card-img[style*="max-height: 0"]')), 'Esc closes the bar: the page gets its bottom room back and no card is left in edit mode');
    await page.evaluate(() => window.scrollTo(0, 0));

    section('EDITING ON A PHONE');
    /* A phone-sized window: the bar is compact and the top bar scrolls away while editing, so the picture keeps most of the screen. */
    await page.setViewportSize({ width: 390, height: 800 }); await frames(); await frames();
    await setRange('sizer', 7); await frames();
    await page.locator('#gallery .vslot').nth(0).locator('.tedit').click();
    await page.waitForSelector('#editPanel.visible');
    await setRange('epRotate', 91); await calm(0);
    const onPhone = await layout(0);
    ok(judge(onPhone, true).length === 0 && onPhone.card.t >= -1.5, 'the whole card (picture, link, Copy Link / Edit / Note / Remove) is above the Edit bar', judge(onPhone, true));
    ok(onPhone.bar && onPhone.bar.b - onPhone.bar.t <= 340, 'the bar is compact (' + (onPhone.bar ? Math.round(onPhone.bar.b - onPhone.bar.t) : '?') + 'px of an 800px screen)');
    ok(onPhone.media.b - onPhone.media.t >= 220, 'the picture keeps a usable height (' + Math.round(onPhone.media.b - onPhone.media.t) + 'px)');
    await page.click('#epDone'); await calm(0);
    const afterPhone = await layout(0);
    ok(judge(afterPhone, false).length === 0 && afterPhone.card.t >= afterPhone.top - 1.5, 'after Done the top bar is back and does not sit on the card: its top shows', judge(afterPhone, false));
    await page.setViewportSize({ width: 1440, height: 900 }); await frames();
    await page.evaluate(() => window.scrollTo(0, 0));

    section('COMMON NOTES');
    await page.click('#commonNotesBtn');
    await page.waitForSelector('dialog.cn-dialog[open]');
    await page.keyboard.type('a b');
    ok((await page.inputValue('#cnTextarea')) === 'a b', 'Space types a space in the notes box');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    ok(await page.evaluate(() => !!document.activeElement.closest('dialog')), 'focus stays inside the dialog');
    await page.keyboard.press('Escape');
    await wait(() => !document.querySelector('dialog.cn-dialog[open]'));
    ok((await page.evaluate(() => document.activeElement.id)) === 'commonNotesBtn', 'Esc closes it and focus returns to the button');

    section('KEYBOARD');
    await page.focus('#pauseAllBtn');
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Space');
    await wait(() => /video/i.test(document.getElementById('statusMsg').textContent));
    ok(true, 'Space presses the focused Pause All button');
    const countBefore = await page.locator('#gallery .vslot').count();
    const remove = page.locator('.card .tremove').first();
    await remove.focus(); await page.keyboard.press('Enter');
    await wait((n) => document.querySelectorAll('#gallery .vslot').length === n, countBefore - 1);
    ok(await page.evaluate(() => !!document.activeElement.closest('.card-toolbar')), 'after Remove, focus lands on the next card');

    section('PAGING (real IntersectionObserver)');
    await page.fill('#bulkArea', many(260, 'p').join('\n'));
    await page.click('#bulkLoadBtn');
    await wait(() => document.querySelectorAll('#gallery .vslot').length === 100);
    ok((await page.textContent('#gCount')) === '260' && (await page.textContent('#galleryMoreText')).indexOf('100 of 260') > -1, 'first page is 100 of 260');
    ok((await page.evaluate(() => document.querySelectorAll('#gallery .vslot.is-active').length)) < 60, 'only a window of slots holds live media');
    await page.click('#loadMoreBtn');
    ok((await page.locator('#gallery .vslot').count()) === 200, 'Load more adds 100');
    await page.fill('#bulkArea', many(260, 'q').join('\n'));
    await page.click('#bulkLoadBtn');
    await wait(() => document.querySelectorAll('#gallery .vslot').length === 100);
    for (let i = 0; i < 40 && (await page.locator('#gallery .vslot').count()) < 200; i++) { await page.mouse.wheel(0, 8000); await page.waitForTimeout(120); }
    ok((await page.locator('#gallery .vslot').count()) > 100, 'scrolling pulls in the next page by itself');

    section('KEYBOARD AFTER THE MOUSE');
    /* A control that kept focus after a mouse click must not take the page keys away. */
    await page.evaluate(() => { window.scrollTo(0, 0); window.__space = []; window.addEventListener('keydown', (e) => { if (e.code === 'Space') window.__space.push(e.defaultPrevented); }); });
    await page.locator('label:has(#zoomEnabled)').click();
    ok(await page.evaluate(() => document.activeElement.id) === 'zoomEnabled', 'a click on the Zoom switch leaves focus on it');
    await page.keyboard.down('s'); await page.waitForTimeout(400); await page.keyboard.up('s');
    ok((await page.evaluate(() => window.scrollY)) > 30, 'the S shortcut still scrolls the page right after that click');
    await page.keyboard.press('Space');
    ok(await page.evaluate(() => window.__space[0] === true), 'Space is still the page key there (it does not flip the switch again)');
    await page.locator('label:has(#zoomEnabled)').click();                       /* back to off */
    await page.click('#pauseAllBtn');                                            /* mouse */
    await page.keyboard.press('Space');
    ok(await page.evaluate(() => window.__space[1] === true), 'Space right after a mouse click on a button is still the page key');
    await page.focus('#pauseAllBtn'); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Space');
    ok(await page.evaluate(() => window.__space[2] === false), 'after Tab it presses the focused button instead');
    await page.evaluate(() => window.scrollTo(0, 0));

    section('DELETE MY DATA');
    await page.click('#deleteDataBtn');
    ok((await page.locator('#gallery .vslot').count()) > 0, 'the first click only asks');
    await page.click('#deleteDataBtn');
    await wait(() => document.querySelectorAll('#gallery .vslot').length === 0);
    ok((await page.evaluate(() => localStorage.length)) === 0 && await page.isVisible('#consentBanner'), 'gallery and storage are wiped, the banner asks again');
    await page.click('#consentDeny');
    await page.click('#themeToggleLabel');
    ok((await page.evaluate(() => localStorage.getItem('bv-theme'))) === null && (await page.evaluate(() => localStorage.getItem('bv-consent'))) === 'denied', 'No thanks: only the answer is stored');

    section('CONSOLE');
    /* The failed requests are deliberate, and the app logs one warning per failed link on purpose. */
    const real = problems.filter((m) => !/Failed to load resource|\[BAT Viewer\] media failed to load/.test(m));
    ok(real.length === 0, 'no console errors, CSP violations or page errors', real);
  } catch (e) {
    console.error('\nTEST CRASHED:', e);
    fail++;
  } finally {
    await browser.close();
    child.kill();
    fixtures.close();
  }
  console.log('\n' + '='.repeat(50));
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : exit);
})();
