'use strict';
/* Behaviour tests for the v19 changes, run against the real index.html, app.js and
   chunks/*.js inside jsdom. jsdom has no layout, no network and no media decoding, so
   IntersectionObserver and fetch are replaced by small fakes and the media elements'
   own `load`/`error` events are dispatched by hand — the same approach as
   fallback.test.js. What is covered here:

     consent & storage      the theme is stored only after "Allow"; "No thanks" stores nothing;
                            "Delete my data" wipes bv-* keys (and only those) plus the gallery
     pagination             100 slots per page, Load more / Load all, the sentinel, Append,
                            Remove + renumbering on a partly-built list
     escaping               a hostile link is shown as text, never parsed as markup
     lazy chunks            edit panel, Common Notes, the video player placeholder and what
                            happens when a chunk cannot be fetched
     input work             debounced tally, O(1) size slider, bounded content-type probes
     keyboard               Space keeps working on buttons; a modal dialog owns the keyboard
     static audit           labels, alt text, landmarks, CSP, and "no third-party anything" */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const appJs = read('app.js');
const chunkSrc = {};
fs.readdirSync(path.join(ROOT, 'chunks')).filter((f) => /\.js$/.test(f)).forEach((f) => { chunkSrc[f.replace(/\.js$/, '')] = read('chunks/' + f); });

let pass = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n' + name); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));

/* opts.manualSentinel  the page-end sentinel does NOT report itself visible (tests call fireSentinel())
   opts.chunks === false  chunks are not pre-evaluated; <script src> insertions are captured in `scripts`
   opts.beforeEval(window)  runs before app.js (seed storage, add fakes) */
async function makeApp(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, { url: 'https://viewer.example/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  class FakeIO {
    constructor(cb) { this.cb = cb; this.observed = new Set(); FakeIO.last = this; }
    observe(el) {
      this.observed.add(el);
      if (opts.manualSentinel && el.id === 'gallerySentinel') return;
      this.cb([{ target: el, isIntersecting: true }]);
    }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
    reactivate(el) { this.cb([{ target: el, isIntersecting: false }]); this.cb([{ target: el, isIntersecting: true }]); }
    fireSentinel() {
      const s = w.document.getElementById('gallerySentinel');
      if (this.observed.has(s)) this.cb([{ target: s, isIntersecting: true }]);
    }
  }
  w.IntersectionObserver = FakeIO;
  /* jsdom does not implement media playback; quiet stand-ins keep its "not implemented" noise out of the log. */
  const mp = w.HTMLMediaElement.prototype;
  mp.pause = function () {}; mp.load = function () {}; mp.play = function () { return Promise.resolve(); };
  w.scrollBy = function () {};      /* the Edit bar scrolls the edited card into view; jsdom has no layout, so it only prints "not implemented" */
  const scripts = [];
  if (opts.chunks === false) {
    const head = w.document.head;
    const orig = head.appendChild.bind(head);
    head.appendChild = function (node) {
      if (node && node.tagName === 'SCRIPT' && node.src) { scripts.push(node); return node; }
      return orig(node);
    };
  }
  if (opts.beforeEval) opts.beforeEval(w);
  w.eval(appJs);
  if (opts.chunks !== false) Object.keys(chunkSrc).forEach((n) => w.eval(chunkSrc[n]));
  return { dom, window: w, document: w.document, FakeIO, scripts };
}

const $ = (d, id) => d.getElementById(id);
const click = (el) => el.click();
function fire(w, el, type, init) { el.dispatchEvent(new w.Event(type, Object.assign({ bubbles: true }, init || {}))); }
function key(w, target, k, extra) {
  const ev = new w.KeyboardEvent('keydown', Object.assign({ key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true }, extra || {}));
  target.dispatchEvent(ev);
  return ev;
}
async function loadUrls(app, urls, append) {
  const d = app.document;
  $(d, 'appendMode').checked = !!append;
  $(d, 'bulkArea').value = urls.join('\n');
  click($(d, 'bulkLoadBtn'));
  for (let i = 0; i < 150; i++) { await tick(20); if (!$(d, 'bulkLoadBtn').disabled) break; }
  await tick(30);
}
const slots = (d) => d.querySelectorAll('#gallery .vslot');
const mkUrls = (n, prefix) => Array.from({ length: n }, (_, i) => 'https://cdn.example/' + (prefix || 'p') + i + '.jpg');
const seed = (obj) => (w) => { Object.keys(obj).forEach((k) => w.localStorage.setItem(k, obj[k])); };

