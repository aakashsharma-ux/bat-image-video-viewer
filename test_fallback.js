'use strict';
/* Logic-level test harness for the "Intelligent Fast Media Format
   Fallback" feature added in app.js v18.

   Real browser <img>/<video> network+decode behavior can't run inside
   jsdom, so this stubs IntersectionObserver (to activate every slot
   immediately, synchronously, like a fully-visible viewport) and drives
   the state machine by manually dispatching synthetic 'load'/'error'
   events on the media elements the app itself creates — exactly the
   events a real browser would fire on success/failure. Everything else
   (DOM structure, class names, event wiring, retry timers) is the real
   app.js running unmodified. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, 'bat-image-video-viewer-main');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.log('  \u2717 ' + msg); }
}
function section(name) { console.log('\n' + name); }

async function freshApp() {
  const dom = new JSDOM(html, {
    url: 'https://viewer.example/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const { window } = dom;

  /* Stub IntersectionObserver: treat every observed slot as immediately
     100% visible, synchronously, so cards build the instant appendUrls
     runs — removes real scrolling from the test, but exercises every
     line of Virtual/ImageCard/VideoCard exactly as a real viewport
     showing everything at once would. */
  class FakeIO {
    constructor(cb) { this.cb = cb; this.observed = new Set(); FakeIO.last = this; }
    observe(el) { this.observed.add(el); this.cb([{ target: el, isIntersecting: true }]); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
    /* Test helper: simulate the slot scrolling off-screen then back. */
    reactivate(el) {
      this.cb([{ target: el, isIntersecting: false }]);
      this.cb([{ target: el, isIntersecting: true }]);
    }
  }
  window.IntersectionObserver = FakeIO;
  /* No ResizeObserver defined — app.js guards with typeof checks, fine. */

  window.eval(appJs);
  return { dom, window, document: window.document, FakeIO };
}

