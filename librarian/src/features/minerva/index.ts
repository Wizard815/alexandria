// Minerva: the DM's agent and her campaign memory (docs/MINERVA.md).
// The vault is Markdown in the library under Minerva/ (vault.ts); the codex
// accretes (codex.ts); revelations feed each player's knowledge
// (revelations.ts); finished sessions become one review (after.ts). Players
// meet only the broker: everything under /minerva/me is their own journal,
// goals, knowledge and the party's pages, and never says who keeps them.
import express, { Router } from 'express';
import type { Feature } from '../types.ts';
import { hasJob } from '../../core/ai.ts';
import { CALLER_HEADER, CALLER_MODEL } from '../../core/levels.ts';
import { requireDM } from '../../core/auth.ts';
import { all, one } from '../../core/db.ts';
import { dmOnly } from '../../core/events.ts';
import { HttpError, int, oneOf, str } from '../../core/util.ts';
import { ctx, me, settings } from '../../routes/_shared.ts';
import { closeArc, conversationLog, fileSession, memoryLog, startArc } from './after.ts';
import { codexUpsert, promotionCandidates, promotionDraft, whoIs } from './codex.ts';
import { contextFor, threadsOf } from './context.ts';
import { describeMinerva, MINERVA_TOOLS } from './describe.ts';
import { applyOp, decideDraft, listDrafts, previewOp, type Op } from './ops.ts';
import { playerCapture, playerGoal, playerLog, playerShare, playerView, playerWhoIs, goalOp } from './player.ts';
import { createMystery, findMystery, listMysteries, markRevelation, rebuildKnowledge, resolvePlayer } from './revelations.ts';
import { enable, ensurePlayers, refreshHome } from './seed.ts';
import { SCHEMA, agentName, audit, listArcs, openArc, requireEnabled, setEnabled, stateOf } from './store.ts';
import { exportVault, importVault } from './transfer.ts';
import { ROOT, STATUS_PATH, STATUS_SECTIONS, listPages, players, readPage, removePage, safeRel, sectionOf, vaultLevel, writePage } from './vault.ts';

const enc = encodeURIComponent;
const S = (description: string) => ({ type: 'string', description });
const HEAT = { type: 'string', enum: ['on', 'ongoing', 'simmering', 'sleeping'], description: 'on: in play now. ongoing. simmering. sleeping.' };
const LEVEL = { type: 'string', enum: ['party', 'broker', 'dm', 'classified'] };

const bearerHeaderOk = (_req: any) => true;
void bearerHeaderOk;

const pageOut = (p: ReturnType<typeof readPage>) => (p ? { id: p.id, rel: p.rel, title: p.title, fm: p.fm, body: p.body, level: p.level, updatedAt: p.updatedAt } : null);