/* ───────────────────────────── consent & storage ───────────────────────────── */
async function testConsent() {
  section('CONSENT: nothing is stored until the visitor allows it');
  let app = await makeApp();
  let d = app.document, w = app.window;
  assert(!$(d, 'consentBanner').hidden, 'banner is shown on a first visit');
  assert(w.localStorage.length === 0, 'nothing in localStorage before any choice');
  click($(d, 'themeToggle'));
  assert(d.documentElement.getAttribute('data-theme') === 'moon', 'theme switch works without consent');
  assert(w.localStorage.getItem('bv-theme') === null, 'theme is NOT written before consent');
  click($(d, 'consentAllow'));
  assert($(d, 'consentBanner').hidden, 'banner closes on Allow');
  assert(w.localStorage.getItem('bv-consent') === 'granted', 'consent choice recorded');
  assert(w.localStorage.getItem('bv-theme') === 'moon', 'Allow stores the current theme');
  click($(d, 'themeToggle'));
  assert(w.localStorage.getItem('bv-theme') === 'night', 'after Allow, theme changes are stored');

  app = await makeApp({ beforeEval: seed({ 'bv-consent': 'granted', 'bv-theme': 'moon' }) });
  d = app.document;
  assert($(d, 'consentBanner').hidden, 'banner stays away once a choice exists');
  assert(d.documentElement.getAttribute('data-theme') === 'moon', 'stored theme is applied on load');
  assert($(d, 'themeToggle').checked && $(d, 'themeName').textContent === 'Moon', 'switch and label match the stored theme');

  section('CONSENT: "No thanks" keeps the app working and stores nothing but the answer');
  app = await makeApp({ beforeEval: seed({ 'bv-theme': 'moon' }) });   /* a v18 visitor: theme saved before any banner existed */
  d = app.document; w = app.window;
  assert(!$(d, 'consentBanner').hidden, 'banner is shown to a visitor who has a theme but no recorded choice');
  click($(d, 'consentDeny'));
  assert(w.localStorage.getItem('bv-consent') === 'denied', 'denial is recorded');
  assert(w.localStorage.getItem('bv-theme') === null, 'No thanks removes the previously saved theme');
  click($(d, 'themeToggle'));
  assert(w.localStorage.getItem('bv-theme') === null, 'theme changes are not stored after No thanks');
  assert(w.localStorage.length === 1, 'only the answer itself is stored', w.localStorage.length);

  app = await makeApp({ beforeEval: seed({ 'bv-consent': 'denied' }) });
  assert($(app.document, 'consentBanner').hidden, 'a stored denial is respected (no nagging)');

  section('CONSENT: Privacy settings reopens the banner and the choice can change');
  app = await makeApp({ beforeEval: seed({ 'bv-consent': 'denied' }) });
  d = app.document; w = app.window;
  click($(d, 'privacySettingsBtn'));
  assert(!$(d, 'consentBanner').hidden, 'banner is back');
  assert(d.activeElement === $(d, 'consentDeny'), 'focus moves into the banner when the visitor asked for it');
  click($(d, 'consentAllow'));
  assert(w.localStorage.getItem('bv-consent') === 'granted' && w.localStorage.getItem('bv-theme') === 'night', 'changing to Allow stores consent and theme');

  section('CONSENT: blocked storage is handled');
  app = await makeApp({
    beforeEval: (win) => {
      Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new win.Error('blocked'); } });
    }
  });
  d = app.document;
  assert($(d, 'consentBanner').hidden, 'no banner when the browser blocks storage (there is nothing to ask about)');
  click($(d, 'themeToggle'));
  assert(d.documentElement.getAttribute('data-theme') === 'moon', 'theme still switches for this page view');
  click($(d, 'privacySettingsBtn'));
  assert(/blocking local storage/i.test($(d, 'statusMsg').textContent), 'Privacy settings explains instead of showing a pointless banner');
}

async function testDeleteData() {
  section('DELETE MY DATA: wipes the gallery, notes, edits and bv-* storage (and only that)');
  const app = await makeApp({ beforeEval: seed({ 'bv-consent': 'granted', 'bv-theme': 'moon', other: 'keep me' }) });
  const d = app.document, w = app.window;
  await loadUrls(app, mkUrls(3));
  const ta = d.querySelector('.card-notes-input');
  ta.value = 'secret note'; fire(w, ta, 'input');
  click($(d, 'commonNotesBtn')); await tick(30);
  const cn = $(d, 'cnTextarea');
  assert(!!cn, 'Common Notes dialog was created on first use');
  cn.value = 'scratch text';
  $(d, 'bulkArea').value = 'https://typed.example/not-loaded.jpg';

  const btn = $(d, 'deleteDataBtn');
  click(btn);
  assert(/confirm/i.test(btn.textContent), 'first click only asks for confirmation');
  assert(slots(d).length === 3 && w.localStorage.getItem('bv-theme') === 'moon', 'nothing is deleted by the first click');
  fire(w, btn, 'blur');
  assert(btn.textContent === 'Delete my data', 'moving away cancels the confirmation');
  click(btn); click(btn);
  assert(slots(d).length === 0 && $(d, 'gCount').textContent === '0', 'gallery is emptied');
  assert(w.localStorage.getItem('bv-theme') === null && w.localStorage.getItem('bv-consent') === null, 'bv-theme and bv-consent are removed');
  assert(w.localStorage.getItem('other') === 'keep me', 'keys that are not Bat-Viewer’s are left alone');
  assert(cn.value === '' && $(d, 'bulkArea').value === '', 'Common Notes and the link box are cleared');
  assert(d.documentElement.getAttribute('data-theme') === 'night', 'theme is back to the default');
  assert(!$(d, 'consentBanner').hidden, 'the storage question is asked again');
  await loadUrls(app, mkUrls(1, 'again'));
  assert(d.querySelector('.card-notes-input').value === '', 'per-card notes did not survive');
}

