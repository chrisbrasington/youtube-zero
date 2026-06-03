'use strict';

/*
 * Web Bluetooth helper for iBeacon scanning.
 *
 * Classic script, loaded before admin.js and boot.js. Exposes a `ble` global
 * (IIFE, like `api`).
 *
 * IMPORTANT: advertisement scanning (navigator.bluetooth.requestLEScan) is
 * Chromium-only (Chrome / Edge / Android Chrome), needs a SECURE context
 * (HTTPS or localhost), the experimental flag
 * chrome://flags/#enable-experimental-web-platform-features, and a user
 * gesture to start. Firefox (any platform) and iOS Safari have no Web
 * Bluetooth at all — canScan() returns false and callers fall back.
 */

const ble = (() => {
  const APPLE_COMPANY_ID = 0x004C;   // iBeacons advertise under Apple's company id

  // Coarse browser bucket from the UA string — only used to pick the right
  // "why can't I scan" message, never for feature gating (that's canScan()).
  function _browser() {
    const ua = navigator.userAgent || '';
    if (/Firefox|FxiOS/.test(ua)) return 'firefox';
    if (/iPhone|iPad|iPod/.test(ua)) return 'ios';       // all iOS browsers are WebKit
    if (/Edg|Chrome|Chromium|CriOS|SamsungBrowser/.test(ua)) return 'chromium';
    return 'other';
  }

  function support() {
    const secure = window.isSecureContext === true;
    const hasBt = 'bluetooth' in navigator;
    const hasScan = hasBt && typeof navigator.bluetooth.requestLEScan === 'function';
    return { secure, hasBt, hasScan, browser: _browser() };
  }

  function canScan() {
    const s = support();
    return s.secure && s.hasScan;
  }

  // Parse an Apple iBeacon payload from the manufacturerData DataView keyed by
  // company id 0x004C. The DataView starts at the iBeacon type byte:
  //   [0]      0x02   (iBeacon type)
  //   [1]      0x15   (remaining length = 21)
  //   [2..17]  proximity UUID (16 bytes)
  //   [18..19] major   (uint16, big-endian)
  //   [20..21] minor   (uint16, big-endian)
  //   [22]     measured TX power at 1m (int8)
  // Returns { uuid, major, minor, txPower } or null.
  function parseIBeacon(dv) {
    if (!dv || dv.byteLength < 23) return null;
    if (dv.getUint8(0) !== 0x02 || dv.getUint8(1) !== 0x15) return null;
    let uuid = '';
    for (let i = 2; i < 18; i++) uuid += dv.getUint8(i).toString(16).padStart(2, '0');
    return {
      uuid,                              // lowercase hex, no dashes — matches storage
      major: dv.getUint16(18, false),    // big-endian
      minor: dv.getUint16(20, false),
      txPower: dv.getInt8(22),
    };
  }

  // Start a scan. onBeacon({ uuid, major, minor, txPower, rssi }) fires for each
  // parseable iBeacon advertisement. Returns a stop() function.
  // MUST be called from a user gesture (click / touch). Throws on unsupported.
  // onBeacon(parsedIBeacon) fires only for iBeacon advertisements.
  // onRaw({ companyIds, rssi, name }) — optional — fires for EVERY advertisement,
  // for diagnostics (what's actually in the air).
  async function startScan(onBeacon, onRaw) {
    if (!canScan()) throw Object.assign(new Error('scan-unavailable'), { kind: 'unsupported' });
    // iBeacons expose no GATT services to filter on, so accept everything.
    const scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    const handler = (ev) => {
      if (onRaw) {
        const companyIds = ev.manufacturerData ? [...ev.manufacturerData.keys()] : [];
        onRaw({ companyIds, rssi: ev.rssi, name: ev.device && ev.device.name });
      }
      const dv = ev.manufacturerData && ev.manufacturerData.get(APPLE_COMPANY_ID);
      const ib = parseIBeacon(dv);
      if (ib) onBeacon({ ...ib, rssi: ev.rssi });
    };
    navigator.bluetooth.addEventListener('advertisementreceived', handler);
    return function stop() {
      try { scan.stop(); } catch (_) {}
      navigator.bluetooth.removeEventListener('advertisementreceived', handler);
    };
  }

  // One-shot: scan for `ms`, return the list of beacons seen, each with its
  // strongest observed RSSI (keyed by uuid:major:minor). Used by flick-up.
  // onRaw (optional) is forwarded to startScan for diagnostics.
  async function scanFor(ms = 3000, onRaw) {
    const best = new Map();
    const stop = await startScan((b) => {
      const k = `${b.uuid}:${b.major}:${b.minor}`;
      const prev = best.get(k);
      if (!prev || b.rssi > prev.rssi) best.set(k, b);
    }, onRaw);
    await new Promise(r => setTimeout(r, ms));
    stop();
    return [...best.values()];
  }

  function _hex(dv) {
    let s = '';
    for (let i = 0; i < dv.byteLength; i++) s += dv.getUint8(i).toString(16).padStart(2, '0');
    return s;
  }

  // Full per-advertisement dump for diagnostics. onAdv(line) gets a formatted
  // string for EVERY advertisement: rssi, name, every manufacturer-data entry
  // (company id + raw hex) and service-data entry. Returns stop().
  // iBeacon shows as mfr[0x4C=0215<32-hex-uuid><major><minor><tx>].
  // Eddystone shows as svc[0000feaa-…=…].
  async function startScanDump(onAdv) {
    if (!canScan()) throw Object.assign(new Error('scan-unavailable'), { kind: 'unsupported' });
    const scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    const handler = (ev) => {
      const parts = [`rssi=${ev.rssi}`];
      const nm = (ev.device && ev.device.name) || ev.name;
      if (nm) parts.push(`name="${nm}"`);
      if (ev.manufacturerData && ev.manufacturerData.size) {
        const m = [];
        ev.manufacturerData.forEach((dv, id) => m.push(`0x${id.toString(16).toUpperCase()}=${_hex(dv)}`));
        parts.push('mfr[' + m.join(' ') + ']');
      }
      if (ev.serviceData && ev.serviceData.size) {
        const s = [];
        ev.serviceData.forEach((dv, uuid) => s.push(`${uuid}=${_hex(dv)}`));
        parts.push('svc[' + s.join(' ') + ']');
      }
      if (ev.uuids && ev.uuids.length) parts.push('uuids[' + ev.uuids.join(',') + ']');
      onAdv(parts.join(' '));
    };
    navigator.bluetooth.addEventListener('advertisementreceived', handler);
    return function stop() {
      try { scan.stop(); } catch (_) {}
      navigator.bluetooth.removeEventListener('advertisementreceived', handler);
    };
  }

  // Human-readable explanation for a scan failure, for toasts / admin results.
  function explainError(e) {
    if (!e) return 'Bluetooth scan failed.';
    if (e.kind === 'unsupported') {
      return 'This browser can’t scan for Bluetooth. Use Chrome or Edge with the experimental flag.';
    }
    const name = e.name || '';
    const msg = String(e.message || '');
    if (name === 'NotAllowedError' || /permission|denied/i.test(msg)) {
      return 'Bluetooth permission denied. Allow Bluetooth for this site and try again.';
    }
    if (name === 'NotFoundError' || /not found|globally disabled|disabled/i.test(msg)) {
      return 'Couldn’t start a scan. Make sure Bluetooth is on and the experimental flag is enabled.';
    }
    return 'Bluetooth scan failed: ' + (msg || 'unknown error');
  }

  return { support, canScan, parseIBeacon, startScan, startScanDump, scanFor, explainError };
})();
