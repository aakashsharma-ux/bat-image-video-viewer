/* Legal pages: use the same Night/Moon theme as the app.
   Same rule as the app — the theme is only remembered if the visitor pressed
   "Allow" on the banner there, so this only ever reads what that choice saved,
   and never writes anything. */
(function () {
  'use strict';
  try {
    var theme = window.localStorage.getItem('bv-theme');
    if (theme === 'moon' || theme === 'night') document.documentElement.setAttribute('data-theme', theme);
  } catch (_) { /* storage blocked: keep the default (Night) */ }
})();