/* ───────────────────────────── pagination ───────────────────────────── */
async function testPagination() {
  section('PAGINATION: first page, Load more, sentinel, Load all');
  let app = await makeApp({ manualSentinel: true });
  let d = app.document;
  await loadUrls(app, mkUrls(250));
  assert(slots(d).length === 100, 'a load builds the first 100 slots', slots(d).length);
  assert($(d, 'gCount').textContent === '250', 'the count covers every link, not just the built ones');
  assert(!$(d, 'galleryMore').hidden, 'the "Load more" bar is visible');
  assert($(d, 'galleryMoreText').textContent === 'Showing 100 of 250 items', 'bar text', $(d, 'galleryMoreText').textContent);
  assert($(d, 'gShown').textContent === ' · showing 100', 'toolbar says how many are built', $(d, 'gShown').textContent);
  assert($(d, 'loadMoreBtn').textContent === 'Load 100 more', 'button label', $(d, 'loadMoreBtn').textContent);
  assert(d.querySelector('#gallery .vslot[role=listitem]') && $(d, 'gallery').getAttribute('role') === 'list', 'gallery is an ARIA list of list items');
  assert(slots(d)[0].querySelector('.card-num').textContent.trim() === 'Image 1', 'numbering starts at 1');
  click($(d, 'loadMoreBtn'));
  assert(slots(d).length === 200 && $(d, 'loadMoreBtn').textContent === 'Load 50 more', 'Load more adds one page', slots(d).length);
  app.FakeIO.last.fireSentinel();
  assert(slots(d).length === 250, 'the sentinel pulls in the last page');
  assert($(d, 'galleryMore').hidden && $(d, 'gShown').textContent === '', 'bar and toolbar hint disappear when everything is built');
  assert(!app.FakeIO.last.observed.has($(d, 'gallerySentinel')), 'the sentinel is no longer watched');
  assert(slots(d)[249].querySelector('.card-num').textContent.trim() === 'Image 250', 'numbering is continuous across pages');
  click($(d, 'clearAllBtn'));
  assert(slots(d).length === 0 && $(d, 'gCount').textContent === '0' && $(d, 'galleryMore').hidden, 'Clear All resets everything');

  app = await makeApp({ manualSentinel: true });
  d = app.document;
  await loadUrls(app, mkUrls(130));
  click($(d, 'loadAllBtn'));
  assert(slots(d).length === 130, 'Load all builds the rest');

  section('PAGINATION: Append and Remove on a partly built list');
  app = await makeApp({ manualSentinel: true });
  d = app.document;
  await loadUrls(app, mkUrls(150, 'a'));
  await loadUrls(app, mkUrls(30, 'b'), true);
  assert($(d, 'gCount').textContent === '180' && slots(d).length === 100, 'Append queues behind the unbuilt part', { count: $(d, 'gCount').textContent, slots: slots(d).length });
  assert($(d, 'galleryMoreText').textContent === 'Showing 100 of 180 items', 'bar reflects the queued links');
  click($(d, 'loadAllBtn'));
  assert(slots(d).length === 180 && slots(d)[179].querySelector('.card-num').textContent.trim() === 'Image 180', 'queued links appear in order at the end');

  app = await makeApp({ manualSentinel: true });
  d = app.document;
  await loadUrls(app, mkUrls(120));
  click(d.querySelector('.card .tremove'));
  assert($(d, 'gCount').textContent === '119', 'Remove lowers the count');
  assert($(d, 'galleryMoreText').textContent === 'Showing 99 of 119 items' && $(d, 'loadMoreBtn').textContent === 'Load 20 more', 'bar adjusts at once', $(d, 'galleryMoreText').textContent);
  await tick(300);
  click($(d, 'loadAllBtn'));
  assert(slots(d).length === 119, 'everything left can still be built');
  const nums = Array.from(d.querySelectorAll('#gallery .card-num')).map((n) => parseInt(n.textContent.replace(/\D+/g, ''), 10));
  assert(nums.length === 119 && nums.every((n, i) => n === i + 1), 'cards are renumbered 1..119 with no gap after the removal');
}

