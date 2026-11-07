/* ════════════════════════════════════════════════════════
   Bat-Viewer chunk: video-card
   The <video> player card. Fetched the first time a video is shown
   (see the VideoCard stand-in in app.js); image-only sessions never
   download it.
════════════════════════════════════════════════════════ */
BVChunk('video-card', function (bv) {
  'use strict';
  var State = bv.State, Util = bv.Util, el = bv.el, on = bv.on;
  var MEDIA_STATUS = bv.MEDIA_STATUS, MediaState = bv.MediaState;
  var EditState = bv.EditState, VideoState = bv.VideoState, GlobalVid = bv.GlobalVid;
  var Toast = bv.Toast, Chrome = bv.Chrome, Virtual = bv.Virtual, ImageCard = bv.ImageCard, EditMode = bv.EditMode;
  var makeLoadingSpinner = bv.makeLoadingSpinner, waitForMediaRetry = bv.waitForMediaRetry;
  var resolveMediaRetry = bv.resolveMediaRetry, beginCardRetry = bv.beginCardRetry;
  var trySwapMediaType = bv.trySwapMediaType, attachZoom = bv.attachZoom, getMediaType = bv.getMediaType;

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
    var FRAME_STEP = 1 / 30;

    /* Icon-only buttons: the glyph is decoration, the accessible name is `name`
       (the hover tip `title` may add the keyboard shortcut). */
    function iconBtn(cls, glyph, name, title) {
      var b = Chrome.makeBtn(cls, '', title || name);
      var g = el('span'); g.setAttribute('aria-hidden', 'true'); g.textContent = glyph;
      b.appendChild(g);
      b.setAttribute('aria-label', name);
      return b;
    }
    function setIcon(b, glyph, name) {
      b.firstChild.textContent = glyph;
      b.setAttribute('aria-label', name);
    }

    /* See ImageCard.build's matching doc comment — same swapCtx contract,
       mirrored for the image-failed-so-try-video direction. */
    var VIDEO_ERROR_CODES = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    function videoErrorReason(video) {
      var e = video.error;
      if (!e) return 'video error: unknown';
      var name = VIDEO_ERROR_CODES[e.code] || ('code ' + e.code);
      return 'video error: ' + name + (e.message ? ' - ' + e.message : '');
    }

    function build(ci, swapCtx) {
      var url = State.allUrls[ci];
      var stored = VideoState.get(url);
      var startsFailed = MediaState.get(url).status === MEDIA_STATUS.FAILED;

      var card = el('div', 'card card-video-card');
      var h = Chrome.header(ci + 1, 'video');

      /* Media surface */
      var box = el('div', 'card-img-box card-video-box is-loading');
      var spin = makeLoadingSpinner(function () { retryVideo(true); });
      box.appendChild(spin);

      var rotateWrap = el('div', 'img-rotate-wrap');
      var video = makeVideo(url, stored, !startsFailed);
      rotateWrap.appendChild(video);
      box.appendChild(rotateWrap);

      /* Restore edit state for video */
      var storedEdit = EditState.get(url);
      if (storedEdit.brightness !== 1 || storedEdit.contrast !== 1) {
        video.style.filter = 'brightness(' + storedEdit.brightness + ') contrast(' + storedEdit.contrast + ')';
      }
      if (storedEdit.rotation !== 0) EditState.rotate(rotateWrap, storedEdit.rotation);

      /* Zoom badge + hint — same overlay elements as ImageCard */
      var badge = Chrome.zoomOverlay(box).badge;

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
      var suppressErrors = false;
      var retryInFlight = false;

      function syncCardStatus(status, reason) {
        MediaState.set(url, status, 'video', reason);
        card.dataset.mediaStatus = status;
        box.classList.toggle('is-loading', status === MEDIA_STATUS.LOADING);
      }

      function retryVideo(fromLoading, applyLimit) {
        if (retryInFlight) return Promise.resolve(false);
        if (!beginCardRetry(url, 'video', card, fromLoading, applyLimit)) return Promise.resolve(false);
        retryInFlight = true;
        suppressErrors = true;
        Util.unloadVideo(video);
        syncCardStatus(MEDIA_STATUS.LOADING);
        box.innerHTML = '';
        spin = makeLoadingSpinner(function () { retryVideo(true); });
        box.appendChild(spin);

        var wait = waitForMediaRetry(url);
        setTimeout(function () {
          var parentSlot = card.closest('.vslot');
          if (parentSlot) {
            if (box._destroy) box._destroy();
            var idx = parseInt(parentSlot.dataset.idx, 10);
            /* Rebuild honoring the currently-known type (getMediaType)
               instead of always forcing VideoCard. Previously this
               cleared both override sets and rebuilt as VideoCard
               unconditionally, which threw away a confirmed type on
               every retry click and let a stubbornly-broken video
               bounce back and forth between "Video" and "Image" on
               repeated retries instead of just retrying as a video. */
            var freshUrl = State.allUrls[idx];
            Virtual.rebuildSlot(parentSlot, idx, function (i) {
              return getMediaType(freshUrl) === 'video' ? VideoCard.build(i) : ImageCard.build(i);
            });
          } else {
            retryInFlight = false;
            resolveMediaRetry(url, false);
          }
        }, MediaState.retryDelay(url, applyLimit));
        return wait;
      }

      function showFailedView(resolvePending, reason) {
        errored = true; video._errored = true;
        if (spin.parentNode) spin.remove();
        syncCardStatus(MEDIA_STATUS.FAILED, reason);
        if (resolvePending) resolveMediaRetry(url, false);
        retryInFlight = false;
        Util.unloadVideo(video);
        box.innerHTML = '';
        Chrome.buildErrorView(box, 'Could not load video', url, function () {
          retryVideo(false);
        }, h.numEl.id);
      }

      if (!startsFailed) syncCardStatus(MEDIA_STATUS.LOADING);
      on(video, 'loadedmetadata', function () {
        if (spin.parentNode) spin.remove();
        syncCardStatus(MEDIA_STATUS.LOADED);
        /* This card is the fallback attempt after an image failed, and it
           actually decoded as a video — now it's safe to remember. */
        if (swapCtx && swapCtx.confirmOverride) swapCtx.confirmOverride.add(url);
        resolveMediaRetry(url, true);
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
        if (suppressErrors) return;
        if (errored) return;
        /* Fast automatic fallback: try the other media type once before
           giving up — see trySwapMediaType for the full rationale. */
        if (trySwapMediaType(url, card, box, zoom, State.imageOverrides, ImageCard.build)) return;
        var reason = swapCtx
          ? (videoErrorReason(video) + '; ' + swapCtx.firstType + ' fallback also failed')
          : videoErrorReason(video);
        showFailedView(true, reason);
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
      box._retryMedia = retryVideo;
      card._retryMedia = retryVideo;
      box._destroy = function () {
        suppressErrors = true;
        try { video.pause(); } catch (_) {}
        persist();
        zoom.destroy();
        controlsApi.destroy();
        EditState.rotate(rotateWrap, 0);             /* stop tracking this wrapper */
        video.removeAttribute('src');
        try { video.load(); } catch (_) {}
      };

      /* Compose */
      card.appendChild(h.hdr);
      card.appendChild(box);
      card.appendChild(Chrome.urlRow(url));
      var notes; /* assigned just below; onNote only fires later, on click */
      card.appendChild(Chrome.toolbar({
        url: url,
        describedBy: h.numEl.id,
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
        onNote: function () { notes.wrap.classList.toggle('hide'); },
        onRemove: function () { Chrome.removeCard(card, ci, box._destroy); }
      }));
      var noteBtn = card.querySelector('.tnote');
      notes = Chrome.notesSection(url, noteBtn, h.numEl.id);
      card.appendChild(notes.wrap);

      /* Expose for keyboard handler */
      card._video     = video;
      card._frameStep = frameStep;
      if (startsFailed) showFailedView(false);
      return card;
    }

    /* ── Build the underlying <video> element with sane defaults ──
       preload="metadata" → the browser fetches only metadata on load,
       saving bandwidth and avoiding connection blocking. Combined with
       virtualization (only ~2 screens of cards are mounted at any
       time), this is safe for 500+ video sets while still feeling
       instant. Videos always start PAUSED and MUTED. */
    function makeVideo(url, stored, shouldLoad) {
      var v = document.createElement('video');
      v.className = 'card-video';
      v.preload   = 'metadata';
      v.playsInline = true;
      /* Mute-by-default. Global "Mute All" overrides any per-video state
         on load; the user can still un-mute an individual video after. */
      v.muted   = GlobalVid.muteAll ? true : (stored.muted !== false);
      v.volume  = stored.volume;
      v.controls = false;
      v.setAttribute('aria-label', Util.mediaLabel(url, 'Video'));
      if (shouldLoad !== false) v.src = url;

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

    /* ── Controls bar (floating overlay) ──
       Returns { bar, onMetadata, onTimeUpdate, onRateChange, onVolumeChange, destroy } */
    function buildControls(video, box, url) {
      var bar = el('div', 'video-controls');

      /* Left cluster: frame step / play / frame step */
      var prevBtn = iconBtn('vc-btn', '\u23EE', 'Previous frame', 'Previous frame (,)');
      var playBtn = iconBtn('vc-btn vc-play', '\u25B6', 'Play', 'Play / Pause (Space)');
      var nextBtn = iconBtn('vc-btn', '\u23ED', 'Next frame', 'Next frame (.)');

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
      on(video, 'play',  function () { setIcon(playBtn, '\u2759\u2759', 'Pause'); });
      on(video, 'pause', function () { setIcon(playBtn, '\u25B6', 'Play'); });

      /* Scrubber */
      var seek = document.createElement('input');
      seek.type = 'range'; seek.className = 'vc-seek';
      seek.min = '0'; seek.max = '0'; seek.step = 'any'; seek.value = '0';
      seek.setAttribute('aria-label', 'Seek');
      var scrubbing = false;
      on(seek, 'input',  function ()  {
        scrubbing = true;
        timeEl.textContent = Util.fmtTime(parseFloat(seek.value)) +
                             ' / ' + Util.fmtTime(video.duration || 0);
        seek.setAttribute('aria-valuetext', timeEl.textContent);
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
      speedBar.setAttribute('aria-label', 'Playback speed');
      var speedBtn = Chrome.makeBtn('vc-btn vc-speed', '1\u00D7', 'Reset speed to 1\u00D7');
      on(speedBar, 'input', function (e) {
        e.stopPropagation();
        video.playbackRate = parseFloat(speedBar.value);
      });
      on(speedBar, 'click', Util.stop);
      /* A plain click resets too (a double-click alone could not be done from the
         keyboard); the old double-click still works because it is two clicks. */
      on(speedBtn, 'click', function (e) {
        e.stopPropagation();
        video.playbackRate = 1;
        speedBar.value = '1';
      });
      speedWrap.appendChild(speedBar);
      speedWrap.appendChild(speedBtn);

      /* Mute / volume */
      var muteBtn = iconBtn('vc-btn', '\uD83D\uDD0A', 'Mute', 'Mute (M)');
      var volBar  = document.createElement('input');
      volBar.type = 'range'; volBar.className = 'vc-vol';
      volBar.min = '0'; volBar.max = '1'; volBar.step = '0.01';
      volBar.value = String(video.volume);
      volBar.setAttribute('aria-label', 'Volume');
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
      var snapBtn = iconBtn('vc-btn vc-snap', '\uD83D\uDCF7', 'Capture frame as image');
      on(snapBtn, 'click', function (e) {
        e.stopPropagation();
        try {
          var canvas = document.createElement('canvas');
          canvas.width  = video.videoWidth  || 1280;
          canvas.height = video.videoHeight || 720;
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          var dataUrl = canvas.toDataURL('image/png');
          Virtual.appendUrls([dataUrl]);
          Toast.show('Frame captured \u2014 added as item ' + State.allUrls.length + '.', 'ok', 2400);
          snapBtn.classList.add('ok');
          setTimeout(function () { snapBtn.classList.remove('ok'); }, 1200);
        } catch (err) {
          Toast.show('Snapshot blocked (cross-origin video).', 'err', 3500);
        }
      });

      /* Fullscreen */
      var fsBtn = iconBtn('vc-btn', '\u26F6', 'Fullscreen');
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
        /* not while the slider has focus: a screen reader would re-read it 4x a second */
        if (document.activeElement !== seek) seek.setAttribute('aria-valuetext', timeEl.textContent);
      }
      function onRateChange() {
        var r = video.playbackRate;
        var rateText = (Number.isInteger(r) ? r : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + '\u00D7';
        speedBtn.textContent = rateText;
        speedBtn.setAttribute('aria-label', 'Playback speed ' + rateText + ', activate to reset');
        speedBar.setAttribute('aria-valuetext', rateText);
        speedBtn.classList.toggle('alt', r !== 1);
        if (parseFloat(speedBar.value) !== r) speedBar.value = String(r);
      }
      function onVolumeChange() {
        var silent = video.muted || video.volume === 0;
        setIcon(muteBtn, silent ? '\uD83D\uDD07' : '\uD83D\uDD0A', silent ? 'Unmute' : 'Mute');
        volBar.value = String(video.muted ? 0 : video.volume);
      }
      function destroy() { /* event listeners live on controls subtree; GC handles them */ }

      onRateChange(); onVolumeChange();
      return { bar: bar, onMetadata: onMetadata, onTimeUpdate: onTimeUpdate,
               onRateChange: onRateChange, onVolumeChange: onVolumeChange, destroy: destroy };
    }

    return { build: build };
  })();

  return VideoCard;
});
