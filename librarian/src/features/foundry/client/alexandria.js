// Alexandria Bridge: a Foundry VTT module (v12 and v13) that keeps this
// Foundry world and an Alexandria world in step.
//
// In the GM's tab (the active GM only) it is the bridge: it sends actors,
// scenes, tokens, rolls and changes to Alexandria and applies what Alexandria
// sends back (HP, status effects, token moves, fog, new scenes, journal
// entries, chat lines), polling every two seconds. In every tab it draws
// Alexandria's fog of war over the scene (kept in the scene's flags).
//
// The Alexandria address and bridge key are set in this module's settings.
// They are kept in the GM's own browser (client scope), so players never
// receive the key.
const ID = 'alexandria-bridge';
const VERSION = '1.0.0';
const POLL_MS = 2000;
const API = '/api/foundry/bridge';

const log = (...a) => console.log('Alexandria |', ...a);
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- fog ----
// The same rules as Alexandria's fog (librarian/src/core/fog.ts): a 96 x 96
// bitmask base (1 = fogged, null = all fogged) and strokes on top. A circle's
// radius is a fraction of the width, with the map taken as `aspect` wide to tall.
const FOG_GRID = 96;

export function fogTest(state) {
  const base = state.base ? Uint8Array.from(atob(state.base), (c) => c.charCodeAt(0)) : null;
  const aspect = state.aspect || 1.6;
  const ops = Array.isArray(state.ops) ? state.ops : [];
  return (x, y) => {
    let fogged = true;
    if (base) {
      const i = Math.min(FOG_GRID - 1, Math.max(0, Math.floor(y * FOG_GRID))) * FOG_GRID + Math.min(FOG_GRID - 1, Math.max(0, Math.floor(x * FOG_GRID)));
      fogged = (base[i >> 3] & (1 << (i & 7))) !== 0;
    }
    for (const op of ops) {
      let hit = false;
      if (op.k === 'all') hit = true;
      else if (op.k === 'r') hit = x >= op.x && x <= op.x + op.w && y >= op.y && y <= op.y + op.h;
      else if (op.k === 'c') { const dx = x - op.x, dy = (y - op.y) / aspect; hit = dx * dx + dy * dy <= op.r * op.r; }
      if (hit) fogged = op.v === 0;
    }
    return fogged;
  };
}

/** The fog as RGBA pixels, w x h: black where fogged. */
export function fogPixels(state, w, h, alpha) {
  const test = fogTest(state);
  const px = new Uint8ClampedArray(w * h * 4);
  const a = Math.round(alpha * 255);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (test((i + 0.5) / w, (j + 0.5) / h)) { const n = (j * w + i) * 4; px[n] = 8; px[n + 1] = 10; px[n + 2] = 14; px[n + 3] = a; }
  return px;
}

let fogSprite = null;
function drawFog() {
  try {
    if (fogSprite) { fogSprite.destroy({ texture: true, baseTexture: true }); fogSprite = null; }
    const scene = canvas?.scene;
    const f = scene?.getFlag?.(ID, 'fog');
    if (!scene || !f?.enabled) return;
    const dm = canvas.dimensions;
    const w = 256;
    const h = Math.max(1, Math.round((w * dm.sceneHeight) / dm.sceneWidth));
    const el = document.createElement('canvas');
    el.width = w; el.height = h;
    const g = el.getContext('2d');
    // The GM sees it as a tint, players as solid fog.
    g.putImageData(new ImageData(fogPixels(f, w, h, game.user.isGM ? 0.45 : 1), w, h), 0, 0);
    fogSprite = new PIXI.Sprite(PIXI.Texture.from(el));
    fogSprite.position.set(dm.sceneX, dm.sceneY);
    fogSprite.width = dm.sceneWidth;
    fogSprite.height = dm.sceneHeight;
    fogSprite.eventMode = 'none';
    fogSprite.name = 'alexandria-fog';
    canvas.stage.addChild(fogSprite);
  } catch (err) { log('fog not drawn', err); }
}

