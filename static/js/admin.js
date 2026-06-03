'use strict';

/*
 * /admin — bind screen names to Bluetooth iBeacons (UUID + Major + Minor).
 *
 * Mappings are stored server-side (GET/POST/DELETE /api/screen-beacons) so any
 * client uses the same set. Scanning needs Chromium + the experimental flag +
 * a secure context (see ble.js); elsewhere the manual form still works and the
 * banner explains why scanning is unavailable.
 *
 * Reached via the /admin branch in boot.js. Depends on api, esc/escAttr,
 * status, and ble — all loaded earlier.
 */

let adminBeacons = [];
let adminScreens = [];
let adminStopScan = null;     // active scan's stop() fn, or null
let adminScanSeen = new Map();
let adminEditingId = null;    // id of the binding being edited (for rename handling)

async function adminBoot() {
  document.body.classList.add('route-admin');
  const root = document.createElement('div');
  root.id = 'admin-root';
  root.innerHTML = adminShellHtml();
  document.body.appendChild(root);

  adminRenderBanner();
  adminWire();
  await adminLoad();          // beacons first, so screen pairing badges are accurate
  await adminLoadScreens();
}

// Screen name ↔ beacon name match — same trim/case rule as the fling resolver.
function _adminEqName(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

// On-screen diagnostics for the "fling to nearest" test. castTestNearest()
// calls adminDiag(...) at each step so failures are readable without DevTools.
function adminDiag(msg) {
  const el = $('admin-diag');
  if (!el) return;
  el.classList.remove('hidden');
  const bar = $('admin-diag-bar');
  if (bar) bar.classList.remove('hidden');
  el.textContent += (el.textContent ? '\n' : '') + msg;
  el.scrollTop = el.scrollHeight;
}
function adminDiagClear() {
  const el = $('admin-diag');
  if (!el) return;
  el.textContent = '';
  el.classList.remove('hidden');
  const bar = $('admin-diag-bar');
  if (bar) bar.classList.remove('hidden');
}

function adminCopyLog() {
  const el = $('admin-diag');
  const text = el ? el.textContent : '';
  if (!text) { status('Nothing to copy', ''); setTimeout(() => status(''), 1500); return; }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => { status('Log copied ✓', 'ok'); setTimeout(() => status(''), 1800); },
      () => { status('Copy failed — select the text manually', 'err'); setTimeout(() => status(''), 3000); }
    );
  } else {
    status('Clipboard unavailable — select the text manually', 'err'); setTimeout(() => status(''), 3000);
  }
}

// Scan filtered to YOUR saved bindings — Chrome only reports beacons you
// defined, and we report which ones are actually in range + RSSI.
async function adminScanMine() {
  adminDiagClear();
  if (!ble.canScan()) {
    adminDiag('Cannot scan in this browser. ' + ble.explainError({ kind: 'unsupported' }));
    return;
  }
  if (!adminBeacons.length) {
    adminDiag('No beacons defined yet — add one below first.');
    return;
  }
  // key "uuid:major:minor" → screen name, for reporting hits.
  const nameByKey = new Map(adminBeacons.map(b => [`${b.uuid}:${b.major}:${b.minor}`, b.screen_name]));
  adminDiag(`Scanning 6s for your ${adminBeacons.length} defined beacon(s)…`);
  adminBeacons.forEach(b => adminDiag(`  • "${b.screen_name}"  ${b.uuid}:${b.major}:${b.minor}`));
  let beacons;
  try {
    beacons = await ble.scanFor(6000);   // acceptAll + AltBeacon parse (proven path)
  } catch (e) {
    adminDiag('Scan error: ' + ble.explainError(e));
    return;
  }
  adminDiag('— done.');
  const hits = beacons
    .filter(b => nameByKey.has(`${b.uuid}:${b.major}:${b.minor}`))
    .sort((a, z) => z.rssi - a.rssi);
  if (!hits.length) {
    adminDiag(`✗ None of YOUR beacons matched. (Saw ${beacons.length} beacon(s) total.)`);
    if (beacons.length) beacons.forEach(b => adminDiag(`  saw ${b.uuid}:${b.major}:${b.minor} rssi=${b.rssi}`));
    return;
  }
  hits.forEach(h => adminDiag(`✓ "${nameByKey.get(`${h.uuid}:${h.major}:${h.minor}`)}"  ${h.uuid}:${h.major}:${h.minor}  rssi=${h.rssi}`));
  adminDiag('These matched your bindings — Test/flick flings to the strongest.');
}

