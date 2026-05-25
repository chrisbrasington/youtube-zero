'use strict';

/*
 * Auto-refresh interval timer + countdown display.
 *
 * Classic script. Loaded AFTER app.js so refreshAll() is in scope.
 * The boot IIFE in app.js calls loadAutoRefreshPrefs() and
 * syncAutoRefresh() once on startup.
 */

const REFRESH_STEPS  = [5, 10, 15, 30, 60, 120, 240, 720, 1440];
const REFRESH_LABELS = ['5m','10m','15m','30m','1h','2h','4h','12h','24h'];

let autoRefreshTimer = null;
let countdownTimer   = null;
let nextRefreshAt    = null;


function formatCountdown(totalSecs) {
  if (totalSecs <= 0) return '0s';
  if (totalSecs < 60) return `${totalSecs}s`;
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}


function updateCountdown() {
  const el = $('auto-refresh-countdown');
  if (!nextRefreshAt) { el.textContent = ''; return; }
  el.textContent = formatCountdown(Math.ceil(Math.max(0, nextRefreshAt - Date.now()) / 1000));
}


function syncAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  clearInterval(countdownTimer);
  autoRefreshTimer = countdownTimer = null;
  nextRefreshAt = null;

  const check = $('auto-refresh-check');
  const idx   = parseInt($('auto-refresh-slider').value, 10);
  $('auto-refresh-interval').textContent = REFRESH_LABELS[idx];

  if (!check.checked) { $('auto-refresh-countdown').textContent = ''; return; }

  const ms = REFRESH_STEPS[idx] * 60 * 1000;
  nextRefreshAt = Date.now() + ms;
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);
  autoRefreshTimer = setTimeout(async () => {
    await refreshAll();
    syncAutoRefresh();
  }, ms);
}


function loadAutoRefreshPrefs() {
  const enabled = localStorage.getItem('arEnabled');
  const idx     = localStorage.getItem('arIdx');
  $('auto-refresh-check').checked = enabled === '1';
  $('auto-refresh-slider').value  = idx !== null ? idx : '3';
  $('auto-refresh-interval').textContent = REFRESH_LABELS[parseInt($('auto-refresh-slider').value, 10)];
}


$('auto-refresh-check').addEventListener('change', () => {
  localStorage.setItem('arEnabled', $('auto-refresh-check').checked ? '1' : '0');
  syncAutoRefresh();
});
$('auto-refresh-slider').addEventListener('input', () => {
  localStorage.setItem('arIdx', $('auto-refresh-slider').value);
  syncAutoRefresh();
});