function routes(d: import('../../app.ts').Deps) {
  const r = Router({ mergeParams: true });
  const W = (res: any): string => ctx(res).world.id;

  // ---- the player side: their own journal, goals and knowledge -------------------------------
  const mine = Router({ mergeParams: true });
  mine.use((_req, res, next) => {
    const c = ctx(res);
    if (c.viewer.role !== 'player' || !stateOf(d.db, c.world.id).enabled) throw new HttpError(404, 'Not found');
    next();
  });
  mine.get('/', (_req, res) => res.json(playerView(d, W(res), me(res))));
  mine.get('/context', (_req, res) => res.json(playerView(d, W(res), me(res))));
  mine.get('/who', (req, res) => res.json({ matches: playerWhoIs(d, W(res), me(res), String(req.query.name ?? '')) }));
  mine.post('/journal', (req, res) => res.status(202).json(playerLog(d, W(res), me(res), { text: String(req.body?.text ?? ''), about: req.body?.about })));
  mine.post('/capture', (req, res) => res.status(202).json(playerCapture(d, W(res), me(res), { text: String(req.body?.text ?? ''), about: req.body?.about })));
  mine.post('/share', (req, res) => res.status(202).json(playerShare(d, W(res), me(res), { text: String(req.body?.text ?? '') })));
  mine.post('/goals', (req, res) => res.status(202).json(playerGoal(d, W(res), me(res), { goal: String(req.body?.goal ?? ''), heat: req.body?.heat, text: req.body?.text })));
  r.use('/me', mine);

  // ---- the DM's side ------------------------------------------------------------------------
  r.use(requireDM);
  // A model asking through the DM's token is never handed classified text: an answer that repeats any is refused whole (docs/SECURITY.md).
  r.use((req, res, next) => {
    if (String(req.headers[CALLER_HEADER] ?? '').toLowerCase() !== CALLER_MODEL) return next();
    const json = res.json.bind(res);
    const send = res.send.bind(res);
    const held = (text: string) => d.library.containsClassified(W(res), text);
    const refuse = () => { res.status(403); return json({ error: 'That answer holds classified text, which is never given to a model.' }); };
    res.json = ((b: unknown) => (held(JSON.stringify(b)) ? refuse() : json(b))) as any;
    res.send = ((b: any) => (typeof b === 'string' || Buffer.isBuffer(b) ? (held(Buffer.isBuffer(b) ? b.toString('utf8') : b) ? refuse() : send(b)) : send(b))) as any;
    next();
  });

  /** One call for the Minerva page: status, arc, threads, review queue, promotions, revelations, players. */
  r.get('/', (_req, res) => {
    const w = W(res);
    const st = stateOf(d.db, w);
    const base = { enabled: st.enabled, name: agentName(d, w), model: hasJob(d, 'chat'), root: ROOT };
    if (!st.enabled) return res.json(base);
    ensurePlayers(d, w, me(res));
    const status = readPage(d, w, STATUS_PATH);
    const ps = players(d, w);
    res.json({
      ...base,
      status: pageOut(status),
      sections: status ? STATUS_SECTIONS.map((s) => ({ title: s, text: sectionOf(status.body, s)?.text ?? '' })) : [],
      arc: openArc(d.db, w), arcs: listArcs(d.db, w),
      threads: threadsOf(d, w),
      pending: one<any>(d.db, `SELECT COUNT(*) AS n FROM minerva_drafts WHERE world_id = ? AND status = 'pending'`, w)?.n ?? 0,
      promotions: promotionCandidates(d, w),
      mysteries: listMysteries(d, w),
      players: ps.map((p) => ({
        accountId: p.accountId, name: p.name, character: p.character,
        goals: listPages(d, w, `players/${p.accountId}/goals/`).map((g) => ({ rel: g.rel, title: g.title, heat: String(g.fm.heat ?? 'ongoing') })),
        journal: listPages(d, w, `players/${p.accountId}/journal/`).length,
        knowledge: readPage(d, w, `players/${p.accountId}/knowledge.md`)?.body ?? '',
        notes: readPage(d, w, `dm/players/${p.accountId}.md`)?.body ?? '',
        shared: readPage(d, w, `players/${p.accountId}/shared.md`)?.body ?? '',
      })),
    });
  });

  r.post('/enable', (req, res) => {
    const w = W(res);
    if (req.body?.enabled === false) { setEnabled(d.db, w, false); audit(d, w, me(res), 'minerva.disable'); return res.json({ enabled: false }); }
    enable(d, w, me(res));
    res.status(201).json({ enabled: true, name: agentName(d, w) });
  });

  // ---- pages ----
  r.get('/pages', (req, res) => res.json({ pages: listPages(d, W(res), String(req.query.prefix ?? '')).map((p) => ({ rel: p.rel, title: p.title, type: p.fm.type, level: p.level, heat: p.fm.heat, updatedAt: p.updatedAt })) }));
  r.get('/page', (req, res) => { const p = readPage(d, W(res), String(req.query.rel ?? '')); if (!p) throw new HttpError(404, 'No such page'); res.json(pageOut(p)); });
  r.put('/page', (req, res) => {
    requireEnabled(d.db, W(res));
    const rel = safeRel(String(req.body?.rel ?? ''));
    const fm: Record<string, any> = {};
    if (req.body?.level !== undefined) fm.level = oneOf(req.body.level, 'level', ['party', 'broker', 'dm', 'classified'] as const);
    if (rel.startsWith('dm/') && fm.level === 'party') throw new HttpError(400, 'Pages in dm/ are never opened to players');
    if (req.body?.heat !== undefined) fm.heat = oneOf(req.body.heat, 'heat', ['on', 'ongoing', 'simmering', 'sleeping'] as const);
    const body = req.body?.body === undefined ? undefined : str(req.body.body, 'body', { max: 200_000 });
    const p = writePage(d, W(res), rel, { title: req.body?.title ? str(req.body.title, 'title', { max: 200 }) : undefined, fm, body, by: me(res) });
    refreshHome(d, W(res), me(res));
    res.json(pageOut(p));
  });
  r.delete('/page', (req, res) => { removePage(d, W(res), String(req.query.rel ?? '')); audit(d, W(res), me(res), 'minerva.delete_page', String(req.query.rel ?? '')); res.json({ ok: true }); });

  // ---- review queue ----
  r.get('/review', (_req, res) => {
    const w = W(res);
    const drafts = listDrafts(d, w, 'pending').map((x) => ({ ...x, preview: (() => { try { return previewOp(d, w, x.op); } catch { return null; } })() }));
    const actions = all<any>(d.db, `SELECT id, tool, summary, created_at FROM agent_actions WHERE world_id = ? AND status = 'pending' AND tool IN (${MINERVA_TOOLS.map(() => '?').join(',')}) ORDER BY created_at`, w, ...MINERVA_TOOLS)
      .map((a) => ({ id: a.id, tool: a.tool, summary: a.summary, createdAt: a.created_at }));
    const done = listDrafts(d, w, null).filter((x) => x.status !== 'pending').slice(-20).reverse();
    res.json({ drafts, actions, recent: done.map((x) => ({ id: x.id, title: x.title, kind: x.kind, status: x.status, note: x.note, decidedAt: x.decidedAt })) });
  });
  r.post('/review/approve-all', (req, res) => {
    const w = W(res);
    const review = typeof req.body?.review === 'string' ? req.body.review : null;
    const out = { approved: 0, failed: 0 };
    for (const x of listDrafts(d, w, 'pending')) {
      if (review && x.review !== review) continue;
      try { decideDraft(d, w, x.id, 'approve', me(res)); out.approved++; } catch { out.failed++; }
    }
    refreshHome(d, w, me(res));
    res.json(out);
  });
  r.post('/review/:id', (req, res) => {
    const w = W(res);
    const decision = oneOf(req.body?.decision, 'decision', ['approve', 'reject'] as const);
    const out = decideDraft(d, w, String(req.params.id), decision, me(res), { text: req.body?.text, body: req.body?.body });
    refreshHome(d, w, me(res));
    res.json(out);
  });

  // ---- arcs and sessions ----
  r.get('/arcs', (_req, res) => res.json({ arcs: listArcs(d.db, W(res)), open: openArc(d.db, W(res)) }));
  r.post('/arcs', (req, res) => res.status(201).json(startArc(d, W(res), String(req.body?.title ?? ''), me(res))));
  r.post('/arcs/:id/close', async (req, res) => res.json(await closeArc(d, W(res), String(req.params.id), me(res))));
  r.post('/sessions/:entry/file', async (req, res) => res.json(await fileSession(d, W(res), String(req.params.entry), me(res))));

  // ---- codex ----
  r.get('/who', (req, res) => res.json({ matches: whoIs(d, W(res), String(req.query.name ?? '')) }));
  r.get('/context', (req, res) => { requireEnabled(d.db, W(res)); res.json(contextFor(d, W(res), String(req.query.who ?? ''))); });
  r.get('/promotions', (_req, res) => res.json({ candidates: promotionCandidates(d, W(res)) }));
  r.post('/codex', (req, res) => {
    requireEnabled(d.db, W(res));
    const b = req.body ?? {};
    res.json(codexUpsert(d, W(res), { entity: b.entity, name: b.name, kind: b.kind, section: String(b.section ?? 'notes'), text: String(b.text ?? ''), session: b.session ?? null, by: me(res), level: b.level }));
  });
  r.post('/promote', (req, res) => {
    const w = W(res);
    requireEnabled(d.db, w);
    const p = promotionDraft(d, w, str(req.body?.name, 'name', { max: 120 }), req.body?.kind);
    const out = applyOp(d, w, { op: 'create', ...p }, me(res));
    refreshHome(d, w, me(res));
    res.status(201).json({ rel: out.rel, title: p.title });
  });

  // ---- revelations ----
  r.get('/revelations', (_req, res) => res.json({ mysteries: listMysteries(d, W(res)) }));
  r.post('/revelations', (req, res) => {
    requireEnabled(d.db, W(res));
    const b = req.body ?? {};
    res.status(201).json(createMystery(d, W(res), { title: String(b.title ?? ''), conclusion: String(b.conclusion ?? ''), clues: Array.isArray(b.clues) ? b.clues : [], by: me(res) }));
  });
  r.post('/revelations/mark', (req, res) => {
    requireEnabled(d.db, W(res));
    const b = req.body ?? {};
    const out = markRevelation(d, W(res), { mystery: String(b.mystery ?? ''), clue: b.clue, player: String(b.player ?? ''), session: b.session === undefined ? null : int(b.session, 'session', { min: 1, max: 100000 }), kind: b.kind, text: b.text, by: me(res) });
    d.hub.emit(W(res), 'minerva', { kind: 'revelation' }, dmOnly);
    res.json(out);
  });
  r.get('/revelations/:slug', (req, res) => res.json(findMystery(d, W(res), String(req.params.slug))));

  // ---- the tools' own routes (the DM's agent runs them with the DM's token) ----
  r.post('/memory/log', (req, res) => res.json(memoryLog(d, W(res), { text: String(req.body?.text ?? ''), about: req.body?.about, session: req.body?.session }, me(res))));
  r.post('/memory/capture', (req, res) => {
    const w = W(res);
    requireEnabled(d.db, w);
    const text = str(req.body?.text, 'text', { max: 2000 }).trim();
    if (!text) throw new HttpError(400, 'text is required');
    const about = String(req.body?.about ?? '').trim();
    const line = `- ${new Date().toISOString().slice(0, 10)}: ${text}`;
    const pl = about ? whoIs(d, w, about, { partial: false }).find((m) => m.type === 'player') : null;
    const op: Op = pl?.accountId
      ? { op: 'section', rel: `dm/players/${pl.accountId}.md`, section: 'Table notes', mode: 'append', text: line }
      : { op: 'section', rel: STATUS_PATH, section: 'Inbox', mode: 'append', text: about ? `${line} (about ${about.slice(0, 80)})` : line };
    res.json(applyOp(d, w, op, me(res)));
  });
  r.post('/conversation', (req, res) => res.json(conversationLog(d, W(res), { lines: Array.isArray(req.body?.lines) ? req.body.lines : [], session: req.body?.session }, me(res))));
  r.post('/status/update', (req, res) => {
    const w = W(res);
    requireEnabled(d.db, w);
    const section = String(req.body?.section ?? '').trim();
    const known = [...STATUS_SECTIONS, 'Inbox'].find((s) => s.toLowerCase() === section.toLowerCase());
    if (!known) throw new HttpError(400, `section must be one of ${[...STATUS_SECTIONS, 'Inbox'].join(', ')}`);
    const text = str(req.body?.text, 'text', { max: 20_000 });
    const out = applyOp(d, w, { op: 'section', rel: STATUS_PATH, section: known, text, mode: req.body?.mode === 'append' ? 'append' : 'replace' }, me(res));
    refreshHome(d, w, me(res));
    res.json(out);
  });
  r.post('/goal', (req, res) => {
    const w = W(res);
    requireEnabled(d.db, w);
    const p = resolvePlayer(d, w, String(req.body?.player ?? ''));
    const rel = `players/${p.accountId}/goals/`;
    const exists = !!readPage(d, w, `${rel}${String(req.body?.goal ?? '').trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 80)}.md`);
    res.json(applyOp(d, w, goalOp(p.accountId, { goal: String(req.body?.goal ?? ''), heat: req.body?.heat, text: req.body?.text }, exists), me(res)));
  });
  r.post('/knowledge/rebuild', (req, res) => { const p = resolvePlayer(d, W(res), String(req.body?.player ?? '')); rebuildKnowledge(d, W(res), p.accountId, me(res)); res.json({ ok: true }); });

  // ---- Obsidian ----
  r.get('/export', (_req, res) => {
    requireEnabled(d.db, W(res));
    audit(d, W(res), me(res), 'minerva.export');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="vault.zip"');
    res.send(exportVault(d, W(res)));
  });
  r.post('/import', express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '24mb' }), (req, res) => {
    requireEnabled(d.db, W(res));
    const rep = importVault(d, W(res), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), me(res));
    refreshHome(d, W(res), me(res));
    res.json(rep);
  });

  void settings; void vaultLevel;
  return r;
}

