/* ==========================================================================
   مرسى | MARSA — MarsaDraft: a generic, per-user sessionStorage draft helper
   --------------------------------------------------------------------------
   Legacy step 6 (docs/online/LEGACY_PAY_AR.md): the payment form (#payments/new) and the custody form (#custody)
   keep an unsaved draft in this tab, so a refresh does not lose what was typed. Pure ES5, no DOM.

     MarsaDraft.save(scope, userId, data)        → true | false   (JSON; never throws)
     MarsaDraft.load(scope, userId, {maxAgeMs?}) → { data, savedAt } | null
     MarsaDraft.clear(scope, userId)
     MarsaDraft.autosave(scope, userId, getter, delayMs?) → { schedule(), flush(), cancel() }  (debounced save)

   * Per user: the key carries the user id; no user id → nothing is stored (never a shared draft).
   * sessionStorage only (this tab, cleared with the tab), never localStorage: a draft may hold amounts and
     references that must not stay on a shared device. Files are never stored (the forms say so).
   * Every storage access is wrapped in try/catch: private mode, a full quota or a blocked storage just means
     "no draft" — the form still works.
   * A draft older than maxAgeMs (default 12 h) is dropped on load.
   ========================================================================== */
(function (root) {
  'use strict';

  var PREFIX = 'marsa.draft.v1:';
  var MAX_AGE = 12 * 3600 * 1000;
  var MAX_CHARS = 200000;   // a draft is form text; anything larger is refused (no files, no readings)
  var SCOPE_RE = /^[a-z][a-z0-9_.:-]{0,80}$/i;
  var USER_RE = /^[A-Za-z0-9-]{1,64}$/;

  function store() {
    try { return root && root.sessionStorage ? root.sessionStorage : null; } catch (e) { return null; }
  }
  function key(scope, userId) {
    if (!SCOPE_RE.test(String(scope || '')) || !USER_RE.test(String(userId || ''))) return null;
    return PREFIX + userId + ':' + scope;
  }
  function save(scope, userId, data) {
    var k = key(scope, userId), s = store();
    if (!k || !s) return false;
    try {
      var txt = JSON.stringify({ v: 1, at: Date.now(), data: data == null ? null : data });
      if (txt.length > MAX_CHARS) return false;
      s.setItem(k, txt);
      return true;
    } catch (e) { return false; }
  }
  function clear(scope, userId) {
    var k = key(scope, userId), s = store();
    if (!k || !s) return false;
    try { s.removeItem(k); return true; } catch (e) { return false; }
  }
  function load(scope, userId, o) {
    var k = key(scope, userId), s = store();
    if (!k || !s) return null;
    var maxAge = o && o.maxAgeMs > 0 ? o.maxAgeMs : MAX_AGE;
    try {
      var txt = s.getItem(k);
      if (!txt) return null;
      var obj = JSON.parse(txt);
      if (!obj || obj.v !== 1 || typeof obj.at !== 'number' || obj.data == null) { s.removeItem(k); return null; }
      if (Date.now() - obj.at > maxAge || obj.at > Date.now() + 60000) { s.removeItem(k); return null; }
      return { data: obj.data, savedAt: obj.at };
    } catch (e) {
      try { s.removeItem(k); } catch (x) { /* storage blocked */ }
      return null;
    }
  }
  // debounced save of getter() (getter returns null → the draft is cleared)
  function autosave(scope, userId, getter, delayMs) {
    var timer = null, delay = delayMs > 0 ? delayMs : 400;
    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      var d;
      try { d = getter(); } catch (e) { return false; }
      return d == null ? clear(scope, userId) : save(scope, userId, d);
    }
    return {
      schedule: function () { if (timer) clearTimeout(timer); timer = setTimeout(flush, delay); },
      flush: flush,
      cancel: function () { if (timer) { clearTimeout(timer); timer = null; } }
    };
  }

  var API = { save: save, load: load, clear: clear, autosave: autosave, key: key, MAX_AGE: MAX_AGE };
  if (typeof module === 'object' && module.exports) module.exports = API;
  if (root) root.MarsaDraft = API;
})(typeof window !== 'undefined' ? window : null);
