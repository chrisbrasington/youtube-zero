'use strict';

/*
 * Minimal fetch wrapper for the youtube-zero backend.
 *
 * Classic script. Exposes `api` as a global with .get / .post / .put / .del.
 * On non-2xx, throws an Error whose message is the FastAPI `detail` field
 * when present, otherwise the HTTP status text.
 */

const api = (() => {
  async function _failure(response) {
    let msg = response.statusText;
    try { msg = (await response.json()).detail || msg; } catch {}
    return new Error(msg);
  }

  async function get(path) {
    const r = await fetch(path);
    if (!r.ok) throw await _failure(r);
    return r.json();
  }

  async function post(path, body = {}) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await _failure(r);
    return r.json();
  }

  async function put(path, body = {}) {
    const r = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await _failure(r);
    return r.json();
  }

  async function del(path) {
    const r = await fetch(path, { method: 'DELETE' });
    if (!r.ok) throw await _failure(r);
    return r.json();
  }

  return { get, post, put, del };
})();
