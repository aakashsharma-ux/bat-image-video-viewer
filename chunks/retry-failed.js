/* ════════════════════════════════════════════════════════
   Bat-Viewer chunk: retry-failed
   The top-bar "Retry" button: re-tries every failed image/video in the
   whole gallery. Fetched the first time the button is used.
════════════════════════════════════════════════════════ */
BVChunk('retry-failed', function (bv) {
  'use strict';
  var State = bv.State, DOM = bv.DOM, el = bv.el;
  var MEDIA_STATUS = bv.MEDIA_STATUS, MediaState = bv.MediaState, RETRY_CONFIG = bv.RETRY_CONFIG, Toast = bv.Toast;

  /* ════════════════════════════════════════════════════════
     FAILED MEDIA RETRY (whole gallery)
  ════════════════════════════════════════════════════════ */
  var running = false;

  /* Collect every FAILED url across the whole gallery — not just a
     small window near the current scroll position. Slots that are
     currently mounted (State.activeSet) are retried for real, right
     now, with bounded concurrency exactly like before. Off-screen
     slots are deliberately NOT force-mounted: building live
     <img>/<video> elements (and opening real S3 connections) for up
     to 1,000 items at once would blow past the ~30-80 live-node
     budget the virtual scroller is built around. Instead their
     failed state is cleared so the moment they scroll into view they
     attempt a fresh load instead of immediately showing "failed"
     again — so every failed item genuinely gets retried, either
     immediately (if mounted) or on next scroll-into-view (if not),
     and performance stays exactly as before. */
  function collect() {
    var activeTasks = [];
    var queuedCount = 0;
    for (var idx = 0; idx < State.slots.length; idx++) {
      var slot = State.slots[idx];
      var url = State.allUrls[idx];
      if (!slot || !url) continue;

      var mediaState = MediaState.get(url);
      if (mediaState.status !== MEDIA_STATUS.FAILED) continue;

      if (State.activeSet.has(slot)) {
        var card = slot.querySelector('.card');
        if (card && typeof card._retryMedia === 'function') {
          mediaState.retryCount = 0;
          activeTasks.push({ url: url, card: card });
          continue;
        }
      }
      /* Off-screen (or missing its card for some reason) — reset so
         the next activation attempts a fresh load instead of
         re-showing the stale failed view. */
      mediaState.status = null;
      mediaState.retryCount = 0;
      queuedCount++;
    }
    return { activeTasks: activeTasks, queuedCount: queuedCount };
  }

  function runQueue(tasks, onDone) {
    var next = 0, done = 0, ok = 0;

    function launch() {
      if (next >= tasks.length) {
        if (done >= tasks.length) onDone(done, ok);
        return;
      }
      var task = tasks[next++];
      /* applyLimit=false — an explicit "Retry" click is a deliberate,
         whole-gallery user action, so every failed item gets a fresh
         attempt regardless of any earlier automatic-retry cap. */
      Promise.resolve(task.card._retryMedia(false, false))
        .then(function (success) { if (success) ok++; })
        .catch(function () {})
        .then(function () {
          done++;
          if (done >= tasks.length) onDone(done, ok);
          else setTimeout(launch, RETRY_CONFIG.delayMs);
        });
    }

    if (!tasks.length) { onDone(0, 0); return; }
    for (var i = 0; i < RETRY_CONFIG.concurrency && i < tasks.length; i++) {
      setTimeout(launch, i * RETRY_CONFIG.delayMs);
    }
  }

  /* "\u21BA Retry" with the arrow hidden from screen readers (as in index.html). */
  function setRetryLabel() {
    var btn = DOM.retryVisibleFailedBtn;
    var g = el('span'); g.setAttribute('aria-hidden', 'true'); g.textContent = '\u21BA';
    btn.textContent = '';
    btn.appendChild(g);
    btn.appendChild(document.createTextNode(' Retry'));
  }

  /* `again` = how many cards the core just set going again because their video
     player's code had not downloaded (they are not "failed media" below). */
  function run(again) {
    if (running) return;
    var collected = collect();
    var activeTasks = collected.activeTasks;
    var queuedCount = collected.queuedCount;

    if (!activeTasks.length && !queuedCount) {
      Toast.show(again ? 'Reloading the video player…' : 'No failed media to retry.', 'ok', 2200);
      return;
    }

    running = true;
    var btn = DOM.retryVisibleFailedBtn;
    var hadFocus = document.activeElement === btn;
    btn.disabled = true;
    btn.textContent = 'Retrying...';

    var startParts = [];
    if (activeTasks.length) startParts.push('retrying ' + activeTasks.length + ' now');
    if (queuedCount) startParts.push(queuedCount + ' more queued to reload on scroll');
    Toast.show('Failed media \u2014 ' + startParts.join(', ') + '.', 'ok', 2800);

    runQueue(activeTasks, function (done, ok) {
      running = false;
      btn.disabled = false;
      setRetryLabel();
      if (hadFocus) btn.focus({ preventScroll: true });   /* a disabled button drops focus */
      var parts = [];
      if (done) parts.push(done + ' retried' + (ok ? ' (' + ok + ' recovered)' : ''));
      if (queuedCount) parts.push(queuedCount + ' queued for scroll-in');
      var msg = parts.length ? parts.join('; ') + '.' : 'Nothing left to retry.';
      Toast.show(msg, (ok || queuedCount) ? 'ok' : 'err', 3200);
    });
  }

  return { run: run };
});
