// The DM agent and the player harness on one chat model (PLAN §6).
// Conversations are stored per account; a message is answered in the
// background and delivered by polling (GET /chats/:id) or the 'agent' event.
// Writes the DM agent wants to make wait as pending actions until the DM
// approves them (POST /actions/:id). Combat tools and statblocks live here.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { hasJob } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { only } from '../../core/events.ts';
import { requireDM } from '../../core/auth.ts';
import { featureSetting } from '../../core/policy.ts';
import { HttpError, int, now, oneOf, str } from '../../core/util.ts';
import { ctx, isDM, me, settings } from '../../routes/_shared.ts';
import { sessionLines, listSessions } from '../audio/api.ts';
import { describeCall, harnessTools, historyFor, runAgent, runTool, type Caller } from './harness.ts';
import { addMessage, actionView, chatView, newChat, ownChat, SCHEMA } from './store.ts';
import { buildStatblock, mod, normalizeStatblock, rollInitiative, saveStatblockPage, statblockFromBody, type Statblock } from './statblock.ts';

const audit = (db: any, worldId: string, accountId: string | null, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const enc = encodeURIComponent;
const S = (description: string) => ({ type: 'string', description });

const bearer = (req: any): string => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();

function routes(d: import('../../app.ts').Deps) {
  const r = Router();
  const W = (res: any): string => ctx(res).world.id;

  /** Who is asking, and with which token the tools will run. */
  const caller = (req: any, res: any): Caller => {
    const dm = isDM(res);
    if (!dm && (ctx(res).viewer.role !== 'player' || featureSetting<boolean>(settings(res), 'agentPlayerChat') === false)) throw new HttpError(403, 'The player assistant is not available to you in this world');
    return { worldId: W(res), worldName: ctx(res).world.name, accountId: me(res), viewer: ctx(res).viewer, harness: dm ? 'dm' : 'player', token: bearer(req), port: req.socket.localPort, settings: settings(res) };
  };
  const needModel = () => { if (!hasJob(d, 'chat')) throw new HttpError(503, 'No chat model is set (Admin → Models), so the assistant cannot answer.'); };

  r.get('/status', (_req, res) => {
    const s = settings(res);
    res.json({ model: hasJob(d, 'chat'), harness: isDM(res) ? 'dm' : 'player', playerChat: featureSetting<boolean>(s, 'agentPlayerChat') !== false, autoApprove: isDM(res) ? featureSetting<string[]>(s, 'agentAutoApprove') ?? [] : [] });
  });

  // ---- chats ----
  r.get('/chats', (req, res) => {
    caller(req, res);
    const rows = all<any>(d.db, 'SELECT id, harness, title, created_at, updated_at FROM agent_chats WHERE world_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 100', W(res), me(res));
    res.json({ chats: rows.map((c) => ({ id: c.id, harness: c.harness, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at })) });
  });
  r.post('/chats', (req, res) => {
    const c = caller(req, res);
    const chat = newChat(d.db, c.worldId, c.accountId, c.harness, str(req.body?.title, 'title', { max: 120, optional: true }));
    res.status(201).json(chatView(d.db, chat.id));
  });
  r.get('/chats/:id', (req, res) => {
    caller(req, res);
    const c = ownChat(d.db, W(res), me(res), String(req.params.id));
    if (!c) throw new HttpError(404, 'Chat not found');
    res.json(chatView(d.db, c.id));
  });
  r.delete('/chats/:id', (req, res) => {
    const c = ownChat(d.db, W(res), me(res), String(req.params.id));
    if (!c) throw new HttpError(404, 'Chat not found');
    run(d.db, 'DELETE FROM agent_chats WHERE id = ?', c.id);
    res.json({ ok: true });
  });

  r.post('/chats/:id/messages', (req, res) => {
    const who = caller(req, res);
    const chat = ownChat(d.db, W(res), me(res), String(req.params.id));
    if (!chat) throw new HttpError(404, 'Chat not found');
    if (chat.harness !== who.harness) throw new HttpError(403, 'This chat belongs to another role');
    const text = str(req.body?.text, 'text', { max: 8000 }).trim();
    if (!text) throw new HttpError(400, 'text is required');
    const page = str(req.body?.page, 'page', { max: 300, optional: true });
    const selection = str(req.body?.selection, 'selection', { max: 3000, optional: true });
    needModel();
    if (one(d.db, `SELECT 1 FROM agent_messages WHERE chat_id = ? AND status = 'working' AND created_at > ?`, chat.id, new Date(Date.now() - 10 * 60_000).toISOString())) throw new HttpError(409, 'The assistant is still answering the last message');
    const history = historyFor(d, chat.id);
    addMessage(d.db, chat.id, 'user', text, { context: { page: page || undefined, selection: selection || undefined } });
    if (!chat.title) run(d.db, 'UPDATE agent_chats SET title = ? WHERE id = ?', text.slice(0, 60), chat.id);
    const reply = addMessage(d.db, chat.id, 'assistant', '', { status: 'working' });
    void runAgent(d, who, { chatId: chat.id, replyId: reply.id, text, context: { page: page || undefined, selection: selection || undefined }, history });
    res.status(202).json(chatView(d.db, chat.id));
  });

  // ---- pending actions (DM) ----
  r.get('/actions', requireDM, (req, res) => {
    const st = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const rows = all<any>(d.db, 'SELECT * FROM agent_actions WHERE world_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100', W(res), st);
    res.json({ actions: rows.map(actionView) });
  });

  r.post('/actions/:id', requireDM, async (req, res) => {
    const decision = oneOf(req.body?.decision, 'decision', ['approve', 'reject'] as const);
    const a = one<any>(d.db, 'SELECT * FROM agent_actions WHERE id = ? AND world_id = ?', String(req.params.id), W(res));
    if (!a) throw new HttpError(404, 'Action not found');
    // Claim it first, so two clicks (or two DMs) never run it twice.
    if (!run(d.db, `UPDATE agent_actions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`, decision === 'reject' ? 'rejected' : 'running', now(), me(res), a.id)) throw new HttpError(409, 'That action was already decided');
    const note = (text: string) => { addMessage(d.db, a.chat_id, 'assistant', text); d.hub.emit(W(res), 'agent', { kind: 'message', chatId: a.chat_id }, only(a.account_id)); };
    if (decision === 'reject') {
      audit(d.db, W(res), me(res), 'agent.reject', `${a.tool} ${a.args}`);
      note(`Rejected: ${a.summary}.`);
      return res.json(actionView(one(d.db, 'SELECT * FROM agent_actions WHERE id = ?', a.id)));
    }
    const tool = (await harnessTools('dm')).find((t) => t.name === a.tool && t.write);
    let ok = false;
    let out = '';
    if (!tool) out = 'That tool is no longer available.';
    else {
      const t = await runTool(d, { worldId: W(res), token: bearer(req), port: req.socket.localPort ?? 0 }, tool, JSON.parse(a.args));
      ok = t.ok;
      out = t.text;
    }
    run(d.db, 'UPDATE agent_actions SET status = ?, result = ? WHERE id = ?', ok ? 'done' : 'failed', out.slice(0, 8000), a.id);
    audit(d.db, W(res), me(res), 'agent.action', `${a.tool} ${a.args} -> ${ok ? 'done' : 'failed'}`);
    note(ok ? `Done: ${a.summary}.` : `That did not work: ${a.summary}. ${out.slice(0, 200)}`);
    res.status(ok ? 200 : 502).json(actionView(one(d.db, 'SELECT * FROM agent_actions WHERE id = ?', a.id)));
  });

  r.get('/leaks', requireDM, (_req, res) => {
    res.json({ leaks: all<any>(d.db, 'SELECT id, account_id, chat_id, matched, at FROM agent_leaks WHERE world_id = ? ORDER BY at DESC LIMIT 50', W(res)).map((l) => ({ id: l.id, accountId: l.account_id, chatId: l.chat_id, matched: l.matched, at: l.at })) });
  });

  // ---- transcript lookup (the search_transcript tool) ----
  r.get('/transcript', (req, res) => {
    const sessions = listSessions(d.db, W(res));
    const sid = typeof req.query.session === 'string' && req.query.session ? req.query.session : sessions[0]?.id;
    const s = sessions.find((x) => x.id === sid);
    if (!s) return res.json({ session: null, lines: [] });
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [] : [];
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    // DMs also get the DM-only lines; a player only ever gets the players' transcript.
    let lines = sessionLines(d.db, W(res), s.id, { includeDm: isDM(res) });
    if (q.length) lines = lines.filter((l) => q.every((w) => `${l.speaker} ${l.text}`.toLowerCase().includes(w)));
    res.json({ session: { id: s.id, name: s.name }, lines: lines.slice(-limit) });
  });

  // ---- statblocks (DM) ----
  r.post('/statblock', requireDM, async (req, res) => {
    const b = req.body ?? {};
    const given = ['prompt', 'pageId', 'moduleTermId'].filter((k) => typeof b[k] === 'string' && b[k].trim());
    if (given.length !== 1) throw new HttpError(400, 'Send exactly one of prompt, pageId or moduleTermId');
    const src = given[0] === 'prompt' ? { prompt: str(b.prompt, 'prompt', { max: 2000 }).trim() } : given[0] === 'pageId' ? { pageId: str(b.pageId, 'pageId', { max: 300 }) } : { moduleTermId: str(b.moduleTermId, 'moduleTermId', { max: 300 }) };
    const built = await buildStatblock(d, W(res), ctx(res).viewer, src);
    const page = saveStatblockPage(d, W(res), me(res), built.statblock, built.source);
    audit(d.db, W(res), me(res), 'agent.statblock', `${built.statblock.name} from ${built.source.kind} ${built.source.ref}`);
    const out: any = { statblock: built.statblock, page: { id: page.id, path: page.path, title: page.title }, source: built.source };
    if (b.addToCombat) out.combatant = await addToCombat(req, res, built.statblock, page.id, b);
    res.status(201).json(out);
  });

  /** "Add to combat" for a saved statblock page. */
  r.post('/statblock/:pageId/combat', requireDM, async (req, res) => {
    const pg: any = d.library.get(W(res), String(req.params.pageId), ctx(res).viewer);
    const sb = statblockFromBody(String(pg.body ?? ''));
    if (!sb) throw new HttpError(422, 'That page has no statblock data from the agent');
    res.status(201).json({ combatant: await addToCombat(req, res, sb, pg.id, req.body ?? {}) });
  });

  async function addToCombat(req: any, res: any, sb: Statblock, pageId: string, b: any) {
    const initiative = b.initiative !== undefined && b.initiative !== null ? int(b.initiative, 'initiative', { min: -20, max: 60 })! : Math.max(-20, Math.min(60, rollInitiative(sb)));
    const tool = (await harnessTools('dm')).find((t) => t.name === 'add_combatant')!;
    const t = await runTool(d, { worldId: W(res), token: bearer(req), port: req.socket.localPort }, tool, { name: typeof b.name === 'string' && b.name ? b.name : sb.name, initiative, hp: sb.hp, maxHp: sb.hp, ac: sb.ac, hidden: !!b.hidden, statblockPage: pageId });
    if (!t.ok) throw new HttpError(t.status >= 400 && t.status < 600 ? t.status : 502, `Could not add to combat: ${t.text.slice(0, 200)}`);
    return { ...JSON.parse(t.text), initiative, hp: sb.hp, ac: sb.ac };
  }

  return r;
}

const COMBAT_NOTE = 'Combat ids come from get_combat.';
const feature: Feature = {
  id: 'agent',
  schema: SCHEMA,
  migrate(db) {
    // The combat tracker keeps each creature's armor class and the statblock page it came from (DM view only).
    const cols = (db.prepare('PRAGMA table_info(combatants)').all() as any[]).map((c) => c.name);
    if (!cols.includes('ac')) db.exec('ALTER TABLE combatants ADD COLUMN ac INTEGER');
    if (!cols.includes('statblock_page')) db.exec('ALTER TABLE combatants ADD COLUMN statblock_page TEXT');
  },
  settings: {
    agentAutoApprove: {
      type: 'json', default: [],
      validate: (v) => { if (!Array.isArray(v) || v.length > 60 || v.some((x) => typeof x !== 'string' || x.length > 60)) throw new Error('agentAutoApprove must be a list of tool names'); },
    },
    agentPlayerChat: { type: 'boolean', default: true },
  },
  worldMount: 'agent',
  worldRoutes: routes,
  mcpTools: [
    { name: 'get_combat', description: `Combat now: whether it is active, the round, whose turn it is, and each creature's initiative, HP and conditions, as you may see them. ${COMBAT_NOTE}`, props: {}, call: () => ({ method: 'GET', path: '/live/combat' }) },
    {
      name: 'add_combatant', write: true,
      description: 'DM: add a creature to the combat tracker in initiative order. Give hp (and ac) or a statblock object (from make_statblock); without an initiative one is rolled (d20 plus Dexterity) when a statblock is given.',
      props: {
        name: S('Name, e.g. Goblin Boss'), initiative: { type: 'integer', description: 'Initiative total' }, hp: { type: 'integer' }, maxHp: { type: 'integer' }, ac: { type: 'integer', description: 'Armor class' },
        hidden: { type: 'boolean', description: 'Hide from players' }, effects: { type: 'array', items: { type: 'string' } },
        statblockPage: S('Library page id of the saved statblock'), statblock: { type: 'object', description: 'A statblock with hp, ac and abilities' },
      },
      required: ['name'],
      call: (a) => {
        const sb = a.statblock && typeof a.statblock === 'object' ? a.statblock : null;
        const hp = a.hp ?? sb?.hp;
        const dex = sb?.abilities?.dex;
        const initiative = a.initiative ?? (typeof dex === 'number' ? Math.max(-20, Math.min(60, 1 + Math.floor(Math.random() * 20) + mod(dex))) : undefined);
        return { method: 'POST', path: '/live/combatants', body: { name: a.name, initiative, hp, maxHp: a.maxHp ?? hp, ac: a.ac ?? sb?.ac, hidden: a.hidden, effects: a.effects, statblockPage: a.statblockPage } };
      },
    },
    { name: 'damage_combatant', write: true, description: `DM: deal damage to a combatant. ${COMBAT_NOTE}`, props: { combatant: S('Combatant id'), amount: { type: 'integer', description: 'Damage, 0 or more' } }, required: ['combatant', 'amount'], call: (a) => ({ method: 'PATCH', path: `/live/combatants/${enc(a.combatant)}`, body: { damage: a.amount } }) },
    { name: 'heal_combatant', write: true, description: `DM: heal a combatant (not above its max HP). ${COMBAT_NOTE}`, props: { combatant: S('Combatant id'), amount: { type: 'integer', description: 'Healing, 0 or more' } }, required: ['combatant', 'amount'], call: (a) => ({ method: 'PATCH', path: `/live/combatants/${enc(a.combatant)}`, body: { heal: a.amount } }) },
    { name: 'set_conditions', write: true, description: `DM: replace a combatant's conditions (e.g. Prone, Poisoned). Send the full list; an empty list clears them. ${COMBAT_NOTE}`, props: { combatant: S('Combatant id'), conditions: { type: 'array', items: { type: 'string' } } }, required: ['combatant', 'conditions'], call: (a) => ({ method: 'PATCH', path: `/live/combatants/${enc(a.combatant)}`, body: { effects: a.conditions } }) },
    { name: 'next_turn', write: true, description: 'DM: end the current turn and move to the next combatant (starts combat if it is not active).', props: {}, call: () => ({ method: 'POST', path: '/live/combat/next' }) },
    {
      name: 'search_transcript',
      description: "Lines of the live session transcript (the latest session unless one is given), optionally only those containing all the words in q. A DM also gets DM-only lines; a player gets only the players' transcript. Cite lines by speaker and text.",
      props: { query: S('Words that must all appear (optional)'), session: S('Session id (default: the latest)'), limit: { type: 'integer' } },
      call: (a) => ({ method: 'GET', path: `/agent/transcript?q=${enc(a.query ?? '')}&session=${enc(a.session ?? '')}&limit=${enc(String(a.limit ?? 30))}` }),
    },
    {
      name: 'make_statblock', write: true,
      description: 'DM: build a statblock and save it as a DM-only page in the Statblocks folder. Give one of: moduleTermId (copy a game-module monster, e.g. dnd-2024:monster-goblin-warrior), pageId (a library page about the creature) or prompt (describe it). addToCombat puts it in initiative with its HP and AC.',
      props: { prompt: S('What the creature is'), pageId: S('Library page id'), moduleTermId: S('Module term id'), addToCombat: { type: 'boolean' }, initiative: { type: 'integer' }, name: S('Name in combat, if different') },
      call: (a) => ({ method: 'POST', path: '/agent/statblock', body: { prompt: a.prompt, pageId: a.pageId, moduleTermId: a.moduleTermId, addToCombat: a.addToCombat, initiative: a.initiative, name: a.name } }),
    },
  ],
};
void describeCall; void normalizeStatblock;
export default feature;
