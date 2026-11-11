// Landing page behaviour. Kept in its own file because the site's
// Content-Security-Policy allows no inline scripts.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ua = navigator.userAgent || '';
  var plat = navigator.platform || '';
  var isPhone = /Android|iPhone|iPad|iPod/.test(ua) || (/Mac/.test(plat) && navigator.maxTouchPoints > 1);
  var isMac = !isPhone && (/Mac/.test(plat) || /Macintosh/.test(ua));
  var isWin = !isPhone && (/Win/.test(plat) || /Windows/.test(ua));

  function badge(holder, text, cls) {
    if (!holder) return;
    holder.textContent = '';
    var s = document.createElement('span');
    s.className = 'suggest-badge' + (cls ? ' ' + cls : '');
    s.textContent = text;
    holder.appendChild(s);
  }
  function meta(id, base, version) {
    var el = $(id);
    if (el) el.textContent = base + (version ? ' · v' + version : '');
  }
  // Make a download card's button live (only once the server confirms it).
  function available(prefix, label, href, subHtml) {
    var btn = $(prefix + '-btn'), sub = $(prefix + '-sub');
    if (btn) { btn.textContent = label; btn.setAttribute('href', href); btn.removeAttribute('aria-disabled'); }
    if (sub && subHtml != null) sub.innerHTML = subHtml;
  }
  // A download this server cannot hand out yet is shown as such instead of
  // leading to a dead link.
  function unavailable(prefix, label, html) {
    var btn = $(prefix + '-btn'), sub = $(prefix + '-sub');
    if (btn) { btn.textContent = label; btn.removeAttribute('href'); btn.setAttribute('aria-disabled', 'true'); }
    if (sub) sub.innerHTML = html;
  }

  var settled = false;
  function render(dl, final) {
    if (settled) return;
    // A provisional render (the timeout, before the server answers) stays
    // neutral: it never claims a platform is available or highlights a card, so
    // the real answer always wins and no card is left pointing at a dead link.
    if (!final) { if (isPhone && $('os-note')) $('os-note').textContent = 'Open this page on the Windows or Mac computer you want to support.'; return; }
    settled = true;
    var win = (dl && dl.windows) || {}, mac = (dl && dl.mac) || {};
    var winReady = !!win.available, macReady = !!mac.available;
    var note = $('os-note');

    meta('win-meta', 'Windows 10 / 11 · 64-bit', winReady && win.version);
    meta('mac-meta', 'macOS 11 or later', macReady && mac.version);

    if (winReady) {
      available('win', 'Download for Windows', '/download/windows-zip', 'ZIP download · <a href="/download/windows">direct .exe</a>');
      if (isWin) { $('dl-win').classList.add('suggested'); badge($('win-badge'), 'Recommended for this PC'); }
    } else {
      badge($('win-badge'), 'Not available yet', 'soon');
      unavailable('win', 'Not available yet', 'Ask your support team for the installer.');
    }

    if (macReady) {
      var macSub = 'Apple Silicon · <a href="/download/mac?arch=intel">Intel Mac</a>';
      if (mac.appleSilicon && !mac.intel) macSub = 'For Apple Silicon (M-series) Macs';
      else if (mac.intel && !mac.appleSilicon) macSub = 'For Intel Macs';
      available('mac', 'Download for Mac', '/download/mac', macSub);
      if (isMac) { $('dl-mac').classList.add('suggested'); badge($('mac-badge'), 'Recommended for this Mac'); }
    } else {
      badge($('mac-badge'), 'Coming soon', 'soon');
      unavailable('mac', 'Coming soon',
        'In final testing · <a href="mailto:support@techsarasolutions.com?subject=DeskLink%20for%20Mac">ask for early access</a>');
    }

    if (!note) return;
    if (isPhone) note.textContent = 'Open this page on the Windows or Mac computer you want to support.';
    else if (isWin && winReady) note.textContent = 'Windows detected — the Windows download is highlighted below.';
    else if (isMac && macReady) note.textContent = 'macOS detected — the Mac download is highlighted below.';
    else if (isMac) note.textContent = 'The Mac agent is coming soon — the Windows agent is available today.';
    else note.textContent = macReady ? 'Available for Windows and macOS.' : 'Available for Windows today — macOS coming soon.';
  }

  var fallback = setTimeout(function () { render(null, false); }, 1500);
  fetch('/api/downloads', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { clearTimeout(fallback); render(d, true); })
    .catch(function () { clearTimeout(fallback); render(null, true); });

  // Product name — the owner can rebrand it from the console.
  fetch('/branding', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.name || d.name === 'DeskLink') return;
      document.querySelectorAll('[data-brand]').forEach(function (el) { el.textContent = d.name; });
      document.title = d.name + ' — Secure Remote Support for Teams';
    })
    .catch(function () {});
})();
