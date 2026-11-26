// A small stand-in for the Roll20 Mod (API) sandbox, enough to run
// features/roll20/client/alexandria.mod.js in tests: objects with get/set,
// findObjs/getObj/createObj, events, chat, players and state. Changes made
// through user*() fire events (like a person at the table); changes the Mod
// makes do not (like Roll20). A classic script: it defines
// globalThis.makeRoll20Sandbox so both node:vm and a browser page can load it.
(function () {
  'use strict';
  function makeRoll20Sandbox(opts) {
    opts = opts || {};
    var objs = [];
    var handlers = {};
    var chat = [];
    var nextId = 1;
    var norm = function (k) { return k.charAt(0) === '_' ? k.slice(1) : k; };
    function Obj(type, props) {
      this.props = {};
      for (var k in props) this.props[norm(k)] = props[k];
      this.props.type = type;
      if (!this.props.id) this.props.id = '-M' + (nextId++);
      this.id = this.props.id;
    }
    Obj.prototype.get = function (k) { var v = this.props[norm(k)]; return v === undefined ? '' : v; };
    Obj.prototype.set = function (k, v) {
      if (typeof k === 'object') { for (var x in k) this.props[norm(x)] = k[x]; } else this.props[norm(k)] = v;
    };
    Obj.prototype.remove = function () { objs.splice(objs.indexOf(this), 1); };
    function fire(name) {
      var args = Array.prototype.slice.call(arguments, 1);
      (handlers[name] || []).forEach(function (fn) { fn.apply(null, args); });
    }
    function matches(o, attrs) {
      for (var k in attrs) if (String(o.props[norm(k)]) !== String(attrs[k])) return false;
      return true;
    }
    var api = {
      state: {},
      log: function () { if (opts.verbose) console.log.apply(console, arguments); },
      on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
      findObjs: function (attrs) { return objs.filter(function (o) { return matches(o, attrs); }); },
      getObj: function (type, id) { return objs.filter(function (o) { return o.props.type === type && o.id === id; })[0]; },
      createObj: function (type, props) { var o = new Obj(type, props); objs.push(o); return o; },
      playerIsGM: function (id) { var p = api.getObj('player', id); return !!(p && p.props.gm); },
      Campaign: function () { return campaign; },
      sendChat: function (as, text) { deliver({ who: as, playerid: 'API', content: text }); },
    };
    var campaign = new Obj('campaign', { name: opts.campaign || 'Test campaign', token_markers: JSON.stringify(opts.tokenMarkers || []) });

    /** A message as Roll20 builds it from what someone typed (or a script sent). */
    function deliver(m) {
      var text = m.content;
      var msg = { who: m.who, playerid: m.playerid, type: 'general', content: text };
      if (text.indexOf('/w gm ') === 0) { msg.type = 'whisper'; msg.target = 'gm'; msg.content = text.slice(6); }
      else if (text.charAt(0) === '!') msg.type = 'api';
      if (m.inlinerolls) msg.inlinerolls = m.inlinerolls;
      if (m.rolltemplate) msg.rolltemplate = m.rolltemplate;
      if (m.type) msg.type = m.type;
      if (m.origRoll) msg.origRoll = m.origRoll;
      chat.push(msg);
      if (api.onChatLine) api.onChatLine(msg);
      fire('chat:message', msg);
    }

    var t = {
      api: api,
      chat: chat,
      ready: function () { fire('ready'); },
      addPlayer: function (name, gm) { return api.createObj('player', { displayname: name, gm: !!gm }); },
      addCharacter: function (name, ownerIds, hp, maxHp) {
        var ch = api.createObj('character', { name: name, controlledby: (ownerIds || []).join(',') });
        if (hp !== undefined) api.createObj('attribute', { characterid: ch.id, name: 'hp', current: String(hp), max: String(maxHp) });
        api.createObj('attribute', { characterid: ch.id, name: 'hp_temp', current: '0', max: '' });
        var tok = api.createObj('graphic', { subtype: 'token', represents: ch.id, bar1_link: '', bar1_value: String(hp), bar1_max: String(maxHp), statusmarkers: '' });
        return { ch: ch, tok: tok };
      },
      attr: function (charId, name) { return api.findObjs({ _type: 'attribute', _characterid: charId, name: name })[0]; },
      /** A person changes something: Roll20 fires the change event. */
      userSet: function (o, k, v) {
        var prev = {}; for (var x in o.props) prev[x] = o.props[x];
        o.set(k, v);
        fire('change:' + o.props.type, o, prev);
        fire('change:' + o.props.type + ':' + norm(k), o, prev);
      },
      say: function (playerId, text, extra) {
        var p = api.getObj('player', playerId);
        var m = { who: (extra && extra.who) || (p ? p.props.displayname : '?'), playerid: playerId, content: text };
        for (var k in extra || {}) m[k] = extra[k];
        deliver(m);
      },
    };
    return t;
  }
  (typeof globalThis !== 'undefined' ? globalThis : window).makeRoll20Sandbox = makeRoll20Sandbox;
}());