/* ───────────────────────────── escaping ───────────────────────────── */
async function testEscaping() {
  section('ESCAPING: a hostile link is shown as text, never as markup');
  const app = await makeApp();
  const d = app.document, w = app.window;
  const url = 'https://x.example/a.jpg?q="><img src=x onerror=alert(1)><b id=pwn>';
  await loadUrls(app, [url]);
  const slot = slots(d)[0];
  fire(w, slot.querySelector('img.card-img'), 'error', { bubbles: false });     /* image fails -> tries video */
  await tick();
  fire(w, slot.querySelector('video.card-video'), 'error', { bubbles: false });  /* video fails too -> error view */
  await tick();
  const err = slot.querySelector('.card-err');
  assert(!!err, 'the failed state is shown');
  assert(err.querySelector('small').textContent === url, 'the link appears verbatim, as text');
  assert(!d.querySelector('img[onerror]') && !d.getElementById('pwn'), 'no element was created from the link');
  assert(!!err.querySelector('.card-retry-btn'), 'the Retry button is there');
}

/* ───────────────────────────── lazy chunks ───────────────────────────── */
async function testEditAndNotes() {
  section('EDIT PANEL (lazy chunk): focus, keyboard, Cancel / Done');
  const app = await makeApp();
  const d = app.document, w = app.window;
  await loadUrls(app, mkUrls(2));
  assert(!$(d, 'editPanel'), 'the panel does not exist until it is needed');
  const edit = d.querySelectorAll('.card .tedit')[0];
  edit.focus(); click(edit); await tick(20);
  const panel = $(d, 'editPanel');
  assert(!!panel && panel.classList.contains('visible'), 'panel is created and shown on first use');
  assert(d.activeElement === $(d, 'epBrightness'), 'focus moves to the first slider');
  assert(edit.getAttribute('aria-pressed') === 'true', 'the Edit button reports that it is pressed');
  const img = d.querySelector('.card .card-img');
  const b = $(d, 'epBrightness');
  b.value = '150'; fire(w, b, 'input');
  assert(img.style.filter.indexOf('brightness(1.5)') > -1, 'sliders preview live on the card', img.style.filter);
  assert($(d, 'epBrightnessVal').textContent === '150%' && b.getAttribute('aria-valuetext') === '150%', 'value text is shown and exposed');
  click($(d, 'epCancel'));
  assert(!panel.classList.contains('visible') && img.style.filter === '', 'Cancel closes the panel and undoes the preview');
  assert(d.activeElement === edit && !edit.hasAttribute('aria-pressed'), 'focus returns to the Edit button');
  click(edit); await tick(10);
  b.value = '150'; fire(w, b, 'input');
  click($(d, 'epDone'));
  assert(img.style.filter.indexOf('brightness(1.5)') > -1, 'Done keeps the edit');
  const slot = img.closest('.vslot');
  app.FakeIO.last.reactivate(slot);
  assert(slot.querySelector('.card-img').style.filter.indexOf('brightness(1.5)') > -1, 'the edit survives scrolling away and back');
  click(slot.querySelector('.tedit')); await tick(10);
  key(w, d, 'r', { ctrlKey: true });
  assert($(d, 'epBrightness').value === '100', 'Ctrl+R resets while the panel is open');
  key(w, d, 'Escape');
  assert(!$(d, 'editPanel').classList.contains('visible'), 'Esc closes the panel');
  const other = d.querySelectorAll('.card .tedit')[1];
  click(slot.querySelector('.tedit')); await tick(10);
  click(other); await tick(10);
  assert(d.querySelectorAll('.card.editing').length === 1 && other.closest('.card').classList.contains('editing'), 'opening another card moves the panel to it');
}

async function testCommonNotes() {
  section('COMMON NOTES (lazy chunk): native dialog');
  const app = await makeApp();
  const d = app.document, w = app.window;
  assert(!d.querySelector('dialog'), 'no dialog in the page until the button is used');
  const btn = $(d, 'commonNotesBtn');
  btn.focus(); click(btn); await tick(30);
  const dlg = d.querySelector('dialog.cn-dialog');
  assert(!!dlg && dlg.hasAttribute('open'), 'dialog opens');
  assert(dlg.getAttribute('aria-labelledby') === 'cnTitle' && !!$(d, 'cnTitle'), 'dialog is labelled');
  assert(d.activeElement === $(d, 'cnTextarea'), 'focus goes to the text box');
  $(d, 'cnTextarea').value = 'remember this';
  click(btn); await tick(20);
  assert(d.querySelectorAll('dialog.cn-dialog').length === 1, 'a second click never builds a second dialog');
  const zoom = $(d, 'zoomEnabled'), before = zoom.checked;
  key(w, $(d, 'cnTextarea'), 'z');
  assert(zoom.checked === before, 'while the dialog is open the page shortcuts are off');
  key(w, $(d, 'cnTextarea'), 'Escape');
  assert(!dlg.hasAttribute('open'), 'Esc closes it');
  assert(d.activeElement === btn, 'focus returns to the button');
  click(btn); await tick(20);
  assert($(d, 'cnTextarea').value === 'remember this', 'text is kept while the page stays open');
  click($(d, 'cnClearBtn'));
  assert($(d, 'cnTextarea').value === '', 'Clear All empties it');
  assert(w.localStorage.length === 0 && w.sessionStorage.length === 0, 'the notes are never written to storage');
}

