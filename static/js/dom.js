'use strict';

/*
 * DOM helpers + plain-text/HTML escaping.
 *
 * Classic script. Exposes `$`, `esc`, `escAttr`, `timeAgo`, `status`, `toast`,
 * `copyText` as globals.
 */

const $ = id => document.getElementById(id);


function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}


function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5)  return `${w}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}


function status(msg, type = '') {
  const el = $('status-msg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ' ' + type : '');
}


/*
 * Transient confirmation that works from anywhere. `status` writes into the
 * toolbar, which body.route-watch hides along with the whole header — so while
 * a video is playing (exactly when copy-link gets used) it says nothing.
 */
let toastTimer = null;

function toast(msg, type = '') {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}


/*
 * Copy text to the clipboard from anywhere — including while a YouTube embed
 * is playing. That case is the whole reason this isn't a one-liner: focus then
 * lives inside the cross-origin iframe, so navigator.clipboard.writeText
 * rejects with "Document is not focused" and execCommand('copy') has nothing
 * selected in the focused document. The Android WebView hits this every time.
 *
 * Order: native bridge (doesn't care where focus is), then the async API, then
 * the textarea trick — whose ta.focus() is what actually pulls focus back out
 * of the iframe. Resolves to true/false so callers can report success.
 */
function copyText(text) {
  const s = String(text ?? '');
  if (!s) return Promise.resolve(false);

  try {
    if (window.AndroidMedia && typeof AndroidMedia.copyText === 'function') {
      AndroidMedia.copyText(s);
      return Promise.resolve(true);
    }
  } catch (e) {}

  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  };

  if (navigator.clipboard && window.isSecureContext && document.hasFocus()) {
    return navigator.clipboard.writeText(s).then(() => true, () => legacy());
  }
  return Promise.resolve(legacy());
}