// Hunt for YOUR UUID(s) in ANY advertisement format — manufacturer data,
// service data, or a 128-bit service UUID. Reports every advertisement that
// carries the UUID, so we learn which broadcast format Chrome can actually read.
// Pair with beacon-bruteforce.sh on the laptop.
async function adminHunt() {
  adminDiagClear();
  if (!ble.canScan()) {
    adminDiag('Cannot scan in this browser. ' + ble.explainError({ kind: 'unsupported' }));
    return;
  }
  // Targets: every bound UUID (no-dash + dashed), or fall back to the test UUID.
  const src = adminBeacons.length ? adminBeacons : [{ uuid: 'e20a39f473f54bc4a12f17d1ad07a961' }];
  const targets = new Set();
  src.forEach(b => {
    const nod = (b.uuid || '').replace(/-/g, '').toLowerCase();
    if (nod.length === 32) {
      targets.add(nod);
      targets.add(nod.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'));
      // 128-bit service UUIDs come through byte-reversed (little-endian):
      const rev = nod.match(/../g).reverse().join('');
      targets.add(rev);
    }
  });
  const list = [...targets];
  adminDiag('Hunting 30s for your UUID in ANY format (mfr data / service data / service UUID).');
  adminDiag('▶ Start beacon-bruteforce.sh on the laptop NOW.');
  const hits = new Map();
  let stop = null;
  try {
    stop = await ble.startScanDump((line) => {
      const L = line.toLowerCase();
      if (list.some(t => L.includes(t))) hits.set(line, (hits.get(line) || 0) + 1);
    });
  } catch (e) {
    adminDiag('Scan error: ' + ble.explainError(e));
    return;
  }
  setTimeout(() => {
    if (stop) stop();
    adminDiag('— done.');
    if (!hits.size) {
      adminDiag('✗ Nothing carrying your UUID came through, in ANY format. Chrome on this device cannot see it however it is broadcast.');
      return;
    }
    [...hits.entries()].sort((a, z) => z[1] - a[1]).forEach(([line, n]) => adminDiag(`✓ (${n}×) ${line}`));
    adminDiag('↑ THESE formats worked. Note whether the UUID showed in mfr[…], svc[…], or uuids[…] — that is the broadcast format to use.');
  }, 30000);
}

// Dump every UNIQUE BLE advertisement seen in a 6s window (deduped by payload,
// with a repeat count), so we can eyeball what's actually broadcasting.
// appleOnly=true scans with an Apple (0x4C) manufacturer-data filter instead of
// acceptAll — the reliable way to receive iBeacon payloads in Chrome/Edge.
async function adminDumpBle(appleOnly) {
  adminDiagClear();
  if (!ble.canScan()) {
    adminDiag('Cannot scan in this browser. ' + ble.explainError({ kind: 'unsupported' }));
    return;
  }
  adminDiag(appleOnly
    ? 'iBeacon-only scan (Apple 0x4C filter) for 6s — keep the beacon broadcasting nearby…'
    : 'Dumping ALL BLE advertisements for 6s — keep the beacon broadcasting nearby…');
  const seen = new Map();   // unique line → repeat count
  let stop = null;
  try {
    stop = await ble.startScanDump((line) => { seen.set(line, (seen.get(line) || 0) + 1); }, { appleOnly });
  } catch (e) {
    adminDiag('Scan error: ' + ble.explainError(e));
    return;
  }
  setTimeout(() => {
    if (stop) stop();
    const lines = [...seen.entries()].sort((a, z) => z[1] - a[1]);
    adminDiag(`— done. ${lines.length} unique signal(s):`);
    if (!lines.length) adminDiag('(nothing)');
    lines.forEach(([line, n]) => adminDiag(`(${n}×) ${line}`));
    const hasApple   = lines.some(([l]) => /0x4C=/i.test(l));
    const hasIBeacon = lines.some(([l]) => /0x4C=0215/i.test(l));
    if (hasIBeacon) {
      adminDiag('✓ A real iBeacon (0x4C=0215…) is present above. Test/flick should work now.');
    } else if (hasApple) {
      adminDiag('~ Apple 0x4C signals are present, but NONE are iBeacons (no 0215 prefix) — those are iPhone/AirPods Continuity/Find My chatter. Your iBeacon is not on air / not reaching this device.');
    } else if (appleOnly) {
      adminDiag('✗ Apple-filtered scan saw no 0x4C at all — nothing Apple in range.');
    } else {
      adminDiag('✗ No 0x4C here. If a native app sees the beacon, try the 🍏 iBeacon-only scan.');
    }
  }, 6000);
}

function adminShellHtml() {
  return `
    <div class="admin-header">
      <button class="btn-icon" id="btn-admin-back" title="Back">←</button>
      <span class="admin-title">Screens &amp; Beacons</span>
    </div>
    <div class="admin-body">
      <div id="admin-banner" class="admin-banner"></div>

      <div class="admin-test">
        <button type="button" class="btn-ghost" id="btn-admin-test">🧪 Test — fling Rick Roll to nearest screen</button>
        <button type="button" class="btn-ghost" id="btn-admin-dump">🔍 Dump all BLE signals (6s)</button>
        <button type="button" class="btn-ghost" id="btn-admin-dump-apple">🍏 iBeacon-only scan (6s, filtered)</button>
        <button type="button" class="btn-ghost" id="btn-admin-scan-mine">🎯 Scan my beacons (6s)</button>
        <button type="button" class="btn-ghost" id="btn-admin-hunt">🔦 Hunt my UUID — any format (30s)</button>
        <div class="admin-test-hint">Test runs the fling path. Dump lists every unique advertisement. The 🍏 scan filters on Apple <code>0x4C</code> — use it if Dump shows no <code>mfr[0x4C=0215…]</code> but a native app sees the beacon.</div>
        <div class="admin-diag-bar hidden" id="admin-diag-bar">
          <button type="button" class="btn-ghost admin-mini" id="btn-admin-copy">📋 Copy log</button>
        </div>
        <pre id="admin-diag" class="admin-diag hidden"></pre>
      </div>

      <h3 class="admin-section-h">
        Connected screens
        <button type="button" class="btn-ghost admin-mini" id="btn-admin-screens-refresh" title="Refresh">↻</button>
      </h3>
      <div id="admin-screens" class="admin-list"></div>

      <h3 class="admin-section-h">Bound screens</h3>
      <div id="admin-list" class="admin-list"></div>

      <h3 class="admin-section-h" id="admin-form-h">Add a beacon</h3>
      <form id="admin-form" class="admin-form" autocomplete="off">
        <label>Screen name
          <input type="text" name="screen_name" placeholder="e.g. Laptop" required>
        </label>
        <label>Beacon UUID
          <input type="text" name="uuid" placeholder="E20A39F4-73F5-4BC4-A12F-17D1AD07A961" required>
        </label>
        <div class="admin-form-row">
          <label>Major <input type="number" name="major" min="0" max="65535" value="0" required></label>
          <label>Minor <input type="number" name="minor" min="0" max="65535" value="0" required></label>
          <label>Tx power <input type="number" name="tx_power" placeholder="optional"></label>
        </div>
        <div class="admin-form-actions">
          <button type="button" class="btn-ghost" id="btn-admin-scan">📡 Scan</button>
          <button type="submit" class="btn-primary" id="btn-admin-save">Save</button>
          <button type="button" class="btn-ghost hidden" id="btn-admin-reset">Clear</button>
        </div>
        <div id="admin-scan-results" class="admin-scan-results"></div>
      </form>
    </div>`;
}

// ── Capability banner ─────────────────────────────────────────────────────────

function adminFlagUrl() {
  // chrome:// vs edge:// — pages can't navigate to these, so the link copies it.
  const scheme = /Edg/.test(navigator.userAgent) ? 'edge' : 'chrome';
  return scheme + '://flags/#enable-experimental-web-platform-features';
}

function adminRenderBanner() {
  const el = $('admin-banner');
  if (!el) return;
  const s = ble.support();
  let cls = 'warn', msg = null, html = null;
  if (ble.canScan()) {
    cls = 'ok';
    msg = 'Bluetooth scanning is ready. Tap Scan and pick your beacon, or enter its values by hand.';
  } else if (s.browser === 'firefox') {
    msg = 'Firefox doesn’t support Web Bluetooth. To scan for beacons, open this page in Chrome or Edge. You can still bind a beacon by typing its UUID, Major, and Minor below.';
  } else if (s.browser === 'ios') {
    msg = 'Safari and all iOS browsers can’t read Bluetooth. Scanning isn’t available on this device. You can still type a beacon’s values below — any Chrome/Edge device will use this mapping.';
  } else if (!s.secure) {
    msg = 'Bluetooth scanning needs a secure connection. Open this page over HTTPS or on localhost.';
  } else if (!s.hasScan) {
    const url = adminFlagUrl();
    html = `Bluetooth scanning is behind a browser flag. Open `
      + `<a href="#" class="admin-flaglink" data-copy="${escAttr(url)}">${esc(url)}</a>`
      + `, set it to Enabled, restart the browser, and reload. You can type a beacon manually meanwhile.`;
  } else {
    msg = 'Bluetooth scanning isn’t available in this browser. Use Chrome or Edge, or type a beacon manually.';
  }
  el.className = 'admin-banner ' + cls;
  if (html != null) el.innerHTML = html;
  else el.textContent = msg;

  const scanBtn = $('btn-admin-scan');
  if (scanBtn) scanBtn.disabled = !ble.canScan();
}

// ── Connected screens (live, beacon-independent) ──────────────────────────────

async function adminLoadScreens() {
  try { adminScreens = await api.get('/api/cast/screens'); }
  catch { adminScreens = []; }
  adminRenderScreens();
  adminRenderList();   // refresh online/offline dots on the bound-screen list
}

function adminRenderScreens() {
  const el = $('admin-screens');
  if (!el) return;
  if (!adminScreens.length) {
    el.innerHTML = `<div class="admin-empty">No screens connected. Open /watch or /tv on a device.</div>`;
    return;
  }
  el.innerHTML = adminScreens.map(s => {
    const beacon = adminBeacons.find(b => _adminEqName(b.screen_name, s.name));
    const badge = beacon
      ? `<span class="admin-pair paired" title="${escAttr(beacon.uuid + ' · ' + beacon.major + '/' + beacon.minor)}">📡 paired</span>`
      : `<span class="admin-pair">no beacon</span>`;
    return `
    <div class="admin-row">
      <div class="admin-row-main">
        <div class="admin-row-name">${esc(s.name || 'Screen')} ${badge}</div>
        <div class="admin-row-id">${esc(s.id)}</div>
      </div>
      <button class="btn-ghost admin-test-screen" data-id="${escAttr(s.id)}">🧪 Test</button>
    </div>`;
  }).join('');
}


// ── Mappings list ───────────────────────────────────────────────────────────

async function adminLoad() {
  try { adminBeacons = await api.get('/api/screen-beacons'); }
  catch (e) { adminBeacons = []; }
  adminRenderList();
  adminRenderScreens();   // refresh "paired" badges on the connected-screen list
}

function adminRenderList() {
  const el = $('admin-list');
  if (!el) return;
  if (!adminBeacons.length) {
    el.innerHTML = `<div class="admin-empty">No screens bound yet. Add one below.</div>`;
    return;
  }
  el.innerHTML = adminBeacons.map(b => {
    const online = adminScreens.some(s => _adminEqName(s.name, b.screen_name));
    const dot = `<span class="admin-dot ${online ? 'online' : ''}" title="${online ? 'Connected now' : 'Not connected'}"></span>`;
    return `
    <div class="admin-row">
      <div class="admin-row-main">
        <div class="admin-row-name">${dot}${esc(b.screen_name)}</div>
        <div class="admin-row-id">${esc(b.uuid)} · ${b.major}/${b.minor}</div>
      </div>
      <button class="btn-ghost admin-edit" data-id="${b.id}">Edit</button>
      <button class="btn-danger admin-del" data-id="${b.id}">Remove</button>
    </div>`;
  }).join('');
}

// ── Form ──────────────────────────────────────────────────────────────────────

function adminFillForm(b) {
  const f = $('admin-form');
  adminEditingId = b.id;
  f.screen_name.value = b.screen_name || '';
  f.uuid.value = b.uuid || '';
  f.major.value = b.major != null ? b.major : 0;
  f.minor.value = b.minor != null ? b.minor : 0;
  f.tx_power.value = b.tx_power != null ? b.tx_power : '';
  $('admin-form-h').textContent = `Edit "${b.screen_name}"`;
  $('btn-admin-reset').classList.remove('hidden');
  f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function adminResetForm() {
  const f = $('admin-form');
  f.reset();
  adminEditingId = null;
  $('admin-form-h').textContent = 'Add a beacon';
  $('btn-admin-reset').classList.add('hidden');
  $('admin-scan-results').innerHTML = '';
}

async function adminSave(e) {
  e.preventDefault();
  const f = $('admin-form');
  const body = {
    screen_name: f.screen_name.value.trim(),
    uuid: f.uuid.value.trim(),
    major: Number(f.major.value),
    minor: Number(f.minor.value),
    tx_power: f.tx_power.value === '' ? null : Number(f.tx_power.value),
  };
  if (!body.screen_name) { status('Screen name required', 'err'); setTimeout(() => status(''), 2000); return; }
  try {
    if (adminEditingId) {
      // Update the existing row in place (rename-safe — no self-collision).
      await api.put('/api/screen-beacons/' + adminEditingId, body);
    } else {
      await api.post('/api/screen-beacons', body);
    }
    status('Saved ✓', 'ok'); setTimeout(() => status(''), 1500);
    adminResetForm();
    await adminLoad();
  } catch (err) {
    status('Save failed: ' + err.message, 'err'); setTimeout(() => status(''), 3500);
  }
}

async function adminDelete(id) {
  try {
    await api.del('/api/screen-beacons/' + id);
    await adminLoad();
  } catch (err) {
    status('Remove failed: ' + err.message, 'err'); setTimeout(() => status(''), 3000);
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────────

async function adminScan() {
  if (adminStopScan) { adminStopScan(); adminStopScan = null; $('btn-admin-scan').textContent = '📡 Scan'; return; }
  const out = $('admin-scan-results');
  adminScanSeen = new Map();
  out.innerHTML = '<div class="admin-scan-status">Scanning… move close to the beacon. Tap Scan again to stop.</div>';
  try {
    adminStopScan = await ble.startScan((b) => {
      const key = `${b.uuid}:${b.major}:${b.minor}`;
      adminScanSeen.set(key, b);   // keep latest reading
      adminRenderScanResults();
    });
    $('btn-admin-scan').textContent = '■ Stop';
    // Auto-stop after a generous window so a forgotten scan doesn't run forever.
    setTimeout(() => {
      if (adminStopScan) { adminStopScan(); adminStopScan = null; $('btn-admin-scan').textContent = '📡 Scan'; }
    }, 20000);
  } catch (e) {
    out.innerHTML = `<div class="admin-scan-status err">${esc(ble.explainError(e))}</div>`;
  }
}

function adminRenderScanResults() {
  const out = $('admin-scan-results');
  const list = [...adminScanSeen.values()].sort((a, z) => z.rssi - a.rssi);
  if (!list.length) { out.innerHTML = '<div class="admin-scan-status">Scanning… no beacons yet.</div>'; return; }
  out.innerHTML = list.map(b => `
    <button type="button" class="admin-beacon" data-uuid="${escAttr(b.uuid)}"
            data-major="${b.major}" data-minor="${b.minor}" data-tx="${b.txPower}">
      <span class="admin-beacon-id">${esc(b.uuid)}</span>
      <span class="admin-beacon-meta">${b.major}/${b.minor} · ${b.rssi} dBm</span>
    </button>`).join('');
}

function adminPickScanned(btn) {
  const f = $('admin-form');
  f.uuid.value = btn.dataset.uuid;
  f.major.value = btn.dataset.major;
  f.minor.value = btn.dataset.minor;
  if (btn.dataset.tx && btn.dataset.tx !== 'undefined') f.tx_power.value = btn.dataset.tx;
  if (!f.screen_name.value) f.screen_name.focus();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function adminWire() {
  $('btn-admin-back').addEventListener('click', () => { location.href = '/'; });
  $('admin-form').addEventListener('submit', adminSave);
  $('btn-admin-scan').addEventListener('click', adminScan);
  $('btn-admin-reset').addEventListener('click', adminResetForm);

  $('btn-admin-test').addEventListener('click', () => {
    adminDiagClear();
    adminDiag('Starting nearest-screen test…');
    if (typeof castTestNearest === 'function') castTestNearest();
    else adminDiag('castTestNearest() is not available — is cast.js loaded?');
  });

  $('btn-admin-dump').addEventListener('click', () => adminDumpBle(false));
  $('btn-admin-dump-apple').addEventListener('click', () => adminDumpBle(true));
  $('btn-admin-scan-mine').addEventListener('click', adminScanMine);
  $('btn-admin-hunt').addEventListener('click', adminHunt);
  $('btn-admin-copy').addEventListener('click', adminCopyLog);

  $('btn-admin-screens-refresh').addEventListener('click', adminLoadScreens);

  $('admin-screens').addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-test-screen');
    if (btn && typeof castTestScreen === 'function') castTestScreen(btn.dataset.id);
  });

  // chrome://flags links can't be opened by a page, so copy to clipboard instead.
  $('admin-banner').addEventListener('click', (e) => {
    const link = e.target.closest('.admin-flaglink');
    if (!link) return;
    e.preventDefault();
    const url = link.dataset.copy || '';
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => { status('Copied — paste into a new tab', 'ok'); setTimeout(() => status(''), 2500); },
        () => { status('Copy this: ' + url, ''); setTimeout(() => status(''), 4000); }
      );
    } else {
      status('Copy this: ' + url, ''); setTimeout(() => status(''), 4000);
    }
  });

  $('admin-list').addEventListener('click', (e) => {
    const edit = e.target.closest('.admin-edit');
    if (edit) {
      const b = adminBeacons.find(x => String(x.id) === edit.dataset.id);
      if (b) adminFillForm(b);
      return;
    }
    const del = e.target.closest('.admin-del');
    if (del) adminDelete(del.dataset.id);
  });

  $('admin-scan-results').addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-beacon');
    if (btn) adminPickScanned(btn);
  });
}
