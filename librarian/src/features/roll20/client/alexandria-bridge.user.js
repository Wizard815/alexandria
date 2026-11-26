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
// Two ways to run, picked by itself when the game opens:
//
// With the Alexandria Mod script (the game creator has Roll20 Pro): the Mod
// reads and changes the game; this script only carries messages:
//   Roll20 → Alexandria: the Mod whispers "ALX::id i/n data::ALX" to the GM;
//     this reads those lines in the chat, hides them and posts them on.
//   Alexandria → Roll20: this asks Alexandria what changed every few
//     seconds and types hidden "!alx-in id i/n data" commands into the chat.
//
// Without it (no Pro, or the Mod is not installed): this does the work
// itself, as the GM, in this browser tab:
//   - rolls: read from the chat as they appear;
//   - chat lines and Alexandria's rolls: typed into the chat as "Alexandria";
//   - HP, conditions and handouts: read and changed through the Roll20 page's
//     own game data (window.Campaign). Roll20 does not document that, so a
//     Roll20 update can break it; then only rolls and chat keep working.
//
// Whatever the GM is typing in the chat box is put back after each line.
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
  var MOD_WAIT_MS = 8000;
  var WATCH_MS = 1000;

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

  // ---- what the chat shows ----
  var parts = {};
  var seen = {};
  var RX = /ALX::(\S+) (\d+)\/(\d+) (\S+?)::ALX/;
  var booted = false;
  var lastWho = '';
  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    var nodes = node.matches && node.matches('.message') ? [node] : Array.prototype.slice.call(node.querySelectorAll ? node.querySelectorAll('.message') : []);
    nodes.forEach(function (el) {
      var text = el.textContent || '';
      var by = el.querySelector('.by');
      if (by) lastWho = by.textContent.replace(/:\s*$/, '').trim();
      // Our own commands, should a game without the Mod show them.
      if (/!alx-in \S+ \d+\/\d+/.test(text)) { el.style.display = 'none'; return; }
      var m = RX.exec(text);
      if (!m) { if (booted && mode === 'free') rollFromChat(el); return; }
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

  // 'wait' until the Mod answers or MOD_WAIT_MS passes; then 'mod' or 'free'.
  var mode = 'wait';
  var modVersion = null;
  var eventQ = Promise.resolve();
  function fromMod(m) {
    if (m.t === 'hi') {
      modVersion = m.version;
      mode = 'mod';
      api('/hello', { modVersion: m.version, campaign: m.campaign, bridgeVersion: VERSION, mode: 'mod' }).then(function () { status('Connected'); }, function (e) { status(e.message, true); });
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

  // ======== without the Mod: this browser tab does the work ========
  var cfgMod = { hpAttr: 'hp', tempAttr: 'hp_temp', bar: 'bar1', managed: [], rollsIn: true, hp: true, conditions: true };
  var freeInstance = store.get('instance', '') || ('br' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
  store.set('instance', freeInstance);
  var freeSeq = Number(store.get('seq', 0)) || 0;
  var pending = [];
  var posting = false;
  function emit(ev) {
    freeSeq += 1;
    store.set('seq', freeSeq);
    ev.seq = freeSeq;
    pending.push(ev);
    if (pending.length > 300) pending.splice(0, pending.length - 300);
    post();
  }
  function post() {
    if (posting || !pending.length) return;
    posting = true;
    var batch = pending.slice(0, 50);
    api('/events', { instance: freeInstance, events: batch }).then(function (r) {
      pending = pending.filter(function (e) { return e.seq > (r.acked || 0); });
      status('Connected (no Mod script)');
    }, function (e) { status(e.message, true); }).then(function () { posting = false; if (pending.length) setTimeout(post, 1000); });
  }

  // -- rolls, read from the chat as Roll20 draws them --
  var nums = function (s) { var out = [], re = /basicdiceroll[^>]*>\s*(\d+)/g, m; while ((m = re.exec(s))) out.push(+m[1]); return out; };
  function rollFromChat(el) {
    var id = el.getAttribute('data-messageid');
    if (id) { if (seen['m:' + id]) return; seen['m:' + id] = 1; }
    if (!cfgMod.rollsIn) return;
    var cls = el.classList;
    if (cls.contains('whisper') || cls.contains('private') || cls.contains('hidden')) return;
    var who = lastWho;
    if (/^alexandria$/i.test(who)) return;
    var rolls = [];
    if (cls.contains('rollresult')) {
      var f = el.querySelector('.formula');
      var total = el.querySelector('.rolled');
      if (f && total) {
        rolls.push({
          expr: f.textContent.replace(/^\s*rolling\s*/i, '').trim(),
          total: Number(total.textContent.trim()),
          dice: Array.prototype.map.call(el.querySelectorAll('.didroll'), function (d) { return Number(d.textContent.trim()); }).filter(function (n) { return !isNaN(n); }),
        });
      }
    }
    Array.prototype.forEach.call(el.querySelectorAll('.inlinerollresult'), function (r) {
      var t = r.getAttribute('title') || r.getAttribute('original-title') || '';
      var mm = /Rolling\s+(.+?)\s*=/.exec(t.replace(/<[^>]*>/g, ''));
      var total = Number((r.textContent || '').trim());
      if (mm && !isNaN(total)) rolls.push({ expr: mm[1], total: total, dice: nums(t) });
    });
    if (!rolls.length) return;
    var cap = el.querySelector('caption, .sheet-title, .sheet-header');
    var ch = findChar(who);
    emit({ t: 'roll', who: who, player: '', characterId: ch ? ch.id : null, label: cap ? cap.textContent.trim().slice(0, 60) : '', rolls: rolls });
  }

  // -- the game's own data in the page (not a public API: guarded everywhere) --
  function camp() { try { return root.Campaign || null; } catch (e) { return null; } }
  var list = function (coll) { return coll && coll.models ? coll.models : []; };
  function allChars() { var c = camp(); return c ? list(c.characters) : []; }
  function findChar(name) { var n = String(name || '').toLowerCase(); return allChars().filter(function (c) { return String(c.get('name')).toLowerCase() === n; })[0] || null; }
  function tracked(ch) { return String(ch.get('controlledby') || '').replace(/all/g, '').replace(/,/g, '').length > 0; }
  var fetched = {};
  function attrOf(ch, name) {
    if (ch.attribs && !fetched[ch.id] && typeof ch.attribs.fetch === 'function') { fetched[ch.id] = 1; try { ch.attribs.fetch(ch.attribs); } catch (e) { /* older page */ } }
    return list(ch.attribs).filter(function (a) { return a.get('name') === name; })[0] || null;
  }
  function tokensOf(id) {
    var c = camp(), out = [];
    var pages = c && c.pages ? list(c.pages) : [];
    if (!pages.length && c && typeof c.activePage === 'function') pages = [c.activePage()];
    pages.forEach(function (p) { if (p && p.thegraphics) list(p.thegraphics).forEach(function (g) { if (g.get('represents') === id) out.push(g); }); });
    return out;
  }
  function markerTable() {
    var c = camp();
    try { var raw = c && (c.get('_token_markers') || c.get('token_markers')); return typeof raw === 'string' ? JSON.parse(raw) : (raw || []); } catch (e) { return []; }
  }
  function markerNames(tok) {
    var custom = markerTable();
    return String(tok.get('statusmarkers') || '').split(',').filter(Boolean).map(function (m) {
      var tag = m.split('@')[0];
      for (var i = 0; i < custom.length; i++) if (custom[i].tag === tag) return custom[i].name;
      return tag.split('::')[0];
    });
  }
  function markerTag(name) {
    var custom = markerTable();
    for (var i = 0; i < custom.length; i++) if (String(custom[i].name).toLowerCase() === String(name).toLowerCase()) return custom[i].tag;
    return name;
  }
  function ownersOf(ch) {
    var c = camp();
    return String(ch.get('controlledby') || '').split(',').filter(function (x) { return x && x !== 'all'; }).map(function (id) {
      var p = c && c.players && c.players.get ? c.players.get(id) : null;
      return p ? (p.get('displayname') || p.get('_displayname') || '') : '';
    }).filter(Boolean);
  }
  var num = function (v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; };
  function readChar(ch) {
    var hp = attrOf(ch, cfgMod.hpAttr), tmp = attrOf(ch, cfgMod.tempAttr), tok = tokensOf(ch.id)[0];
    var v = { hp: null, maxHp: null, tempHp: tmp ? (num(tmp.get('current')) || 0) : undefined, markers: tok ? markerNames(tok) : [] };
    if (hp) { v.hp = num(hp.get('current')); v.maxHp = num(hp.get('max')); }
    else if (tok) { v.hp = num(tok.get(cfgMod.bar + '_value')); v.maxHp = num(tok.get(cfgMod.bar + '_max')); }
    return v;
  }
  function save(model, attrs) { if (typeof model.save === 'function') model.save(attrs); else model.set(attrs); }

  // What each character looked like last time (changes are found by comparing).
  var last = {};
  var key = function (v) { return [v.hp, v.maxHp, v.tempHp].join('/'); };
  function snapshotFree() {
    var out = allChars().filter(tracked).map(function (ch) {
      var v = readChar(ch);
      last[ch.id] = { vit: key(v), mk: v.markers.join(',') };
      return { id: ch.id, name: ch.get('name'), controlledBy: ownersOf(ch), hp: v.hp, maxHp: v.maxHp, tempHp: v.tempHp, markers: v.markers };
    });
    emit({ t: 'characters', list: out });
  }
  function watchFree() {
    if (mode !== 'free') return;
    try {
      allChars().filter(tracked).forEach(function (ch) {
        var v = readChar(ch), was = last[ch.id];
        if (!was) { last[ch.id] = { vit: key(v), mk: v.markers.join(',') }; emit({ t: 'characters', list: [{ id: ch.id, name: ch.get('name'), controlledBy: ownersOf(ch), hp: v.hp, maxHp: v.maxHp, tempHp: v.tempHp, markers: v.markers }] }); return; }
        if (cfgMod.hp && key(v) !== was.vit) { was.vit = key(v); emit({ t: 'vitals', id: ch.id, name: ch.get('name'), hp: v.hp, maxHp: v.maxHp, tempHp: v.tempHp }); }
        if (cfgMod.conditions && v.markers.join(',') !== was.mk) { was.mk = v.markers.join(','); emit({ t: 'markers', id: ch.id, name: ch.get('name'), markers: v.markers }); }
      });
    } catch (e) { status('Could not read the game here: ' + e.message, true); }
    setTimeout(watchFree, WATCH_MS);
  }
  function applyFree(r) {
    var ok = true;
    (r.pushes || []).forEach(function (p) {
      var ch = allChars().filter(function (c) { return c.id === p.id; })[0];
      if (!ch) return;
      try {
        if (p.hp !== undefined || p.maxHp !== undefined) {
          var a = attrOf(ch, cfgMod.hpAttr);
          var patch = {};
          if (p.hp !== undefined && p.hp !== null) patch.current = p.hp;
          if (p.maxHp !== undefined && p.maxHp !== null) patch.max = p.maxHp;
          if (a) save(a, patch);
          else tokensOf(p.id).forEach(function (t) {
            if (t.get(cfgMod.bar + '_link')) return;
            var tp = {};
            if (patch.current !== undefined) tp[cfgMod.bar + '_value'] = patch.current;
            if (patch.max !== undefined) tp[cfgMod.bar + '_max'] = patch.max;
            save(t, tp);
          });
        }
        if (p.tempHp !== undefined) { var tmp = attrOf(ch, cfgMod.tempAttr); if (tmp) save(tmp, { current: p.tempHp }); }
        if (Array.isArray(p.markers)) {
          var managed = (cfgMod.managed || []).map(function (m) { return String(m).toLowerCase(); });
          var custom = markerTable();
          var want = p.markers.map(markerTag);
          tokensOf(p.id).forEach(function (t) {
            var keep = String(t.get('statusmarkers') || '').split(',').filter(Boolean).filter(function (m) {
              var tag = m.split('@')[0], nm = tag.split('::')[0].toLowerCase();
              var cm = custom.filter(function (x) { return x.tag === tag; })[0];
              if (cm) nm = String(cm.name).toLowerCase();
              return managed.indexOf(nm) < 0;
            });
            var next = keep.concat(want.filter(function (w) { return keep.indexOf(w) < 0; })).join(',');
            if (next !== t.get('statusmarkers')) save(t, { statusmarkers: next });
          });
        }
        // What Alexandria just set is not a change to report back.
        var v = readChar(ch);
        last[ch.id] = { vit: key(v), mk: v.markers.join(',') };
      } catch (e) { ok = false; }
    });
    (r.items || []).forEach(function (x) {
      if (x.kind === 'say') say(x.as || 'Alexandria', x.text || '');
      if (x.kind === 'handout') {
        try {
          var c = camp(), name = String(x.name || 'Alexandria');
          var h = list(c && c.handouts).filter(function (m) { return m.get('name') === name; })[0];
          if (!h) h = c.handouts.create({ name: name, inplayerjournals: x.players ? 'all' : '', archived: false });
          else save(h, { inplayerjournals: x.players ? 'all' : '' });
          if (typeof h.updateBlobs === 'function') h.updateBlobs({ notes: String(x.notes || ''), gmnotes: String(x.gmnotes || '') });
          else save(h, { notes: String(x.notes || ''), gmnotes: String(x.gmnotes || '') });
        } catch (e) { ok = false; say('Alexandria', 'A handout from Alexandria (' + String(x.name || '') + ') could not be made here. With the Alexandria Mod script installed it can.'); }
      }
    });
    (r.rolls || []).forEach(function (o) {
      say('Alexandria', '&{template:default} {{name=' + safe(o.who) + ' rolls ' + safe(o.expr) + '}} {{Total=' + safe(o.total) + '}}' + (o.dice && o.dice.length ? ' {{Dice=' + safe(o.dice.join(', ')) + '}}' : '') + (o.note ? ' {{Note=' + safe(o.note) + '}}' : ''));
    });
    if (!ok) status('Some changes could not be made in this game', true);
  }
  // Typed text cannot run templates, roll or call macros.
  function safe(v) { return String(v).replace(/[{}]/g, function (c) { return c === '{' ? '(' : ')'; }).replace(/\[\[|\]\]/g, '').replace(/[@%#&]\{/g, '(').replace(/\n/g, ' '); }
  function say(as, text) {
    var body = /^&\{template:/.test(text) ? text : safe(text);
    outQ.push('/as "' + String(as).replace(/"/g, '\'') + '" ' + body);
    pump();
  }

  // ---- the loop ----
  var lastPing = 0;
  function sync() {
    if (mode === 'wait') { setTimeout(sync, SYNC_MS); return; }
    api('/sync', { modVersion: modVersion, mode: mode }).then(function (r) {
      if (r.config) cfgMod = r.config;
      var busy = (r.pushes && r.pushes.length) || (r.items && r.items.length) || (r.rolls && r.rolls.length);
      if (mode === 'free') {
        if (busy) applyFree(r);
        status('Connected (no Mod script)');
        return;
      }
      if (busy) { toMod({ t: 'sync', config: r.config, pushes: r.pushes, items: r.items, rolls: r.rolls }); lastPing = Date.now(); }
      else if (Date.now() - lastPing > PING_MS) { toMod({ t: 'ping' }); lastPing = Date.now(); }
      status('Connected');
    }, function (e) { status(e.message, true); }).then(function () { setTimeout(sync, SYNC_MS); });
  }
  function goFree() {
    if (mode !== 'wait') return;
    mode = 'free';
    api('/hello', { bridgeVersion: VERSION, mode: 'free', campaign: (camp() && camp().get && camp().get('name')) || '' }).then(function (r) {
      if (r.config) cfgMod = r.config;
      if (camp()) { snapshotFree(); watchFree(); }
      else status('Connected (no Mod script): rolls and chat only', false);
    }, function (e) { status(e.message, true); });
  }
  function hello() {
    return api('/hello', { bridgeVersion: VERSION }).then(function (r) {
      if (r.config) cfgMod = r.config;
      toMod({ t: 'hello', config: r.config });
      lastPing = Date.now();
      status('Looking for the Alexandria Mod script');
      // No answer: the game has no Mod script; this tab does the work.
      setTimeout(goFree, MOD_WAIT_MS);
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
    pill.dataset.state = bad ? 'error' : /^Connected/.test(text) ? 'ok' : 'wait';
    pill.dataset.mode = mode;
  }
  function setup() {
    var url = root.prompt('Alexandria address (e.g. https://alexandria.example.com)', cfg.url || '');
    if (url === null) return;
    var k = root.prompt('Roll20 bridge key from Alexandria (DM → Roll20 → Make a bridge key)', cfg.key || '');
    if (k === null) return;
    cfg = { url: url.trim().replace(/\/+$/, ''), key: k.trim() };
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
    // What is already in the chat is history: not sent as new rolls.
    scan(log);
    booted = true;
    new MutationObserver(function (muts) { muts.forEach(function (mu) { mu.addedNodes.forEach(scan); }); }).observe(log, { childList: true, subtree: true });
    status('Starting');
    start();
  }
  boot();
}());