// ------------------------------------------------------------- bridge ----
export class Bridge {
  constructor({ url, key, fetchImpl }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = key;
    this.fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.instance = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.seq = 0;
    this.pending = [];
    this.config = null;
    this.timer = null;
    this.busy = false;
    this.status = 'off';
    this.debounce = {};
  }

  /** A JSON call to the bridge. */
  async api(method, p, body) {
    const headers = { Authorization: `Bearer ${this.key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return (await this.call(p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  }
  /** Bytes to the bridge, or (no blob) bytes from it. */
  async bytes(p, blob) {
    const headers = { Authorization: `Bearer ${this.key}` };
    if (blob) headers['Content-Type'] = blob.type || 'application/octet-stream';
    return this.call(p, { method: blob ? 'POST' : 'GET', headers, body: blob });
  }
  async call(p, init) {
    const r = await this.fetch(this.url + API + p, init);
    if (!r.ok) {
      let msg = `${r.status}`;
      try { msg = (await r.json()).error ?? msg; } catch { /* not json */ }
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r;
  }

  send(t, data) { this.pending.push({ seq: ++this.seq, t, ...data }); }
  /** One snapshot of a kind, sent once per tick however many hooks asked. */
  soon(kind, fn) { this.debounce[kind] = fn; }

  linked(sceneId) { return !!this.config?.scenes?.includes(sceneId); }

  // ---- reading the game ----
  owners(actor) {
    return game.users.filter((u) => !u.isGM && actor.testUserPermission(u, 'OWNER')).map((u) => u.name);
  }
  actorData(a) {
    const c = this.config;
    return {
      id: a.id, name: a.name, owners: this.owners(a),
      hp: getPath(a, c.hpPath), maxHp: getPath(a, c.maxPath), tempHp: getPath(a, c.tempPath),
      statuses: [...(a.statuses ?? [])],
    };
  }
  playerActors() { return game.actors.filter((a) => a.hasPlayerOwner || a.type === 'character'); }
  sceneData(s) {
    const d = s.dimensions;
    return {
      id: s.id, name: s.name, img: s.background?.src ?? null, width: s.width, height: s.height, active: !!s.active,
      gridFrac: d && d.sceneWidth ? (s.grid?.size ?? d.size) / d.sceneWidth : null,
    };
  }
  tokenData(t) {
    const s = t.parent;
    const d = s.dimensions;
    const size = s.grid?.size ?? d.size;
    const cx = t.x + (t.width * size) / 2;
    const cy = t.y + (t.height * size) / 2;
    return {
      id: t.id, name: t.name, actorId: t.actorId ?? t.actor?.id ?? null,
      x: round(Math.min(100, Math.max(0, ((cx - d.sceneX) / d.sceneWidth) * 100))),
      y: round(Math.min(100, Math.max(0, ((cy - d.sceneY) / d.sceneHeight) * 100))),
      w: Math.min(1, (t.width * size) / d.sceneWidth), hidden: !!t.hidden, disposition: t.disposition,
      player: !!t.actor?.hasPlayerOwner,
    };
  }
  snapshot() {
    this.send('actors', { list: this.playerActors().map((a) => this.actorData(a)) });
    this.send('scenes', { list: game.scenes.map((s) => this.sceneData(s)) });
    if (this.config.tokens) for (const s of game.scenes) if (this.linked(s.id)) this.send('tokens', { scene: s.id, list: s.tokens.map((t) => this.tokenData(t)) });
  }

  // ---- the loop ----
  async start() {
    if (!this.url || !this.key) { this.setStatus('Set the Alexandria address and bridge key in the module settings'); return false; }
    try {
      const h = await this.api('POST', '/hello', {
        moduleVersion: VERSION, world: game.world?.title, system: game.system?.id, foundryVersion: game.version,
        statusIds: (CONFIG.statusEffects ?? []).map((e) => e.id).filter(Boolean),
      });
      this.config = h.config;
      this.world = h.world;
      if (h.moduleVersion && h.moduleVersion !== VERSION) ui.notifications?.info(`Alexandria: a newer Alexandria Bridge (${h.moduleVersion}) is ready. Update it in Foundry's module list.`);
    } catch (err) {
      this.setStatus(`Cannot reach Alexandria: ${err.message}`);
      if (!this.stopped) this.timer = setTimeout(() => void this.start(), 15000);
      return false;
    }
    this.snapshot();
    this.setStatus(`Connected to ${this.world}`);
    await this.tick();
    return true;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.flush();
      const s = await this.api('POST', '/sync');
      const was = this.config?.scenes ?? [];
      this.config = s.config;
      await this.apply(s);
      // A scene was linked: its tokens are sent.
      if (this.config.tokens) for (const id of this.config.scenes) if (!was.includes(id)) { const sc = game.scenes.get(id); if (sc) this.send('tokens', { scene: id, list: sc.tokens.map((t) => this.tokenData(t)) }); }
      // What applying changed (a new scene, a refresh) goes now, not a tick later.
      await this.flush();
      if (this.status !== `Connected to ${this.world}`) this.setStatus(`Connected to ${this.world}`);
    } catch (err) {
      this.setStatus(`Alexandria: ${err.message}`);
    } finally {
      this.busy = false;
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), POLL_MS);
    }
  }

  /** Send every waiting event (the debounced snapshots first). */
  async flush() {
    for (const k of Object.keys(this.debounce)) { const fn = this.debounce[k]; delete this.debounce[k]; fn(); }
    while (this.pending.length) {
      const batch = this.pending.slice(0, 100);
      const r = await this.api('POST', '/events', { instance: this.instance, events: batch });
      this.pending = this.pending.filter((e) => e.seq > r.acked);
      if (!r.acked) break;
    }
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    log(s);
    Hooks.callAll(`${ID}.status`, s);
  }

  // ---- applying what Alexandria sends ----
  async apply(s) {
    const c = this.config;
    for (const p of s.pushes ?? []) {
      const a = game.actors.get(p.id);
      if (!a) continue;
      const up = {};
      if (p.hp !== undefined) up[c.hpPath] = p.hp;
      if (p.maxHp !== undefined) up[c.maxPath] = p.maxHp;
      if (p.tempHp !== undefined) up[c.tempPath] = p.tempHp;
      try { if (Object.keys(up).length) await a.update(up, { [ID]: true }); } catch (err) { log('HP not set', a.name, err); }
      if (p.statuses) {
        for (const sid of c.managed) {
          const want = p.statuses.includes(sid);
          if (!!a.statuses?.has(sid) === want) continue;
          try { await a.toggleStatusEffect(sid, { active: want }); } catch (err) { log('status not set', sid, err); }
        }
      }
    }
    for (const m of s.moves ?? []) {
      const sc = game.scenes.get(m.scene);
      const t = sc?.tokens.get(m.id);
      if (!t) continue;
      const d = sc.dimensions;
      const size = sc.grid?.size ?? d.size;
      let x = d.sceneX + (m.x / 100) * d.sceneWidth - (t.width * size) / 2;
      let y = d.sceneY + (m.y / 100) * d.sceneHeight - (t.height * size) / 2;
      // Snapped to the grid's squares, as a drag in Foundry would be.
      if (sc.grid?.type !== 0) { x = Math.round(x / size) * size; y = Math.round(y / size) * size; }
      try { await t.update({ x, y }, { [ID]: true }); } catch (err) { log('token not moved', err); }
    }
    for (const f of s.fog ?? []) {
      const sc = game.scenes.get(f.scene);
      if (!sc) continue;
      try { await sc.update({ [`flags.${ID}.fog`]: { enabled: f.enabled, base: f.base, ops: f.ops, aspect: f.aspect } }, { [ID]: true }); } catch (err) { log('fog not saved', err); }
    }
    for (const it of s.items ?? []) {
      try { await this.item(it); } catch (err) { log(`${it.kind} failed`, err); }
    }
    for (const r of s.rolls ?? []) {
      await ChatMessage.create({ content: `<p><strong>${esc(r.who)}</strong> rolled <code>${esc(r.expr)}</code> = <strong>${esc(r.total)}</strong>${r.note ? ` <em>${esc(r.note)}</em>` : ''}</p>`, speaker: { alias: 'Alexandria' }, flags: { [ID]: { from: true } } });
    }
  }

  async item(it) {
    if (it.kind === 'refresh') { this.snapshot(); return; }
    if (it.kind === 'say') {
      await ChatMessage.create({ content: `<p>${esc(it.text)}</p>`, speaker: { alias: it.as || 'Alexandria' }, flags: { [ID]: { from: true } } });
      return;
    }
    if (it.kind === 'handout') {
      const pages = [{ name: it.name, type: 'text', text: { content: it.html } }];
      if (it.gmnotes) pages.push({ name: 'GM notes', type: 'text', text: { content: it.gmnotes }, ownership: { default: 0 } });
      await JournalEntry.create({ name: it.name, pages, ownership: { default: it.players ? 2 : 0 }, flags: { [ID]: { from: true } } });
      return;
    }
    if (it.kind === 'fetchScene') {
      // A scene's picture to Alexandria (the DM asked to bring it in).
      const sc = game.scenes.get(it.sceneId);
      const src = sc?.background?.src;
      if (!src) return;
      const r = await this.fetch(src);
      if (!r.ok) throw new Error(`picture ${r.status}`);
      const blob = await r.blob();
      const name = decodeURIComponent(src.split('/').pop() || 'scene.webp').split('?')[0];
      await this.bytes(`/scenes/${encodeURIComponent(sc.id)}/image?name=${encodeURIComponent(name)}`, blob);
      ui.notifications?.info(`Alexandria: "${sc.name}" is on the Alexandria map now.`);
      return;
    }
    if (it.kind === 'scene') {
      // An Alexandria map picture as a new scene: saved in this world's data folder, then a scene of its size.
      const r = await this.bytes(`/pictures/${it.id}`);
      const blob = await r.blob();
      const FP = globalThis.foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      const dir = 'alexandria';
      try { await FP.createDirectory('data', dir); } catch { /* already there */ }
      const file = new File([blob], `${String(it.mapId).replace(/[^a-z0-9-]/gi, '-')}-${it.id}.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: blob.type });
      const up = await FP.upload('data', dir, file, {}, { notify: false });
      const src = up?.path ?? `${dir}/${file.name}`;
      const bmp = await createImageBitmap(blob);
      const sc = await Scene.create({ name: it.name, background: { src }, width: bmp.width, height: bmp.height, padding: 0, flags: { [ID]: { mapId: it.mapId, pic: it.pic } } });
      this.send('sceneMade', { ref: it.id, sceneId: sc.id });
      ui.notifications?.info(`Alexandria: made the scene "${it.name}".`);
    }
  }

  // ---- watching the game (hooks call these) ----
  onActor(a, options) {
    if (!this.config || options?.[ID]) return;
    if (!(a.hasPlayerOwner || a.type === 'character')) return;
    this.soon(`actor:${a.id}`, () => this.send('actor', this.actorData(a)));
  }
  onToken(t) {
    if (!this.config?.tokens) return;
    const s = t.parent;
    if (!s || !this.linked(s.id)) return;
    this.soon(`token:${t.id}`, () => this.send('token', { scene: s.id, ...this.tokenData(t) }));
  }
  onTokenGone(t) {
    const s = t.parent;
    if (!this.config?.tokens || !s || !this.linked(s.id)) return;
    this.send('tokenGone', { scene: s.id, id: t.id });
  }
  onScenes() { if (this.config) this.soon('scenes', () => this.send('scenes', { list: game.scenes.map((s) => this.sceneData(s)) })); }
  onChat(m) {
    if (!this.config?.rollsIn || m.getFlag?.(ID, 'from')) return;
    if (!m.rolls?.length || m.whisper?.length || m.blind) return;
    const actor = m.speaker?.actor ?? null;
    this.send('roll', {
      who: m.speaker?.alias ?? m.author?.name ?? m.user?.name ?? '', player: m.author?.name ?? m.user?.name ?? '', actorId: actor,
      label: (m.flavor ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60),
      rolls: m.rolls.map((r) => ({ expr: r.formula, total: r.total, dice: (r.dice ?? []).flatMap((d) => (d.results ?? []).filter((x) => x.active !== false).map((x) => x.result)) })),
    });
  }
}

// -------------------------------------------------------------- wiring ---
let bridge = null;

function isBridgeClient() {
  if (!game.user.isGM) return false;
  const active = game.users.activeGM;
  return !active || active.isSelf || active.id === game.user.id;
}

function startBridge() {
  bridge?.stop();
  bridge = null;
  if (!isBridgeClient()) return Promise.resolve(false);
  bridge = new Bridge({ url: game.settings.get(ID, 'url'), key: game.settings.get(ID, 'key') });
  return bridge.start();
}

if (typeof Hooks !== 'undefined') {
  Hooks.once('init', () => {
    const restart = () => { if (game.ready) void startBridge(); };
    game.settings.register(ID, 'url', { name: 'Alexandria address', hint: 'Where your Alexandria server is, e.g. http://192.168.1.20:8787 (from DM → Setup → Foundry in Alexandria).', scope: 'client', config: true, type: String, default: '', onChange: restart });
    game.settings.register(ID, 'key', { name: 'Bridge key', hint: 'The key from DM → Setup → Foundry in Alexandria. It stays in this browser; players never get it.', scope: 'client', config: true, type: String, default: '', onChange: restart });
  });
  Hooks.once('ready', () => {
    void startBridge();
    globalThis.game.modules.get(ID).api = { get bridge() { return bridge; }, reconnect: startBridge, fogTest };
  });
  Hooks.on('canvasReady', drawFog);
  Hooks.on('updateScene', (s, change) => {
    if (s.id === canvas?.scene?.id && foundry.utils.hasProperty(change, `flags.${ID}`)) drawFog();
    bridge?.onScenes();
  });
  Hooks.on('createScene', () => bridge?.onScenes());
  Hooks.on('deleteScene', () => bridge?.onScenes());
  Hooks.on('updateActor', (a, _c, o) => bridge?.onActor(a, o));
  Hooks.on('createActor', () => bridge?.config && bridge.soon('actors', () => bridge.send('actors', { list: bridge.playerActors().map((a) => bridge.actorData(a)) })));
  for (const h of ['createActiveEffect', 'deleteActiveEffect', 'updateActiveEffect']) Hooks.on(h, (e) => { if (e.parent?.documentName === 'Actor') bridge?.onActor(e.parent); });
  Hooks.on('createToken', (t) => bridge?.onToken(t));
  Hooks.on('updateToken', (t, change) => { if (['x', 'y', 'hidden', 'name', 'width', 'height', 'disposition'].some((k) => k in change)) bridge?.onToken(t); });
  Hooks.on('deleteToken', (t) => bridge?.onTokenGone(t));
  Hooks.on('createChatMessage', (m) => bridge?.onChat(m));
  // A small connection tag in the GM's player list.
  Hooks.on(`${ID}.status`, (s) => {
    let el = document.getElementById('alexandria-status');
    if (!el) { el = document.createElement('div'); el.id = 'alexandria-status'; document.body.appendChild(el); }
    el.textContent = s.startsWith('Connected') ? `Alexandria: ${s}` : s;
    el.dataset.ok = String(s.startsWith('Connected'));
  });
}
