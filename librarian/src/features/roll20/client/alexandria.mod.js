// Alexandria for Roll20: a Mod (API) script.
//
// Install: Roll20 game → Settings → Mod (API) Scripts → New Script, paste
// this file, Save. (The game's creator needs a Pro plan for Mod scripts;
// players need nothing.) Then run the Alexandria bridge in the GM's browser.
//
// Roll20 Mod scripts cannot reach the internet, so this script talks only to
// the bridge, through the chat:
//   in:  "!alx-in <id> <part>/<parts> <base64url JSON>" sent by a GM (hidden)
//   out: a whisper to the GM, "ALX::<id> <part>/<parts> <base64url JSON>::ALX",
//        which the bridge reads and hides.
//
// It reports: player characters (name, owners, HP), HP and temporary HP
// changes, token status marker changes, and rolls. It applies: HP and marker
// pushes, handouts, and chat lines from Alexandria.
//
// GM commands: !alx status · !alx sync (send the character list again) ·
// !alx reset (forget queued events)
/* global on, sendChat, findObjs, getObj, createObj, playerIsGM, state, log, Campaign */
var AlexandriaBridge = AlexandriaBridge || (function () {
  'use strict';
  var VERSION = '1.0.0';
  var CHUNK = 1800;
  var MAX_QUEUE = 300;
  var BRIDGE_TIMEOUT = 90 * 1000;
  var DEBOUNCE = 400;

  // ---- base64url of UTF-8 JSON (the sandbox has no atob/btoa) ----
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function utf8String(b) {
    var s = '';
    for (var i = 0; i < b.length;) {
      var c = b[i++];
      if (c >= 0xf0) { c = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63); c -= 0x10000; s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); continue; }
      if (c >= 0xe0) c = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      else if (c >= 0xc0) c = ((c & 31) << 6) | (b[i++] & 63);
      s += String.fromCharCode(c);
    }
    return s;
  }
  function encode(obj) {
    var b = utf8Bytes(JSON.stringify(obj)), s = '';
    for (var i = 0; i < b.length; i += 3) {
      var n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '') + (i + 2 < b.length ? B64[n & 63] : '');
    }
    return s;
  }
  function decode(s) {
    var b = [], bits = 0, acc = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s[i]);
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; b.push((acc >> bits) & 255); }
    }
    return JSON.parse(utf8String(b));
  }

  // ---- state ----
  function st() {
    if (!state.Alexandria) state.Alexandria = {};
    var s = state.Alexandria;
    if (!s.instance) s.instance = 'r20' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    if (typeof s.seq !== 'number') s.seq = 0;
    if (!Array.isArray(s.queue)) s.queue = [];
    if (typeof s.bridgeAt !== 'number') s.bridgeAt = 0;
    if (!s.config) s.config = { hpAttr: 'hp', tempAttr: 'hp_temp', bar: 'bar1', managed: [], rollsIn: true, hp: true, conditions: true };
    return s;
  }
  var bridgeOnline = function () { return Date.now() - st().bridgeAt < BRIDGE_TIMEOUT; };

  // ---- talking to the bridge ----
  var outId = 0;
  function whisper(obj) {
    var data = encode(obj);
    var id = (Date.now() % 1e8).toString(36) + (outId++).toString(36);
    var parts = Math.max(1, Math.ceil(data.length / CHUNK));
    for (var i = 0; i < parts; i++) {
      sendChat('Alexandria', '/w gm ALX::' + id + ' ' + (i + 1) + '/' + parts + ' ' + data.slice(i * CHUNK, (i + 1) * CHUNK) + '::ALX', null, { noarchive: true });
    }
  }
  /** Queue an event for Alexandria; sent at once while the bridge is online. */
  function emit(ev) {
    var s = st();
    s.seq += 1;
    ev.seq = s.seq;
    s.queue.push(ev);
    if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE);
    if (bridgeOnline()) whisper({ t: 'events', instance: s.instance, events: [ev] });
  }
  function flush() {
    var s = st();
    if (!s.queue.length) return;
    for (var i = 0; i < s.queue.length; i += 20) whisper({ t: 'events', instance: s.instance, events: s.queue.slice(i, i + 20) });
  }

  // ---- reading the game ----
  function attr(charId, name) { return findObjs({ _type: 'attribute', _characterid: charId, name: name })[0]; }
  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }
  function ownersOf(ch) {
    var ids = String(ch.get('controlledby') || '').split(',').filter(function (x) { return x && x !== 'all'; });
    return ids.map(function (id) { var p = getObj('player', id); return p ? p.get('_displayname') : ''; }).filter(Boolean);
  }
  /** Characters a player controls: the ones Alexandria cares about. */
  function tracked(ch) { return !!ch && String(ch.get('controlledby') || '').replace(/all/g, '').replace(/,/g, '').length > 0; }
  function tokensOf(charId) { return findObjs({ _type: 'graphic', _subtype: 'token', represents: charId }); }
  function markerTable() {
    try { return JSON.parse(Campaign().get('_token_markers') || '[]'); } catch (e) { return []; }
  }
  /** Marker tags on a token as names ("Poisoned::123" → "Poisoned"; built-ins stay as they are). */
  function markerNames(tok) {
    var custom = markerTable();
    return String(tok.get('statusmarkers') || '').split(',').filter(Boolean).map(function (m) {
      var tag = m.split('@')[0];
      for (var i = 0; i < custom.length; i++) if (custom[i].tag === tag) return custom[i].name;
      return tag.split('::')[0];
    });
  }
  /** The tag for a marker name: a custom marker of that name, else the built-in name. */
  function markerTag(name) {
    var custom = markerTable();
    for (var i = 0; i < custom.length; i++) if (String(custom[i].name).toLowerCase() === String(name).toLowerCase()) return custom[i].tag;
    return name;
  }
  /** HP from the character's HP attribute, or from a token's bar when that bar is not linked to it. */
  function vitalsOf(ch, tok) {
    var c = st().config, id = ch.id, out = {};
    var hp = attr(id, c.hpAttr), tmp = attr(id, c.tempAttr);
    if (tok && !tok.get(c.bar + '_link')) { out.hp = num(tok.get(c.bar + '_value')); out.maxHp = num(tok.get(c.bar + '_max')); }
    else if (hp) { out.hp = num(hp.get('current')); out.maxHp = num(hp.get('max')); }
    else {
      var t = tokensOf(id)[0];
      if (t) { out.hp = num(t.get(c.bar + '_value')); out.maxHp = num(t.get(c.bar + '_max')); }
    }
    if (tmp) out.tempHp = num(tmp.get('current')) || 0;
    return out;
  }
  function snapshot() {
    var list = findObjs({ _type: 'character' }).filter(tracked).map(function (ch) {
      var v = vitalsOf(ch), tok = tokensOf(ch.id)[0];
      return { id: ch.id, name: ch.get('name'), controlledBy: ownersOf(ch), hp: v.hp, maxHp: v.maxHp, tempHp: v.tempHp, markers: tok ? markerNames(tok) : [] };
    });
    emit({ t: 'characters', list: list });
  }

  // Changes are gathered for a moment so a damage edit is one event, not three.
  var pending = {};
  function later(kind, charId, tokId) {
    var key = kind + ':' + charId;
    if (pending[key]) clearTimeout(pending[key]);
    pending[key] = setTimeout(function () {
      delete pending[key];
      var ch = getObj('character', charId);
      if (!tracked(ch)) return;
      if (kind === 'vitals') { var v = vitalsOf(ch, tokId ? getObj('graphic', tokId) : null); emit({ t: 'vitals', id: ch.id, name: ch.get('name'), hp: v.hp, maxHp: v.maxHp, tempHp: v.tempHp }); }
      else { var tok = tokensOf(charId)[0]; emit({ t: 'markers', id: ch.id, name: ch.get('name'), markers: tok ? markerNames(tok) : [] }); }
    }, DEBOUNCE);
  }

  // ---- applying Alexandria's changes ----
  // Changes made by a Mod script fire no change events, so nothing applied here is sent back.
  function setAttr(charId, name, cur, max) {
    var a = attr(charId, name);
    if (!a) { if (cur === undefined && max === undefined) return false; a = createObj('attribute', { _characterid: charId, name: name, current: '', max: '' }); }
    if (cur !== undefined && cur !== null && String(a.get('current')) !== String(cur)) a.set('current', cur);
    if (max !== undefined && max !== null && String(a.get('max')) !== String(max)) a.set('max', max);
    return true;
  }
  function applyPush(p) {
    var c = st().config, ch = getObj('character', p.id);
    if (!ch) return;
    if (p.hp !== undefined || p.maxHp !== undefined) {
      if (attr(p.id, c.hpAttr)) setAttr(p.id, c.hpAttr, p.hp, p.maxHp);
      else tokensOf(p.id).forEach(function (t) {
        if (t.get(c.bar + '_link')) return;
        if (p.hp !== undefined && p.hp !== null) t.set(c.bar + '_value', p.hp);
        if (p.maxHp !== undefined && p.maxHp !== null) t.set(c.bar + '_max', p.maxHp);
      });
    }
    if (p.tempHp !== undefined && attr(p.id, c.tempAttr)) setAttr(p.id, c.tempAttr, p.tempHp);
    if (Array.isArray(p.markers)) {
      var managed = (c.managed || []).map(function (m) { return String(m).toLowerCase(); });
      var want = p.markers.map(markerTag);
      tokensOf(p.id).forEach(function (t) {
        var keep = String(t.get('statusmarkers') || '').split(',').filter(Boolean).filter(function (m) {
          var tag = m.split('@')[0], nm = tag.split('::')[0].toLowerCase();
          var custom = markerTable().filter(function (x) { return x.tag === tag; })[0];
          if (custom) nm = String(custom.name).toLowerCase();
          return managed.indexOf(nm) < 0;
        });
        var next = keep.concat(want.filter(function (w) { return keep.indexOf(w) < 0; })).join(',');
        if (next !== t.get('statusmarkers')) t.set('statusmarkers', next);
      });
    }
  }
  function applyHandout(h) {
    var name = String(h.name || 'Alexandria');
    var ho = findObjs({ _type: 'handout', name: name })[0];
    if (!ho) ho = createObj('handout', { name: name, inplayerjournals: h.players ? 'all' : '', archived: false });
    else ho.set('inplayerjournals', h.players ? 'all' : '');
    // Notes cannot be set when a handout is made; they are set after.
    ho.set('notes', String(h.notes || ''));
    ho.set('gmnotes', String(h.gmnotes || ''));
  }
  function esc(s) { return String(s).replace(/[{}[\]]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function applyItem(x) {
    if (x.kind === 'handout') applyHandout(x);
    else if (x.kind === 'say') sendChat(x.as || 'Alexandria', esc(x.text || ''));
  }
  function applyRoll(r) {
    var dice = (r.dice || []).join(', ');
    sendChat('Alexandria', '&{template:default} {{name=' + esc(r.who) + ' rolls ' + esc(r.expr) + '}} {{Total=' + esc(r.total) + '}}' + (dice ? ' {{Dice=' + esc(dice) + '}}' : '') + (r.note ? ' {{Note=' + esc(r.note) + '}}' : ''));
  }

  function fromBridge(m) {
    var s = st();
    s.bridgeAt = Date.now();
    switch (m.t) {
      case 'hello':
        if (m.config) s.config = m.config;
        whisper({ t: 'hi', version: VERSION, instance: s.instance, campaign: Campaign().get('name') || '' });
        snapshot();
        flush();
        break;
      case 'ping':
        break;
      case 'ack':
        s.queue = s.queue.filter(function (e) { return e.seq > m.seq; });
        break;
      case 'sync':
        if (m.config) s.config = m.config;
        (m.pushes || []).forEach(applyPush);
        (m.items || []).forEach(applyItem);
        (m.rolls || []).forEach(applyRoll);
        break;
      case 'resend':
        flush();
        break;
    }
  }

  // Pieces of a long message, by id.
  var parts = {};
  function onIn(content) {
    var mm = /^!alx-in\s+(\S+)\s+(\d+)\/(\d+)\s+(\S+)\s*$/.exec(content);
    if (!mm) return;
    var id = mm[1], i = +mm[2], n = +mm[3];
    if (n > 200 || i < 1 || i > n) return;
    var p = parts[id] || (parts[id] = { n: n, got: {}, at: Date.now() });
    p.got[i] = mm[4];
    if (Object.keys(p.got).length < n) return;
    delete parts[id];
    var data = '';
    for (var k = 1; k <= n; k++) data += p.got[k];
    try { fromBridge(decode(data)); } catch (e) { log('Alexandria: could not read a bridge message: ' + e); }
  }

  /** Rolls in a chat message: [{ expr, total, dice }]. */
  function rollsOf(msg) {
    var out = [];
    function dice(rolls) {
      var d = [];
      (rolls || []).forEach(function (r) { if (r.type === 'R') (r.results || []).forEach(function (x) { if (!x.d) d.push(x.v); }); });
      return d;
    }
    if (msg.type === 'rollresult') {
      try { var r = JSON.parse(msg.content); out.push({ expr: msg.origRoll || '', total: r.total, dice: dice(r.rolls) }); } catch (e) { /* not a roll */ }
    }
    (msg.inlinerolls || []).forEach(function (r) { if (r.results) out.push({ expr: r.expression, total: r.results.total, dice: dice(r.results.rolls) }); });
    return out;
  }
  function labelOf(msg) {
    var m = /\{\{(?:rname|name|title)=([^}]*)\}\}/.exec(msg.content || '');
    return m ? m[1].replace(/<[^>]*>/g, '').replace(/\$\[\[\d+\]\]/g, '').trim().slice(0, 60) : '';
  }

  function onChat(msg) {
    if (msg.type === 'api') {
      if (msg.content.indexOf('!alx-in ') === 0) { if (playerIsGM(msg.playerid)) onIn(msg.content); return; }
      if (/^!alx(\s|$)/.test(msg.content) && playerIsGM(msg.playerid)) {
        var cmd = msg.content.split(/\s+/)[1] || 'status', s = st();
        if (cmd === 'sync') snapshot();
        if (cmd === 'reset') s.queue = [];
        sendChat('Alexandria', '/w gm Alexandria ' + VERSION + ': bridge ' + (bridgeOnline() ? 'online' : 'not seen for ' + Math.round((Date.now() - s.bridgeAt) / 1000) + 's') + ', ' + s.queue.length + ' event(s) waiting.', null, { noarchive: true });
      }
      return;
    }
    // Rolls players and the GM make in the open (not whispers, not GM rolls, not this script's own lines).
    var c = st().config;
    if (!c.rollsIn || msg.playerid === 'API' || msg.type === 'whisper' || msg.type === 'gmrollresult') return;
    var rolls = rollsOf(msg);
    if (!rolls.length) return;
    var who = msg.who || '', player = getObj('player', msg.playerid);
    var ch = findObjs({ _type: 'character', name: who })[0];
    emit({ t: 'roll', who: who, player: player ? player.get('_displayname') : '', characterId: ch ? ch.id : null, label: labelOf(msg), rolls: rolls });
  }

  function init() {
    st();
    on('chat:message', onChat);
    on('change:attribute', function (obj) {
      var c = st().config, n = obj.get('name');
      if (c.hp && (n === c.hpAttr || n === c.tempAttr)) later('vitals', obj.get('_characterid'));
    });
    on('change:graphic', function (obj, prev) {
      var c = st().config, rep = obj.get('represents');
      if (!rep) return;
      if (c.conditions && obj.get('statusmarkers') !== prev.statusmarkers) later('markers', rep);
      // A bar linked to an attribute is reported by the attribute change.
      var b = c.bar;
      if (c.hp && !obj.get(b + '_link') && (obj.get(b + '_value') !== prev[b + '_value'] || obj.get(b + '_max') !== prev[b + '_max'])) later('vitals', rep, obj.id);
    });
    on('add:character', function () { if (bridgeOnline()) setTimeout(snapshot, 2000); });
    log('Alexandria ' + VERSION + ' ready. Start the Alexandria bridge in the GM\'s browser.');
  }

  return { init: init, VERSION: VERSION, _test: { encode: encode, decode: decode, fromBridge: fromBridge, onChat: onChat, st: st } };
}());

on('ready', function () { AlexandriaBridge.init(); });
