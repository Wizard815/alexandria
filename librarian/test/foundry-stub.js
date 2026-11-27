// A stand-in for the parts of Foundry VTT (v12/v13 API shapes) that the
// Alexandria Bridge module uses: game.actors/scenes/users/settings, Hooks,
// documents with update(), status effects, tokens, chat messages, journal
// entries, FilePicker and Scene.create. Loaded into a vm context by
// test/foundry.test.ts, together with the real module.
function makeFoundry(opts) {
  const hooks = {};
  const Hooks = {
    on(n, fn) { (hooks[n] ??= []).push(fn); },
    once(n, fn) { (hooks[n] ??= []).push(fn); },
    callAll(n, ...a) { for (const fn of hooks[n] ?? []) fn(...a); return true; },
    call(n, ...a) { return Hooks.callAll(n, ...a); },
  };
  class Collection extends Map {
    [Symbol.iterator]() { return this.values(); }
    filter(f) { return [...this.values()].filter(f); }
    map(f) { return [...this.values()].map(f); }
    find(f) { return [...this.values()].find(f); }
  }
  let n = 0;
  const nid = (p) => `${p}${(++n).toString(36).padStart(6, '0')}`;
  const setPath = (o, p, v) => { const k = p.split('.'); let x = o; for (const s of k.slice(0, -1)) x = x[s] ??= {}; x[k.at(-1)] = v; };
  const flat = (up) => Object.entries(up);

  const users = new Collection();
  const user = (name, isGM, self) => { const u = { id: nid('u'), name, isGM, isSelf: !!self }; users.set(u.id, u); return u; };
  const gm = user('Gamemaster', true, true);

  const actors = new Collection();
  function addActor(name, type, owners, hp, max) {
    const a = {
      id: nid('a'), name, type, documentName: 'Actor', statuses: new Set(), owners: owners.map((u) => u.id),
      system: { attributes: { hp: { value: hp, max, temp: 0 } } },
      get hasPlayerOwner() { return this.owners.some((id) => !users.get(id).isGM); },
      testUserPermission(u, level) { return level === 'OWNER' && (u.isGM || this.owners.includes(u.id)); },
      async update(up, o = {}) { for (const [k, v] of flat(up)) setPath(this, k, v); Hooks.callAll('updateActor', this, up, o, gm.id); return this; },
      async toggleStatusEffect(id, { active }) {
        if (!statusIds.includes(id)) throw new Error(`no status ${id}`);
        if (active) { this.statuses.add(id); Hooks.callAll('createActiveEffect', { parent: this }, {}, gm.id); } else { this.statuses.delete(id); Hooks.callAll('deleteActiveEffect', { parent: this }, {}, gm.id); }
      },
    };
    actors.set(a.id, a);
    return a;
  }

  const scenes = new Collection();
  function addScene(name, src, width, height, grid = 100) {
    const pad = grid * 3;
    const s = {
      id: nid('s'), name, documentName: 'Scene', background: { src }, width, height, active: false, flags: {},
      grid: { size: grid, type: 1 },
      dimensions: { sceneX: pad, sceneY: pad, sceneWidth: width, sceneHeight: height, size: grid },
      tokens: new Collection(),
      getFlag(scope, k) { return this.flags[scope]?.[k]; },
      async update(up, o = {}) {
        const change = {};
        for (const [k, v] of flat(up)) { setPath(this, k, v); setPath(change, k, v); }
        Hooks.callAll('updateScene', this, change, o, gm.id);
        return this;
      },
    };
    scenes.set(s.id, s);
    return s;
  }
  function addToken(scene, name, actor, gx, gy, extra = {}) {
    const t = {
      id: nid('t'), name, actorId: actor?.id ?? null, actor, parent: scene, width: 1, height: 1, hidden: false, disposition: actor?.hasPlayerOwner ? 1 : -1,
      x: scene.dimensions.sceneX + gx * scene.grid.size, y: scene.dimensions.sceneY + gy * scene.grid.size, ...extra,
      async update(up, o = {}) { const change = {}; for (const [k, v] of flat(up)) { setPath(this, k, v); change[k] = v; } Hooks.callAll('updateToken', this, change, o, gm.id); return this; },
    };
    scene.tokens.set(t.id, t);
    Hooks.callAll('createToken', t, {}, gm.id);
    return t;
  }

  const chat = [];
  const journals = [];
  const files = {};
  const statusIds = ['blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion', 'concentrating', 'dead'];

  const settings = {};
  const game = {
    ready: false, version: '13.345', world: { title: 'Sunken Realm' }, system: { id: 'dnd5e' },
    user: gm, users, actors, scenes, modules: new Map([['alexandria-bridge', {}]]),
    settings: {
      register(scope, k, cfg) { settings[`${scope}.${k}`] = cfg.default; },
      get(scope, k) { return settings[`${scope}.${k}`]; },
      set(scope, k, v) { settings[`${scope}.${k}`] = v; },
    },
  };
  Object.defineProperty(users, 'activeGM', { get: () => gm });

  const ChatMessage = {
    async create(data) {
      const m = { id: nid('m'), ...data, rolls: data.rolls ?? [], whisper: data.whisper ?? [], blind: false, getFlag(scope, k) { return data.flags?.[scope]?.[k]; } };
      chat.push(m);
      Hooks.callAll('createChatMessage', m, {}, gm.id);
      return m;
    },
  };
  const JournalEntry = { async create(data) { const j = { id: nid('j'), ...data }; journals.push(j); return j; } };
  const Scene = {
    async create(data) {
      const s = addScene(data.name, data.background.src, data.width, data.height);
      s.flags = data.flags ?? {};
      s.padding = data.padding;
      Hooks.callAll('createScene', s, {}, gm.id);
      return s;
    },
  };
  const FilePicker = {
    dirs: [],
    async createDirectory(src, dir) { if (FilePicker.dirs.includes(dir)) throw new Error('exists'); FilePicker.dirs.push(dir); },
    async upload(src, dir, file) { const p = `${dir}/${file.name}`; files[p] = Buffer.from(await file.arrayBuffer()); return { path: p }; },
  };

  const api = {
    Hooks, game, ChatMessage, JournalEntry, Scene, FilePicker,
    CONFIG: { statusEffects: statusIds.map((id) => ({ id })) },
    foundry: { utils: { hasProperty: (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' && k in x ? x[k] : undefined), o) !== undefined } },
    ui: { notifications: { info() {}, warn() {} } },
    canvas: null,
    createImageBitmap: async () => ({ width: opts?.imageSize?.[0] ?? 800, height: opts?.imageSize?.[1] ?? 500 }),
  };
  return {
    api, hooks, chat, journals, files, users, gm, user, addActor, addScene, addToken,
    ready() { game.ready = true; Hooks.callAll('init'); Hooks.callAll('ready'); },
  };
}