const feature: Feature = {
  id: 'minerva',
  schema: SCHEMA,
  settings: {
    // What the DM calls the assistant. Only the DM side ever sees or uses it.
    agentName: { type: 'string', default: 'Minerva', max: 60 },
  },
  worldMount: 'minerva',
  worldRoutes: routes,
  appRoutes: (_app, d) => {
    // A published session log is filed under the open arc and reviewed (docs/MINERVA.md §8).
    d.hub.tap((worldId, type, data: any) => {
      if (type !== 'sessionlog' || data?.action !== 'published' || !data?.entry?.id) return;
      try { if (!stateOf(d.db, worldId).enabled) return; } catch { return; }
      void fileSession(d, worldId, String(data.entry.id), null).catch((e) => console.error('minerva: filing a session failed', e));
    });
  },
  mcpTools: [
    // DM harness (Minerva).
    { name: 'context_for', dmOnly: true, description: "Minerva's memory: everything she knows about a player, an NPC, a place, a mystery or an arc (who). With no name: the campaign status, the active arc and the last session. Read this before answering about long-term threads.", props: { who: S('A player, character, NPC, place, mystery or arc (optional)') }, call: (a) => ({ method: 'GET', path: `/minerva/context?who=${enc(a.who ?? '')}` }) },
    { name: 'who_is', dmOnly: true, description: 'Find who or what a name is: a codex page, a player (by name, character or mic speaker), or a library page. Use it before writing about an entity so no duplicate page is made.', props: { name: S('Name, alias, character or speaker') }, required: ['name'], call: (a) => ({ method: 'GET', path: `/minerva/who?name=${enc(a.name)}` }) },
    { name: 'memory_log', write: true, description: 'Log what just happened at the table to the session in progress (DM-only notes).', props: { text: S('What happened'), about: S('Who or what it is about (optional)') }, required: ['text'], call: (a) => ({ method: 'POST', path: '/minerva/memory/log', body: { text: a.text, about: a.about } }) },
    { name: 'memory_capture', write: true, description: "Quick capture of an idea or table note. About a player it goes to that player's notes; otherwise to the status inbox.", props: { text: S('The note'), about: S('A player, character or topic (optional)') }, required: ['text'], call: (a) => ({ method: 'POST', path: '/minerva/memory/capture', body: { text: a.text, about: a.about } }) },
    { name: 'conversation_log', write: true, description: "File a conversation by speaker: each player's lines go to their journal, the whole to the session's DM notes.", props: { lines: { type: 'array', items: { type: 'object', properties: { speaker: { type: 'string' }, text: { type: 'string' } } } }, session: { type: 'integer', description: 'Session number (default: the one in progress)' } }, required: ['lines'], call: (a) => ({ method: 'POST', path: '/minerva/conversation', body: { lines: a.lines, session: a.session } }) },
    { name: 'status_update', write: true, description: `Change one section of the Campaign Status doc (${[...STATUS_SECTIONS, 'Inbox'].join(', ')}). It is the living doc: keep it current, never replace it with an archive.`, props: { section: S('Section name'), text: S('The new text'), mode: { type: 'string', enum: ['replace', 'append'] } }, required: ['section', 'text'], call: (a) => ({ method: 'POST', path: '/minerva/status/update', body: { section: a.section, text: a.text, mode: a.mode } }) },
    { name: 'revelation_create', write: true, description: 'Start a mystery: a conclusion and at least three clues, so the players can find it more than one way. Name it as a question; players who find a clue see its name.', props: { title: S('The mystery, as a question'), conclusion: S('The truth'), clues: { type: 'array', items: { type: 'string' }, description: 'At least three clues' } }, required: ['title', 'conclusion', 'clues'], call: (a) => ({ method: 'POST', path: '/minerva/revelations', body: { title: a.title, conclusion: a.conclusion, clues: a.clues } }) },
    { name: 'revelation_mark', write: true, description: "Record who found which clue (or guessed, or reached the conclusion). The player's knowledge page is rebuilt from the marks.", props: { mystery: S('Mystery title'), clue: S('Clue number or text'), player: S('Player or character'), kind: { type: 'string', enum: ['clue', 'theory', 'reached'] }, text: S('The theory (kind theory)'), session: { type: 'integer' } }, required: ['mystery', 'player'], call: (a) => ({ method: 'POST', path: '/minerva/revelations/mark', body: { mystery: a.mystery, clue: a.clue, player: a.player, kind: a.kind, text: a.text, session: a.session } }) },
    { name: 'codex_upsert', write: true, description: 'Add to an entity\'s codex page: a dated appearance, what changed, a secret (in a DM-only block), a tie to a player or a note. The page is found by library page id, name or alias; one is made only when none exists. Call who_is first.', props: { entity: S('Library page id (optional)'), name: S('Name'), kind: { type: 'string', enum: ['npc', 'pc', 'place', 'region', 'organization', 'trade-route', 'family', 'creature', 'race', 'item', 'quest', 'map', 'topic'] }, section: S('appearances, changed, secret, ties or notes'), text: S('What to add'), session: { type: 'integer' } }, required: ['section', 'text'], call: (a) => ({ method: 'POST', path: '/minerva/codex', body: { entity: a.entity, name: a.name, kind: a.kind, section: a.section, text: a.text, session: a.session } }) },
    { name: 'promote', write: true, description: 'Give a recurring NPC, place or item its own codex page, drafted from where the sessions mention them. Link the library page, never copy it.', props: { name: S('Name'), kind: S('npc, place, organization, ...') }, required: ['name'], call: (a) => ({ method: 'POST', path: '/minerva/promote', body: { name: a.name, kind: a.kind } }) },
    { name: 'arc_start', write: true, description: 'Start a new arc (about 8 to 12 sessions). Sessions are filed under the open arc.', props: { title: S('Arc title') }, required: ['title'], call: (a) => ({ method: 'POST', path: '/minerva/arcs', body: { title: a.title } }) },
    { name: 'arc_close', write: true, description: "Close an arc and draft its one-page summary for the DM's review.", props: { arc: S('Arc number, slug or title (default: the open arc)') }, call: (a) => ({ method: 'POST', path: `/minerva/arcs/${enc(String(a.arc ?? 'open'))}/close` }) },
    { name: 'goal_update', write: true, description: "Set a player character's goal: its heat (on, ongoing, simmering, sleeping) and a dated note.", props: { player: S('Player or character'), goal: S('The goal'), heat: HEAT, text: S('Note') }, required: ['player', 'goal'], call: (a) => ({ method: 'POST', path: '/minerva/goal', body: { player: a.player, goal: a.goal, heat: a.heat, text: a.text } }) },
    // Player harness (the broker): only the caller's own notes.
    { name: 'my_context', playerOnly: true, description: "This player's own journal, goals, knowledge and bonds, and what the whole party knows.", props: {}, call: () => ({ method: 'GET', path: '/minerva/me/context' }) },
    { name: 'my_who_is', playerOnly: true, description: 'Find a player character or something the whole party knows, by name.', props: { name: S('Name') }, required: ['name'], call: (a) => ({ method: 'GET', path: `/minerva/me/who?name=${enc(a.name)}` }) },
    { name: 'my_memory_log', playerOnly: true, description: "Add a line to this player's journal for the session. It waits for the DM to approve it.", props: { text: S('What to write down'), about: S('Who or what it is about (optional)') }, required: ['text'], call: (a) => ({ method: 'POST', path: '/minerva/me/journal', body: { text: a.text, about: a.about } }) },
    { name: 'my_memory_capture', playerOnly: true, description: "Quick note into this player's own notes. It waits for the DM to approve it.", props: { text: S('The note'), about: S('About (optional)') }, required: ['text'], call: (a) => ({ method: 'POST', path: '/minerva/me/capture', body: { text: a.text, about: a.about } }) },
    { name: 'my_goal_update', playerOnly: true, description: "Update one of this player's own goals: its heat and a note. It waits for the DM to approve it.", props: { goal: S('The goal'), heat: HEAT, text: S('Note') }, required: ['goal'], call: (a) => ({ method: 'POST', path: '/minerva/me/goals', body: { goal: a.goal, heat: a.heat, text: a.text } }) },
  ],
};

void describeMinerva;
export default feature;