async function testChunkFailure() {
  section('VIDEO CHUNK: placeholder first, real player when the code arrives');
  const app = await makeApp({ chunks: false });
  const d = app.document, w = app.window;
  const url = 'https://v.example/clip.mp4';
  await loadUrls(app, [url]);
  let card = d.querySelector('.card');
  assert(card.classList.contains('card-pending') && !!card.querySelector('.card-spinner'), 'a video link shows a loading card while the player code is fetched');
  assert(app.scripts.length === 1 && /chunks\/video-card/.test(app.scripts[0].src), 'exactly one request for the chunk', app.scripts.map((s) => s.src));
  app.scripts[0].onerror();
  await tick();
  card = d.querySelector('.card');
  assert(/Could not load the video player/.test(card.textContent), 'a failed fetch says so');
  assert(card.querySelector('.card-err small').textContent === url, 'and still shows the link');
  assert(d.querySelector('.card').dataset.mediaStatus !== 'failed', 'a missing chunk is not recorded as a failed media load');
  click(card.querySelector('.card-retry-btn')); await tick();
  assert(app.scripts.length === 2, 'Retry asks for the chunk again');
  w.eval(chunkSrc['video-card']);
  app.scripts[1].onload();
  await tick(20);
  card = d.querySelector('.card');
  assert(!card.classList.contains('card-pending') && !!card.querySelector('video.card-video'), 'the placeholder is replaced by the real player');
  assert(d.querySelectorAll('.card').length === 1, 'still exactly one card');

  section('VIDEO CHUNK: a link that left the page before the code arrived builds nothing');
  const app2 = await makeApp({ chunks: false });
  const d2 = app2.document, w2 = app2.window;
  await loadUrls(app2, ['https://v.example/gone.mp4']);
  click($(d2, 'clearAllBtn'));
  w2.eval(chunkSrc['video-card']);
  app2.scripts[0].onload();
  await tick(20);
  assert(d2.querySelectorAll('.card, video').length === 0, 'nothing is built for a cleared link');

  section('VIDEO CHUNK: removing a card ABOVE a waiting placeholder does not strand it');
  const app3 = await makeApp({ chunks: false });
  const d3 = app3.document, w3 = app3.window;
  await loadUrls(app3, ['https://i.example/a.jpg', 'https://v.example/one.mp4', 'https://v.example/two.mp4', 'https://i.example/b.jpg']);
  assert(d3.querySelectorAll('.card-pending').length === 2, 'two video cards are waiting for the player code');
  click(d3.querySelector('.card .tremove'));                       /* the image at the top */
  w3.eval(chunkSrc['video-card']);
  app3.scripts[0].onload();
  await tick(30);
  assert(d3.querySelectorAll('.card-pending').length === 0 && d3.querySelectorAll('video.card-video').length === 2, 'both placeholders become real players after the renumbering', d3.querySelectorAll('.card-pending').length);
  const nums3 = Array.from(d3.querySelectorAll('#gallery .vslot .card-num')).map((n) => n.textContent.trim().replace(/\s+VIDEO$/, ''));
  assert(JSON.stringify(nums3.slice(-3)) === JSON.stringify(['Video 1', 'Video 2', 'Image 3']), 'and the numbers are right', nums3);

  section('VIDEO CHUNK: once the player code has arrived, every card that was waiting gets its player');
  const app4 = await makeApp({ chunks: false });
  const d4 = app4.document, w4 = app4.window;
  await loadUrls(app4, ['https://v.example/a.mp4', 'https://v.example/b.mp4']);
  app4.scripts[0].onerror();
  await tick();
  assert(d4.querySelectorAll('.card-err').length === 2, 'both cards say the player could not be loaded');
  click(d4.querySelectorAll('.card-retry-btn')[0]); await tick();
  w4.eval(chunkSrc['video-card']);
  app4.scripts[1].onload();
  await tick(30);
  assert(d4.querySelectorAll('video.card-video').length === 2 && d4.querySelectorAll('.card-pending').length === 0, 'one Retry click is enough for both');

  section('VIDEO CHUNK: the top-bar Retry restarts cards that are stuck on the missing player');
  const app5 = await makeApp({ chunks: false });
  const d5 = app5.document, w5 = app5.window;
  await loadUrls(app5, ['https://v.example/a.mp4', 'https://v.example/b.mp4']);
  app5.scripts[0].onerror();
  await tick();
  click($(d5, 'retryVisibleFailedBtn')); await tick();
  const playerReqs = app5.scripts.filter((s) => /video-card/.test(s.src));
  const retryReq = app5.scripts.filter((s) => /retry-failed/.test(s.src));
  assert(playerReqs.length === 2 && retryReq.length === 1, 'the player code is requested again (once for both cards), next to the retry tool', app5.scripts.map((s) => s.src));
  w5.eval(chunkSrc['video-card']); playerReqs[1].onload();
  w5.eval(chunkSrc['retry-failed']); retryReq[0].onload();
  await tick(30);
  assert(d5.querySelectorAll('video.card-video').length === 2 && d5.querySelectorAll('.card-pending').length === 0, 'both cards get their player');
  assert(/Reloading the video player/.test($(d5, 'statusMsg').textContent), 'the message says what happened, not "No failed media to retry"', $(d5, 'statusMsg').textContent);
}

