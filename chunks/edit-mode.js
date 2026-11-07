/* ════════════════════════════════════════════════════════
   Bat-Viewer chunk: edit-mode
   The Edit panel (brightness / contrast / rotation) for one card at a
   time. Its markup is created here, the first time an Edit button is
   used, so it costs nothing until then.

   The panel is a bar along the bottom of the window. The page keeps its
   width, so no card reflows or jumps when it opens; the page just gets
   room at the bottom for it (--edit-sheet-h) and the card being edited is
   scrolled above it, so the picture is never hidden behind the panel.

   Contract with app.js (EditMode stand-in): enter(card, url),
   exit(apply), reset(), isActive().

   Keyboard: opening the panel moves focus to its first slider; closing
   it (Done / Cancel / ✕ / Esc / switching card) puts focus back on the
   Edit button that opened it. The panel is `visibility:hidden` while
   closed (see style.css), so it is out of the tab order and the
   accessibility tree until needed.
════════════════════════════════════════════════════════ */
BVChunk('edit-mode', function (bv) {
  'use strict';
  var $ = bv.$, el = bv.el, on = bv.on, DOM = bv.DOM, EditState = bv.EditState;

  var panel = null, refs = null, watcher = null, watchTimer = 0;
  var activeCard = null, activeUrl = null;
  var saved = null, live = null, opener = null;

  function control(id, label, min, max, value, text) {
    return '<div class="ep-control">' +
      '<div class="ep-ctrl-header">' +
        '<label class="ep-ctrl-name" for="' + id + '">' + label + '</label>' +
        '<span class="ep-ctrl-val" id="' + id + 'Val" aria-hidden="true">' + text + '</span>' +
      '</div>' +
      '<input type="range" class="ep-slider" id="' + id + '" min="' + min + '" max="' + max +
        '" value="' + value + '" step="1" aria-valuetext="' + text + '">' +
    '</div>';
  }

  function build() {
    panel = el('aside', 'edit-panel');
    panel.id = 'editPanel';
    panel.setAttribute('aria-labelledby', 'epTitle');
    panel.innerHTML =
      '<div class="ep-header">' +
        '<div class="ep-title" id="epTitle"><span class="ep-icon" aria-hidden="true">✎</span><span>Edit Mode</span></div>' +
        '<button type="button" class="ep-close" id="epClose" title="Exit Edit Mode (Esc)" aria-label="Exit Edit Mode"><span aria-hidden="true">✕</span></button>' +
      '</div>' +
      '<div class="ep-body">' +
        '<div class="ep-section-label">Adjustments</div>' +
        control('epBrightness', 'Brightness', 0, 200, 100, '100%') +
        control('epContrast',   'Contrast',   0, 200, 100, '100%') +
        '<div class="ep-section-label ep-section-gap">Transform</div>' +
        control('epRotate', 'Free Rotate', -180, 180, 0, '0°') +
        '<div class="ep-rotate-row">' +
          '<button type="button" class="ep-rot-btn" id="epRotCCW" title="Rotate 90° counter-clockwise"><span aria-hidden="true">↺</span> 90°<span class="sr-only"> counter-clockwise</span></button>' +
          '<button type="button" class="ep-rot-btn" id="epRotCW" title="Rotate 90° clockwise"><span aria-hidden="true">↻</span> 90°<span class="sr-only"> clockwise</span></button>' +
        '</div>' +
        '<div class="ep-actions">' +
          '<button type="button" class="ep-btn ep-btn-ghost" id="epReset" title="Ctrl+R" aria-keyshortcuts="Control+R">Reset</button>' +
          '<button type="button" class="ep-btn ep-btn-cancel" id="epCancel">Cancel</button>' +
          '<button type="button" class="ep-btn ep-btn-done" id="epDone">Done <span aria-hidden="true">✓</span></button>' +
        '</div>' +
        '<div class="ep-hint">Changes apply to this session only.<br>Exit edit mode to resume normal viewing.</div>' +
      '</div>';
    DOM.pageBody.parentNode.insertBefore(panel, DOM.pageBody);

    refs = {
      b: $('epBrightness'), c: $('epContrast'), r: $('epRotate'),
      bv: $('epBrightnessVal'), cv: $('epContrastVal'), rv: $('epRotateVal')
    };
    on(refs.b, 'input', function () { live.brightness = refs.b.value / 100; showB(parseInt(refs.b.value, 10)); preview(); });
    on(refs.c, 'input', function () { live.contrast   = refs.c.value / 100; showC(parseInt(refs.c.value, 10)); preview(); });
    on(refs.r, 'input', function () { live.rotation   = parseInt(refs.r.value, 10); showR(live.rotation); preview(); });
    on($('epRotCCW'), 'click', function () { live.rotation = normalise(live.rotation - 90); showR(live.rotation); preview(); });
    on($('epRotCW'),  'click', function () { live.rotation = normalise(live.rotation + 90); showR(live.rotation); preview(); });
    on($('epReset'),  'click', resetLive);
    on($('epCancel'), 'click', function () { exit(false); });
    on($('epDone'),   'click', function () { exit(true);  });
    on($('epClose'),  'click', function () { exit(false); });
    on(window, 'resize', function () {                                    /* the bar's height depends on the window's width */
      if (!activeCard) return;
      syncSheet(); fitToWindow(activeCard); preview();
    });
  }

  /* Slider position + the visible value + the text a screen reader speaks. */
  function showB(pct) { refs.b.value = pct; refs.bv.textContent = pct + '%';      refs.b.setAttribute('aria-valuetext', pct + '%'); }
  function showC(pct) { refs.c.value = pct; refs.cv.textContent = pct + '%';      refs.c.setAttribute('aria-valuetext', pct + '%'); }
  function showR(deg) { refs.r.value = deg; refs.rv.textContent = deg + '°'; refs.r.setAttribute('aria-valuetext', deg + '°'); }

  function normalise(d) { while (d > 180) d -= 360; while (d < -180) d += 360; return d; }
  function preview()    { if (activeCard) { EditState.applyTo(activeCard, live); keepInView(activeCard); } }
  function resetLive() {
    live = { brightness: 1, contrast: 1, rotation: 0 };
    showB(100); showC(100); showR(0);
    preview();
  }
  function populate(s) {
    showB(Math.round(s.brightness * 100));
    showC(Math.round(s.contrast * 100));
    showR(s.rotation);
  }

  /* The page needs as much room at the bottom as the bar is tall, or the last cards could never be
     scrolled above it. style.css reads this variable (body.edit-active). */
  function syncSheet() {
    document.documentElement.style.setProperty('--edit-sheet-h', panel.offsetHeight + 'px');
  }

  /* While editing, the card's picture may be shown a little smaller than the Image Size setting
     says, so the whole card (header, picture, link, buttons) fits above the bar and none of it has to
     be scrolled out of sight. --edit-max-h is read by style.css and by RotateFit (turned pictures). */
  /* How much of the top of the window the top bar hides: its height while it sticks there. In a small window
     it stops sticking while the Edit bar is open (style.css) and then hides nothing, so the card can use the
     whole window above the bar. */
  function topBar() {
    var bar = document.getElementById('topbar');
    if (!bar || window.getComputedStyle(bar).position !== 'sticky') return 0;
    return parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 54;
  }
  function fitToWindow(card) {
    var box = card.querySelector('.card-img-box');
    if (!box) return;
    card.style.removeProperty('--edit-max-h');                      /* measure the card without the limit */
    var chrome = card.offsetHeight - box.offsetHeight;              /* everything in the card that is not the picture */
    var room = window.innerHeight - topBar() - panel.offsetHeight - chrome - 24;
    card.style.setProperty('--edit-max-h', Math.max(160, Math.floor(room)) + 'px');
  }

  /* Keep the card being edited inside the part of the window the bar leaves free, so the picture can
     be seen while it is adjusted. Moves the page as little as it can: just far enough that the card's
     bottom clears the bar, but never so far that its top goes under the top bar (a card taller than the
     free part shows its top; the rest is a scroll away, as with any tall card). Runs when the panel opens
     and whenever a change (turning the picture) makes the card taller. */
  function keepInView(card) {
    var top  = topBar();
    var free = window.innerHeight - panel.offsetHeight;             /* where the bar begins */
    var r = card.getBoundingClientRect();
    var dy = 0;
    if (r.bottom > free - 4) dy = Math.min(r.bottom - (free - 4), Math.max(0, r.top - (top + 8)));
    if (r.top < top + 4) dy = r.top - (top + 8);
    if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
  }

  /* The card can change size after the bar opened: its picture finishes loading, a video reports its size,
     a turned picture is re-fitted a frame later. Whenever it does, keep it above the bar again. Only the
     page is scrolled here, never the card's size, so this can't feed back into itself. */
  function watch(card) {
    if (typeof window.ResizeObserver !== 'function') return;
    if (!watcher) {
      watcher = new window.ResizeObserver(function () {
        if (watchTimer) return;
        watchTimer = window.requestAnimationFrame(function () { watchTimer = 0; if (activeCard) keepInView(activeCard); });
      });
    }
    watcher.disconnect();
    if (card) watcher.observe(card);
  }

  function enter(card, url) {
    if (activeCard === card) return;
    if (activeCard) exit(false, true, true);    /* switching cards: focus is already where the new click put it, and the panel stays open */
    if (!panel) build();
    opener = document.activeElement;
    activeCard = card; activeUrl = url;
    saved = EditState.get(url);
    live  = { brightness: saved.brightness, contrast: saved.contrast, rotation: saved.rotation };
    populate(live);
    syncSheet();
    panel.classList.add('visible');
    document.body.classList.add('edit-active');
    card.classList.add('editing');
    fitToWindow(card);
    watch(card);
    var editBtn = card.querySelector('.tedit');
    if (editBtn) editBtn.setAttribute('aria-pressed', 'true');
    refs.b.focus({ preventScroll: true });
    preview();                                  /* re-fits a turned picture to the new limit, then keeps the card in view */
  }

  function exit(apply, keepFocus, switching) {
    if (!activeCard) return;
    var card = activeCard, back = opener;
    if (!switching) watch(null);
    card.style.removeProperty('--edit-max-h');                          /* the picture goes back to the Image Size setting */
    if (apply) { EditState.set(activeUrl, live); EditState.applyTo(card, live); }
    else       { EditState.applyTo(card, saved); }
    var editBtn = card.querySelector('.tedit');
    if (editBtn) editBtn.removeAttribute('aria-pressed');
    var hadFocus = panel.contains(document.activeElement);
    var topBarWasLoose = !switching && topBar() === 0;                  /* small window: the top bar was not sticking */
    card.classList.remove('editing');
    if (!switching) {                           /* switching: another card is about to be edited, so the panel stays open */
      document.body.classList.remove('edit-active');
      panel.classList.remove('visible');
      if (topBarWasLoose) {                     /* the top bar sticks again: don't let it land on the top of the card that was just edited */
        var over = card.getBoundingClientRect().top - (topBar() + 8);
        if (over < 0) window.scrollBy(0, over);
      }
    }
    activeCard = activeUrl = saved = live = opener = null;
    if (!keepFocus && hadFocus) {
      var target = (back && back !== document.body && document.documentElement.contains(back)) ? back : editBtn;
      if (target && document.documentElement.contains(target)) target.focus({ preventScroll: true });
    }
  }

  return {
    enter   : enter,
    exit    : exit,
    reset   : function () { if (activeCard) resetLive(); },
    isActive: function () { return activeCard !== null; }
  };
});
