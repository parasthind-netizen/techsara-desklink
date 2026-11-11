// Runs synchronously in <head>, before first paint, so the page never flashes
// the wrong theme. Preference: 'light' | 'dark' | 'system' (default).
(function () {
  var KEY = 'dl_theme';
  function stored() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (_) { return 'system'; }
  }
  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function apply(pref) {
    var root = document.documentElement;
    root.setAttribute('data-theme', resolve(pref));
    root.setAttribute('data-theme-pref', pref);
  }
  apply(stored());

  // Follow the OS while the preference is 'system'.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (stored() === 'system') apply('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  window.DLTheme = {
    get: stored,
    resolved: function () { return document.documentElement.getAttribute('data-theme'); },
    set: function (pref) {
      if (pref !== 'light' && pref !== 'dark') pref = 'system';
      try { localStorage.setItem(KEY, pref); } catch (_) {}
      apply(pref);
      try { window.dispatchEvent(new CustomEvent('dl-theme', { detail: { pref: pref, resolved: resolve(pref) } })); } catch (_) {}
    }
  };
})();
