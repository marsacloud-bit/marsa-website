'use strict';
/*
  A very small DOM for UI flow tests (no dependency): elements with children, attributes, className / classList,
  textContent, value (input / select / textarea), events, getElementById, and querySelector(All) for simple selectors:
  tag, #id, .class, [attr], [attr="v"], :last-child, joined by descendant spaces. Enough for assets/js/doc-batch.js and
  assets/js/ops/tx-docs.js; not a general DOM.
*/
function makeDom() {
  let byIdCache = null;
  class Node {
    constructor(tag) {
      this.tagName = String(tag || '#text').toUpperCase(); this.nodeName = this.tagName;
      this.children = []; this.parentNode = null; this.attrs = {}; this._text = ''; this._listeners = {};
      this.style = {}; this.hidden = false; this.disabled = false; this.checked = false; this.dataset = {};
      this._value = ''; this.selected = false; this.open = false; this.files = null;
      const self = this;
      this.classList = {
        add(...c) { const s = self._cls(); c.forEach(x => s.add(x)); self.className = [...s].join(' '); },
        remove(...c) { const s = self._cls(); c.forEach(x => s.delete(x)); self.className = [...s].join(' '); },
        toggle(c, on) { const s = self._cls(); const want = on === undefined ? !s.has(c) : !!on; if (want) s.add(c); else s.delete(c); self.className = [...s].join(' '); return want; },
        contains(c) { return self._cls().has(c); }
      };
      this.className = '';
    }
    _cls() { return new Set(String(this.className || '').split(/\s+/).filter(Boolean)); }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = String(v); byIdCache = null; }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get childNodes() { return this.children; }
    get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
    get selectedIndex() { return this.options.findIndex(o => o.selected); }
    set selectedIndex(i) { this.options.forEach((o, k) => { o.selected = k === i; }); }
    get value() {
      if (this.tagName === 'SELECT') { const o = this.options.find(x => x.selected) || this.options[0]; return o ? o.value : ''; }
      if (this.tagName === 'OPTION') return this._value !== '' || this._valueSet ? this._value : this.textContent;
      return this._value;
    }
    set value(v) {
      if (this.tagName === 'SELECT') { let hit = false; this.options.forEach(o => { o.selected = !hit && o.value === String(v); if (o.selected) hit = true; }); return; }
      this._value = String(v); this._valueSet = true;
    }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = v == null ? '' : String(v); byIdCache = null; }
    appendChild(n) {
      if (n.tagName === '#FRAGMENT') { n.children.slice().forEach(c => this.appendChild(c)); return n; }
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this; this.children.push(n); byIdCache = null; return n;
    }
    removeChild(n) { this.children = this.children.filter(c => c !== n); n.parentNode = null; byIdCache = null; return n; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { if (k === 'id') this.id = v; else if (k === 'class') this.className = String(v); else this.attrs[k] = String(v); }
    getAttribute(k) { if (k === 'class') return this.className; return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
    removeEventListener(t, f) { this._listeners[t] = (this._listeners[t] || []).filter(x => x !== f); }
    dispatch(t, extra) {
      const ev = Object.assign({ type: t, target: this, preventDefault() {}, stopPropagation() {} }, extra || {});
      (this._listeners[t] || []).slice().forEach(f => f.call(this, ev));
      return ev;
    }
    click() { if (this.disabled) return; if (this.tagName === 'INPUT' && (this.type === 'radio' || this.type === 'checkbox')) { this.checked = this.type === 'radio' ? true : !this.checked; this.dispatch('change'); } this.dispatch('click'); }
    focus() {} blur() {} scrollIntoView() {}
    get href() { return this.attrs.href || ''; }
    set href(v) { this.attrs.href = String(v); }
    walk(fn) { this.children.forEach(c => { fn(c); c.walk(fn); }); }
    matches(sel) { return matchCompound(this, sel); }
    querySelectorAll(sel) {
      const parts = sel.trim().split(/\s+/);
      const out = [];
      this.walk(n => { if (matchChain(n, parts, this)) out.push(n); });
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  function matchCompound(n, s) {
    if (n.tagName === '#TEXT') return false;
    const re = /(^[a-z0-9]+)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:last-child/gi;
    let m, ok = true, any = false;
    while ((m = re.exec(s))) {
      any = true;
      if (m[1]) ok = ok && n.tagName === m[1].toUpperCase();
      else if (m[2]) ok = ok && n.id === m[2];
      else if (m[3]) ok = ok && n.classList.contains(m[3]);
      else if (m[4]) { const v = m[4] === 'class' ? n.className : n.getAttribute(m[4]); ok = ok && v != null && (m[5] === undefined || v === m[5]); }
      else ok = ok && !!n.parentNode && n.parentNode.children[n.parentNode.children.length - 1] === n;
    }
    return any && ok;
  }
  function matchChain(n, parts, scope) {
    if (!matchCompound(n, parts[parts.length - 1])) return false;
    let i = parts.length - 2, p = n.parentNode;
    while (i >= 0 && p && p !== scope.parentNode) { if (matchCompound(p, parts[i])) i--; p = p.parentNode; }
    return i < 0;
  }
  const document = {
    readyState: 'complete',
    body: new Node('body'),
    createElement(t) { return new Node(t); },
    createTextNode(t) { const n = new Node('#text'); n._text = String(t); return n; },
    createDocumentFragment() { return new Node('#fragment'); },
    getElementById(id) {
      let hit = null;
      document.body.walk(n => { if (!hit && n.id === id) hit = n; });
      return hit;
    },
    querySelector(s) { return document.body.querySelector(s); },
    querySelectorAll(s) { return document.body.querySelectorAll(s); },
    addEventListener() {}
  };
  return { document, Node };
}
module.exports = { makeDom };
