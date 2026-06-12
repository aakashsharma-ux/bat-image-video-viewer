/* ════════════════════════════════════════════════════════════
   BAT-VIEWER  app.js  v17

   REFACTOR HIGHLIGHTS (v17):
   ─ Single shared "chrome" layer: header, url-row, toolbar,
     and remove handler are factored out. Image- and Video-card
     factories only describe what is unique to their media type.
   ─ Modules grouped under namespaces (Util, State, Theme, Size,
     Scroll, EditState, EditMode, Virtual, ImageCard, VideoCard,
     Keyboard, BulkLoad) — each section is self-contained.
   ─ Video card: floating overlay controls (almost invisible at
     rest, expanded on hover) so they don't block the bottom of
     the picture. Adds a playback-speed cycler.
   ─ Video card: cleaner timeupdate loop, single state-save fn,
     a thin always-visible progress strip at the bottom edge.

   PRESERVED CONTRACTS:
   ─ Edit Mode applies filter to img/video and rotate to wrapper.
   ─ Virtualization uses IntersectionObserver with slot refs.
   ─ Per-card destroy hook (.card-*-box._destroy) for memory.
   ─ editStates + videoStates keyed by URL survive virtualization.
════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     UTIL
  ════════════════════════════════════════════════════════ */
  var Util = (function () {
    function $(id) { return document.getElementById(id); }
    function el(tag, cls, html) {
      var n = document.createElement(tag);
      if (cls != null)  n.className = cls;
      if (html != null) n.innerHTML = html;
      return n;
    }
    function on(t, type, fn, opts) { t.addEventListener(type, fn, opts || false); }
    function stop(e) { e.stopPropagation(); }
    function isTyping() {
      var a = document.activeElement;
      return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
    }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    function fmtTime(t, precise) {
      if (!isFinite(t) || t < 0) t = 0;
      var h = Math.floor(t / 3600);
      var m = Math.floor((t % 3600) / 60);
      var s = Math.floor(t % 60);
      var base = (h > 0 ? h + ':' + pad(m, 2) : m) + ':' + pad(s, 2);
      if (!precise) return base;
      var ms = Math.floor((t - Math.floor(t)) * 1000);
      return base + '.' + pad(ms, 3);
    }
    function fallbackCopy(text) {
      return new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          ta.setSelectionRange(0, ta.value.length);
          var ok = document.execCommand('copy');
          ta.remove();
          ok ? resolve() : reject(new Error('execCommand copy failed'));
        } catch (e) { reject(e); }
      });
    }
    function copyToClipboard(text) {
      /* Try modern Clipboard API first, but always fall back to the
         textarea+execCommand path when it rejects (insecure context,
         permission denied, iframe sandbox, older browsers, etc.). */
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).catch(function () {
          return fallbackCopy(text);
        });
      }
      return fallbackCopy(text);
    }
    function downloadImage(url) {
      /* Derive a sensible filename from the URL path.
         Strip query-string and fragment; fall back to 'image' if the
         path segment carries no recognisable file extension. */
      var raw  = url.split('/').pop().split(/[?#]/)[0];
      var name = raw.match(/\.[a-zA-Z0-9]{2,5}$/) ? raw : 'image';

      function triggerBlobDownload(blob) {
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
        }, 3000);
      }

      function safeFetch(fetchUrl) {
        return fetch(fetchUrl, { credentials: 'omit' })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.blob();
          });
      }

      /* Stage 1 — direct fetch.
         Works for same-origin URLs and any host that sends permissive
         CORS headers (e.g. most CDNs, Wikimedia, Unsplash).

         Stage 2 — CORS proxy fallback.
         Cross-origin hosts such as Reddit or NYT do not send CORS
         headers, so a browser-side fetch is blocked by the browser's
         security policy.  We retry through corsproxy.io, which fetches
         the image server-side and relays it with permissive CORS headers.
         The target URL is fully encoded as a query parameter so that any
         query strings in the original URL are preserved intact. */
      return safeFetch(url)
        .catch(function () {
          return safeFetch(
            'https://corsproxy.io/?url=' + encodeURIComponent(url)
          );
        })
        .then(function (blob) {
          triggerBlobDownload(blob);
        });
      /* Any remaining rejection propagates to the button's .catch handler
         which shows a user-visible error state — never a silent new tab. */
    }
    return {
      $: $, el: el, on: on, stop: stop, isTyping: isTyping,
      clamp: clamp, fmtTime: fmtTime, copyToClipboard: copyToClipboard,
      downloadImage: downloadImage
    };
  })();

  var $   = Util.$;
  var el  = Util.el;
  var on  = Util.on;

  /* ════════════════════════════════════════════════════════
     DOM REFS  (single source of truth)
  ════════════════════════════════════════════════════════ */
  var DOM = {
    html         : document.documentElement,
    gallery      : $('gallery'),
    bulkArea     : $('bulkArea'),
    bulkTally    : $('bulkTally'),
    bulkLoadBtn  : $('bulkLoadBtn'),
    bulkClearBtn : $('bulkClearBtn'),
    appendMode   : $('appendMode'),
    statusMsg    : $('statusMsg'),
    progWrap     : $('progWrap'),
    progFill     : $('progFill'),
    progLabel    : $('progLabel'),
    gCount       : $('gCount'),
    clearAllBtn  : $('clearAllBtn'),
    btt          : $('btt'),
    sizer        : $('sizer'),
    sizeBadge    : $('sizeBadge'),
    scrollSpeed  : $('scrollSpeed'),
    scrollBadge  : $('scrollBadge'),
    zoomEnabled  : $('zoomEnabled'),
    themeToggle  : $('themeToggle'),
    themeLabel   : $('themeLabel'),
    helpBtn      : $('helpBtn'),
    helpTooltip  : $('helpTooltip'),
    pauseAllBtn  : $('pauseAllBtn'),
    muteAllBtn   : $('muteAllBtn'),
    globalSpeed  : $('globalSpeed'),
    globalSpeedBadge: $('globalSpeedBadge')
  };

  /* Global video controls — applied to every video on load and on change.
     muteAll defaults to true so every newly-loaded video is muted. */
  var GlobalVid = {
    muteAll: true,
    rate   : 1
  };

  /* ════════════════════════════════════════════════════════
     STATE  (all mutable runtime state lives here)
  ════════════════════════════════════════════════════════ */
  var State = {
    allUrls    : [],
    slots      : [],
    activeSet  : new Set(),    /* Set<HTMLElement> — slot references, never indices */
    observer   : null,
    isLoading  : false,
    editStates : Object.create(null),
    videoStates: Object.create(null),
    spaceHeld  : false,
    hoveredBox : null,
    hoveredVideoCard: null,
    currentMaxH: '220px'
  };

  /* ════════════════════════════════════════════════════════
     STATUS / TOAST
  ════════════════════════════════════════════════════════ */
  var Toast = (function () {
    var tid = null;
    function show(msg, cls, ms) {
      clearTimeout(tid);
      DOM.statusMsg.textContent = msg;
      DOM.statusMsg.className = 'status ' + (cls || 'ok');
      tid = setTimeout(function () { DOM.statusMsg.className = 'status hide'; }, ms || 3000);
    }
    return { show: show };
  })();

  /* ════════════════════════════════════════════════════════
     THEME
  ════════════════════════════════════════════════════════ */
  (function Theme() {
    function apply(theme) {
      DOM.html.setAttribute('data-theme', theme);
      DOM.themeToggle.checked = (theme === 'moon');
      DOM.themeLabel.textContent = theme === 'moon' ? '\uD83C\uDF15 Moon' : '\uD83C\uDF19 Night';
      localStorage.setItem('bv-theme', theme);
    }
    apply(localStorage.getItem('bv-theme') || 'night');
    on(DOM.themeToggle, 'change', function () {
      apply(DOM.themeToggle.checked ? 'moon' : 'night');
    });
  })();

  /* ════════════════════════════════════════════════════════
     HELP TOOLTIP
  ════════════════════════════════════════════════════════ */
  (function Help() {
    var open = false;
    on(DOM.helpBtn, 'click', function (e) {
      e.stopPropagation();
      open = !open;
      DOM.helpTooltip.classList.toggle('visible', open);
    });
    on(document, 'click', function () {
      if (open) { open = false; DOM.helpTooltip.classList.remove('visible'); }
    });
  })();

  /* ════════════════════════════════════════════════════════
     SIZE PRESETS
  ════════════════════════════════════════════════════════ */
  var SIZE_PRESETS = [
    { label: 'Tiny',      cols: 5, maxH: '120px' },
    { label: 'Small',     cols: 4, maxH: '160px' },
    { label: 'Medium',    cols: 3, maxH: '220px' },
    { label: 'Large',     cols: 2, maxH: '320px' },
    { label: 'XL',        cols: 2, maxH: '440px' },
    { label: 'XXL',       cols: 1, maxH: '540px' },
    { label: '1/Screen',  cols: 1, maxH: '70vh'  },
    { label: '1/Screen+', cols: 1, maxH: '80vh'  },
    { label: 'Full',      cols: 1, maxH: '90vh'  },
    { label: 'Max',       cols: 1, maxH: 'none'  }
  ];

  function applySize(v) {
    var p = SIZE_PRESETS[Util.clamp(v - 1, 0, 9)];
    State.currentMaxH = p.maxH;
    DOM.sizeBadge.textContent = p.label;
    DOM.gallery.style.gridTemplateColumns =
      p.cols === 1 ? '1fr' : 'repeat(' + p.cols + ',minmax(0,1fr))';
    var slotMin = p.maxH === 'none' ? '200px' : p.maxH;
    DOM.gallery.querySelectorAll('.card-img,.card-video')
      .forEach(function (m) { m.style.maxHeight = p.maxH; });
    DOM.gallery.querySelectorAll('.vslot')
      .forEach(function (s) { s.style.minHeight = slotMin; });
  }
  on(DOM.sizer, 'input', function () { applySize(parseInt(DOM.sizer.value, 10)); });
  applySize(parseInt(DOM.sizer.value, 10));

  /* ════════════════════════════════════════════════════════
     SCROLL SPEED
  ════════════════════════════════════════════════════════ */
  var SCROLL_PRESETS = [
    { label: 'Very Slow', base: 15,  max:  50, ramp:  7 },
    { label: 'Slow',      base: 30,  max: 100, ramp: 13 },
    { label: 'Medium',    base: 55,  max: 170, ramp: 22 },
    { label: 'Fast',      base: 90,  max: 260, ramp: 36 },
    { label: 'Very Fast', base: 140, max: 400, ramp: 55 }
  ];
  function getScrollPreset() {
    return SCROLL_PRESETS[Util.clamp(parseInt(DOM.scrollSpeed.value, 10) - 1, 0, 4)];
  }
  on(DOM.scrollSpeed, 'input', function () {
    DOM.scrollBadge.textContent = getScrollPreset().label;
  });
  DOM.scrollBadge.textContent = getScrollPreset().label;

  function zoomOn() { return DOM.zoomEnabled.checked; }

  /* ════════════════════════════════════════════════════════
     URL PARSE / VALIDATE / MEDIA TYPE
  ════════════════════════════════════════════════════════ */
  var VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv|ogg)(?:$|[?#])/i;
  function getMediaType(url) { return url && VIDEO_EXT_RE.test(url) ? 'video' : 'image'; }

  function parseUrls(txt) {
    return txt.split(/[\n,]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 6; })
      .slice(0, 1000);
  }
  function isValidUrl(s) {
    try {
      var u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'data:';
    } catch (_) { return false; }
  }
  function refreshCount() { DOM.gCount.textContent = State.allUrls.length; }

  on(DOM.bulkArea, 'input', function () {
    var n = parseUrls(DOM.bulkArea.value).length;
    DOM.bulkTally.innerHTML = '<b>' + n + '</b> URL' + (n !== 1 ? 's' : '');
  });

  /* ════════════════════════════════════════════════════════
     PERSISTED PER-URL STATE
     Edit (filter / rotation) + Video (time / muted / volume / rate).
  ════════════════════════════════════════════════════════ */
  var EditState = {
    get: function (url) {
      var s = State.editStates[url];
      return s
        ? { brightness: s.brightness, contrast: s.contrast, rotation: s.rotation }
        : { brightness: 1, contrast: 1, rotation: 0 };
    },
    set: function (url, s) {
      if (s.brightness === 1 && s.contrast === 1 && s.rotation === 0) {
        delete State.editStates[url];
      } else {
        State.editStates[url] = { brightness: s.brightness, contrast: s.contrast, rotation: s.rotation };
      }
    },
    applyTo: function (card, s) {
      var media = card.querySelector('.card-img') || card.querySelector('.card-video');
      var wrap  = card.querySelector('.img-rotate-wrap');
      if (!media || !wrap) return;
      media.style.filter = (s.brightness !== 1 || s.contrast !== 1)
        ? 'brightness(' + s.brightness + ') contrast(' + s.contrast + ')' : '';
      wrap.style.transform = s.rotation !== 0 ? 'rotate(' + s.rotation + 'deg)' : '';
    }
  };

  var VideoState = {
    get: function (url) {
      var s = State.videoStates[url];
      return {
        time   : s && s.time    || 0,
        muted  : s ? s.muted    !== false : true,
        volume : s && typeof s.volume === 'number' ? s.volume : 1,
        rate   : s && s.rate    || 1
      };
    },
    set: function (url, s) {
      State.videoStates[url] = {
        time: s.time, muted: s.muted, volume: s.volume, rate: s.rate
      };
    },
    clear: function () { State.videoStates = Object.create(null); }
  };

  /* ════════════════════════════════════════════════════════
     EDIT MODE  (singleton — lazy panel wire-up)
  ════════════════════════════════════════════════════════ */
  var EditMode = (function () {
    var panel, activeCard = null, activeUrl = null;
    var saved = null, live = null;
    var refs  = null, ready = false;

    function ensure() {
      if (ready) return;
      ready = true;
      panel = $('editPanel');
      refs = {
        b: $('epBrightness'), c: $('epContrast'), r: $('epRotate'),
        bv: $('epBrightnessVal'), cv: $('epContrastVal'), rv: $('epRotateVal')
      };
      on(refs.b, 'input', function () { live.brightness = refs.b.value / 100; refs.bv.textContent = refs.b.value + '%'; preview(); });
      on(refs.c, 'input', function () { live.contrast   = refs.c.value / 100; refs.cv.textContent = refs.c.value + '%'; preview(); });
      on(refs.r, 'input', function () { live.rotation   = parseInt(refs.r.value, 10); refs.rv.textContent = refs.r.value + '\u00b0'; preview(); });
      on($('epRotCCW'), 'click', function () { live.rotation = normalise(live.rotation - 90); syncRot(); preview(); });
      on($('epRotCW'),  'click', function () { live.rotation = normalise(live.rotation + 90); syncRot(); preview(); });
      on($('epReset'),  'click', resetLive);
      on($('epCancel'), 'click', function () { exit(false); });
      on($('epDone'),   'click', function () { exit(true);  });
      on($('epClose'),  'click', function () { exit(false); });
    }
    function normalise(d) { while (d > 180) d -= 360; while (d < -180) d += 360; return d; }
    function syncRot()   { refs.r.value = live.rotation; refs.rv.textContent = live.rotation + '\u00b0'; }
    function preview()   { if (activeCard) EditState.applyTo(activeCard, live); }
    function resetLive() {
      live = { brightness: 1, contrast: 1, rotation: 0 };
      refs.b.value = 100; refs.bv.textContent = '100%';
      refs.c.value = 100; refs.cv.textContent = '100%';
      refs.r.value = 0;   refs.rv.textContent = '0\u00b0';
      preview();
    }
    function populate(s) {
      var b = Math.round(s.brightness * 100), c = Math.round(s.contrast * 100);
      refs.b.value = b; refs.bv.textContent = b + '%';
      refs.c.value = c; refs.cv.textContent = c + '%';
      refs.r.value = s.rotation; refs.rv.textContent = s.rotation + '\u00b0';
    }
    function enter(card, url) {
      if (activeCard === card) return;
      if (activeCard) exit(false);
      ensure();
      activeCard = card; activeUrl = url;
      saved = EditState.get(url);
      live  = { brightness: saved.brightness, contrast: saved.contrast, rotation: saved.rotation };
      populate(live);
      panel.classList.add('visible');
      panel.setAttribute('aria-hidden', 'false');
      document.body.classList.add('edit-active');
      card.classList.add('editing');
    }
    function exit(apply) {
      if (!activeCard) return;
      if (apply) { EditState.set(activeUrl, live); EditState.applyTo(activeCard, live); }
      else       { EditState.applyTo(activeCard, saved); }
      activeCard.classList.remove('editing');
      document.body.classList.remove('edit-active');
      panel.classList.remove('visible');
      panel.setAttribute('aria-hidden', 'true');
      activeCard = activeUrl = saved = live = null;
    }
    return {
      enter   : enter,
      exit    : exit,
      reset   : function () { if (activeCard) resetLive(); },
      isActive: function () { return activeCard !== null; }
    };
  })();

  /* ════════════════════════════════════════════════════════
     SHARED CARD CHROME  (header, url row, toolbar, remove)

     Eliminates the duplicate boilerplate that existed between
     image and video card factories.
  ════════════════════════════════════════════════════════ */
  var Chrome = (function () {
    function header(num, type) {
      var hdr = el('div', 'card-header');
      var lbl = type === 'video' ? 'Video ' : 'Image ';
      var tag = type === 'video' ? ' <span class="media-tag">VIDEO</span>' : '';
      var numEl = el('span', 'card-num'); numEl.innerHTML = lbl + num + tag;
      var dimsEl = el('span', 'card-dims');
      hdr.appendChild(numEl); hdr.appendChild(dimsEl);
      return { hdr: hdr, dimsEl: dimsEl, numEl: numEl };
    }

    function urlRow(url) {
      var row = el('div', 'card-url-row');
      var txt = el('span', 'card-url-text');
      txt.title = url; txt.textContent = url;
      row.appendChild(txt);
      return row;
    }

    function makeBtn(cls, label, title) {
      var b = el('button', cls); b.textContent = label;
      if (title) b.title = title;
      return b;
    }

    /* Builds Copy/Edit/Remove toolbar.
       opts: { url, onCopyLink, onEdit, onRemove } */
    function toolbar(opts) {
      var bar = el('div', 'card-toolbar');

      var copyBtn = makeBtn('tcopy', 'Copy Link');
      var copyTid = null;
      on(copyBtn, 'click', function (ev) {
        ev && ev.stopPropagation && ev.stopPropagation();
        var link = opts.onCopyLink ? opts.onCopyLink() : opts.url;
        var label = (typeof link === 'object' && link.label) ? link.label : 'Copied!';
        var text  = (typeof link === 'object') ? link.text : link;
        Util.copyToClipboard(text).then(function () {
          copyBtn.textContent = label;
          copyBtn.classList.remove('err');
          copyBtn.classList.add('ok');
          clearTimeout(copyTid);
          copyTid = setTimeout(function () {
            copyBtn.textContent = 'Copy Link';
            copyBtn.classList.remove('ok');
          }, 1700);
        }).catch(function () {
          /* Last-resort: surface the URL so the user can copy manually,
             and indicate failure rather than silently doing nothing. */
          copyBtn.textContent = 'Copy failed';
          copyBtn.classList.add('err');
          Toast.show('Could not copy automatically — link shown below.', 'err', 2400);
          try { window.prompt('Copy this link:', text); } catch (_) {}
          clearTimeout(copyTid);
          copyTid = setTimeout(function () {
            copyBtn.textContent = 'Copy Link';
            copyBtn.classList.remove('err');
          }, 2200);
        });
      });

      /* ── Download button (image cards only, opt-in via showDownload) ── */
      var dlBtn = null;
      if (opts.showDownload) {
        dlBtn = makeBtn('tdownload', 'Download');
        var dlTid = null;
        on(dlBtn, 'click', function (ev) {
          ev && ev.stopPropagation && ev.stopPropagation();
          if (dlBtn.disabled) return;
          dlBtn.textContent = 'Saving\u2026';
          dlBtn.classList.add('loading');
          dlBtn.disabled = true;
          Util.downloadImage(opts.url)
            .then(function () {
              dlBtn.textContent = 'Saved!';
              dlBtn.classList.remove('loading');
              dlBtn.classList.add('ok');
              dlBtn.disabled = false;
              clearTimeout(dlTid);
              dlTid = setTimeout(function () {
                dlBtn.textContent = 'Download';
                dlBtn.classList.remove('ok');
              }, 2000);
            })
            .catch(function () {
              /* Both direct fetch and the CORS proxy failed (e.g. the
                 host blocks all external access, or the user is offline).
                 Show a clear error state — never silently open a new tab. */
              dlBtn.textContent = 'Failed \u2715';
              dlBtn.classList.remove('loading');
              dlBtn.classList.add('err');
              dlBtn.disabled = false;
              clearTimeout(dlTid);
              dlTid = setTimeout(function () {
                dlBtn.textContent = 'Download';
                dlBtn.classList.remove('err');
              }, 3000);
            });
        });
      }

      var editBtn = makeBtn('tedit', 'Edit');
      on(editBtn, 'click', function () { opts.onEdit && opts.onEdit(editBtn); });

      var removeBtn = makeBtn('tremove', 'Remove');
      on(removeBtn, 'click', function () { opts.onRemove && opts.onRemove(); });

      bar.appendChild(copyBtn);
      if (dlBtn) bar.appendChild(dlBtn);
      bar.appendChild(editBtn);
      bar.appendChild(removeBtn);
      return bar;
    }

    /* Single removeCard helper used by both card types. */
    function removeCard(card, fallbackIdx, beforeRemove) {
      var parentSlot = card.closest('.vslot');
      var idx = parentSlot ? parseInt(parentSlot.dataset.idx, 10) : fallbackIdx;
      var url = State.allUrls[idx];

      if (typeof beforeRemove === 'function') beforeRemove();
      if (card.classList.contains('editing')) EditMode.exit(false);

      State.allUrls.splice(idx, 1);
      delete State.editStates[url];
      delete State.videoStates[url];

      var removedSlot = State.slots.splice(idx, 1)[0];
      State.activeSet.delete(removedSlot);

      for (var j = idx; j < State.slots.length; j++) {
        State.slots[j].dataset.idx = String(j);
        var cn = State.slots[j].querySelector('.card-num');
        if (cn) {
          var jt = getMediaType(State.allUrls[j]);
          var lbl = jt === 'video' ? 'Video ' : 'Image ';
          var tag = jt === 'video' ? ' <span class="media-tag">VIDEO</span>' : '';
          cn.innerHTML = lbl + (j + 1) + tag;
        }
      }
      refreshCount();
      card.classList.add('out');
      setTimeout(function () {
        if (State.observer) State.observer.unobserve(removedSlot);
        removedSlot.remove();
      }, 230);
    }

    return { header: header, urlRow: urlRow, toolbar: toolbar, removeCard: removeCard };
  })();

  /* ════════════════════════════════════════════════════════
     VIRTUAL GALLERY ENGINE
  ════════════════════════════════════════════════════════ */
  var Virtual = (function () {
    function makeUrlLabel(url) {
      var s = el('span', 'url-label');
      s.textContent = url;
      return s;
    }
    function makeSlot(i) {
      var slot = el('div', 'vslot');
      slot.style.minHeight = (State.currentMaxH === 'none' ? '200px' : State.currentMaxH);
      slot.dataset.idx = String(i);
      slot.appendChild(makeUrlLabel(State.allUrls[i]));
      return slot;
    }
    function activate(slot) {
      if (State.activeSet.has(slot)) return;
      var i = parseInt(slot.dataset.idx, 10);
      if (i >= State.allUrls.length) return;
      State.activeSet.add(slot);
      slot.innerHTML = '';
      var url = State.allUrls[i];
      slot.appendChild(
        getMediaType(url) === 'video' ? VideoCard.build(i) : ImageCard.build(i)
      );
    }
    function deactivate(slot) {
      if (!State.activeSet.has(slot)) return;
      State.activeSet.delete(slot);
      var box = slot.querySelector('.card-img-box');
      if (box && box._destroy) box._destroy();
      slot.querySelectorAll('img').forEach(function (img) { img.src = ''; });
      slot.querySelectorAll('video').forEach(function (v) {
        try { v.pause(); } catch (_) {}
        v.removeAttribute('src');
        try { v.load(); } catch (_) {}
      });
      slot.innerHTML = '';
      var i = parseInt(slot.dataset.idx, 10);
      if (i < State.allUrls.length) slot.appendChild(makeUrlLabel(State.allUrls[i]));
    }
    function rebuildObserver() {
      if (State.observer) State.observer.disconnect();
      /* Keep only ~1 screen of cards hot above/below the viewport so we
         scale to 1,000+ media items without exhausting memory or sockets.
         Inactive slots fully unload their <video src> in deactivate(). */
      State.observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) activate(e.target);
          else                  deactivate(e.target);
        });
      }, { root: null, rootMargin: '100% 0px 100% 0px', threshold: 0 });
      State.slots.forEach(function (s) { State.observer.observe(s); });
    }
    function clear() {
      if (State.observer) { State.observer.disconnect(); State.observer = null; }
      if (EditMode.isActive()) EditMode.exit(false);
      DOM.gallery.querySelectorAll('img').forEach(function (img) { img.src = ''; });
      DOM.gallery.querySelectorAll('video').forEach(function (v) {
        try { v.pause(); } catch (_) {}
        v.removeAttribute('src');
        try { v.load(); } catch (_) {}
      });
      DOM.gallery.innerHTML = '';
      State.allUrls = []; State.slots = []; State.activeSet = new Set();
      VideoState.clear();
      refreshCount();
    }
    function appendUrls(urls) {
      if (!urls || !urls.length) return;
      var startIdx = State.allUrls.length;
      State.allUrls = State.allUrls.concat(urls);
      var frag = document.createDocumentFragment();
      for (var i = 0; i < urls.length; i++) {
        var slot = makeSlot(startIdx + i);
        State.slots.push(slot);
        frag.appendChild(slot);
      }
      DOM.gallery.appendChild(frag);
      if (!State.observer) rebuildObserver();
      else State.slots.slice(startIdx).forEach(function (s) { State.observer.observe(s); });
      refreshCount();
    }
    return {
      makeSlot: makeSlot, rebuildObserver: rebuildObserver,
      clear: clear, appendUrls: appendUrls
    };
  })();

  /* ════════════════════════════════════════════════════════
     ZOOM + PAN  (shared by ImageCard and VideoCard)

     attachZoom(card, box, media, badge)
       card  — the outer .card element (editing-class gate)
       box   — the .card-img-box / .card-video-box (clip + cursor)
       media — the <img> or <video> element to transform
       badge — the .zoom-badge overlay element

     Returns { destroy, syncCursor, reset }.

     Zoom is gated by the global zoomOn() toggle (Z key / topbar).
     Scroll-wheel up/down zooms in/out around the cursor.
     Drag pans when s > 1.  Dbl-click resets or quick-zooms to 2.5×.
  ════════════════════════════════════════════════════════ */
  function attachZoom(card, box, media, badge) {
    var Z_MIN = 1, Z_MAX = 5, Z_FACTOR = 1.13;
    var s = 1, tx = 0, ty = 0;
    var inside = false, dragging = false, dragMoved = false;
    var sx = 0, sy = 0, tx0 = 0, ty0 = 0;
    var resetTid = null;

    function isEditing() { return card.classList.contains('editing'); }
    function clamp(ns, ntx, nty) {
      var bw = box.offsetWidth, bh = box.offsetHeight;
      return {
        tx: Math.min(0, Math.max(bw - bw * ns, ntx)),
        ty: Math.min(0, Math.max(bh - bh * ns, nty))
      };
    }
    function apply(animate) {
      media.style.transition = animate ? 'transform 0.27s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none';
      media.style.transform = 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + s.toFixed(4) + ')';
    }
    function syncBadge() {
      badge.textContent = s.toFixed(1) + '\u00d7';
      var z = s > 1.02;
      badge.classList.toggle('visible', z);
      box.classList.toggle('zoomed', z);
    }
    function syncCursor() {
      if (isEditing()) { box.classList.remove('zoom-ready', 'zoomed', 'zoom-drag'); return; }
      box.classList.toggle('zoom-ready', zoomOn() && s <= 1.02);
      box.classList.toggle('zoomed',     s > 1.02);
      if (!zoomOn() && s <= 1.02) box.classList.remove('zoom-ready', 'zoomed', 'zoom-drag');
    }
    function reset(animate) {
      clearTimeout(resetTid);
      s = 1; tx = 0; ty = 0;
      apply(animate !== false); syncBadge(); syncCursor();
    }

    on(box, 'wheel', function (e) {
      if (!zoomOn() || isEditing()) return;
      var r  = box.getBoundingClientRect();
      var cx = e.clientX - r.left, cy = e.clientY - r.top;
      if (cx < 0 || cy < 0 || cx > r.width || cy > r.height) return;
      e.preventDefault(); e.stopPropagation();
      var factor = e.deltaY < 0 ? Z_FACTOR : 1 / Z_FACTOR;
      var ns = Util.clamp(s * factor, Z_MIN, Z_MAX);
      if (ns === s) return;
      var c = clamp(ns, cx - (cx - tx) / s * ns, cy - (cy - ty) / s * ns);
      s = ns; tx = c.tx; ty = c.ty;
      apply(false); syncBadge(); syncCursor();
      clearTimeout(resetTid);
      if (s <= Z_MIN + 0.02) reset();
    }, { passive: false });

    on(box, 'mouseenter', function () { inside = true; clearTimeout(resetTid); syncCursor(); });
    on(box, 'mouseleave', function () {
      inside = false;
      if (!dragging && s > Z_MIN + 0.02) resetTid = setTimeout(reset, 700);
      syncCursor();
    });

    on(box, 'mousedown', function (e) {
      if (e.button !== 0 || !zoomOn() || s <= 1.02 || State.spaceHeld || isEditing()) return;
      e.preventDefault();
      dragging = true; dragMoved = false;
      sx = e.clientX; sy = e.clientY; tx0 = tx; ty0 = ty;
      clearTimeout(resetTid);
      box.classList.add('zoom-drag'); box.classList.remove('zoomed');
    });
    function onMove(e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
      var c = clamp(s, tx0 + dx, ty0 + dy);
      tx = c.tx; ty = c.ty;
      media.style.transition = 'none';
      media.style.transform = 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + s.toFixed(4) + ')';
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      box.classList.remove('zoom-drag'); box.classList.add('zoomed');
      syncCursor();
      if (!inside && s > Z_MIN + 0.02) resetTid = setTimeout(reset, 700);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);

    on(box, 'dblclick', function (e) {
      if (!zoomOn() || dragMoved || isEditing()) return;
      var r  = box.getBoundingClientRect();
      var cx = e.clientX - r.left, cy = e.clientY - r.top;
      if (s > 1.05) { reset(); }
      else {
        var ns = 2.5;
        var c = clamp(ns, cx - (cx - tx) / s * ns, cy - (cy - ty) / s * ns);
        s = ns; tx = c.tx; ty = c.ty;
        apply(true); syncBadge(); syncCursor();
      }
    });
    on(DOM.zoomEnabled, 'change', function () {
      if (!zoomOn() && s > 1.02) reset(); else syncCursor();
    });

    function destroy() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      clearTimeout(resetTid);
      dragging = false;
    }
    return { destroy: destroy, syncCursor: syncCursor, reset: reset };
  }

  /* ════════════════════════════════════════════════════════
     IMAGE CARD
  ════════════════════════════════════════════════════════ */
  var ImageCard = (function () {
    function build(ci) {
      var url = State.allUrls[ci];
      var card = el('div', 'card');
      var h = Chrome.header(ci + 1, 'image');
      var stored = EditState.get(url);

      /* Image box */
      var box = el('div', 'card-img-box');
      var spin = el('div', 'card-spinner', '<div class="spinner"></div>');
      box.appendChild(spin);

      var rotateWrap = el('div', 'img-rotate-wrap');
      var img = el('img', 'card-img');
      img.alt = 'Image ' + (ci + 1);
      img.decoding = 'async';
      img.draggable = false;
      img.style.transformOrigin = '0 0';
      img.style.maxHeight = State.currentMaxH;

      /* Restore persisted edit state */
      if (stored.brightness !== 1 || stored.contrast !== 1) {
        img.style.filter = 'brightness(' + stored.brightness + ') contrast(' + stored.contrast + ')';
      }
      if (stored.rotation !== 0) {
        rotateWrap.style.transform = 'rotate(' + stored.rotation + 'deg)';
      }

      on(img, 'load', function () {
        spin.remove();
        if (img.naturalWidth) h.dimsEl.textContent = img.naturalWidth + ' \u00d7 ' + img.naturalHeight;
        zoom.syncCursor();
      });
      on(img, 'error', function () {
        spin.remove();
        box.innerHTML = '<div class="card-err">\u26a0 Could not load<br>' +
                        '<small style="opacity:.4;word-break:break-all;">' + url + '</small></div>';
      });
      img.src = url;
      rotateWrap.appendChild(img);
      box.appendChild(rotateWrap);

      /* Zoom overlays */
      var badge = el('div', 'zoom-badge');
      var hint  = el('div', 'zoom-hint');
      hint.textContent = 'Scroll\u2022zoom    Drag\u2022pan    Dbl-click\u2022reset';
      box.appendChild(badge); box.appendChild(hint);

      var zoom = attachZoom(card, box, img, badge);
      box._destroy = zoom.destroy;
      zoom.syncCursor();

      /* Compose */
      card.appendChild(h.hdr);
      card.appendChild(box);
      card.appendChild(Chrome.urlRow(url));
      card.appendChild(Chrome.toolbar({
        url: url,
        showDownload: true,
        onEdit: function () {
          if (card.classList.contains('editing')) {
            EditMode.exit(false);
          } else {
            zoom.reset(false);
            EditMode.enter(card, url);
          }
        },
        onRemove: function () { Chrome.removeCard(card, ci, zoom.destroy); }
      }));
      return card;
    }

    return { build: build };
  })();

  /* ════════════════════════════════════════════════════════
     VIDEO CARD

     Layout:
       .card.card-video-card
         .card-header
         .card-img-box.card-video-box           ← media surface
           .img-rotate-wrap > video.card-video
           .video-play-overlay                  ← big play button when paused
           .video-progress-line                 ← thin gold strip, always visible
           .video-controls                      ← overlay bar, fades in on hover
             [⏮ ▶ ⏭]  scrubber  time  [speed]  [🔊 vol]  [📷]  [⛶]
         .card-url-row
         .card-toolbar (Copy/Edit/Remove)
  ════════════════════════════════════════════════════════ */
  var VideoCard = (function () {
    var PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
    var FRAME_STEP = 1 / 30;

    function build(ci) {
      var url = State.allUrls[ci];
      var stored = VideoState.get(url);

      var card = el('div', 'card card-video-card');
      var h = Chrome.header(ci + 1, 'video');

      /* Media surface */
      var box = el('div', 'card-img-box card-video-box');
      var spin = el('div', 'card-spinner', '<div class="spinner"></div>');
      box.appendChild(spin);

      var rotateWrap = el('div', 'img-rotate-wrap');
      var video = makeVideo(url, stored);
      rotateWrap.appendChild(video);
      box.appendChild(rotateWrap);

      /* Restore edit state for video */
      var storedEdit = EditState.get(url);
      if (storedEdit.brightness !== 1 || storedEdit.contrast !== 1) {
        video.style.filter = 'brightness(' + storedEdit.brightness + ') contrast(' + storedEdit.contrast + ')';
      }
      if (storedEdit.rotation !== 0) {
        rotateWrap.style.transform = 'rotate(' + storedEdit.rotation + 'deg)';
      }

      /* Big centred play overlay */
      var playOverlay = el('div', 'video-play-overlay',
        '<div class="video-play-icon">\u25B6</div>');
      box.appendChild(playOverlay);

      /* Zoom badge + hint — same overlay elements as ImageCard */
      var badge = el('div', 'zoom-badge');
      var hint  = el('div', 'zoom-hint');
      hint.textContent = 'Scroll\u2022zoom    Drag\u2022pan    Dbl-click\u2022reset';
      box.appendChild(badge); box.appendChild(hint);

      /* Attach scroll-wheel zoom identical to image zoom */
      video.style.transformOrigin = '0 0';
      var zoom = attachZoom(card, box, video, badge);
      zoom.syncCursor();

      /* Always-visible thin progress strip pinned to the bottom edge */
      var progressLine = el('div', 'video-progress-line');
      var progressFill = el('div', 'video-progress-fill');
      progressLine.appendChild(progressFill);
      box.appendChild(progressLine);

      /* Floating overlay controls bar */
      var controlsApi = buildControls(video, box, url);
      box.appendChild(controlsApi.bar);

      /* Hover preview disabled — videos remain paused until the user clicks.
         Controls bar reveals only while the cursor is moving over the video,
         and hides immediately when motion stops. */
      attachCursorReveal(box);

      /* Click toggles play/pause (ignore clicks on controls) */
      on(box, 'click', function (e) {
        if (e.target.closest('.video-controls') ||
            e.target.closest('.video-progress-line')) return;
        if (video._errored) return;
        if (video.paused) video.play().catch(function () {});
        else              video.pause();
      });

      /* Lifecycle: load/error/state-sync */
      var errored = false;
      on(video, 'loadedmetadata', function () {
        spin.remove();
        if (video.videoWidth) {
          h.dimsEl.textContent = video.videoWidth + ' \u00d7 ' + video.videoHeight +
                                 ' \u2022 ' + Util.fmtTime(video.duration);
        }
        if (stored.time > 0 && stored.time < video.duration) {
          try { video.currentTime = stored.time; } catch (_) {}
        }
        video.playbackRate = stored.rate || 1;
        controlsApi.onMetadata();
      });
      on(video, 'error', function () {
        if (errored) return;
        errored = true; video._errored = true;
        spin.remove();
        box.innerHTML = '<div class="card-err">\u26a0 Could not load video<br>' +
                        '<small style="opacity:.4;word-break:break-all;">' + url + '</small></div>';
      });

      function persist() {
        VideoState.set(url, {
          time  : video.currentTime,
          muted : video.muted,
          volume: video.volume,
          rate  : video.playbackRate
        });
      }
      on(video, 'play',  function () { box.classList.add('playing');    persist(); });
      on(video, 'pause', function () { box.classList.remove('playing'); persist(); });
      on(video, 'ended', function () { box.classList.remove('playing'); });
      on(video, 'timeupdate', function () {
        controlsApi.onTimeUpdate();
        if (video.duration > 0) {
          var pct = (video.currentTime / video.duration) * 100;
          progressFill.style.width = pct.toFixed(2) + '%';
        }
      });
      on(video, 'ratechange', function () { controlsApi.onRateChange(); persist(); });
      on(video, 'volumechange', function () { controlsApi.onVolumeChange(); persist(); });

      /* Frame-step helpers exposed for keyboard shortcuts */
      function frameStep(dir) {
        if (errored) return;
        video.pause();
        video.currentTime = Util.clamp(
          video.currentTime + dir * FRAME_STEP, 0, video.duration || 0
        );
      }

      /* Memory release hook */
      box._destroy = function () {
        try { video.pause(); } catch (_) {}
        persist();
        zoom.destroy();
        controlsApi.destroy();
        video.removeAttribute('src');
        try { video.load(); } catch (_) {}
      };

      /* Compose */
      card.appendChild(h.hdr);
      card.appendChild(box);
      card.appendChild(Chrome.urlRow(url));
      card.appendChild(Chrome.toolbar({
        url: url,
        onCopyLink: function () {
          /* Always copy the EXACT original URL the user provided — no
             timestamp fragment, no thumbnail-seed (#t=0.1) we added
             internally. This is the link the user expects to paste. */
          return { text: url, label: 'Copied!' };
        },
        onEdit: function () {
          if (card.classList.contains('editing')) { EditMode.exit(false); }
          else { video.pause(); zoom.reset(false); EditMode.enter(card, url); }
        },
        onRemove: function () { Chrome.removeCard(card, ci, box._destroy); }
      }));

      /* Expose for keyboard handler */
      card._video     = video;
      card._frameStep = frameStep;
      return card;
    }

    /* ── Build the underlying <video> element with sane defaults ──
       preload="auto" → the browser fetches enough data to begin
       playback immediately when the user hits play. Combined with
       virtualization (only ~3 screens of cards are mounted at any
       time), this is safe for 500+ video sets while still feeling
       instant. Videos always start PAUSED and MUTED. */
    function makeVideo(url, stored) {
      var v = document.createElement('video');
      v.className = 'card-video';
      v.preload   = 'auto';
      v.playsInline = true;
      /* Mute-by-default. Global "Mute All" overrides any per-video state
         on load; the user can still un-mute an individual video after. */
      v.muted   = GlobalVid.muteAll ? true : (stored.muted !== false);
      v.volume  = stored.volume;
      v.controls = false;
      v.crossOrigin = 'anonymous';     /* needed for snapshot toDataURL */
      v.style.maxHeight = State.currentMaxH;
      /* Render the first frame as a built-in thumbnail before playback. */
      v.setAttribute('preload', 'auto');
      try {
        var sep = url.indexOf('#') >= 0 ? '&' : '#';
        v.src = url + sep + 't=0.1';
      } catch (_) { v.src = url; }

      /* Cap concurrent playbacks: when this video starts, pause every
         other one in the gallery.  Keeps decoder + network usage flat
         even when thousands of cards are mounted. */
      v.addEventListener('play', function () {
        var all = document.querySelectorAll('video.card-video');
        for (var i = 0; i < all.length; i++) {
          if (all[i] !== v && !all[i].paused) {
            try { all[i].pause(); } catch (_) {}
          }
        }
      });
      /* Apply global playback rate as soon as metadata is ready. */
      v.addEventListener('loadedmetadata', function () {
        try { v.playbackRate = GlobalVid.rate; } catch (_) {}
      });
      return v;
    }

    /* ── Cursor-reveal: show controls while pointer is moving, and KEEP
         them visible whenever the pointer is hovering the control bar
         itself (so users can comfortably click play / scrub / etc.). ── */
    function attachCursorReveal(box) {
      var IDLE_MS = 90;          /* hides almost immediately when cursor stops */
      var idleTimer = 0;
      var overBar  = false;      /* pointer is currently inside .video-controls */

      function show() {
        box.classList.add('cursor-active');
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
        /* Don't start the hide-timer while the cursor is parked on
           the control bar — the bar must stay fully visible. */
        if (!overBar) idleTimer = setTimeout(hide, IDLE_MS);
      }
      function hide() {
        idleTimer = 0;
        if (overBar) return;     /* safety: never hide while on the bar */
        box.classList.remove('cursor-active');
      }

      on(box, 'mousemove',  show);
      on(box, 'mouseenter', show);
      on(box, 'mouseleave', function () {
        overBar = false;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
        hide();
      });
      on(box, 'mousedown',   show);
      on(box, 'pointerdown', show);
      on(box, 'focusin',     show);
      on(box, 'touchstart',  show);

      /* Track the pointer relative to the control bar.  We attach
         listeners after a microtask so the bar element exists. */
      Promise.resolve().then(function () {
        var bar = box.querySelector('.video-controls');
        if (!bar) return;
        on(bar, 'mouseenter', function () {
          overBar = true;
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
          box.classList.add('cursor-active');
        });
        on(bar, 'mouseleave', function () {
          overBar = false;
          show();                /* restart idle timer */
        });
      });
    }

    /* ── Hover preview ── */
    function attachHoverPreview(box, video) {
      var hover = false;
      on(box, 'mouseenter', function () {
        if (video._errored || video.readyState < 1) return;
        if (video.paused && video.currentTime < (video.duration || 1) - 0.1) {
          hover = true;
          var p = video.play();
          if (p && p.catch) p.catch(function () { hover = false; });
        }
      });
      on(box, 'mouseleave', function () {
        if (hover && !video.paused) { video.pause(); hover = false; }
      });
    }

    /* ── Controls bar (floating overlay) ──
       Returns { bar, onMetadata, onTimeUpdate, onRateChange, onVolumeChange, destroy } */
    function buildControls(video, box, url) {
      var bar = el('div', 'video-controls');

      /* Left cluster: frame step / play / frame step */
      var prevBtn = mkBtn('vc-btn', '\u23EE', 'Previous frame (,)');
      var playBtn = mkBtn('vc-btn vc-play', '\u25B6', 'Play / Pause (Space)');
      var nextBtn = mkBtn('vc-btn', '\u23ED', 'Next frame (.)');

      on(prevBtn, 'click', function (e) { e.stopPropagation();
        video.pause();
        video.currentTime = Util.clamp(video.currentTime - FRAME_STEP, 0, video.duration || 0);
      });
      on(nextBtn, 'click', function (e) { e.stopPropagation();
        video.pause();
        video.currentTime = Util.clamp(video.currentTime + FRAME_STEP, 0, video.duration || 0);
      });
      on(playBtn, 'click', function (e) { e.stopPropagation();
        if (video.paused) video.play().catch(function () {});
        else              video.pause();
      });
      on(video, 'play',  function () { playBtn.textContent = '\u2759\u2759'; });
      on(video, 'pause', function () { playBtn.textContent = '\u25B6'; });

      /* Scrubber */
      var seek = document.createElement('input');
      seek.type = 'range'; seek.className = 'vc-seek';
      seek.min = '0'; seek.max = '0'; seek.step = 'any'; seek.value = '0';
      var scrubbing = false;
      on(seek, 'input',  function ()  {
        scrubbing = true;
        timeEl.textContent = Util.fmtTime(parseFloat(seek.value)) +
                             ' / ' + Util.fmtTime(video.duration || 0);
      });
      on(seek, 'change', function ()  {
        video.currentTime = parseFloat(seek.value);
        scrubbing = false;
      });
      on(seek, 'click',  Util.stop);

      var timeEl = el('span', 'vc-time'); timeEl.textContent = '0:00 / 0:00';

      /* Speed slider — drag to change playback rate. Double-click the
         badge to snap back to 1×. Mirrors the global Speed All slider. */
      var speedWrap = el('span', 'vc-speedwrap');
      var speedBar  = document.createElement('input');
      speedBar.type = 'range'; speedBar.className = 'vc-speedbar';
      speedBar.min = '0.25'; speedBar.max = '4'; speedBar.step = '0.05';
      speedBar.value = String(video.playbackRate || 1);
      speedBar.title = 'Playback speed';
      var speedBtn = mkBtn('vc-btn vc-speed', '1\u00D7', 'Double-click to reset speed');
      on(speedBar, 'input', function (e) {
        e.stopPropagation();
        video.playbackRate = parseFloat(speedBar.value);
      });
      on(speedBar, 'click', Util.stop);
      on(speedBtn, 'dblclick', function (e) {
        e.stopPropagation();
        video.playbackRate = 1;
        speedBar.value = '1';
      });
      speedWrap.appendChild(speedBar);
      speedWrap.appendChild(speedBtn);

      /* Mute / volume */
      var muteBtn = mkBtn('vc-btn', '\uD83D\uDD0A', 'Mute (M)');
      var volBar  = document.createElement('input');
      volBar.type = 'range'; volBar.className = 'vc-vol';
      volBar.min = '0'; volBar.max = '1'; volBar.step = '0.01';
      volBar.value = String(video.volume);
      on(muteBtn, 'click', function (e) {
        e.stopPropagation();
        video.muted = !video.muted;
      });
      on(volBar, 'input', function (e) {
        e.stopPropagation();
        video.volume = parseFloat(volBar.value);
        video.muted = video.volume === 0;
      });
      on(volBar, 'click', Util.stop);

      /* Snapshot — capture current frame as a new image entry */
      var snapBtn = mkBtn('vc-btn vc-snap', '\uD83D\uDCF7', 'Capture frame as image');
      on(snapBtn, 'click', function (e) {
        e.stopPropagation();
        try {
          var canvas = document.createElement('canvas');
          canvas.width  = video.videoWidth  || 1280;
          canvas.height = video.videoHeight || 720;
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          var dataUrl = canvas.toDataURL('image/png');
          Virtual.appendUrls([dataUrl]);
          snapBtn.classList.add('ok');
          setTimeout(function () { snapBtn.classList.remove('ok'); }, 1200);
        } catch (err) {
          Toast.show('Snapshot blocked (cross-origin video).', 'err', 3500);
        }
      });

      /* Fullscreen */
      var fsBtn = mkBtn('vc-btn', '\u26F6', 'Fullscreen');
      on(fsBtn, 'click', function (e) {
        e.stopPropagation();
        if (box.requestFullscreen) box.requestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      });

      [prevBtn, playBtn, nextBtn, seek, timeEl, speedWrap, muteBtn, volBar, snapBtn, fsBtn]
        .forEach(function (n) { bar.appendChild(n); });

      function onMetadata() {
        seek.max = String(video.duration || 0);
        onTimeUpdate();
      }
      function onTimeUpdate() {
        if (!scrubbing) seek.value = String(video.currentTime || 0);
        timeEl.textContent = Util.fmtTime(video.currentTime || 0) +
                             ' / ' + Util.fmtTime(video.duration || 0);
      }
      function onRateChange() {
        var r = video.playbackRate;
        speedBtn.textContent = (Number.isInteger(r) ? r : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + '\u00D7';
        speedBtn.classList.toggle('alt', r !== 1);
        if (parseFloat(speedBar.value) !== r) speedBar.value = String(r);
      }
      function onVolumeChange() {
        muteBtn.textContent = (video.muted || video.volume === 0)
          ? '\uD83D\uDD07' : '\uD83D\uDD0A';
        volBar.value = String(video.muted ? 0 : video.volume);
      }
      function destroy() { /* event listeners live on controls subtree; GC handles them */ }

      onRateChange(); onVolumeChange();
      return { bar: bar, onMetadata: onMetadata, onTimeUpdate: onTimeUpdate,
               onRateChange: onRateChange, onVolumeChange: onVolumeChange, destroy: destroy };
    }

    function mkBtn(cls, label, title) {
      var b = el('button', cls); b.textContent = label;
      if (title) b.title = title;
      return b;
    }

    return { build: build };
  })();

  /* ════════════════════════════════════════════════════════
     HOVER TRACKING (used by keyboard shortcuts)
  ════════════════════════════════════════════════════════ */
  on(document, 'mouseover', function (e) {
    var t = e.target;
    State.hoveredBox        = (t.closest && t.closest('.card-img-box')) || null;
    State.hoveredVideoCard  = (t.closest && t.closest('.card-video-card')) || null;
  }, { passive: true });

  /* ════════════════════════════════════════════════════════
     KEYBOARD
  ═══════════════════════════════════════��════════════════ */
  (function Keyboard() {
    var scrollVel = 0, scrollDir = 0, scrollRaf = null;
    var held = Object.create(null);

    function tick() {
      if (scrollDir === 0) return;
      var p = getScrollPreset();
      scrollVel = Math.min(p.max, scrollVel + p.ramp);
      window.scrollBy({ top: scrollDir * scrollVel, behavior: 'instant' });
      scrollRaf = requestAnimationFrame(tick);
    }
    function start(dir) {
      if (scrollDir === dir) return;
      cancelAnimationFrame(scrollRaf);
      scrollDir = dir; scrollVel = getScrollPreset().base;
      scrollRaf = requestAnimationFrame(tick);
    }
    function stop() { cancelAnimationFrame(scrollRaf); scrollDir = 0; scrollVel = 0; }

    function handleVideoShortcut(e) {
      var card = State.hoveredVideoCard;
      if (!card) return false;
      var v = card._video;
      if (!v) return false;
      var k = e.key;

      if (k === ',' || (k === 'ArrowLeft'  && (e.shiftKey || e.altKey))) {
        e.preventDefault(); card._frameStep && card._frameStep(-1); return true;
      }
      if (k === '.' || (k === 'ArrowRight' && (e.shiftKey || e.altKey))) {
        e.preventDefault(); card._frameStep && card._frameStep( 1); return true;
      }
      var lower = k.toLowerCase();
      if (lower === 'j' && !e.repeat) {
        e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); return true;
      }
      if (lower === 'l' && !e.repeat) {
        e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); return true;
      }
      if (lower === 'm' && !e.repeat) {
        e.preventDefault(); v.muted = !v.muted; return true;
      }
      return false;
    }

    on(document, 'keydown', function (e) {
      /* Space: play/pause hovered video, otherwise block native scroll */
      if (e.code === 'Space') {
        e.preventDefault();
        if (!Util.isTyping() && State.hoveredVideoCard && State.hoveredVideoCard._video) {
          var v = State.hoveredVideoCard._video;
          if (v.paused) v.play().catch(function () {}); else v.pause();
          return;
        }
        State.spaceHeld = true;
        return;
      }

      if (!Util.isTyping() && handleVideoShortcut(e)) return;

      if (e.key === 'Escape') {
        if (EditMode.isActive()) EditMode.exit(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        if (EditMode.isActive()) { e.preventDefault(); EditMode.reset(); }
        return;
      }
      if (Util.isTyping()) return;

      var k = e.key;
      /* Ignore F when Ctrl/Cmd is held so the browser's native Find
         (Ctrl+F / Cmd+F) works normally instead of toggling fullscreen. */
      if (k.toLowerCase() === 'f' && !e.repeat && !e.ctrlKey && !e.metaKey) {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        } else {
          document.exitFullscreen && document.exitFullscreen();
        }
        return;
      }
      if (k.toLowerCase() === 'z' && !e.repeat) {
        DOM.zoomEnabled.checked = !DOM.zoomEnabled.checked;
        DOM.zoomEnabled.dispatchEvent(new Event('change'));
        return;
      }
      if ((k === '+' || k === '=') && !e.repeat) {
        DOM.sizer.value = String(Math.min(10, parseInt(DOM.sizer.value, 10) + 1));
        applySize(parseInt(DOM.sizer.value, 10));
        return;
      }
      if (k === '-' && !e.repeat) {
        DOM.sizer.value = String(Math.max(1, parseInt(DOM.sizer.value, 10) - 1));
        applySize(parseInt(DOM.sizer.value, 10));
        return;
      }
      var isUp   = (k === 'w' || k === 'ArrowUp'   || k === 'ArrowLeft');
      var isDown = (k === 's' || k === 'ArrowDown' || k === 'ArrowRight');
      if ((isUp || isDown) && !e.repeat) {
        e.preventDefault();
        held[k] = true;
        start(isDown ? 1 : -1);
      }
    });
    on(document, 'keyup', function (e) {
      if (e.code === 'Space') { State.spaceHeld = false; return; }
      delete held[e.key];
      var any = held['w'] || held['s'] || held['ArrowUp'] || held['ArrowDown'] ||
                held['ArrowLeft'] || held['ArrowRight'];
      if (!any) stop();
    });
    on(window, 'blur', function () {
      stop(); held = Object.create(null); State.spaceHeld = false;
    });
  })();

  /* ════════════════════════════════════════════════════════
     BULK LOAD
  ════════════════════════════════════════════════════════ */
  on(DOM.bulkLoadBtn, 'click', async function () {
    if (State.isLoading) return;
    var urls = parseUrls(DOM.bulkArea.value).filter(isValidUrl);
    if (!urls.length) { Toast.show('No valid URLs found.', 'err'); return; }

    State.isLoading = true;
    DOM.bulkLoadBtn.disabled = true;

    if (!DOM.appendMode.checked) Virtual.clear();

    var startIdx = State.allUrls.length;
    State.allUrls = State.allUrls.concat(urls);

    DOM.progWrap.classList.remove('hide');
    DOM.progFill.style.width = '0%';
    DOM.progLabel.textContent = 'Building ' + urls.length + ' slots\u2026';

    if (State.observer) State.observer.disconnect();

    var CHUNK = 200;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < urls.length; i++) {
      var slot = Virtual.makeSlot(startIdx + i);
      State.slots.push(slot);
      frag.appendChild(slot);

      if ((i + 1) % CHUNK === 0 || i === urls.length - 1) {
        DOM.gallery.appendChild(frag);
        frag = document.createDocumentFragment();
        DOM.progFill.style.width = Math.round(((i + 1) / urls.length) * 100) + '%';
        DOM.progLabel.textContent = (i + 1) + ' / ' + urls.length + ' slots placed\u2026';
        refreshCount();
        await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
      }
    }
    Virtual.rebuildObserver();

    var nVid = urls.filter(function (u) { return getMediaType(u) === 'video'; }).length;
    var nImg = urls.length - nVid;
    var summary = urls.length + ' item' + (urls.length !== 1 ? 's' : '') + ' loaded' +
                  (nVid ? ' (' + nImg + ' image' + (nImg !== 1 ? 's' : '') +
                          ', ' + nVid + ' video' + (nVid !== 1 ? 's' : '') + ')' : '') + '.';
    DOM.progLabel.textContent = urls.length + ' items ready!';
    Toast.show(summary, 'ok', 4000);
    setTimeout(function () { DOM.progWrap.classList.add('hide'); DOM.progFill.style.width = '0%'; }, 2400);
    DOM.bulkArea.value = '';
    DOM.bulkTally.innerHTML = '<b>0</b> URLs';
    State.isLoading = false;
    DOM.bulkLoadBtn.disabled = false;
  });

  on(DOM.bulkClearBtn, 'click', function () {
    DOM.bulkArea.value = '';
    DOM.bulkTally.innerHTML = '<b>0</b> URLs';
  });

  on(DOM.clearAllBtn, 'click', Virtual.clear);

  /* ════════════════════════════════════════════════════════
     GLOBAL VIDEO CONTROLS  (Pause All / Mute All / Speed All)
  ════════════════════════════════════════════════════════ */
  (function GlobalControls() {
    function allVideos() {
      return document.querySelectorAll('video.card-video');
    }

    /* PAUSE ALL */
    on(DOM.pauseAllBtn, 'click', function () {
      var vids = allVideos();
      var paused = 0;
      vids.forEach(function (v) {
        if (!v.paused) { try { v.pause(); paused++; } catch (_) {} }
      });
      Toast.show(paused
        ? 'Paused ' + paused + ' video' + (paused !== 1 ? 's' : '') + '.'
        : 'No videos were playing.', 'ok', 1800);
    });

    /* MUTE ALL — toggles. When ON, every current AND future video is muted. */
    function syncMuteBtn() {
      DOM.muteAllBtn.classList.toggle('active', GlobalVid.muteAll);
      DOM.muteAllBtn.innerHTML = GlobalVid.muteAll
        ? '\uD83D\uDD07 Unmute All'
        : '\uD83D\uDD0A Mute All';
    }
    on(DOM.muteAllBtn, 'click', function () {
      GlobalVid.muteAll = !GlobalVid.muteAll;
      allVideos().forEach(function (v) {
        try { v.muted = GlobalVid.muteAll; } catch (_) {}
      });
      syncMuteBtn();
    });
    syncMuteBtn();

    /* SPEED ALL — slider sets a global playback rate for every video. */
    function fmtRate(r) {
      if (r === 1) return '1.00\u00D7';
      return r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '\u00D7';
    }
    function applyGlobalRate(r) {
      GlobalVid.rate = r;
      DOM.globalSpeedBadge.textContent = fmtRate(r);
      DOM.globalSpeedBadge.parentElement.classList.toggle('alt', r !== 1);
      allVideos().forEach(function (v) {
        try { v.playbackRate = r; } catch (_) {}
      });
    }
    on(DOM.globalSpeed, 'input', function () {
      applyGlobalRate(parseFloat(DOM.globalSpeed.value));
    });
    /* Double-click the badge to snap back to 1×. */
    on(DOM.globalSpeedBadge, 'dblclick', function () {
      DOM.globalSpeed.value = '1';
      applyGlobalRate(1);
    });
    applyGlobalRate(parseFloat(DOM.globalSpeed.value));
  })();

  /* ════════════════════════════════════════════════════════
     BACK TO TOP
  ════════════════════════════════════════════════════════ */
  on(window, 'scroll', function () {
    DOM.btt.classList.toggle('show', window.scrollY > 280);
  }, { passive: true });
  on(DOM.btt, 'click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  refreshCount();
})();