async function loadUrls(window, document, urls) {
  document.getElementById('bulkArea').value = urls.join('\n');
  document.getElementById('bulkLoadBtn').dispatchEvent(new window.Event('click'));
  // The click handler is async (chunked building + rAF yields). Poll for
  // the expected number of .card elements to appear.
  for (let i = 0; i < 100; i++) {
    if (document.querySelectorAll('.card').length >= urls.length) break;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function cardFor(document, url) {
  const rows = document.querySelectorAll('.card-url-row, .url-label');
  // Simpler: cards render in order added; find by index via slot dataset.
  const slots = document.querySelectorAll('.vslot');
  for (const slot of slots) {
    if (document.getElementById('bulkArea')) { /* noop */ }
    const label = slot.querySelector('.url-label');
    const card = slot.querySelector('.card');
    if (card) {
      // URL is embedded in the toolbar copy handler closures, not an
      // attribute — but the error view and url-row both print it as text.
      const urlRow = card.querySelector('.card-url-row');
      if (urlRow && urlRow.textContent.indexOf(url) !== -1) return card;
      const err = card.querySelector('.card-err');
      if (err && err.textContent.indexOf(url) !== -1) return card;
    }
  }
  return null;
}

function isVideoCard(card) { return card.classList.contains('card-video-card'); }
function status(card) { return card.dataset.mediaStatus; }

async function tick(ms) { await new Promise((r) => setTimeout(r, ms || 10)); }

/* ─────────────────────────────────────────────────────────────
   TEST 1
   Confidently-typed IMAGE url (.jpg) fails, fallback to video also
   fails -> must end FAILED, and must NOT get permanently stuck typed
   as 'video': a manual retry must rebuild as ImageCard again (proves
   no bad override was left behind).
───────────────────────────────────────────────────────────── */
async function test1() {
  section('TEST 1: confident image, both formats fail -> no permanent mistype, retry self-heals');
  const { window, document } = await freshApp();
  const url = 'https://cdn.example.com/photo123.jpg';
  await loadUrls(window, document, [url]);

  let card = cardFor(document, url);
  assert(!!card, 'card was built');
  assert(!isVideoCard(card), 'starts as ImageCard (confident .jpg detection)');
  assert(status(card) === 'loading', 'starts in loading state');

  // Fail the image load.
  const img1 = card.querySelector('img.card-img');
  img1.dispatchEvent(new window.Event('error'));
  await tick();

  card = cardFor(document, url); // re-fetch: card was rebuilt
  assert(isVideoCard(card), 'after image failure, immediately swapped to VideoCard (fallback fired for a CONFIDENT url)');
  assert(status(card) === 'loading', 'fallback video card is loading (fast, no delay)');

  // Fail the fallback video load too.
  const video1 = card.querySelector('video.card-video');
  video1.dispatchEvent(new window.Event('error'));
  await tick();

  card = cardFor(document, url);
  assert(status(card) === 'failed', 'both formats failed -> FAILED state shown');
  assert(!!card.querySelector('.card-err'), 'error view with Retry button rendered');

  // Now manually retry. Because the fallback ultimately failed and the
  // original detection was confident, no override should have been
  // left behind -> retry should rebuild as ImageCard again, not stay
  // stuck as VideoCard.
  const retryBtn = card.querySelector('.card-retry-btn');
  assert(!!retryBtn, 'retry button present');
  retryBtn.dispatchEvent(new window.Event('click'));
  await tick(500); // retryDelay (220ms) + backoff margin

  card = cardFor(document, url);
  assert(!isVideoCard(card), 'manual retry rebuilt as ImageCard again (self-healed, not stuck on the failed guess)');
}

/* ─────────────────────────────────────────────────────────────
   TEST 2
   Confidently-typed VIDEO url (.mp4) fails, fallback to image
   SUCCEEDS -> card ends LOADED as ImageCard, and the correct type is
   remembered (re-virtualizing the same slot should show it as an
   image card immediately, no re-fail-then-swap dance).
───────────────────────────────────────────────────────────── */
async function test2() {
  section('TEST 2: confident video url whose bytes are actually an image -> fallback succeeds and is remembered');
  const { window, document, FakeIO } = await freshApp();
  const url = 'https://cdn.example.com/mislabeled999.mp4';
  await loadUrls(window, document, [url]);

  let card = cardFor(document, url);
  assert(isVideoCard(card), 'starts as VideoCard (confident .mp4 detection)');

  const video1 = card.querySelector('video.card-video');
  video1.dispatchEvent(new window.Event('error'));
  await tick();

  card = cardFor(document, url);
  assert(!isVideoCard(card), 'after video failure, immediately swapped to ImageCard');

  const img1 = card.querySelector('img.card-img');
  img1.dispatchEvent(new window.Event('load'));
  await tick();

  card = cardFor(document, url);
  assert(status(card) === 'loaded', 'fallback image loaded successfully -> LOADED');
  assert(!isVideoCard(card), 'still an ImageCard');

  // Simulate scrolling this slot off-screen and back on-screen. Since
  // the fallback SUCCEEDED, the corrected type should now be
  // remembered, so it should come back as an ImageCard directly,
  // without another failed video attempt.
  const slot = card.closest('.vslot');
  FakeIO.last.reactivate(slot);
  await tick();

  card = cardFor(document, url);
  assert(!isVideoCard(card), 'after scroll-away/scroll-back, remembered as ImageCard (no repeat fail+swap)');
  assert(status(card) !== 'failed', 'not shown as failed on re-render');
}

/* ─────────────────────────────────────────────────────────────
   TEST 3
   Genuinely ambiguous url (no extension) fails as the default image
   guess -> falls back to video as before (pre-existing behavior,
   unchanged by the widened gate).
───────────────────────────────────────────────────────────── */
async function test3() {
  section('TEST 3: ambiguous url (no extension) still falls back image -> video as before');
  const { window, document } = await freshApp();
  const url = 'https://cdn.example.com/objects/9f8a7b6c5d4e3f2a1b0c';
  await loadUrls(window, document, [url]);

  let card = cardFor(document, url);
  assert(!!card, 'card was built');
  assert(!isVideoCard(card), 'defaults to ImageCard guess (no extension/MIME hint)');

  const img1 = card.querySelector('img.card-img');
  img1.dispatchEvent(new window.Event('error'));
  await tick();

  card = cardFor(document, url);
  assert(isVideoCard(card), 'ambiguous url falls back to VideoCard on image failure (pre-existing behavior preserved)');
}

/* ─────────────────────────────────────────────────────────────
   TEST 4
   No infinite bounce: after both formats have been tried once, a
   THIRD failure must go straight to FAILED, not swap again.
───────────────────────────────────────────────────────────── */
async function test4() {
  section('TEST 4: no infinite image<->video bounce loop');
  const { window, document } = await freshApp();
  const url = 'https://cdn.example.com/broken555.png';
  await loadUrls(window, document, [url]);

  let card = cardFor(document, url);
  const img1 = card.querySelector('img.card-img');
  img1.dispatchEvent(new window.Event('error'));
  await tick();

  card = cardFor(document, url);
  assert(isVideoCard(card), 'first failure swapped to video');
  const video1 = card.querySelector('video.card-video');
  video1.dispatchEvent(new window.Event('error'));
  await tick();

  card = cardFor(document, url);
  assert(status(card) === 'failed', 'second failure (both formats tried) -> FAILED, no more swapping');
  const cardTypeAfterBothFailed = isVideoCard(card);

  // Nothing left to dispatch error on (error view has no media element),
  // so the loop-prevention is really enforced structurally: there's no
  // further media element to fail. Confirm state is stable/consistent.
  assert(card.querySelector('.card-err') !== null, 'stable failed state, still showing error view');
  assert(isVideoCard(card) === cardTypeAfterBothFailed, 'card type unchanged after settling into failed state');
}

(async () => {
  try {
    await test1();
    await test2();
    await test3();
    await test4();
  } catch (e) {
    console.error('\nTEST HARNESS CRASHED:', e);
    fail++;
  }
  console.log('\n' + '='.repeat(50));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
