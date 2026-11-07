/* ════════════════════════════════════════════════════════════
   BAT-VIEWER  app.js  v19

   HIGHLIGHTS (v19) — performance, accessibility, privacy:
   ─ Code splitting: this file is the core. The video player, Edit
     panel, Common Notes dialog and "retry all failed" run live in
     chunks/*.js and are fetched only when first needed (see Chunks).
   ─ Pagination: a load builds the first PAGE (100) slots; more are
     added as the page-end sentinel nears the viewport, or with the
     "Load more / Load all" buttons. State.allUrls still holds every
     link, so the count, Append and Clear behave exactly as before.
   ─ Cheaper work: sizing is one CSS-variable write instead of a
     style write on every card; media-type detection and content-type
     probes are cached; probes run through a small bounded queue;
     input handlers are debounced / frame-throttled.
   ─ Privacy: the theme is only written to localStorage after an
     explicit choice (Consent). "Delete my data" wipes everything.
   ─ Accessibility: real labels/alt text, focus management, keyboard
     handling that no longer swallows Space on focused buttons.
   ─ Rotation (Edit) fits the card: a rotated picture is sized as a
     picture of its new shape and the card makes room for it, so it
     is never clipped and never covers the card's buttons (RotateFit).
   ─ v18 fallback logic, Edit/Video/Note state, zoom and the single
     IntersectionObserver are unchanged.

   HIGHLIGHTS (v18) — Intelligent Fast Media Format Fallback:
   ─ The image<->video swap-on-error fallback (trySwapMediaType) now
     fires on ANY first-load failure, not just genuinely ambiguous
     URLs (no extension/MIME hint). A confidently-typed URL (real
     .jpg/.mp4 extension, S3 MIME hint) that fails now also gets one
     fast, immediate shot at the other format before being marked
     failed, instead of going straight to the failed/retry state.
   ─ That widened fallback is loop-safe (State.fallbackAttempted caps
     it at one swap per URL, independent of type memory) and doesn't
     corrupt future type detection: a confidently-typed URL's swap is
     only remembered if it actually succeeds. If both formats fail,
     no override is left behind, so a later re-render or retry tries
     the correct original format again instead of getting stuck.
   ─ Failure reasons (native video MediaError detail, or which format
     failed first when both were tried) are now stored on
     MediaState[url].failReason and logged via console.warn for
     debugging — nothing new in the UI itself.

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
    /* Fully release a <video>'s network/decoder resources. Safe to call
       even if the element has no src or is mid-teardown. */
    function unloadVideo(v) {
      try { v.pause(); } catch (_) {}
      v.removeAttribute('src');
      try { v.load(); } catch (_) {}
    }
    function stop(e) { e.stopPropagation(); }
    /* A text box, slider or checkbox has focus, so letters/arrows/Space belong to
       it. The two header switches are checkboxes too, but they take no text: after
       a mouse click on one of them the page shortcuts must keep working (they
       always did — those inputs used to be unfocusable). */
    function isTyping() {
      var a = document.activeElement;
      if (!a) return false;
      if (a.tagName === 'INPUT') return a.getAttribute('role') !== 'switch';
      return a.tagName === 'TEXTAREA' || !!a.isContentEditable;
    }

    /* Keyboard or mouse? Space is the play/pause key for a hovered video, but it
       must also press a button the keyboard user has Tabbed to. A button that is
       merely still focused after a MOUSE click must not take Space away from the
       video, so remember what the visitor is using: Tab switches to "keyboard",
       any press of the mouse/finger switches back. (:focus-visible cannot tell:
       Chrome sets it on the focused button at the moment any key goes down.)
       Focus that arrives with its ring showing before any mouse use at all — a
       Tab in from the address bar — counts as keyboard too. */
    var keyboardMode = false, pointerSeen = false;
    function usePointer() { keyboardMode = false; pointerSeen = true; }
    on(document, 'pointerdown', usePointer, true);
    on(document, 'mousedown',   usePointer, true);          /* browsers without pointer events */
    on(document, 'keydown', function (e) { if (e.key === 'Tab') keyboardMode = true; }, true);
    on(document, 'focusin', function (e) {
      if (pointerSeen || keyboardMode) return;
      try { if (e.target.matches(':focus-visible')) keyboardMode = true; } catch (_) {}
    }, true);

    /* True while the keyboard user's focus is on a control that Space should
       activate (a button, a <select>, a role=button/switch) — the global Space
       shortcut leaves those alone. */
    function isInteractive() {
      if (!keyboardMode) return false;
      var a = document.activeElement;
      if (!a || a === document.body) return false;
      var role = a.getAttribute && a.getAttribute('role');
      return /^(BUTTON|SELECT|SUMMARY)$/.test(a.tagName) || role === 'button' || role === 'switch';
    }
    /* Trailing debounce: runs `fn` once calls have stopped for `ms`.
       .flush() runs a pending call right now; .cancel() drops it. */
    function debounce(fn, ms) {
      var tid = 0, lastArgs = null, lastThis = null;
      function run() { tid = 0; var a = lastArgs, t = lastThis; lastArgs = lastThis = null; fn.apply(t, a); }
      function debounced() { lastArgs = arguments; lastThis = this; clearTimeout(tid); tid = setTimeout(run, ms); }
      debounced.flush  = function () { if (tid) { clearTimeout(tid); run(); } };
      debounced.cancel = function () { clearTimeout(tid); tid = 0; lastArgs = lastThis = null; };
      return debounced;
    }
    /* At most one call per animation frame; the latest arguments win. */
    function rafThrottle(fn) {
      var id = 0, lastArgs = null, lastThis = null;
      function run() { id = 0; var a = lastArgs, t = lastThis; lastArgs = lastThis = null; fn.apply(t, a); }
      function throttled() { lastArgs = arguments; lastThis = this; if (!id) id = requestAnimationFrame(run); }
      throttled.cancel = function () { if (id) cancelAnimationFrame(id); id = 0; lastArgs = lastThis = null; };
      return throttled;
    }
    function prefersReducedMotion() {
      try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
      catch (_) { return false; }
    }
    var uidCounter = 0;
    function uid(prefix) { return prefix + (++uidCounter); }
    /* Screen-reader description for a pasted link. We know nothing about the
       picture itself, so use what the link does tell us: a real-looking file
       name, otherwise the host it comes from. `kind` is 'Image' or 'Video'. */
    function mediaLabel(url, kind) {
      try {
        var u = new URL(url);
        if (u.protocol === 'data:' || u.protocol === 'blob:') return 'Embedded ' + kind.toLowerCase();
        var seg = u.pathname.split('/').pop();
        try { seg = decodeURIComponent(seg); } catch (_) {}
        if (seg && seg.length <= 80 && /\.[a-z0-9]{2,5}$/i.test(seg) && !/^[0-9a-f-]{24,}\./i.test(seg)) return seg;
        return kind + ' from ' + u.hostname;
      } catch (_) { return kind; }
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
        var prev = document.activeElement;   /* put focus back afterwards (keyboard users) */
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.setAttribute('aria-hidden', 'true');
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          ta.setSelectionRange(0, ta.value.length);
          var ok = document.execCommand('copy');
          ta.remove();
          if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (_) {} }
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
    return {
      $: $, el: el, on: on, stop: stop, isTyping: isTyping, isInteractive: isInteractive,
      clamp: clamp, fmtTime: fmtTime, copyToClipboard: copyToClipboard,
      unloadVideo: unloadVideo, debounce: debounce, rafThrottle: rafThrottle,
      prefersReducedMotion: prefersReducedMotion, uid: uid, mediaLabel: mediaLabel
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
    script       : $('bvScript'),
    pageBody     : $('pageBody'),
    gallery      : $('gallery'),
    gallerySentinel : $('gallerySentinel'),
    galleryMore  : $('galleryMore'),
    galleryMoreText : $('galleryMoreText'),
    loadMoreBtn  : $('loadMoreBtn'),
    loadAllBtn   : $('loadAllBtn'),
    gShown       : $('gShown'),
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
    zoomEnabled           : $('zoomEnabled'),
    retryVisibleFailedBtn : $('retryVisibleFailedBtn'),
    themeToggle           : $('themeToggle'),
    themeIcon    : $('themeIcon'),
    themeName    : $('themeName'),
    helpBtn      : $('helpBtn'),
    helpTooltip  : $('helpTooltip'),
    topbar       : $('topbar'),
    logoText     : document.querySelector('.logo-text'),
    commonNotesBtn : $('commonNotesBtn'),
    consentBanner  : $('consentBanner'),
    consentAllow   : $('consentAllow'),
    consentDeny    : $('consentDeny'),
    privacySettingsBtn : $('privacySettingsBtn'),
    deleteDataBtn      : $('deleteDataBtn'),
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
    noteStates : Object.create(null),
    mediaStates: Object.create(null),
    retryWaiters: Object.create(null),
    videoOverrides: new Set(), /* URLs confirmed as video via probe fallback */
    imageOverrides: new Set(), /* URLs confirmed as image via fallback */
    fallbackAttempted: new Set(), /* URLs that already had ONE cross-format
      fallback attempt (image<->video) triggered — independent of the
      override sets above, so a confidently-typed URL can get a one-shot
      fallback try without that attempt permanently overwriting its type
      if the fallback also fails. See trySwapMediaType(). */
    spaceHeld  : false,
    hoveredVideoCard: null
  };

  var MEDIA_STATUS = {
    LOADED : 'loaded',
    LOADING: 'loading',
    FAILED : 'failed'
  };

  var RETRY_CONFIG = {
    maxRetries : 3,
    concurrency: 4,
    delayMs    : 220,
    backoffMs  : 260
  };

  var MediaState = {
    get: function (url) {
      var s = State.mediaStates[url];
      if (!s) {
        s = State.mediaStates[url] = {
          status: null,
          type: null,
          retryCount: 0,
          failReason: null
        };
      }
      return s;
    },
    /* `reason` is optional and only meaningful alongside FAILED — kept on
       the state object (not shown in the UI) so it's inspectable from the
       console for debugging (window doesn't expose State, but this is
       reachable via a breakpoint/log) when a media item won't load. */
    set: function (url, status, type, reason) {
      var s = MediaState.get(url);
      s.status = status;
      if (type) s.type = type;
      if (status === MEDIA_STATUS.LOADED) { s.retryCount = 0; s.failReason = null; }
      if (status === MEDIA_STATUS.FAILED && reason) {
        s.failReason = reason;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[BAT Viewer] media failed to load:', url, '\u2014', reason);
        }
      }
      return s;
    },
    beginRetry: function (url, type, applyLimit) {
      var s = MediaState.get(url);
      if (applyLimit && s.retryCount >= RETRY_CONFIG.maxRetries) return false;
      if (applyLimit) s.retryCount++;
      s.status = MEDIA_STATUS.LOADING;
      if (type) s.type = type;
      return true;
    },
    canRetry: function (url) {
      return MediaState.get(url).retryCount < RETRY_CONFIG.maxRetries;
    },
    /* Base delay, plus an escalating backoff once beginRetry(url, type, true)
       has bumped retryCount (automatic/limited retries only). Shared formula
       — was duplicated identically in ImageCard.retryImage and
       VideoCard.retryVideo. */
    retryDelay: function (url, applyLimit) {
      return RETRY_CONFIG.delayMs + (applyLimit === true
        ? (MediaState.get(url).retryCount - 1) * RETRY_CONFIG.backoffMs : 0);
    },
    clear: function () {
      State.mediaStates = Object.create(null);
    },
    remove: function (url) {
      delete State.mediaStates[url];
    }
  };

  /* ════════════════════════════════════════════════════════
     STATUS / TOAST
  ════════════════════════════════════════════════════════ */
  var Toast = (function () {
    var tid = null, clearTid = null;
    function show(msg, cls, ms) {
      clearTimeout(tid); clearTimeout(clearTid);
      DOM.statusMsg.textContent = msg;
      DOM.statusMsg.className = 'status ' + (cls || 'ok');
      tid = setTimeout(function () {
        DOM.statusMsg.className = 'status hide';
        /* Once it has faded out, empty the live region so screen-reader
           browse mode doesn't keep finding a stale message. */
        clearTid = setTimeout(function () { DOM.statusMsg.textContent = ''; }, 400);
      }, ms || 3000);
    }
    return { show: show };
  })();

  /* onRetry is optional: without it this is just the loading skeleton
     (used for the placeholder shown while a code chunk is still arriving). */
  function makeLoadingSpinner(onRetry) {
    var spin = el('div', 'card-spinner');
    spin.appendChild(el('div', 'spinner'));
    if (typeof onRetry !== 'function') return spin;
    var retryBtn = el('button', 'card-loading-retry-btn');
    retryBtn.type = 'button';
    retryBtn.textContent = 'Retry';
    retryBtn.title = 'Cancel this request and retry this media';
    on(retryBtn, 'click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onRetry();
    });
    spin.appendChild(retryBtn);
    return spin;
  }

  function waitForMediaRetry(url) {
    return new Promise(function (resolve) {
      State.retryWaiters[url] = resolve;
    });
  }

  function resolveMediaRetry(url, ok) {
    var resolve = State.retryWaiters[url];
    if (resolve) {
      delete State.retryWaiters[url];
      resolve(ok);
    }
  }

  /* ════════════════════════════════════════════════════════
     CHUNKS  (code that is fetched only when it is first needed)

     chunks/*.js are plain scripts that register themselves:
         BVChunk('video-card', function (bv) { ...; return api; });
     `bv` hands them the few core pieces they use (see internals()).
     Chunks.load(name) fetches the file once (same-origin, so the
     `script-src 'self'` policy allows it), runs the factory once and
     resolves with its API. A failed fetch can simply be tried again.

     build.js writes the hashed file names into the script tag's
     data-chunks attribute; in a plain checkout (no build) the files
     are looked up as chunks/<name>.js.
  ════════════════════════════════════════════════════════ */
  var Chunks = (function () {
    var factories = Object.create(null);   /* name -> factory(bv), filled in by BVChunk() */
    var instances = Object.create(null);   /* name -> the chunk's public API */
    var inflight  = Object.create(null);   /* name -> Promise of that API */
    var manifest  = {};
    try { manifest = JSON.parse((DOM.script && DOM.script.getAttribute('data-chunks')) || '{}'); } catch (_) {}
    var bv = null;

    window.BVChunk = function (name, factory) { factories[name] = factory; };

    function internals() {
      return bv || (bv = {
        State: State, DOM: DOM, Util: Util, el: el, on: on, $: $,
        MEDIA_STATUS: MEDIA_STATUS, RETRY_CONFIG: RETRY_CONFIG, MediaState: MediaState,
        EditState: EditState, VideoState: VideoState, GlobalVid: GlobalVid,
        Toast: Toast, Chrome: Chrome, Virtual: Virtual, ImageCard: ImageCard, EditMode: EditMode,
        makeLoadingSpinner: makeLoadingSpinner, waitForMediaRetry: waitForMediaRetry,
        resolveMediaRetry: resolveMediaRetry, beginCardRetry: beginCardRetry,
        trySwapMediaType: trySwapMediaType, attachZoom: attachZoom, getMediaType: getMediaType
      });
    }

    function load(name) {
      if (instances[name]) return Promise.resolve(instances[name]);
      if (inflight[name]) return inflight[name];
      var p = new Promise(function (resolve, reject) {
        function instantiate() {
          try { instances[name] = factories[name](internals()); resolve(instances[name]); }
          catch (e) { reject(e); }
        }
        if (factories[name]) { instantiate(); return; }        /* already evaluated (e.g. a test harness) */
        var s = document.createElement('script');
        s.src = manifest[name] || ('chunks/' + name + '.js');
        s.async = true;
        s.onload = function () {
          if (factories[name]) instantiate();
          else reject(new Error('chunk "' + name + '" did not register itself'));
        };
        s.onerror = function () { s.remove(); reject(new Error('chunk "' + name + '" failed to load')); };
        document.head.appendChild(s);
      });
      inflight[name] = p;
      p.then(null, function () { delete inflight[name]; });
      return p;
    }

    /* The chunk's API if it is already running, else null (lets a caller skip
       its "still loading" path when the code has in fact arrived). */
    function peek(name) { return instances[name] || null; }

    /* Start fetching a chunk now, ignoring failure — used on hover/focus of
       the control that will need it, so the click itself finds it ready. */
    function prefetch(name) { if (!instances[name]) load(name).then(null, function () {}); }

    function failed(what) {
      Toast.show('Could not load ' + what + '. Check your connection and try again.', 'err', 4500);
    }

    return { load: load, peek: peek, prefetch: prefetch, failed: failed };
  })();

  /* ════════════════════════════════════════════════════════
     STORAGE + CONSENT

     Bat-Viewer sets no cookies and sends nothing to any server. The only
     thing it can keep on the device is the Night/Moon theme (plus a note
     of the choice made in the banner), in localStorage — and the theme is
     written there only after an explicit "Allow". Every key starts with
     `bv-` so "Delete my data" can remove all of it.
  ════════════════════════════════════════════════════════ */
  var Store = (function () {
    var PREFIX = 'bv-';
    function area() { try { return window.localStorage || null; } catch (_) { return null; } }
    function get(key) { try { var a = area(); return a ? a.getItem(key) : null; } catch (_) { return null; } }
    function set(key, value) { try { var a = area(); if (!a) return false; a.setItem(key, value); return true; } catch (_) { return false; } }
    function del(key) { try { var a = area(); if (a) a.removeItem(key); } catch (_) {} }
    function clearAll() {
      try {
        var a = area();
        if (!a) return;
        var doomed = [], i, k;
        for (i = 0; i < a.length; i++) { k = a.key(i); if (k && k.indexOf(PREFIX) === 0) doomed.push(k); }
        for (i = 0; i < doomed.length; i++) del(doomed[i]);
      } catch (_) {}
    }
    return { available: function () { return area() !== null; }, get: get, set: set, del: del, clearAll: clearAll };
  })();

  var Consent = (function () {
    var KEY = 'bv-consent';
    var value = Store.get(KEY);                       /* 'granted' | 'denied' | null (not asked yet) */
    if (value !== 'granted' && value !== 'denied') value = null;
    return {
      decided: function () { return value !== null; },
      granted: function () { return value === 'granted'; },
      grant:   function () { value = 'granted'; Store.set(KEY, value); },
      deny:    function () { value = 'denied';  Store.set(KEY, value); Store.del('bv-theme'); },
      reset:   function () { value = null; }          /* the caller has already emptied storage */
    };
  })();

  /* ════════════════════════════════════════════════════════
     THEME
  ════════════════════════════════════════════════════════ */
  var Theme = (function () {
    function apply(theme, persist) {
      var moon = theme === 'moon';
      DOM.html.setAttribute('data-theme', moon ? 'moon' : 'night');
      DOM.themeToggle.checked = moon;
      DOM.themeIcon.textContent = moon ? '🌕' : '🌙';
      DOM.themeName.textContent = moon ? 'Moon' : 'Night';
      if (persist && Consent.granted()) Store.set('bv-theme', moon ? 'moon' : 'night');
    }
    function current() { return DOM.html.getAttribute('data-theme'); }
    apply(Store.get('bv-theme'), false);
    on(DOM.themeToggle, 'change', function () { apply(DOM.themeToggle.checked ? 'moon' : 'night', true); });
    return { apply: apply, current: current };
  })();

  /* ════════════════════════════════════════════════════════
     CONSENT BANNER
     Shown once, only if storage is usable and nothing has been chosen
     yet. Both choices are one click and carry equal weight; the page
     works fully either way and the banner never blocks anything.
     "Privacy settings" in the footer brings it back.
  ════════════════════════════════════════════════════════ */
  var ConsentBanner = (function () {
    var opener = null;
    function show(fromUser) {
      opener = fromUser ? document.activeElement : null;
      DOM.consentBanner.hidden = false;
      if (fromUser) DOM.consentDeny.focus();
    }
    function hide() {
      var hadFocus = DOM.consentBanner.contains(document.activeElement);
      DOM.consentBanner.hidden = true;
      if (hadFocus) {
        var back = opener && document.documentElement.contains(opener) ? opener : DOM.pageBody;
        back.focus({ preventScroll: true });
      }
      opener = null;
    }
    function choose(allow) {
      if (allow) { Consent.grant(); Store.set('bv-theme', Theme.current()); }
      else       { Consent.deny(); }
      hide();
      Toast.show(allow ? 'Saved. Your theme will be remembered on this device.'
                       : 'Okay. Nothing is saved; your theme resets when you reload.', 'ok', 4200);
    }
    on(DOM.consentAllow, 'click', function () { choose(true); });
    on(DOM.consentDeny,  'click', function () { choose(false); });
    if (Store.available() && !Consent.decided()) show(false);
    return { show: show, hide: hide };
  })();

  /* ════════════════════════════════════════════════════════
     HELP TOOLTIP
  ════════════════════════════════════════════════════════ */
  var Help = (function () {
    var open = false;
    function set(v) {
      open = v;
      DOM.helpTooltip.classList.toggle('visible', open);
      DOM.helpBtn.setAttribute('aria-expanded', String(open));
    }
    on(DOM.helpBtn, 'click', function (e) {
      e.stopPropagation();
      set(!open);
    });
    on(document, 'click', function (e) {
      if (open && !DOM.helpTooltip.contains(e.target)) set(false);
    });
    return { isOpen: function () { return open; }, close: function () { set(false); } };
  })();

  /* ════════════════════════════════════════════════════════
     COMMON NOTES  (global, session-only scratchpad — top bar)
     ─ Fully separate from the per-card Notes feature (NoteState /
       .card-notes): one shared textarea, not tied to any media URL.
     ─ The dialog and its code live in chunks/common-notes.js and are
       created the first time the button is used. Nothing is ever
       written to storage, so a reload clears it.
  ════════════════════════════════════════════════════════ */
  var CommonNotes = (function () {
    var api = null;
    function prefetch() { Chunks.prefetch('common-notes'); }
    on(DOM.commonNotesBtn, 'pointerenter', prefetch);
    on(DOM.commonNotesBtn, 'focus', prefetch);
    on(DOM.commonNotesBtn, 'click', function (e) {
      e.stopPropagation();
      if (api) { api.show(); return; }
      Chunks.load('common-notes').then(function (a) { api = a; a.show(); },
                                       function () { Chunks.failed('Common Notes'); });
    });
    return {
      isOpen: function () { return !!api && api.isOpen(); },
      hide:   function () { if (api) api.hide(); },
      clear:  function () { if (api) api.clear(); }
    };
  })();

  /* ════════════════════════════════════════════════════════
     ROTATION FIT
     A card's picture is rotated by turning its wrapper. Turned as it
     is, the wrapper's box (as wide as the card) swings out of the
     card: edit mode used to clip the picture, and once Done it lay
     over the card's own buttons and its neighbours.

     Now a rotated picture is treated as a picture of its new shape.
     The natural image, turned by the angle, has a bounding box; that
     box is shown as wide as the card allows and no taller than the
     Image Size limit (exactly how an image of that shape is shown),
     and the card makes room for it with vertical margins on the
     wrapper. Nothing is clipped and nothing leaves the card, at any
     angle, for images and videos alike.

     Sizes need layout, so this runs again when the media loads, when
     the card's width changes (columns, window, scrollbar) and when
     the Image Size limit changes.
  ════════════════════════════════════════════════════════ */
  var RotateFit = (function () {
    var tracked = new Set();          /* wrappers of rotated cards that are on the page */
    var frame = 0;
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(refreshSoon) : null;

    function mediaOf(wrap) { return wrap.querySelector('.card-img, .card-video'); }

    /* The Image Size limit in pixels (Infinity for "Max"). applySize() keeps it in
       --card-max-h as px or vh. While a card is being edited the Edit panel may lower it for
       that card (--edit-max-h on the card) so the whole card fits above the panel. */
    function cap(wrap) {
      var v = (DOM.gallery.style.getPropertyValue('--card-max-h') || '').trim();
      var n = parseFloat(v);
      var limit = !(n > 0) ? Infinity : (/vh$/.test(v) ? n * window.innerHeight / 100 : n);
      var card = wrap.closest ? wrap.closest('.card') : null;
      var e = card ? parseFloat(card.style.getPropertyValue('--edit-max-h')) : NaN;
      return e > 0 ? Math.min(limit, e) : limit;
    }

    /* Back to the card's normal layout. */
    function clear(wrap, media) {
      var st = wrap.style;
      st.transform = st.width = st.marginTop = st.marginBottom = st.marginLeft = st.marginRight = '';
      if (media) media.style.maxHeight = '';
    }

    /* Rotated, but the picture's size is not known yet (still loading): just turn it. */
    function plain(wrap, media, deg) {
      clear(wrap, media);
      wrap.style.transform = 'rotate(' + deg + 'deg)';
    }

    function fit(wrap) {
      var deg = wrap._deg || 0, media = mediaOf(wrap), box = wrap.parentNode;
      if (!deg || !media) return;
      if (box && ro && wrap._fitBox !== box) {
        if (wrap._fitBox) ro.unobserve(wrap._fitBox);
        wrap._fitBox = box;
        ro.observe(box);
      }
      var nw = media.naturalWidth  || media.videoWidth  || 0;
      var nh = media.naturalHeight || media.videoHeight || 0;
      var wb = box ? box.clientWidth : 0;
      if (!nw || !nh || !wb) { plain(wrap, media, deg); return; }

      var a = deg * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      var wn = nw * c + nh * s, hn = nw * s + nh * c;   /* the natural picture, turned: its bounding box */
      var wd = Math.min(wb, cap(wrap) * wn / hn);          /* shown as wide as the card allows, no taller than the limit */
      var k  = wd / wn;
      var cw = nw * k;                                 /* the picture's own width, before it is turned */
      var hd = hn * k;                                 /* the room the turned picture needs */

      /* The wrapper is laid out no wider than the card and scaled up to its real size by the
         transform. (A layout box wider than the card — a landscape picture turned upright is
         wider than it is shown — would stretch a one-column grid track, which widens the card,
         which asks for a still wider picture, and so on without end.) */
      var w0 = Math.min(wb, cw);                       /* layout width */
      var h0 = w0 * nh / nw;                           /* layout height: the picture keeps its shape */
      var f  = cw / w0;                                /* 1 unless the picture is shown wider than it is laid out */

      var st = wrap.style;
      st.width = w0.toFixed(2) + 'px';
      st.marginLeft = st.marginRight = 'auto';
      st.marginTop = st.marginBottom = ((hd - h0) / 2).toFixed(2) + 'px';
      st.transform = 'rotate(' + deg + 'deg)' + (f > 1.0005 ? ' scale(' + f.toFixed(5) + ')' : '');
      media.style.maxHeight = 'none';                  /* the size is set above; the limit is already applied */
    }

    function release(wrap) {
      tracked.delete(wrap);
      wrap._deg = 0;
      if (wrap._fitBox && ro) ro.unobserve(wrap._fitBox);
      wrap._fitBox = null;
    }

    function refreshAll() {
      tracked.forEach(function (wrap) {
        if (!wrap.isConnected) { release(wrap); return; }   /* its card was torn down */
        fit(wrap);
      });
    }

    function refreshSoon() {
      if (frame) return;
      frame = requestAnimationFrame(function () { frame = 0; refreshAll(); });
    }

    /* Turn a card's wrapper by `deg` (0 puts it back). */
    function set(wrap, deg) {
      var media = mediaOf(wrap);
      deg = deg || 0;
      if (!deg) { release(wrap); clear(wrap, media); return; }
      tracked.forEach(function (w) { if (!w.isConnected) release(w); });   /* never keep a torn-down card */
      wrap._deg = deg;
      tracked.add(wrap);
      if (media && !wrap._fitBound) {
        wrap._fitBound = true;
        media.addEventListener('load', function () { fit(wrap); });
        media.addEventListener('loadedmetadata', function () { fit(wrap); });
      }
      fit(wrap);
    }

    window.addEventListener('resize', refreshSoon);
    return { set: set, release: release, refreshSoon: refreshSoon };
  })();

  /* ════════════════════════════════════════════════════════
     SIZE PRESETS
     applySize() is O(1): it writes three CSS variables on the gallery and
     the stylesheet does the rest (.card-img/.card-video max-height,
     .vslot min-height, loading-skeleton height). It used to touch every
     card and slot on every slider tick.
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
    DOM.sizeBadge.textContent = p.label;
    DOM.sizer.setAttribute('aria-valuetext', p.label);
    DOM.gallery.style.gridTemplateColumns =
      'repeat(' + p.cols + ',minmax(0,1fr))';       /* never wider than the page, even for one column */
    DOM.gallery.style.setProperty('--card-max-h', p.maxH);
    DOM.gallery.style.setProperty('--slot-min-h', p.maxH === 'none' ? '200px' : p.maxH);
    DOM.gallery.style.setProperty('--skeleton-h', p.maxH === 'none' ? '160px' : 'min(160px,' + p.maxH + ')');
    RotateFit.refreshSoon();                       /* rotated pictures are fitted to the new limit */
  }
  on(DOM.sizer, 'input', Util.rafThrottle(function () { applySize(parseInt(DOM.sizer.value, 10)); }));
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
  function syncScrollBadge() {
    var label = getScrollPreset().label;
    DOM.scrollBadge.textContent = label;
    DOM.scrollSpeed.setAttribute('aria-valuetext', label);
  }
  on(DOM.scrollSpeed, 'input', syncScrollBadge);
  syncScrollBadge();

  function zoomOn() { return DOM.zoomEnabled.checked; }

  /* ════════════════════════════════════════════════════════
     URL PARSE / VALIDATE / MEDIA TYPE

     Detection order (each step only runs if the previous one is
     inconclusive):
       1. File extension in the URL's PATH ONLY (authoritative,
          instant, and immune to random signature/hash text elsewhere
          in the URL that used to trip up the old "does the string
          contain 'mov' anywhere" heuristic).
       2. MIME/filename hints carried in S3 / CloudFront presigned-URL
          query params (response-content-type, content-type,
          response-content-disposition) — common when the S3 object
          key itself has no extension.
       3. A best-effort background HEAD request (probeContentType,
          below) that reads the real Content-Type S3 returns for the
          object. This never blocks rendering — the card renders with
          its best current guess immediately and is corrected in place
          if the probe later disagrees.
       4. If everything above is inconclusive we still render with a
          default guess, but that guess is NOT confident.

       Regardless of confidence, ANY media that fails its first load
       attempt gets one fast, automatic shot at the OTHER format before
       it's shown as failed (see trySwapMediaType below) — a wrong
       extension, a mislabeled S3 object, or genuinely corrupt media are
       all indistinguishable from "this format doesn't work" until we've
       actually tried decoding it. The one exception to memory: if a
       confidently-typed URL's fallback attempt ALSO fails, that guess is
       not kept — see trySwapMediaType's comment for why.
  ════════════════════════════════════════════════════════ */
  /* Boundary is "end of string OR any non-alphanumeric character" rather
     than just "?/#/end" — this still refuses to match inside a longer
     word (so "movies" never matches ".mov") but it also correctly
     matches an extension embedded in a query-param value, e.g. a quoted
     filename from an S3 response-content-disposition hint
     ("...filename=\"clip.mov\"") where a quote, semicolon, or ampersand
     follows instead of a literal "?" or "#". */
  var VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|avi|m4v|ogv|ogg|ts|mpe?g|3gp|flv|m3u8|wmv|vob|mts|m2ts)(?:$|[^a-z0-9])/i;
  var IMAGE_EXT_RE = /\.(jpe?g|jfif|png|gif|webp|svg|bmp|ico|tiff?|avif|heic|heif)(?:$|[^a-z0-9])/i;

  /* Query-string keys S3/CloudFront presigned URLs commonly carry the
     object's real MIME type or original filename under, for objects
     whose key itself is an extensionless hash/UUID. */
  var S3_CONTENT_TYPE_PARAMS = ['response-content-type', 'content-type', 'x-amz-meta-content-type'];
  var S3_FILENAME_PARAMS     = ['response-content-disposition', 'x-amz-meta-filename'];

  /* Extension/hint-based detection only — no network calls, no
     overrides. Returns 'video' | 'image' | null (null = genuinely
     inconclusive, caller decides the default + swap eligibility).

     The result depends only on the URL string, and getMediaType() asks
     about the same URLs again and again (every card build, every
     renumber after a removal, the bulk-load summary), so answers are
     memoized. The memo is emptied by Virtual.clear() and capped so a long
     session can't grow it without bound. */
  var DETECT_CACHE_MAX = 5000;
  var detectCache = Object.create(null), detectCacheSize = 0;
  function detectMediaType(url) {
    if (!url) return null;
    var hit = detectCache[url];
    if (hit !== undefined) return hit;
    var found = detectMediaTypeUncached(url);
    if (detectCacheSize >= DETECT_CACHE_MAX) { detectCache = Object.create(null); detectCacheSize = 0; }
    detectCache[url] = found;
    detectCacheSize++;
    return found;
  }
  function resetDetectCache() { detectCache = Object.create(null); detectCacheSize = 0; }

  function detectMediaTypeUncached(url) {
    /* data:image/png;base64,… and data:video/mp4;… carry their own type
       (this is what the video "capture frame" button produces). */
    var dm = /^data:(image|video)\//i.exec(url);
    if (dm) return dm[1].toLowerCase();
    var pathname = url, search = '';
    try {
      var base = (typeof window !== 'undefined' && window.location) ? window.location.href : undefined;
      var u = new URL(url, base);
      pathname = u.pathname || '';
      search = u.search || '';
    } catch (_) {
      /* Not a parseable absolute URL (unusual blob:/data: form) — fall
         through to testing the raw string below. */
    }

    if (VIDEO_EXT_RE.test(pathname)) return 'video';
    if (IMAGE_EXT_RE.test(pathname)) return 'image';

    if (search) {
      try {
        var params = new URLSearchParams(search);
        var i, raw, mime;
        for (i = 0; i < S3_CONTENT_TYPE_PARAMS.length; i++) {
          raw = params.get(S3_CONTENT_TYPE_PARAMS[i]);
          if (!raw) continue;
          mime = decodeURIComponent(raw).toLowerCase();
          if (mime.indexOf('video/') === 0) return 'video';
          if (mime.indexOf('image/') === 0) return 'image';
        }
        var j, fnRaw, fn;
        for (j = 0; j < S3_FILENAME_PARAMS.length; j++) {
          fnRaw = params.get(S3_FILENAME_PARAMS[j]);
          if (!fnRaw) continue;
          fn = decodeURIComponent(fnRaw);
          if (VIDEO_EXT_RE.test(fn)) return 'video';
          if (IMAGE_EXT_RE.test(fn)) return 'image';
        }
      } catch (_) { /* malformed query string — ignore, stay inconclusive */ }
    }

    if (pathname === url) {
      /* URL() couldn't parse this scheme at all — last resort, test the
         whole raw string. */
      if (VIDEO_EXT_RE.test(url)) return 'video';
      if (IMAGE_EXT_RE.test(url)) return 'image';
    }
    return null;
  }

  /* True only when the type came from a real extension or an explicit
     MIME/filename hint — never from a coin-flip guess. Gates the
     one-time swap-on-error fallback in ImageCard/VideoCard. */
  function isConfidentMediaType(url) {
    return !!detectMediaType(url);
  }

  function getMediaType(url) {
    if (!url) return 'image';
    if (State.videoOverrides.has(url)) return 'video';
    if (State.imageOverrides.has(url)) return 'image';
    var detected = detectMediaType(url);
    if (detected) return detected;
    /* A content-type probe already answered for this link (and the answer
       outlives Clear — it is a fact about the link, not about the gallery). */
    var probed = ProbeCache[url];
    if (probed === 'video' || probed === 'image') return probed;
    /* Genuinely inconclusive (no extension, no MIME/filename hint yet).
       This app started life as an image gallery and most extensionless
       S3 keys in practice are images, so default there. Crucially this
       guess is NOT recorded as an override, so a later confident signal
       (the background probe below, or a single onerror swap) can still
       correct it without a fight. */
    return 'image';
  }

  /* Rebuild the card in slot `idx` as `type`, but only if that slot is
     currently mounted and hasn't already finished loading successfully
     — used by the background probe below to correct an inconclusive
     guess in place without disturbing media that's already fine. */
  function swapCardType(idx, type) {
    var slot = State.slots[idx];
    if (!slot || !State.activeSet.has(slot)) return;
    var card = slot.querySelector('.card');
    if (!card || card.dataset.mediaStatus === MEDIA_STATUS.LOADED) return;
    var wantsVideo = type === 'video';
    var isVideo = card.classList.contains('card-video-card');
    if (wantsVideo === isVideo) return;
    var box = card.querySelector('.card-img-box');
    if (box && box._destroy) box._destroy();
    Virtual.rebuildSlot(slot, idx, wantsVideo ? VideoCard.build : ImageCard.build);
  }

  /* Shared by ImageCard/VideoCard onerror handlers: when a media
     element fails and the OTHER type hasn't already been tried for this
     URL, swap the card to that other media type once instead of giving
     up immediately — "Intelligent Fast Media Format Fallback". Fires on
     ANY failure, confidently-typed URL or not: a real .jpg/.mp4
     extension is usually right, but a wrong extension, a mislabeled S3
     object, or corrupt bytes look identical to a network failure until
     the browser has actually tried to decode them, and this fallback
     is cheap and immediate (reuses the same URL, no re-download of
     anything already fetched, no added delay).

     `State.fallbackAttempted` (separate from the videoOverrides /
     imageOverrides type-memory sets) is the one-shot loop guard here —
     it caps this at a single swap per URL regardless of outcome:
       detected format -> alternate format -> failed
     and is checked/set independently of whether the type guess itself
     gets remembered.

     Memory of the swapped-to type (`overrideSet`) is handled
     differently depending on how confident the ORIGINAL guess was:
       - Genuinely ambiguous URL (no extension/MIME hint): remember the
         swap immediately, same as before this fallback was widened —
         there's no more-authoritative type to fall back on if this
         guess turns out wrong too, so keeping the best available guess
         is still correct.
       - Confidently-typed URL (real extension/MIME hint): do NOT
         remember the swap yet. It's only confirmed (added to
         overrideSet) if the fallback actually succeeds — see the
         `swapCtx.confirmOverride` handling in ImageCard/VideoCard's
         load success handlers below. If the fallback ALSO fails, no
         override is left behind, so getMediaType() keeps returning the
         original confident detection — a later re-render (scrolling the
         slot out and back, or VideoCard's smart retry) tries the
         correct format again instead of getting stuck retrying the
         wrong one forever.

     Returns true if a swap was performed (caller should stop there and
     not show a failed state yet). */
  function trySwapMediaType(url, card, box, zoom, overrideSet, buildOther) {
    if (State.fallbackAttempted.has(url)) return false;
    var parentSlot = card.closest('.vslot');
    /* A card whose slot has already left the page (cleared or removed) must not
       be rebuilt — that would load media for a link nobody is looking at. */
    if (!parentSlot || !parentSlot.isConnected) return false;
    State.fallbackAttempted.add(url);
    var firstType = card.classList.contains('card-video-card') ? 'video' : 'image';
    var confident = isConfidentMediaType(url);
    var swapCtx = { firstType: firstType, confirmOverride: confident ? overrideSet : null };
    if (!confident) overrideSet.add(url);
    if (box._destroy) box._destroy(); else zoom.destroy();
    Virtual.rebuildSlot(parentSlot, parseInt(parentSlot.dataset.idx, 10), function (i) {
      return buildOther(i, swapCtx);
    });
    return true;
  }

  /* Shared retry-guard for ImageCard.retryImage / VideoCard.retryVideo:
     returns false (after showing a toast, if the retry cap was hit) when
     the retry should NOT proceed; otherwise marks the card LOADING and
     begins tracking the attempt in MediaState. Callers still own their
     own `retryInFlight` closure flag and any type-specific teardown. */
  function beginCardRetry(url, type, card, fromLoading, applyLimit) {
    var current = MediaState.get(url);
    if (!fromLoading && current.status !== MEDIA_STATUS.FAILED) return false;
    if (!MediaState.beginRetry(url, type, applyLimit === true)) {
      Toast.show('Maximum retries reached for this media.', 'err', 2600);
      return false;
    }
    card.dataset.mediaStatus = MEDIA_STATUS.LOADING;
    return true;
  }

  /* ────────────────────────────────────────────────────────
     BACKGROUND CONTENT-TYPE PROBE (best effort, S3-aware)

     For URLs where detectMediaType() above is genuinely inconclusive,
     ask S3 directly via a lightweight HEAD request and read the real
     Content-Type header instead of leaving it to chance. Fully
     best-effort: if the bucket has no CORS policy allowing HEAD, or
     the request stalls, we just time out quietly and keep relying on
     the existing one-time swap-on-error fallback — no error is ever
     surfaced to the user and rendering is never blocked on this.
  ════════════════════════════════════════════════════════ */
  /* Answers already obtained, keyed by link: 'video' | 'image' | 'none'
     ('none' = asked, nothing usable came back — don't ask again). Kept
     across Clear on purpose: re-loading the same links needs no new
     requests, and getMediaType() consults it so the card is built as the
     right type the first time. */
  var ProbeCache = Object.create(null);

  /* Probes go through a small bounded pool instead of one request per
     activated card (a fast scroll through 1,000 extensionless links used to
     fire hundreds of simultaneous HEADs, competing with the media itself
     for the browser's connections). Newest first — that is the card
     nearest the viewport — and a job whose card has scrolled away or been
     removed while it waited is simply dropped. */
  var PROBE_CONCURRENCY = 4, PROBE_TIMEOUT_MS = 6000;
  var probeQueue  = [];                        /* jobs waiting for a free connection */
  var probeQueued = Object.create(null);       /* url -> true while queued or in flight */
  var probeActive = 0;

  function probeWanted(job) {
    return State.allUrls[job.idx] === job.url && State.activeSet.has(State.slots[job.idx]);
  }
  function applyProbeResult(idx, url, type) {
    if (type === 'video') { State.imageOverrides.delete(url); State.videoOverrides.add(url); }
    else                  { State.videoOverrides.delete(url); State.imageOverrides.add(url); }
    if (State.allUrls[idx] === url) swapCardType(idx, type);
  }
  function runProbe(job) {
    probeActive++;
    var done = false;
    var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var tid = setTimeout(function () { if (ac) ac.abort(); }, PROBE_TIMEOUT_MS);
    function finish(type) {
      if (done) return;
      done = true;
      clearTimeout(tid);
      ProbeCache[job.url] = type || 'none';
      delete probeQueued[job.url];
      probeActive--;
      if (type) applyProbeResult(job.idx, job.url, type);
      pumpProbes();
    }
    /* credentials:'omit' — the privacy policy promises this request carries no cookies. */
    fetch(job.url, { method: 'HEAD', cache: 'force-cache', credentials: 'omit', signal: ac ? ac.signal : undefined })
      .then(function (res) {
        var ct = res && res.headers && res.headers.get && res.headers.get('content-type');
        ct = ct ? ct.toLowerCase() : '';
        finish(ct.indexOf('video/') === 0 ? 'video' : ct.indexOf('image/') === 0 ? 'image' : null);
      })
      .catch(function () { finish(null); /* CORS/network/timeout — silently keep the current guess */ });
  }
  function pumpProbes() {
    while (probeActive < PROBE_CONCURRENCY && probeQueue.length) {
      var job = probeQueue.pop();
      if (probeWanted(job)) runProbe(job);
      else delete probeQueued[job.url];        /* scrolled away while waiting; asked again if it returns */
    }
  }
  function dropQueuedProbes() {
    for (var i = 0; i < probeQueue.length; i++) delete probeQueued[probeQueue[i].url];
    probeQueue.length = 0;
  }
  function probeContentType(idx, url) {
    if (ProbeCache[url] || probeQueued[url]) return;
    /* data: and blob: links need no probe (and the CSP's connect-src is
       limited to http(s) anyway). */
    if (typeof fetch !== 'function' || !/^https?:/i.test(url)) return;
    probeQueued[url] = true;
    probeQueue.push({ idx: idx, url: url });
    pumpProbes();
  }

  function parseUrls(txt) {
    return txt.split(/[\n,]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 6; })
      .slice(0, 1000);
  }
  function isValidUrl(s) {
    try {
      var u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'data:' || u.protocol === 'blob:';
    } catch (_) { return false; }
  }
  function refreshCount() {
    DOM.gCount.textContent = State.allUrls.length;
    Pager.updateUI();
  }

  /* The "N URLs" tally under the box. Re-parsing a 1,000-line paste on every
     keystroke is wasted work, so input is debounced (a paste still updates
     after one short pause) and the DOM is only touched when the number
     actually changes. */
  var shownTally = -1;
  function setTally(n) {
    if (n === shownTally) return;
    shownTally = n;
    var b = el('b');
    b.textContent = n;
    DOM.bulkTally.textContent = '';
    DOM.bulkTally.appendChild(b);
    DOM.bulkTally.appendChild(document.createTextNode(' URL' + (n !== 1 ? 's' : '')));
  }
  var updateTally = Util.debounce(function () { setTally(parseUrls(DOM.bulkArea.value).length); }, 150);
  on(DOM.bulkArea, 'input', updateTally);

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
      RotateFit.set(wrap, s.rotation);
    },
    /* Rotation only (cards restoring their saved edit when they are built). */
    rotate: function (wrap, deg) { RotateFit.set(wrap, deg); }
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
     NOTE STATE  (per-card free-text notes — memory only)

     Keyed by URL, same pattern as EditState/VideoState, so a note
     survives virtualization (card scrolled off-screen, DOM torn down,
     then rebuilt when it scrolls back — see Virtual.activate/deactivate)
     and survives an image<->video type swap for the same URL. It is
     NEVER written to localStorage/sessionStorage/disk, so a real
     browser reload wipes it — that reset-on-reload behavior is free,
     not something we implement, because nothing here is persisted.

     A blank/whitespace-only note is treated as "no note" and the key
     is dropped, so State.noteStates only ever holds real content and
     the has-note indicator can't get stuck on for an empty box.
  ════════════════════════════════════════════════════════ */
  var NOTE_MAX_LEN = 4000;
  var NoteState = {
    get: function (url) {
      var s = State.noteStates[url];
      return typeof s === 'string' ? s : '';
    },
    set: function (url, text) {
      if (typeof text !== 'string') text = '';
      if (text.length > NOTE_MAX_LEN) text = text.slice(0, NOTE_MAX_LEN);
      if (text.trim() === '') delete State.noteStates[url];
      else State.noteStates[url] = text;
    },
    has: function (url) {
      var s = State.noteStates[url];
      return !!(s && s.trim() !== '');
    }
  };

  /* ════════════════════════════════════════════════════════
     EDIT MODE  (singleton — loads on first use)

     The panel's markup and code live in chunks/edit-mode.js. This
     stand-in keeps the four-method contract that the cards, Keyboard
     and Virtual already use (enter / exit / reset / isActive) and
     fetches the chunk the first time an Edit button is pressed. Until
     then there is nothing to exit, so exit/reset/isActive are no-ops.
  ════════════════════════════════════════════════════════ */
  var EditMode = (function () {
    var api = null;
    function ready(fn) {
      if (api) { fn(api); return; }
      Chunks.load('edit-mode').then(function (a) { api = a; fn(a); },
                                    function () { Chunks.failed('the editor'); });
    }
    return {
      enter   : function (card, url) {
        ready(function (a) { if (document.documentElement.contains(card)) a.enter(card, url); });
      },
      exit    : function (apply) { if (api) api.exit(apply); },
      reset   : function () { if (api) api.reset(); },
      isActive: function () { return !!api && api.isActive(); }
    };
  })();

  /* ════════════════════════════════════════════════════════
     SHARED CARD CHROME  (header, url row, toolbar, remove)

     Eliminates the duplicate boilerplate that existed between
     image and video card factories.
  ════════════════════════════════════════════════════════ */
  var Chrome = (function () {
    /* "Image 5" / "Video 5 [VIDEO]" — also used to renumber after a removal. */
    function setCardNum(numEl, num, type) {
      numEl.textContent = (type === 'video' ? 'Video ' : 'Image ') + num;
      if (type === 'video') {
        var tag = el('span', 'media-tag');
        tag.textContent = 'VIDEO';
        numEl.appendChild(document.createTextNode(' '));
        numEl.appendChild(tag);
      }
    }

    function header(num, type) {
      var hdr = el('div', 'card-header');
      var numEl = el('span', 'card-num'); setCardNum(numEl, num, type);
      /* The card's buttons/note box point at this with aria-describedby, so
         "Remove" is announced as "Remove, Image 5" — and stays right when
         removing an earlier card renumbers this one. */
      numEl.id = Util.uid('bvn');
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
      b.type = 'button';
      if (title) b.title = title;
      return b;
    }

    /* Shared "\u26a0 Could not load ..." panel + Retry button, used by both
       ImageCard and VideoCard failed states (previously duplicated).
       The link is pasted by the user, so it goes in as TEXT \u2014 it used to be
       concatenated into innerHTML, which let a crafted link inject markup.
       `describedBy` (the card's number element id) lets a screen reader say
       which card the Retry button belongs to. */
    function buildErrorView(box, message, url, onRetryClick, describedBy) {
      var errDiv = el('div', 'card-err');
      errDiv.appendChild(document.createTextNode('\u26a0 ' + message));
      var small = el('small', 'card-err-url');
      small.textContent = url;
      errDiv.appendChild(small);
      var retryBtn = makeBtn('card-retry-btn', '');
      var glyph = el('span'); glyph.setAttribute('aria-hidden', 'true'); glyph.textContent = '\u21ba';
      retryBtn.appendChild(glyph);
      retryBtn.appendChild(document.createTextNode(' Retry'));
      if (describedBy) retryBtn.setAttribute('aria-describedby', describedBy);
      on(retryBtn, 'click', onRetryClick);
      errDiv.appendChild(retryBtn);
      box.appendChild(errDiv);
      return errDiv;
    }

    /* Builds Copy/Edit/Note/Remove toolbar.
       opts: { url, describedBy, onCopyLink, onEdit, onNote, onRemove }
       describedBy = id of the card's number element (see header()). */
    function toolbar(opts) {
      var bar = el('div', 'card-toolbar');
      /* Screen-reader confirmation for Copy — the button's own text change is silent. */
      var srStatus = el('span', 'sr-only');
      srStatus.setAttribute('role', 'status');

      var copyBtn = makeBtn('tcopy', 'Copy Link');
      var copyTid = null;
      on(copyBtn, 'click', function (ev) {
        ev && ev.stopPropagation && ev.stopPropagation();
        var link = opts.onCopyLink ? opts.onCopyLink() : opts.url;
        var label = (typeof link === 'object' && link.label) ? link.label : 'Copied!';
        var text  = (typeof link === 'object') ? link.text : link;
        Util.copyToClipboard(text).then(function () {
          copyBtn.textContent = label;
          srStatus.textContent = 'Link copied';
          copyBtn.classList.remove('err');
          copyBtn.classList.add('ok');
          clearTimeout(copyTid);
          copyTid = setTimeout(function () {
            copyBtn.textContent = 'Copy Link';
            srStatus.textContent = '';
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

      var editBtn = makeBtn('tedit', 'Edit');
      on(editBtn, 'click', function () { opts.onEdit && opts.onEdit(editBtn); });
      /* The editor's code is fetched on first use; start as soon as the button is approached. */
      function prefetchEditor() { Chunks.prefetch('edit-mode'); }
      on(editBtn, 'pointerenter', prefetchEditor);
      on(editBtn, 'focus', prefetchEditor);

      var noteBtn = makeBtn('tnote', 'Note', 'Add a note for this item (kept while you scroll, cleared on page reload)');
      on(noteBtn, 'click', function (ev) {
        ev && ev.stopPropagation && ev.stopPropagation();
        opts.onNote && opts.onNote(noteBtn);
      });

      var removeBtn = makeBtn('tremove', 'Remove');
      on(removeBtn, 'click', function () { opts.onRemove && opts.onRemove(); });

      var all = [copyBtn, editBtn, noteBtn, removeBtn];
      all.forEach(function (b) {
        if (opts.describedBy) b.setAttribute('aria-describedby', opts.describedBy);
        bar.appendChild(b);
      });
      bar.appendChild(srStatus);
      return bar;
    }

    /* Collapsible per-card Notes panel — textarea + char counter + Clear.
       url (State.noteStates key), noteBtn (toolbar button kept in sync so a
       card shows it has a note even while the panel is closed), describedBy
       (id of the card's number element, so a screen reader hears which card
       the note box and its Clear button belong to).
       Text is written to State.noteStates on every keystroke (not just
       blur) because the gallery is virtualized: a card can be torn down
       the instant it scrolls out of view, mid-keystroke, with no warning. */
    function notesSection(url, noteBtn, describedBy) {
      var wrap = el('div', 'card-notes hide');

      var head = el('div', 'card-notes-head');
      head.appendChild(el('span', 'card-notes-label', 'Note'));
      var clearBtn = makeBtn('card-notes-clear hide', 'Clear', 'Clear this note');
      clearBtn.type = 'button';
      head.appendChild(clearBtn);
      if (describedBy) clearBtn.setAttribute('aria-describedby', describedBy);

      var ta = el('textarea', 'card-notes-input');
      ta.placeholder = 'Add a note\u2026 (cleared on page reload)';
      ta.setAttribute('aria-label', 'Note');
      if (describedBy) ta.setAttribute('aria-describedby', describedBy);
      ta.maxLength = NOTE_MAX_LEN;
      ta.spellcheck = true;
      ta.value = NoteState.get(url);

      var count = el('span', 'card-notes-count');

      function sync() {
        var has = NoteState.has(url);
        if (noteBtn) noteBtn.classList.toggle('has-note', has);
        clearBtn.classList.toggle('hide', !ta.value);
        count.textContent = ta.value.length + ' / ' + NOTE_MAX_LEN;
      }

      on(ta, 'input', function () {
        NoteState.set(url, ta.value);
        sync();
      });
      /* Defensive: stop clicks/drags/wheel inside the textarea from
         reaching card-level handlers (zoom/pan, etc.) — mirrors the
         stopPropagation already used on the toolbar's Copy button. */
      on(ta, 'mousedown', Util.stop);
      on(ta, 'click', Util.stop);
      on(ta, 'wheel', Util.stop);

      on(clearBtn, 'click', function (ev) {
        Util.stop(ev);
        ta.value = '';
        NoteState.set(url, '');
        sync();
        ta.focus();
      });

      wrap.appendChild(head);
      wrap.appendChild(ta);
      wrap.appendChild(count);

      sync();
      if (NoteState.has(url)) wrap.classList.remove('hide');

      return { wrap: wrap, textarea: ta };
    }

    /* Single removeCard helper used by both card types. */
    function removeCard(card, fallbackIdx, beforeRemove) {
      var parentSlot = card.closest('.vslot');
      var idx = parentSlot ? parseInt(parentSlot.dataset.idx, 10) : fallbackIdx;
      var url = State.allUrls[idx];
      var hadFocus = card.contains(document.activeElement);

      if (typeof beforeRemove === 'function') beforeRemove();
      if (card.classList.contains('editing')) EditMode.exit(false);

      State.allUrls.splice(idx, 1);
      delete State.editStates[url];
      delete State.videoStates[url];
      delete State.noteStates[url];
      MediaState.remove(url);
      delete State.retryWaiters[url];

      var removedSlot = State.slots.splice(idx, 1)[0];
      State.activeSet.delete(removedSlot);

      for (var j = idx; j < State.slots.length; j++) {
        State.slots[j].dataset.idx = String(j);
        var cn = State.slots[j].querySelector('.card-num');
        if (cn) setCardNum(cn, j + 1, getMediaType(State.allUrls[j]));
      }
      refreshCount();
      card.classList.add('out');
      /* A keyboard user who pressed Remove would otherwise lose their place when
         the card vanishes: hand focus to the card that takes its spot. */
      if (hadFocus) {
        var next = State.slots[idx] || State.slots[idx - 1];
        var target = next && next.querySelector('.card-toolbar button');
        (target || DOM.gallery).focus({ preventScroll: true });
      }
      setTimeout(function () {
        if (State.observer) State.observer.unobserve(removedSlot);
        removedSlot.remove();
      }, 230);
    }

    /* Zoom badge + hint overlay — identical in ImageCard and VideoCard.
       Returns both elements (ImageCard also needs `hint` to show/hide
       it during loading-state transitions; VideoCard only needs badge). */
    function zoomOverlay(box) {
      var badge = el('div', 'zoom-badge');
      var hint  = el('div', 'zoom-hint');
      badge.setAttribute('aria-hidden', 'true');      /* visual-only overlays */
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = 'Scroll\u2022zoom    Drag\u2022pan    Dbl-click\u2022reset';
      box.appendChild(badge); box.appendChild(hint);
      return { badge: badge, hint: hint };
    }

    return {
      header: header, urlRow: urlRow, toolbar: toolbar, removeCard: removeCard,
      makeBtn: makeBtn, buildErrorView: buildErrorView, zoomOverlay: zoomOverlay,
      notesSection: notesSection, setCardNum: setCardNum
    };
  })();

  /* ════════════════════════════════════════════════════════
     VIRTUAL GALLERY ENGINE
     A slot is a cheap placeholder; the IntersectionObserver turns the
     slots near the viewport into real cards and back again (activate /
     deactivate), so only a few dozen cards ever hold live media.
  ════════════════════════════════════════════════════════ */
  var Virtual = (function () {
    function makeUrlLabel(url) {
      var s = el('span', 'url-label');
      s.textContent = url;
      return s;
    }
    function makeSlot(i) {
      var slot = el('div', 'vslot');
      slot.setAttribute('role', 'listitem');        /* #gallery is role="list" */
      slot.dataset.idx = String(i);
      slot.appendChild(makeUrlLabel(State.allUrls[i]));
      return slot;                                  /* its height comes from --slot-min-h (see applySize) */
    }
    function activate(slot) {
      if (State.activeSet.has(slot)) return;
      var i = parseInt(slot.dataset.idx, 10);
      if (i >= State.allUrls.length) return;
      State.activeSet.add(slot);
      slot.classList.add('is-active');
      slot.textContent = '';
      var url = State.allUrls[i];
      if (!State.videoOverrides.has(url) && !State.imageOverrides.has(url) && !isConfidentMediaType(url)) {
        probeContentType(i, url);
      }
      slot.appendChild(
        getMediaType(url) === 'video' ? VideoCard.build(i) : ImageCard.build(i)
      );
    }
    /* Tear down whatever card currently occupies `slot` and replace it
       with buildFn(idx), keeping State.activeSet accounting correct.
       Shared by swapCardType, the video retry path, and the image<->video
       onerror fallback (trySwapMediaType) — previously each repeated the
       delete/clear/build/re-add sequence inline. */
    function rebuildSlot(slot, idx, buildFn) {
      State.activeSet.delete(slot);
      slot.textContent = '';
      slot.appendChild(buildFn(idx));
      slot.classList.add('is-active');
      State.activeSet.add(slot);
    }
    function deactivate(slot) {
      if (!State.activeSet.has(slot)) return;
      State.activeSet.delete(slot);
      slot.classList.remove('is-active');
      var box = slot.querySelector('.card-img-box');
      if (box && box._destroy) box._destroy();
      slot.querySelectorAll('img').forEach(function (img) { img.src = ''; });
      slot.querySelectorAll('video').forEach(Util.unloadVideo);
      slot.textContent = '';
      var i = parseInt(slot.dataset.idx, 10);
      if (i < State.allUrls.length) slot.appendChild(makeUrlLabel(State.allUrls[i]));
    }
    function rebuildObserver() {
      if (State.observer) State.observer.disconnect();
      /* Keep ~2 screens of cards hot above/below the viewport so media has
         time to finish downloading before it actually scrolls into view —
         at normal scroll speed this makes loading feel instant instead of
         showing a spinner on every newly-revealed row. Still bounded (not
         "load everything") so we keep scaling to 1,000+ media items
         without exhausting memory or sockets. Inactive slots fully unload
         their <video src> in deactivate() once they scroll back out of
         this window.
         ONE observer serves both jobs: it also watches the page-end sentinel
         (Pager), which asks for the next page when it comes within the same
         two-screen margin. */
      State.observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.target === DOM.gallerySentinel) { if (e.isIntersecting) Pager.onSentinel(); return; }
          if (e.isIntersecting) activate(e.target);
          else                  deactivate(e.target);
        });
      }, { root: null, rootMargin: '200% 0px 200% 0px', threshold: 0 });
      State.slots.forEach(function (s) { State.observer.observe(s); });
      Pager.arm();
    }
    function clear() {
      if (State.observer) { State.observer.disconnect(); State.observer = null; }
      dropQueuedProbes();
      if (EditMode.isActive()) EditMode.exit(false);
      /* Tear every live card down the proper way first. Blanking an <img> fires an
         `error` event a moment later; the card's own _destroy() is what tells its
         handler to ignore that, so without it each cleared image could start the
         image->video fallback on a card that no longer exists (a wasted request
         and a "failed to load" warning per image). It also drops each card's
         zoom listener on the page-wide Zoom switch. */
      State.activeSet.forEach(function (slot) {
        var box = slot.querySelector('.card-img-box');
        if (box && box._destroy) box._destroy();
      });
      DOM.gallery.querySelectorAll('img').forEach(function (img) { img.src = ''; });
      DOM.gallery.querySelectorAll('video').forEach(Util.unloadVideo);
      DOM.gallery.textContent = '';
      State.allUrls = []; State.slots = []; State.activeSet = new Set();
      State.hoveredBox = null; State.hoveredVideoCard = null;
      State.videoOverrides.clear();
      State.imageOverrides.clear();
      State.fallbackAttempted.clear();
      VideoState.clear();
      MediaState.clear();
      State.retryWaiters = Object.create(null);
      resetDetectCache();
      refreshCount();
    }
    /* Add links after the ones already there (used by the video "capture
       frame" button). If everything so far is on screen the new item is
       built too; otherwise it joins the end of the queue and appears with
       the last page, exactly where it sits in the list. */
    function appendUrls(urls) {
      if (!urls || !urls.length) return;
      var allBuilt = State.slots.length === State.allUrls.length;
      State.allUrls = State.allUrls.concat(urls);
      if (allBuilt) Pager.renderNext(urls.length);
      else refreshCount();
    }
    return {
      makeSlot: makeSlot, activate: activate, rebuildObserver: rebuildObserver,
      clear: clear, appendUrls: appendUrls, rebuildSlot: rebuildSlot
    };
  })();

  /* ════════════════════════════════════════════════════════
     PAGER  (progressive loading of a long list)

     State.allUrls always holds every link, so the count, Append, Clear and
     the numbering behave exactly as before. What is paged is the DOM: only
     the first PAGE slots are built; the next PAGE are built when the
     page-end sentinel comes within two screens of the viewport (same
     observer as the slots), or on demand with "Load more" / "Load all".
     State.slots is therefore always a prefix of State.allUrls.
  ════════════════════════════════════════════════════════ */
  var Pager = (function () {
    var PAGE = 100;

    function remaining() { return State.allUrls.length - State.slots.length; }

    /* (Re)start watching the sentinel. An observe() always delivers one fresh
       report, even if nothing changed — which is what lets a still-visible
       sentinel pull in the following page. */
    function arm() {
      var io = State.observer;
      if (!io) return;
      io.unobserve(DOM.gallerySentinel);
      if (remaining() > 0) io.observe(DOM.gallerySentinel);
    }

    /* Build up to `n` more slots after the existing ones; returns how many. */
    function renderNext(n) {
      var left = remaining();
      if (left <= 0) { updateUI(); return 0; }
      n = Math.min(n || PAGE, left);
      var start = State.slots.length;
      var frag = document.createDocumentFragment();
      for (var i = 0; i < n; i++) {
        var slot = Virtual.makeSlot(start + i);
        State.slots.push(slot);
        frag.appendChild(slot);
      }
      DOM.gallery.appendChild(frag);
      updateUI();
      if (!State.observer) {
        Virtual.rebuildObserver();                  /* observes every slot, then arms the sentinel */
      } else {
        for (var j = start; j < State.slots.length; j++) State.observer.observe(State.slots[j]);
        arm();
      }
      return n;
    }

    function renderAll() { renderNext(remaining()); }
    function onSentinel() { if (remaining() > 0) renderNext(PAGE); }

    function updateUI() {
      var total = State.allUrls.length, shown = State.slots.length, left = total - shown;
      DOM.gShown.textContent = left > 0 ? ' · showing ' + shown : '';
      DOM.galleryMore.hidden = left <= 0;
      DOM.galleryMoreText.textContent = left > 0 ? 'Showing ' + shown + ' of ' + total + ' items' : '';
      DOM.loadMoreBtn.textContent = 'Load ' + Math.min(PAGE, Math.max(left, 0)) + ' more';
    }

    on(DOM.loadMoreBtn, 'click', function () { renderNext(PAGE); });
    on(DOM.loadAllBtn,  'click', renderAll);

    return { PAGE: PAGE, renderNext: renderNext, renderAll: renderAll, arm: arm,
             onSentinel: onSentinel, updateUI: updateUI, remaining: remaining };
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
      /* Listen on the document only while a drag is actually in progress — a
         permanent pair per card meant dozens of idle handlers on every mouse move. */
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
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
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      box.classList.remove('zoom-drag'); box.classList.add('zoomed');
      syncCursor();
      if (!inside && s > Z_MIN + 0.02) resetTid = setTimeout(reset, 700);
    }
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
    /* Registered on the page-wide Zoom switch, so destroy() MUST remove it again:
       every activation of a card adds one, and cards are built and torn down
       constantly while scrolling (it used to leak one listener per activation). */
    function onZoomToggle() {
      if (!zoomOn() && s > 1.02) reset(); else syncCursor();
    }
    on(DOM.zoomEnabled, 'change', onZoomToggle);

    function destroy() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      DOM.zoomEnabled.removeEventListener('change', onZoomToggle);
      clearTimeout(resetTid);
      dragging = false;
    }
    return { destroy: destroy, syncCursor: syncCursor, reset: reset };
  }

  /* ════════════════════════════════════════════════════════
     IMAGE CARD
  ════════════════════════════════════════════════════════ */
  var ImageCard = (function () {
    /* `swapCtx` is only present when this card is being built as the
       automatic cross-format fallback for a video that just failed —
       see trySwapMediaType. { firstType, confirmOverride } — confirmOverride
       is the Set to add `url` to if THIS load succeeds (only set when the
       original video detection was confident; see trySwapMediaType's
       comment for why an unconfirmed guess isn't remembered on failure). */
    function build(ci, swapCtx) {
      var url = State.allUrls[ci];
      var card = el('div', 'card');
      var h = Chrome.header(ci + 1, 'image');
      var stored = EditState.get(url);

      /* Image box */
      var box = el('div', 'card-img-box is-loading');
      var spin = makeLoadingSpinner(function () { retryImage(true); });
      box.appendChild(spin);

      var rotateWrap = el('div', 'img-rotate-wrap');
      var img = el('img', 'card-img');
      img.alt = Util.mediaLabel(url, 'Image');     /* file name or host — the link is all we know about the picture */
      img.decoding = 'async';
      img.draggable = false;
      img.style.transformOrigin = '0 0';           /* max-height comes from --card-max-h (see applySize) */

      /* Restore persisted edit state */
      if (stored.brightness !== 1 || stored.contrast !== 1) {
        img.style.filter = 'brightness(' + stored.brightness + ') contrast(' + stored.contrast + ')';
      }

      var activeSpin = spin;
      var errDiv = null;
      var suppressErrors = false;
      var pendingRetry = null;
      var retryInFlight = false;

      function syncCardStatus(status, reason) {
        MediaState.set(url, status, 'image', reason);
        card.dataset.mediaStatus = status;
        box.classList.toggle('is-loading', status === MEDIA_STATUS.LOADING);
      }

      function resolveRetry(ok) {
        if (pendingRetry) {
          pendingRetry(ok);
          pendingRetry = null;
        }
        retryInFlight = false;
        resolveMediaRetry(url, ok);
      }

      function cancelImageRequest() {
        suppressErrors = true;
        img.removeAttribute('src');
        img.src = '';
        if (activeSpin) { activeSpin.remove(); activeSpin = null; }
        syncCardStatus(MEDIA_STATUS.FAILED);
      }

      function restoreLoadingView() {
        if (errDiv && errDiv.parentNode) errDiv.parentNode.removeChild(errDiv);
        errDiv = null;
        if (!activeSpin) {
          activeSpin = makeLoadingSpinner(function () { retryImage(true); });
          box.appendChild(activeSpin);
        }
        if (rotateWrap.parentNode !== box) box.appendChild(rotateWrap);
        if (badge.parentNode      !== box) box.appendChild(badge);
        if (hint.parentNode       !== box) box.appendChild(hint);
      }

      function showFailedView(resolvePending, reason) {
        if (activeSpin) { activeSpin.remove(); activeSpin = null; }
        if (rotateWrap.parentNode === box) box.removeChild(rotateWrap);
        if (badge.parentNode      === box) box.removeChild(badge);
        if (hint.parentNode       === box) box.removeChild(hint);
        syncCardStatus(MEDIA_STATUS.FAILED, reason);
        if (resolvePending) resolveRetry(false);
        if (errDiv && errDiv.parentNode) return;
        errDiv = Chrome.buildErrorView(box, 'Could not load', url, function () {
          retryImage(false);
        }, h.numEl.id);
      }

      function retryImage(fromLoading, applyLimit) {
        if (retryInFlight) return Promise.resolve(false);
        if (!beginCardRetry(url, 'image', card, fromLoading, applyLimit)) return Promise.resolve(false);
        retryInFlight = true;
        cancelImageRequest();
        restoreLoadingView();
        syncCardStatus(MEDIA_STATUS.LOADING);
        return new Promise(function (resolve) {
          pendingRetry = resolve;
          setTimeout(function () {
            suppressErrors = false;
            img.src = url;
          }, MediaState.retryDelay(url, applyLimit));
        });
      }

      on(img, 'load', function () {
        if (activeSpin) { activeSpin.remove(); activeSpin = null; }
        syncCardStatus(MEDIA_STATUS.LOADED);
        /* This card is the fallback attempt after a video failed, and it
           actually decoded as an image — now it's safe to remember. */
        if (swapCtx && swapCtx.confirmOverride) swapCtx.confirmOverride.add(url);
        resolveRetry(true);
        if (img.naturalWidth) h.dimsEl.textContent = img.naturalWidth + ' \u00d7 ' + img.naturalHeight;
        zoom.syncCursor();
      });
      on(img, 'error', function () {
        if (suppressErrors) return;
        /* Fast automatic fallback: try the other media type once before
           giving up — see trySwapMediaType for the full rationale. */
        if (trySwapMediaType(url, card, box, zoom, State.videoOverrides, VideoCard.build)) return;
        var reason = swapCtx
          ? ('image fallback also failed (' + swapCtx.firstType + ' failed first)')
          : 'image failed to load';
        showFailedView(true, reason);
      });
      rotateWrap.appendChild(img);
      box.appendChild(rotateWrap);
      if (stored.rotation !== 0) RotateFit.set(rotateWrap, stored.rotation);   /* restore the saved rotation */

      /* Zoom overlay (badge + hint) */
      var overlay = Chrome.zoomOverlay(box);
      var badge = overlay.badge, hint = overlay.hint;

      var zoom = attachZoom(card, box, img, badge);
      box._retryMedia = retryImage;
      card._retryMedia = retryImage;
      box._destroy = function () {
        suppressErrors = true;
        img.removeAttribute('src');
        img.src = '';
        resolveRetry(false);
        zoom.destroy();
        RotateFit.release(rotateWrap);
      };
      zoom.syncCursor();

      if (MediaState.get(url).status === MEDIA_STATUS.FAILED) {
        showFailedView(false);
      } else {
        syncCardStatus(MEDIA_STATUS.LOADING);
        img.src = url;
      }

      /* Compose */
      card.appendChild(h.hdr);
      card.appendChild(box);
      card.appendChild(Chrome.urlRow(url));
      var notes; /* assigned just below; onNote only fires later, on click */
      card.appendChild(Chrome.toolbar({
        url: url,
        describedBy: h.numEl.id,
        onEdit: function () {
          if (card.classList.contains('editing')) {
            EditMode.exit(false);
          } else {
            zoom.reset(false);
            EditMode.enter(card, url);
          }
        },
        onNote: function () { notes.wrap.classList.toggle('hide'); },
        onRemove: function () { Chrome.removeCard(card, ci, box._destroy); }
      }));
      var noteBtn = card.querySelector('.tnote');
      notes = Chrome.notesSection(url, noteBtn, h.numEl.id);
      card.appendChild(notes.wrap);
      return card;
    }

    return { build: build };
  })();

  /* ════════════════════════════════════════════════════════
     VIDEO CARD  (stand-in — the player's code lives in chunks/video-card.js)

     build(i) must return a card synchronously (Virtual.activate and the
     image<->video fallback both append it straight away). Until the chunk
     has arrived that is a header + loading skeleton; when it lands the
     placeholder is swapped for the real card — but only if its slot still
     shows it (the slot may have scrolled away, been rebuilt or removed).
  ════════════════════════════════════════════════════════ */
  var VideoCard = (function () {
    var api = null;
    var stalled = [];     /* { ph, swapCtx } for every card whose player code could not be fetched */

    function placeholder(ci) {
      var url = State.allUrls[ci];
      var card = el('div', 'card card-video-card card-pending');
      var h = Chrome.header(ci + 1, 'video');
      var box = el('div', 'card-img-box card-video-box is-loading');
      box.appendChild(makeLoadingSpinner());
      card.appendChild(h.hdr);
      card.appendChild(box);
      card.appendChild(Chrome.urlRow(url));
      return { card: card, box: box, url: url, describedBy: h.numEl.id };
    }

    /* Put the real card where the placeholder is — if its slot still shows it.
       The slot may have scrolled out of range, been rebuilt or been removed while
       the code was on its way. Removing a card ABOVE it renumbers the slots, so
       the index is read now, not remembered from build time. */
    function swapIn(ph, swapCtx, a) {
      var slot = ph.card.closest('.vslot');
      if (!slot || !State.activeSet.has(slot)) return;
      var idx = parseInt(slot.dataset.idx, 10);
      if (State.allUrls[idx] !== ph.url) return;
      Virtual.rebuildSlot(slot, idx, function (i) { return a.build(i, swapCtx); });
    }

    function showLoading(ph) {
      ph.box.textContent = '';
      ph.box.classList.add('is-loading');
      ph.box.appendChild(makeLoadingSpinner());
    }

    function attach(ph, swapCtx) {
      Chunks.load('video-card').then(function (a) {
        api = a;
        swapIn(ph, swapCtx, a);
        /* The code is here now, so cards that gave up waiting for it earlier get
           their player too — one Retry click is enough, not one per card. */
        var waiting = stalled;
        stalled = [];
        waiting.forEach(function (w) { swapIn(w.ph, w.swapCtx, a); });
      }, function () { giveUp(ph, swapCtx); });
    }

    /* Could not fetch the player code. The link itself may be fine, so this is NOT
       recorded as a failed media load — just offer to try again. */
    function giveUp(ph, swapCtx) {
      if (!ph.card.isConnected) return;                 /* the card left the page meanwhile */
      var entry = { ph: ph, swapCtx: swapCtx };
      stalled = stalled.filter(function (e) { return e.ph.card.isConnected; });
      stalled.push(entry);
      ph.box.textContent = '';
      ph.box.classList.remove('is-loading');
      Chrome.buildErrorView(ph.box, 'Could not load the video player', ph.url, function () {
        var k = stalled.indexOf(entry);
        if (k >= 0) stalled.splice(k, 1);
        showLoading(ph);
        attach(ph, swapCtx);
      }, ph.describedBy);
    }

    /* The top-bar Retry also covers these cards (they are not "failed media", so
       the retry tool would not see them). Returns how many were set going again. */
    function retryStalled() {
      var again = stalled.filter(function (e) { return e.ph.card.isConnected; });
      stalled = [];
      again.forEach(function (e) { showLoading(e.ph); attach(e.ph, e.swapCtx); });
      return again.length;
    }

    function build(ci, swapCtx) {
      api = api || Chunks.peek('video-card');
      if (api) return api.build(ci, swapCtx);
      var ph = placeholder(ci);
      attach(ph, swapCtx);
      return ph.card;
    }

    return { build: build, retryStalled: retryStalled };
  })();

  /* ════════════════════════════════════════════════════════
     HOVER TRACKING (used by keyboard shortcuts)
  ════════════════════════════════════════════════════════ */
  on(document, 'mouseover', function (e) {
    var t = e.target;
    State.hoveredBox        = (t.closest && t.closest('.card-img-box')) || null;
    State.hoveredVideoCard  = (t.closest && t.closest('.card-video-card')) || null;
  }, { passive: true });
  /* Keyboard users never "hover": the video card they are working in (focus is
     on one of its controls) is the target of the video shortcuts instead. */
  on(document, 'focusin', function (e) {
    var t = e.target;
    var c = t && t.closest && t.closest('.card-video-card');
    if (c) State.hoveredVideoCard = c;
  });

  /* ════════════════════════════════════════════════════════
     FAILED MEDIA RETRY  (whole gallery — code in chunks/retry-failed.js)
  ════════════════════════════════════════════════════════ */
  (function RetryFailedMedia() {
    var api = null;
    function prefetch() { Chunks.prefetch('retry-failed'); }
    on(DOM.retryVisibleFailedBtn, 'pointerenter', prefetch);
    on(DOM.retryVisibleFailedBtn, 'focus', prefetch);
    on(DOM.retryVisibleFailedBtn, 'click', function () {
      var again = VideoCard.retryStalled();       /* cards still waiting for the video player's code */
      if (api) { api.run(again); return; }
      Chunks.load('retry-failed').then(function (a) { api = a; a.run(again); },
                                       function () { Chunks.failed('the retry tool'); });
    });
  })();

  /* ════════════════════════════════════════════════════════
     KEYBOARD
  ════════════════════════════════════════════════════════ */
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
      if (!e.key) return;                 /* e.g. browser autofill fires key-less keydown events */

      /* A modal dialog (Common Notes) owns the keyboard: only Esc is ours. */
      if (CommonNotes.isOpen()) {
        if (e.key === 'Escape') CommonNotes.hide();
        return;
      }

      /* Space: play/pause hovered video, otherwise block native scroll.
         Leave it alone when a text field (URL box, card notes, …) is focused,
         so Space types a literal space, and when keyboard focus is on a button,
         select or switch, so Space still activates it (it used to be swallowed
         there — keyboard users could not press any button with Space). */
      if (e.code === 'Space') {
        if (Util.isTyping() || Util.isInteractive()) return;
        e.preventDefault();
        if (State.hoveredVideoCard && State.hoveredVideoCard._video) {
          var v = State.hoveredVideoCard._video;
          if (v.paused) v.play().catch(function () {}); else v.pause();
          return;
        }
        State.spaceHeld = true;
        return;
      }

      if (!Util.isTyping() && handleVideoShortcut(e)) return;

      if (e.key === 'Escape') {
        if (Help.isOpen()) { Help.close(); return; }
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
  /* Resolves after the browser has painted, so a status message actually shows. */
  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(); }); }); });
  }

  function setProgress(pct, label) {
    DOM.progFill.style.width = pct + '%';
    DOM.progWrap.setAttribute('aria-valuenow', String(pct));
    if (label != null) DOM.progLabel.textContent = label;
  }

  /* Shared tail of the bulk-load: fade out the progress bar, clear the
     input, and release the loading lock. */
  var progHideTid = 0;
  function finishBulkLoadUI() {
    progHideTid = setTimeout(function () { DOM.progWrap.classList.add('hide'); setProgress(0); }, 2400);
    DOM.bulkArea.value = '';
    updateTally.cancel();
    setTally(0);
    State.isLoading = false;
    DOM.bulkLoadBtn.disabled = false;
  }

  function plural(n, word) { return n + ' ' + word + (n !== 1 ? 's' : ''); }

  on(DOM.bulkLoadBtn, 'click', async function () {
    if (State.isLoading) return;
    var urls = parseUrls(DOM.bulkArea.value).filter(isValidUrl);
    if (!urls.length) { Toast.show('No valid URLs found.', 'err'); return; }

    State.isLoading = true;
    DOM.bulkLoadBtn.disabled = true;
    clearTimeout(progHideTid);
    try {
      if (!DOM.appendMode.checked) {
        Virtual.clear();
      }

      /* Every link is recorded up front, so the count, the numbering and Append
         behave as they always did. Only the first page of slots is built now;
         the rest are built as the page-end sentinel nears the viewport (Pager).
         If part of an earlier list is still unbuilt (Append), the new links
         simply queue behind it. */
      var allBuilt = State.slots.length === State.allUrls.length;
      State.allUrls = State.allUrls.concat(urls);

      DOM.progWrap.classList.remove('hide');
      setProgress(0, 'Preparing ' + plural(urls.length, 'item') + '…');
      refreshCount();
      await nextFrame();

      if (allBuilt) Pager.renderNext(Pager.PAGE);
      setProgress(100, State.slots.length + ' / ' + State.allUrls.length + ' slots placed…');

      var nVid = 0;
      for (var i = 0; i < urls.length; i++) { if (getMediaType(urls[i]) === 'video') nVid++; }
      var nImg = urls.length - nVid;
      var summary = plural(urls.length, 'item') + ' loaded' +
                    (nVid ? ' (' + plural(nImg, 'image') + ', ' + plural(nVid, 'video') + ')' : '') + '.';
      if (Pager.remaining() > 0) summary += ' The rest load as you scroll.';
      DOM.progLabel.textContent = urls.length + ' items ready!';
      Toast.show(summary, 'ok', 4000);
    } finally {
      finishBulkLoadUI();
    }
  });

  on(DOM.bulkClearBtn, 'click', function () {
    DOM.bulkArea.value = '';
    updateTally.cancel();
    setTally(0);
  });

  on(DOM.clearAllBtn, 'click', function () {
    Virtual.clear();
  });

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
      var btn = DOM.muteAllBtn;
      btn.classList.toggle('active', GlobalVid.muteAll);
      var glyph = el('span');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = GlobalVid.muteAll ? '\uD83D\uDD07' : '\uD83D\uDD0A';
      btn.textContent = '';
      btn.appendChild(glyph);
      btn.appendChild(document.createTextNode(GlobalVid.muteAll ? ' Unmute All' : ' Mute All'));
      btn.title = GlobalVid.muteAll ? 'Unmute every video' : 'Mute every video';
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
      DOM.globalSpeed.setAttribute('aria-valuetext', fmtRate(r));
      DOM.globalSpeedBadge.parentElement.classList.toggle('alt', r !== 1);
      allVideos().forEach(function (v) {
        try { v.playbackRate = r; } catch (_) {}
      });
    }
    /* At most once per frame while dragging; it reads the slider at run time so a
       double-click reset (below) can never be overwritten by a stale value. */
    on(DOM.globalSpeed, 'input', Util.rafThrottle(function () {
      applyGlobalRate(parseFloat(DOM.globalSpeed.value));
    }));
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
  var syncBtt = Util.rafThrottle(function () {
    DOM.btt.classList.toggle('show', window.scrollY > 280);
  });
  on(window, 'scroll', syncBtt, { passive: true });
  on(DOM.btt, 'click', function () {
    window.scrollTo({ top: 0, behavior: Util.prefersReducedMotion() ? 'auto' : 'smooth' });
    /* The button hides itself at the top of the page; keep keyboard focus on the page. */
    DOM.pageBody.focus({ preventScroll: true });
  });

  /* ════════════════════════════════════════════════════════
     PRIVACY CONTROLS  (footer)
     "Privacy settings" brings the storage banner back. "Delete my data"
     erases what Bat-Viewer keeps on this device (the saved theme and the
     banner choice) and everything it holds in memory for this page (the
     gallery, per-card notes, edits and video positions, the Common Notes
     text). It asks for a second click first, because the gallery and the
     notes cannot be brought back. Nothing is stored on any server, so there
     is nothing to delete anywhere else.
  ════════════════════════════════════════════════════════ */
  (function DataControls() {
    var btn = DOM.deleteDataBtn, idleLabel = btn.textContent;
    var armed = false, armTid = 0;

    function disarm() {
      armed = false;
      clearTimeout(armTid);
      btn.textContent = idleLabel;
      btn.classList.remove('is-armed');
    }

    function deleteAll() {
      Store.clearAll();
      Consent.reset();
      Virtual.clear();
      State.noteStates = Object.create(null);
      State.editStates = Object.create(null);
      ProbeCache = Object.create(null);
      CommonNotes.clear();
      DOM.bulkArea.value = '';
      updateTally.cancel();
      setTally(0);
      Theme.apply('night', false);
      Toast.show('Done — everything Bat-Viewer kept on this device has been deleted.', 'ok', 5000);
      if (Store.available()) ConsentBanner.show(false);       /* nothing is remembered, so it asks again */
    }

    on(btn, 'click', function () {
      if (!armed) {
        armed = true;
        btn.textContent = 'Click again to confirm';
        btn.classList.add('is-armed');
        Toast.show('This clears your gallery, notes and edits and the settings saved in this browser. Click “Click again to confirm” within 6 seconds to go ahead.', 'err', 6000);
        armTid = setTimeout(disarm, 6000);
        return;
      }
      disarm();
      deleteAll();
    });
    on(btn, 'blur', disarm);                                   /* moving on counts as changing your mind */

    on(DOM.privacySettingsBtn, 'click', function () {
      if (!Store.available()) {
        Toast.show('Your browser is blocking local storage, so Bat-Viewer is not saving anything.', 'ok', 4500);
        return;
      }
      ConsentBanner.show(true);
    });
  })();

  /* ════════════════════════════════════════════════════════
     TOPBAR HEIGHT SYNC
     ─ The topbar wraps to a second row instead of scrolling
       horizontally on narrow screens. Keep --topbar-h synced
       to its real rendered height so the fixed-position Edit
       Mode panel always sits flush below it, at any width.
  ════════════════════════════════════════════════════════ */
  (function () {
    function sync() {
      var h = DOM.topbar ? DOM.topbar.offsetHeight : 54;
      document.documentElement.style.setProperty('--topbar-h', h + 'px');
    }
    sync();
    if (typeof ResizeObserver === 'function' && DOM.topbar) {
      new ResizeObserver(sync).observe(DOM.topbar);
    } else {
      on(window, 'resize', sync);
    }
  })();

  refreshCount();
})();