/* ───────────────────────────── input work ───────────────────────────── */
async function testInputHandlers() {
  section('INPUT: debounced tally, O(1) size slider');
  const app = await makeApp();
  const d = app.document, w = app.window;
  const area = $(d, 'bulkArea');
  area.value = mkUrls(3).join('\n'); fire(w, area, 'input');
  assert($(d, 'bulkTally').textContent === '0 URLs', 'the tally waits for typing to pause');
  await tick(220);
  assert($(d, 'bulkTally').textContent === '3 URLs' && $(d, 'bulkTally').querySelector('b').textContent === '3', 'then updates once', $(d, 'bulkTally').textContent);
  area.value = mkUrls(1).join('\n'); fire(w, area, 'input'); await tick(220);
  assert($(d, 'bulkTally').textContent === '1 URL', 'singular');

  const sizer = $(d, 'sizer'), g = $(d, 'gallery');
  sizer.value = '6'; fire(w, sizer, 'input'); await tick(60);
  assert(g.style.getPropertyValue('--card-max-h') === '540px' && g.style.gridTemplateColumns === 'repeat(1,minmax(0,1fr))', 'XXL: one CSS variable and the grid change', g.style.cssText);
  assert(sizer.getAttribute('aria-valuetext') === 'XXL' && $(d, 'sizeBadge').textContent === 'XXL', 'badge and aria-valuetext follow');
  sizer.value = '10'; fire(w, sizer, 'input'); await tick(60);
  assert(g.style.getPropertyValue('--card-max-h') === 'none' && g.style.getPropertyValue('--slot-min-h') === '200px' && g.style.getPropertyValue('--skeleton-h') === '160px', 'Max: no height limit, sensible placeholder heights');
  sizer.value = '1'; fire(w, sizer, 'input'); await tick(60);
  assert(g.style.getPropertyValue('--skeleton-h') === 'min(160px,120px)' && g.style.gridTemplateColumns === 'repeat(5,minmax(0,1fr))', 'Tiny: skeleton never taller than a card');
  await loadUrls(app, mkUrls(3));
  const cardStyleAttrs = Array.from(d.querySelectorAll('.card, .vslot')).filter((n) => n.hasAttribute('style'));
  assert(cardStyleAttrs.length === 0, 'cards and slots carry no per-element size styles', cardStyleAttrs.length);
}

async function testProbes() {
  section('PROBES: content-type lookups are bounded, cached and applied');
  const calls = [];
  const app = await makeApp({
    beforeEval: (w) => {
      w.fetch = (url, init) => new Promise((resolve, reject) => {
        calls.push({ url, init, resolve, reject });
      });
    }
  });
  const d = app.document;
  const urls = Array.from({ length: 10 }, (_, i) => 'https://s3.example/obj/' + i);      /* no extension: type unknown */
  await loadUrls(app, urls);
  assert(calls.length === 4, 'at most 4 probes in flight at once', calls.length);
  assert(calls.every((c) => c.init.method === 'HEAD'), 'probes are HEAD requests');
  const reply = (c, type) => c.resolve({ headers: { get: () => type } });
  reply(calls[0], 'video/mp4'); await tick(10);
  assert(calls.length === 5, 'a finished probe frees a slot for the next link', calls.length);
  const probedIdx = urls.indexOf(calls[0].url);
  const probedSlot = slots(d)[probedIdx];
  assert(probedSlot.querySelector('.card').classList.contains('card-video-card'), 'a "video/mp4" answer turns that card into a video card');
  reply(calls[1], 'image/png'); reply(calls[2], 'text/html'); calls[3].reject(new Error('CORS')); await tick(10);
  assert(calls.length === 8, 'queue keeps draining (images, unknown types and failures all count as done)', calls.length);
  const before = calls.length;
  click($(d, 'clearAllBtn'));
  await loadUrls(app, [urls[probedIdx]]);
  assert(calls.length === before, 'the same link is not probed twice (answers survive Clear)');
  assert(slots(d)[0].querySelector('.card').classList.contains('card-video-card'), 'and is built as a video straight away');
  app.window.close();
}

