// ==UserScript==
// @name         Alexandria bridge for Roll20
// @namespace    alexandria
// @version      1.0.0
// @description  Keeps a Roll20 game and an Alexandria world in step (HP, conditions, rolls, handouts). Run it in the GM's browser only.
// @match        https://app.roll20.net/editor*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==
//
// The Alexandria Mod script in the game cannot reach the internet, so this
// script carries messages between it and Alexandria:
//   Roll20 → Alexandria: the Mod whispers "ALX::id i/n data::ALX" to the GM;
//     this reads those lines in the chat, hides them and posts them on.
//   Alexandria → Roll20: this asks Alexandria what changed every few
//     seconds and types hidden "!alx-in id i/n data" commands into the chat.
// Whatever the GM is typing in the chat box is put back after each command.
(function () {
  'use strict';
  // Filled in when the DM downloads this from Alexandria's Roll20 page.
  var PRESET_URL = '__ALX_URL__';
  var PRESET_KEY = '__ALX_KEY__';
  var VERSION = '1.0.0';
  var SYNC_MS = 2500;
  var PING_MS = 30000;
  var CHUNK = 1500;
  var SEND_GAP_MS = 250;

  var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  var store = {
    get: function (k, d) { try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : (root.localStorage.getItem('alx.' + k) ?? d); } catch (e) { return d; } },
    set: function (k, v) { try { if (typeof GM_setValue === 'function') GM_setValue(k, v); else root.localStorage.setItem('alx.' + k, v); } catch (e) { /* private window */ } },
  };
  var preset = function (v) { return v && v.indexOf('__ALX_') !== 0 ? v : ''; };
  var cfg = { url: (store.get('url', '') || preset(PRESET_URL)).replace(/\/+$/, ''), key: store.get('key', '') || preset(PRESET_KEY) };
  if (preset(PRESET_KEY) && preset(PRESET_KEY) !== store.get('key', '')) { cfg = { url: preset(PRESET_URL).replace(/\/+$/, ''), key: preset(PRESET_KEY) }; store.set('url', cfg.url); store.set('key', cfg.key); }

  // ---- base64url of UTF-8 JSON (the Mod decodes it by hand) ----
  function encode(obj) {
    var b = new TextEncoder().encode(JSON.stringify(obj)), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(s) {
    var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    var b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(b));
  }

  // ---- Alexandria ----
  function api(path, body) {
    return new Promise(function (resolve, reject) {
      if (!cfg.url || !cfg.key) return reject(new Error('Set the Alexandria address and bridge key'));
      var url = cfg.url + '/api/roll20/bridge' + path;
      var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key };
      var done = function (status, text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (status >= 200 && status < 300) resolve(json || {});
        else reject(new Error((json && json.error) || ('Alexandria answered ' + status)));
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({ method: 'POST', url: url, headers: headers, data: JSON.stringify(body || {}), timeout: 15000,
          onload: function (r) { done(r.status, r.responseText); }, onerror: function () { reject(new Error('Cannot reach Alexandria')); }, ontimeout: function () { reject(new Error('Alexandria did not answer')); } });
      } else {
        fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) }).then(function (r) { return r.text().then(function (t) { done(r.status, t); }); }, function () { reject(new Error('Cannot reach Alexandria')); });
      }
    });
  }

  // ---- the Roll20 chat ----
  function chatBox() { return document.querySelector('#textchat-input textarea'); }
  function sendButton() { return document.querySelector('#textchat-input .btn, #textchat-input button'); }
  var outQ = [];
  var sending = false;
  var lastSent = 0;
  function pump() {
    if (sending || !outQ.length) return;
    var ta = chatBox(), btn = sendButton();
    if (!ta || !btn) { setTimeout(pump, 1000); return; }
    sending = true;
    var line = outQ.shift();
    var typed = ta.value;
    ta.value = line;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    // Give back whatever the GM was typing.
    setTimeout(function () { if (!ta.value || ta.value === line) ta.value = typed; sending = false; lastSent = Date.now(); setTimeout(pump, SEND_GAP_MS); }, 30);
  }
  var outId = 0;
  function toMod(obj) {
    var data = encode(obj);
    var id = Date.now().toString(36) + (outId++).toString(36);
    var n = Math.max(1, Math.ceil(data.length / CHUNK));
    for (var i = 0; i < n; i++) outQ.push('!alx-in ' + id + ' ' + (i + 1) + '/' + n + ' ' + data.slice(i * CHUNK, (i + 1) * CHUNK));
    pump();
  }

  // ---- what the Mod whispers ----
  var parts = {};
  var seen = {};
  var RX = /ALX::(\S+) (\d+)\/(\d+) (\S+?)::ALX/;
  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    var nodes = node.matches && node.matches('.message') ? [node] : Array.prototype.slice.call(node.querySelectorAll ? node.querySelectorAll('.message') : []);
    nodes.forEach(function (el) {
      var m = RX.exec(el.textContent || '');
      if (!m) return;
      el.style.display = 'none';
      var key = m[1] + ':' + m[2];
      if (seen[key]) return;
      seen[key] = 1;
      var p = parts[m[1]] || (parts[m[1]] = { n: +m[3], got: {} });
      p.got[+m[2]] = m[4];
      if (Object.keys(p.got).length < p.n) return;
      delete parts[m[1]];
      var data = '';
      for (var i = 1; i <= p.n; i++) data += p.got[i];
      try { fromMod(decode(data)); } catch (e) { status('A message from the Mod could not be read', true); }
    });
  }

  var modVersion = null;
  var instance = null;
  var eventQ = Promise.resolve();
  function fromMod(m) {
    if (m.t === 'hi') {
      modVersion = m.version; instance = m.instance;
      api('/hello', { modVersion: m.version, campaign: m.campaign, bridgeVersion: VERSION }).then(function () { status('Connected'); }, function (e) { status(e.message, true); });
    } else if (m.t === 'events') {
      // One at a time, in order; the Mod drops what Alexandria acknowledged.
      eventQ = eventQ.then(function () {
        return api('/events', { instance: m.instance, events: m.events }).then(function (r) {
          if (r.acked) toMod({ t: 'ack', seq: r.acked });
          status('Connected');
        }, function (e) { status(e.message, true); });
      });
    }
  }

  // ---- the loop ----
  var lastPing = 0;
  function sync() {
    api('/sync', { modVersion: modVersion }).then(function (r) {
      var busy = (r.pushes && r.pushes.length) || (r.items && r.items.length) || (r.rolls && r.rolls.length);
      if (busy) { toMod({ t: 'sync', config: r.config, pushes: r.pushes, items: r.items, rolls: r.rolls }); lastPing = Date.now(); }
      else if (Date.now() - lastPing > PING_MS) { toMod({ t: 'ping' }); lastPing = Date.now(); }
      status(modVersion ? 'Connected' : 'Waiting for the Alexandria Mod script in this game');
    }, function (e) { status(e.message, true); }).then(function () { setTimeout(sync, SYNC_MS); });
  }
  function hello() {
    return api('/hello', { bridgeVersion: VERSION }).then(function (r) {
      toMod({ t: 'hello', config: r.config });
      lastPing = Date.now();
      status('Waiting for the Alexandria Mod script in this game');
    });
  }

  // ---- a small status pill (click it to change the address or key) ----
  var pill = null;
  function status(text, bad) {
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'alx-bridge';
      pill.setAttribute('role', 'status');
      pill.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:100000;font:12px system-ui,sans-serif;padding:4px 10px;border-radius:12px;background:#1f2430;color:#e8e8e8;cursor:pointer;opacity:.85';
      pill.title = 'Alexandria bridge: click to change the address or key';
      pill.addEventListener('click', setup);
      document.body.appendChild(pill);
    }
    pill.textContent = 'Alexandria: ' + text;
    pill.style.background = bad ? '#7a2630' : '#1f2430';
    pill.dataset.state = bad ? 'error' : text === 'Connected' ? 'ok' : 'wait';
  }
  function setup() {
    var url = root.prompt('Alexandria address (e.g. https://alexandria.example.com)', cfg.url || '');
    if (url === null) return;
    var key = root.prompt('Roll20 bridge key from Alexandria (DM → Roll20 → Make a bridge key)', cfg.key || '');
    if (key === null) return;
    cfg = { url: url.trim().replace(/\/+$/, ''), key: key.trim() };
    store.set('url', cfg.url); store.set('key', cfg.key);
    start();
  }

  var started = false;
  function start() {
    hello().then(function () {
      if (started) return;
      started = true;
      sync();
    }, function (e) { status(e.message + ' (click to set up)', true); });
  }

  function boot() {
    var log = document.querySelector('#textchat .content');
    if (!log || !chatBox()) { setTimeout(boot, 1000); return; }
    scan(log);
    new MutationObserver(function (muts) { muts.forEach(function (mu) { mu.addedNodes.forEach(scan); }); }).observe(log, { childList: true, subtree: true });
    status('Starting');
    start();
  }
  boot();
}());
