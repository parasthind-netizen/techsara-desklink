// Download page behaviour. Kept in its own file because the site's
// Content-Security-Policy allows no inline scripts.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var tabWin = $('tab-windows'), tabMac = $('tab-mac');

  // Preselect the visitor's platform; both tabs stay one click away.
  function showOS(os) {
    var mac = os === 'mac';
    tabMac.classList.toggle('active', mac);
    tabWin.classList.toggle('active', !mac);
    tabMac.setAttribute('aria-selected', mac ? 'true' : 'false');
    tabWin.setAttribute('aria-selected', mac ? 'false' : 'true');
    $('pane-mac').style.display = mac ? '' : 'none';
    $('pane-windows').style.display = mac ? 'none' : '';
  }
  tabWin.addEventListener('click', function () { showOS('windows'); });
  tabMac.addEventListener('click', function () { showOS('mac'); });
  var ua = navigator.userAgent || '';
  var isPhone = /Android|iPhone|iPad|iPod/.test(ua) || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1);
  if (!isPhone && (/Mac/.test(navigator.platform || '') || /Macintosh/.test(ua))) showOS('mac');

  // A download this server cannot hand out yet is shown as such instead of
  // leading to a dead link.
  function unavailable(prefix, label) {
    var btn = $(prefix + '-dl');
    if (btn) {
      btn.removeAttribute('href');
      btn.setAttribute('aria-disabled', 'true');
      var text = btn.querySelector('span');
      if (text) text.textContent = label;
    }
    var hide = [prefix + '-info', prefix + '-steps'];
    for (var i = 0; i < hide.length; i++) { var el = $(hide[i]); if (el) el.style.display = 'none'; }
    var soon = $(prefix + '-soon');
    if (soon) soon.style.display = 'block';
  }
  // Mac ships disabled; only a confirmed build makes it a live download.
  function macAvailable() {
    var btn = $('mac-dl');
    if (btn) { btn.setAttribute('href', '/download/mac'); btn.removeAttribute('aria-disabled'); }
    ['mac-info', 'mac-steps'].forEach(function (id) { var el = $(id); if (el) el.style.display = ''; });
    var soon = $('mac-soon'); if (soon) soon.style.display = 'none';
  }
  fetch('/api/downloads', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      if (d.windows && d.windows.available === false) unavailable('win', 'Not available yet');
      if (d.mac && d.mac.available === true) macAvailable();
    })
    .catch(function () {});

  // Product name — the owner can rebrand it from the console.
  fetch('/branding', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.name || d.name === 'DeskLink') return;
      document.querySelectorAll('[data-brand]').forEach(function (el) { el.textContent = d.name; });
      document.title = 'Download ' + d.name;
    })
    .catch(function () {});
})();