/* ───────────────────────────── keyboard ───────────────────────────── */
async function testKeyboard() {
  section('KEYBOARD: Space activates a focused button; elsewhere it is still the scroll-block / play key');
  const app = await makeApp();
  const d = app.document, w = app.window;
  key(w, d.body, 'Tab');                                  /* a keyboard user starts tabbing through the page */
  $(d, 'pauseAllBtn').focus();
  let ev = key(w, $(d, 'pauseAllBtn'), ' ');
  assert(ev.defaultPrevented === false, 'Space on a button reached with the keyboard is left to the browser (it presses the button)');
  $(d, 'bulkArea').focus();
  ev = key(w, $(d, 'bulkArea'), ' ');
  assert(ev.defaultPrevented === false, 'Space in a text box types a space');
  d.activeElement.blur();
  ev = key(w, d.body, ' ');
  assert(ev.defaultPrevented === true, 'Space on the bare page is still taken (it used to scroll)');
  key(w, d.body, 'z');
  assert($(d, 'zoomEnabled').checked === true, 'Z toggles zoom');
  key(w, d.body, '+');
  assert($(d, 'sizer').value === '4' && $(d, 'sizeBadge').textContent === 'Large', '+ grows the cards');
  $(d, 'bulkArea').focus();
  key(w, $(d, 'bulkArea'), 'z');
  assert($(d, 'zoomEnabled').checked === true, 'letters typed into a text box are not shortcuts');

  section('KEYBOARD: after a mouse click the page shortcuts and Space keep their old meaning');
  const sw = $(d, 'zoomEnabled');
  fire(w, d.body, 'pointerdown');                         /* the mouse is in use ... */
  sw.focus();                                             /* ... and a click on the Zoom switch leaves focus on it */
  const was = sw.checked;
  key(w, sw, 'z');
  assert(sw.checked !== was, 'the page shortcuts still work while the Zoom switch has focus (it takes no text)');
  ev = key(w, sw, ' ');
  assert(ev.defaultPrevented === true, 'Space keeps its play/pause/scroll-block meaning there');
  $(d, 'pauseAllBtn').focus();
  ev = key(w, $(d, 'pauseAllBtn'), ' ');
  assert(ev.defaultPrevented === true, 'and on a button that merely kept focus after a mouse click');
  key(w, d.body, 'Tab');                                  /* the keyboard takes over again */
  sw.focus();
  ev = key(w, sw, ' ');
  assert(ev.defaultPrevented === false, 'after Tab, Space on the switch is left to the browser (it flips the switch)');
  $(d, 'pauseAllBtn').focus();
  ev = key(w, $(d, 'pauseAllBtn'), ' ');
  assert(ev.defaultPrevented === false, 'and on a button');

  section('KEYBOARD: removing a card keeps focus in the gallery');
  await loadUrls(app, mkUrls(3));
  const rm = d.querySelector('.card .tremove');
  rm.focus(); click(rm);
  assert(!!d.activeElement.closest('.card-toolbar'), 'focus moves to the next card’s toolbar instead of vanishing');
  const labelled = Array.from(d.querySelectorAll('.card-toolbar button')).every((b) => b.getAttribute('aria-describedby'));
  assert(labelled, 'card buttons say which card they belong to (aria-describedby)');
}

