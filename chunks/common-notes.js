/* ════════════════════════════════════════════════════════
   Bat-Viewer chunk: common-notes
   The "Common Notes" scratchpad — one global textarea that is NOT
   tied to any media item (separate from the per-card Notes).

   • A native <dialog> opened with showModal(): the browser supplies
     the modal semantics, the focus trap, the inert background and
     Esc-to-close, so none of that is hand-rolled.
   • Created the first time the top-bar button is used (app.js loads
     this file then); repeated clicks never build a second one.
   • The text lives only in the textarea's DOM node. It is never
     written to localStorage/sessionStorage/cookies/a server, so a
     reload clears it. "Delete my data" calls clear() as well.
════════════════════════════════════════════════════════ */
BVChunk('common-notes', function (bv) {
  'use strict';
  var el = bv.el, on = bv.on;

  var dlg = null, ta = null, opener = null, downOnBackdrop = false;

  function isOpen() { return !!dlg && dlg.hasAttribute('open'); }

  function restoreFocus() {
    var back = opener;
    opener = null;
    if (back && back !== document.body && document.documentElement.contains(back) && typeof back.focus === 'function') {
      back.focus({ preventScroll: true });
    }
  }

  function build() {
    dlg = el('dialog', 'cn-dialog');
    dlg.setAttribute('aria-labelledby', 'cnTitle');

    var head = el('div', 'cn-header');
    var title = el('div', 'cn-title');
    title.id = 'cnTitle';
    var icon = el('span', 'cn-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '🗒';
    var name = el('span');
    name.textContent = 'Common Notes';
    title.appendChild(icon);
    title.appendChild(name);

    var close = el('button', 'cn-close');
    close.type = 'button';
    close.id = 'cnClose';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close Common Notes');
    var x = el('span');
    x.setAttribute('aria-hidden', 'true');
    x.textContent = '✕';
    close.appendChild(x);
    head.appendChild(title);
    head.appendChild(close);

    var body = el('div', 'cn-body');
    ta = el('textarea', 'cn-textarea');
    ta.id = 'cnTextarea';
    ta.setAttribute('aria-label', 'Common notes');
    ta.placeholder = 'note down anything here… kept only for this session and cleared automatically on reload.';
    ta.spellcheck = true;
    ta.autofocus = true;
    body.appendChild(ta);

    var foot = el('div', 'cn-footer');
    var hint = el('span', 'cn-hint');
    hint.textContent = 'Session only — cleared automatically on reload.';
    var clearBtn = el('button', 'cn-clear');
    clearBtn.type = 'button';
    clearBtn.id = 'cnClearBtn';
    clearBtn.title = 'Delete all notes';
    clearBtn.textContent = 'Clear All';
    foot.appendChild(hint);
    foot.appendChild(clearBtn);

    dlg.appendChild(head);
    dlg.appendChild(body);
    dlg.appendChild(foot);
    document.body.appendChild(dlg);

    on(close, 'click', hide);
    on(clearBtn, 'click', function () { ta.value = ''; ta.focus(); });
    /* Esc and form-method close both end here, so focus always goes back to
       whatever opened the dialog. */
    on(dlg, 'close', restoreFocus);
    /* A click on the dimmed backdrop (the <dialog> element itself) closes it —
       but only when the press ALSO started there, so dragging a text selection
       out of the textarea and releasing over the backdrop doesn't. */
    on(dlg, 'mousedown', function (e) { downOnBackdrop = e.target === dlg; });
    on(dlg, 'click', function (e) {
      if (e.target === dlg && downOnBackdrop) hide();
      downOnBackdrop = false;
    });
  }

  function show() {
    if (!dlg) build();
    if (isOpen()) return;                       /* never open a second time */
    opener = document.activeElement;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');          /* very old engines: still usable, just not modal */
    ta.focus();
  }

  function hide() {
    if (!isOpen()) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    restoreFocus();
  }

  function clear() { if (ta) ta.value = ''; }

  return { isOpen: isOpen, show: show, hide: hide, clear: clear };
});