/* ───────────────────────────── static audit ───────────────────────────── */
function audit() {
  section('STATIC AUDIT: pages, labels, alt text, policies');
  const pages = ['index.html', 'privacy.html', 'terms.html', 'cookies.html', '404.html'];
  pages.forEach((p) => {
    const doc = new JSDOM(read(p)).window.document;
    assert(doc.documentElement.lang === 'en', p + ': <html lang>');
    assert(!!doc.title && doc.title.length > 8, p + ': has a title');
    assert(!!doc.querySelector('meta[name=description]'), p + ': has a meta description');
    const csp = (doc.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '';
    assert(/script-src 'self'/.test(csp) && /style-src 'self'/.test(csp) && /default-src 'none'/.test(csp), p + ': CSP allows scripts and styles from this site only');
    assert(doc.querySelectorAll('main').length === 1 && doc.querySelectorAll('h1').length === 1, p + ': one <main> and one <h1>');
    const skip = doc.querySelector('a.skip-link');
    assert(skip && doc.querySelector(skip.getAttribute('href')), p + ': skip link points at something');
    assert(doc.querySelectorAll('script:not([src])').length === 0, p + ': no inline scripts');
    assert(doc.querySelectorAll('[style]').length === 0, p + ': no inline style attributes (blocked by the CSP)');
    assert(Array.from(doc.querySelectorAll('img')).every((i) => i.hasAttribute('alt')), p + ': every <img> has an alt attribute');
    assert(Array.from(doc.querySelectorAll('a[href^="http"]')).every((a) => /noopener/.test(a.rel)), p + ': external links use rel=noopener');
  });
  const doc = new JSDOM(html).window.document;
  const named = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if (el.id && doc.querySelector('label[for="' + el.id + '"]')) return true;
    if (el.closest('label')) return true;
    /* a button's own text counts, but arrows and icons alone do not */
    return el.tagName === 'BUTTON' && /[A-Za-z0-9]/.test(el.textContent);
  };
  const unnamed = Array.from(doc.querySelectorAll('input, textarea, select, button')).filter((el) => !named(el)).map((el) => el.id || el.outerHTML.slice(0, 60));
  assert(unnamed.length === 0, 'index.html: every form control and button has an accessible name', unnamed);
  const ids = Array.from(doc.querySelectorAll('[id]')).map((e) => e.id);
  assert(new Set(ids).size === ids.length, 'index.html: ids are unique');
  assert(!!doc.querySelector('#statusMsg[role=status]') && !!doc.querySelector('#progWrap[role=progressbar]'), 'index.html: status and progress are announced');
  assert(doc.querySelector('header') && doc.querySelector('footer') && doc.querySelector('nav[aria-label]'), 'index.html: header, footer and a labelled nav landmark exist');
  const footerLinks = Array.from(doc.querySelectorAll('footer a')).map((a) => a.getAttribute('href'));
  ['privacy.html', 'terms.html', 'cookies.html'].forEach((h) => assert(footerLinks.indexOf(h) > -1, 'footer links to ' + h));
  assert(!!doc.getElementById('deleteDataBtn') && !!doc.getElementById('privacySettingsBtn'), 'footer has "Delete my data" and "Privacy settings"');
  const choices = [doc.getElementById('consentAllow'), doc.getElementById('consentDeny')];
  assert(choices.every((b) => b && b.className === 'btn-choice'), 'consent banner: both answers use the same style (no nudging)');
  ['privacy.html', 'terms.html', 'cookies.html', 'index.html'].forEach((p) => {
    assert(/aakashsharma-ux/.test(read(p)), p + ': names the operator');
  });
}

function thirdParty() {
  section('THIRD PARTIES: nothing loads from, or is sent to, any other site');
  const exts = ['index.html', 'privacy.html', 'terms.html', 'cookies.html', '404.html'];
  exts.forEach((p) => {
    const doc = new JSDOM(read(p)).window.document;
    const external = Array.from(doc.querySelectorAll('script[src], link[href], img[src], iframe, source[src], video[src], audio[src], form[action]'))
      .filter((n) => n.tagName !== 'A')
      .map((n) => n.getAttribute('src') || n.getAttribute('href') || n.getAttribute('action'))
      .filter((u) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(u || ''));
    assert(external.length === 0, p + ': no external script, style, image or frame', external);
  });
  ['style.css', 'legal.css'].forEach((f) => {
    const css = read(f);
    assert(!/@import|url\(\s*["']?(?:https?:)?\/\//i.test(css), f + ': no @import and no remote url()');
    assert(!/@font-face/.test(css), f + ': no web fonts');
  });
  const code = ['app.js', 'legal.js'].map(read).concat(Object.keys(chunkSrc).map((n) => chunkSrc[n])).join('\n');
  const net = (code.match(/\b(fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|navigator\.serviceWorker|indexedDB|document\.cookie)/g) || []);
  assert(net.length === 1 && net[0] === 'fetch(', 'the only network call in the code is the content-type probe', net);
  assert(/fetch\(job\.url, \{ method: 'HEAD'/.test(code), 'and that call goes to the link the visitor pasted, nowhere else');
  assert(!/https?:\/\/(?!github\.com\/aakashsharma-ux|docs\.github\.com)/.test(read('index.html').replace(/<meta http-equiv[^>]*>/, '')), 'index.html names no host except the operator’s GitHub profile');
  assert(!/analytics|gtag|googletagmanager|facebook|hotjar|segment\.|mixpanel|sentry/i.test(code + read('index.html')), 'no analytics or tracking identifiers anywhere');
}

(async () => {
  try {
    await testConsent();
    await testDeleteData();
    await testPagination();
    await testEscaping();
    await testEditAndNotes();
    await testCommonNotes();
    await testChunkFailure();
    await testInputHandlers();
    await testProbes();
    await testKeyboard();
    audit();
    thirdParty();
  } catch (e) {
    console.error('\nTEST HARNESS CRASHED:', e);
    fail++;
  }
  console.log('\n' + '='.repeat(50));
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
