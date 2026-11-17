// /api/worlds/:world/source-keys (see index.ts for the list).
import { Router } from 'express';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { all, one } from '../../core/db.ts';
import { featureSetting } from '../../core/policy.ts';
import { HttpError, int, oneOf, str } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, names, settings } from '../../routes/_shared.ts';
import { dmView, escalate, gatherContext, judge, answer, price, refuse, playerView, effectiveStatus, type EscRow } from './escalation.ts';
import { canFeedLibrary, dropAccess, refreshAccess, waitMs } from './access.ts';
import { keyConnector, KeyRefused, probeKey, verifyKey, type SourceRow } from './live.ts';
import { lookup } from './lookup.ts';
import { TRUSTS, auditKey, cleanUses, getKey, insertKey, keyView, normTrust, revokeKey, usesOf, usersOf, worldKeys, type KeyRow } from './store.ts';

/** A short in-memory limit for the calls that reach out to a source. */
const hits = new Map<string, number[]>();
function limit(key: string, max: number, windowMs: number, what: string) {
  const t = Date.now();
  const mine = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  if (mine.length >= max) throw new HttpError(429, `Too many ${what}. Wait a little.`);
  mine.push(t);
  hits.set(key, mine);
}

export function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const W = (res: any): string => ctx(res).world.id;
  const needMember = (res: any) => { if (ctx(res).viewer.role === 'guest') throw new HttpError(403, 'Not available to guests'); };

  /** Sources of this world that can be read with a person's own key. */
  const keySources = (worldId: string) => all<SourceRow>(d.db, 'SELECT * FROM sources WHERE world_id = ? AND enabled = 1 ORDER BY name', worldId).filter((s) => { try { keyConnector(d, s); return true; } catch { return false; } });

  r.get('/', (_req, res) => {
    needMember(res);
    const w = W(res);
    const nm = names(d.db, w);
    const dm = isDM(res);
    const rows = dm ? worldKeys(d.db, w) : worldKeys(d.db, w).filter((k) => k.owner_id === me(res) && !k.revoked);
    res.json({
      keys: rows.map((k) => keyView(d.db, k, nm, { dm })),
      sources: keySources(w).map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      canAdd: dm || featureSetting<boolean>(settings(res), 'sourceKeysPlayers') !== false,
      members: dm ? memberIds(d.db, w, ['dm', 'player']).map((id) => ({ id, name: nm[id] ?? 'Someone' })) : undefined,
      refreshEveryMinutes: 5,
    });
  });

  r.post('/', async (req, res) => {
    needMember(res);
    const w = W(res);
    const dm = isDM(res);
    if (!dm && featureSetting<boolean>(settings(res), 'sourceKeysPlayers') === false) throw new HttpError(403, 'The DM has not opened source keys to players in this world');
    limit(`add:${me(res)}`, 10, 60_000, 'tries to add a key');
    const src = one<SourceRow>(d.db, 'SELECT * FROM sources WHERE id = ? AND world_id = ?', str(req.body?.sourceId, 'sourceId', { max: 60 }), w);
    if (!src) throw new HttpError(404, 'Source not found in this world');
    try { keyConnector(d, src); } catch (e: any) { throw new HttpError(400, e.message); }
    const secret = str(req.body?.secret, 'secret', { max: 2000 }).trim();
    if (secret.length < 8) throw new HttpError(400, 'That key is too short to be one');
    const label = str(req.body?.label, 'label', { max: 80, optional: true }).trim();
    const claimed = normTrust(req.body?.trust);
    let users = [me(res)];
    let uses = cleanUses(req.body?.uses ?? ['library', 'agent']).filter((u) => dm || u !== 'broker');
    let trust = claimed === 'blanket' ? 'blanket' : 'unsure';
    if (dm) {
      // The DM chooses who may use the key, what for, and its trust.
      if (req.body?.users !== undefined) {
        const members = new Set(memberIds(d.db, w, ['dm', 'player']));
        if (!Array.isArray(req.body.users) || req.body.users.some((u: unknown) => typeof u !== 'string' || !members.has(u))) throw new HttpError(400, 'users must be members of this world (the DM or a player)');
        users = [...new Set<string>(req.body.users)];
      }
      if (req.body?.uses === undefined) uses = ['agent'];
      trust = oneOf(req.body?.trust, 'trust', TRUSTS, 'unsure');
    }
    if (!uses.length) throw new HttpError(400, 'Pick at least one use: library, agent or broker');
    // The key must belong to this world before it is saved: nothing is stored for one that does not.
    const v = await verifyKey(d, src, secret);
    if (!v.ok) { auditKey(d.db, w, me(res), 'refused', `${src.id} ${v.reason}`); throw new HttpError(400, v.reason); }
    const probe = await probeKey(d, src, secret);
    const k = insertKey(d.db, { worldId: w, sourceId: src.id, ownerId: me(res), label: label || `${src.name} key`, secret, trust: trust as any, claimed, users, uses, verified: true, probe });
    auditKey(d.db, w, me(res), 'add', `${k.id} source ${src.id} trust ${k.trust} uses ${uses.join(',')}`);
    d.hub.emit(w, 'sourcekeys', { kind: 'key', id: k.id }, (viewer) => viewer.role === 'dm' || viewer.accountId === me(res));
    res.status(201).json({ ...keyView(d.db, k, names(d.db, w), { dm }), verifyNote: v.reason });
  });

  // ---- lookups and escalations (before /:id) -----------------------------------------------------

  r.get('/lookup', async (req, res) => {
    needMember(res);
    res.json(await lookup(d, { worldId: W(res), accountId: me(res), role: ctx(res).viewer.role, q: str(req.query.q, 'q', { max: 200 }), question: typeof req.query.question === 'string' ? req.query.question.slice(0, 500) : undefined, ai: ctx(res).viewer.audience === 'ai' }));
  });

  r.get('/escalations', (_req, res) => {
    needMember(res);
    const w = W(res);
    const nm = names(d.db, w);
    if (isDM(res)) {
      const rows = all<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE world_id = ? ORDER BY created_at DESC LIMIT 200', w);
      return res.json({ escalations: rows.map((e) => dmView(d, e, nm)), mode: settings(res) && featureSetting<string>(settings(res), 'escalation') });
    }
    const rows = all<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE world_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 100', w, me(res));
    res.json({ escalations: rows.map((e) => playerView(d, e)) });
  });

  // A player asks for something beyond their own view. The audit model decides whether it can be answered at all; unsure escalates.
  r.post('/escalations', async (req, res) => {
    if (ctx(res).viewer.role !== 'player') throw new HttpError(403, 'Only players ask the broker for more than their own view');
    const w = W(res);
    limit(`esc:${me(res)}`, 10, 60_000, 'questions');
    const question = str(req.body?.question, 'question', { max: 500 }).trim();
    const verdict = await judge(d, w, me(res), question);
    if (!verdict.escalate) return res.json({ escalated: false, refused: verdict.refuse, message: verdict.message });
    const context = await gatherContext(d, w, me(res), question);
    const e = escalate(d, { worldId: w, accountId: me(res), question, origin: 'direct', hidden: { reason: `Asked directly. ${verdict.labels.why}`, routing: verdict.labels, items: context } });
    res.status(201).json({ escalated: true, message: verdict.message, escalation: playerView(d, e) });
  });

  const esc = (res: any, eid: string): EscRow => {
    const e = one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ? AND world_id = ?', eid, W(res));
    if (!e) throw new HttpError(404, 'Question not found');
    return e;
  };
  const shown = (res: any, e: EscRow) => dmView(d, one<EscRow>(d.db, 'SELECT * FROM sourcekeys_escalations WHERE id = ?', e.id)!, names(d.db, W(res)));
  r.post('/escalations/:eid/answer', requireDM, (req, res) => {
    const e = esc(res, String(req.params.eid));
    res.json(shown(res, answer(d, W(res), e.id, str(req.body?.answer, 'answer', { max: 10_000 }), me(res))));
  });
  r.post('/escalations/:eid/price', requireDM, (req, res) => {
    const e = esc(res, String(req.params.eid));
    const sessions = int(req.body?.sessions, 'sessions', { min: 0, max: 50, optional: true }) ?? Number(featureSetting<number>(settings(res), 'escalationSessions') ?? 2);
    res.json(shown(res, price(d, W(res), e.id, { costCp: int(req.body?.costCp, 'costCp', { min: 0, max: 100_000_000 })!, sessions, answer: str(req.body?.answer, 'answer', { max: 10_000 }), note: str(req.body?.note, 'note', { max: 300, optional: true }) }, me(res))));
  });
  r.post('/escalations/:eid/refuse', requireDM, (req, res) => {
    const e = esc(res, String(req.params.eid));
    res.json(shown(res, refuse(d, W(res), e.id, str(req.body?.note, 'note', { max: 300, optional: true }), me(res))));
  });

  // ---- one key ------------------------------------------------------------------------------------

  /** The DM may act on any key of this world; a player only on their own (anything else is "not found"). */
  const keyOf = (res: any, kid: string, ownOnly: boolean): KeyRow => {
    const k = getKey(d.db, W(res), kid);
    if (!k || (ownOnly && !isDM(res) && k.owner_id !== me(res))) throw new HttpError(404, 'Key not found');
    return k;
  };

  r.patch('/:id', requireDM, (req, res) => {
    const w = W(res);
    const k = keyOf(res, String(req.params.id), false);
    if (k.revoked) throw new HttpError(409, 'That key is revoked');
    const b = req.body ?? {};
    const was = { trust: k.trust, users: usersOf(k).join(','), uses: usesOf(k).join(',') };
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.label !== undefined) { sets.push('label = ?'); vals.push(str(b.label, 'label', { max: 80, optional: true }).trim()); }
    if (b.trust !== undefined) { sets.push('trust = ?'); vals.push(oneOf(b.trust, 'trust', TRUSTS)); }
    if (b.users !== undefined) {
      const members = new Set(memberIds(d.db, w, ['dm', 'player']));
      if (!Array.isArray(b.users) || b.users.some((u: unknown) => typeof u !== 'string' || !members.has(u))) throw new HttpError(400, 'users must be members of this world (the DM or a player)');
      sets.push('users = ?'); vals.push(JSON.stringify([...new Set<string>(b.users)]));
    }
    if (b.uses !== undefined) {
      const uses = cleanUses(b.uses);
      if (!Array.isArray(b.uses) || !uses.length) throw new HttpError(400, 'uses must list library, agent and/or broker');
      sets.push('uses = ?'); vals.push(JSON.stringify(uses));
    }
    if (sets.length) d.db.prepare(`UPDATE sourcekeys_keys SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]), k.id);
    const next = getKey(d.db, w, k.id)!;
    // What a key may feed is read live, so the view follows at once; a key that no longer feeds the library view forgets what it saw.
    if (!canFeedLibrary(next)) dropAccess(d, k.id);
    auditKey(d.db, w, me(res), 'update', `${k.id} trust ${was.trust}->${next.trust} users ${was.users || '-'}->${usersOf(next).join(',') || '-'} uses ${was.uses || '-'}->${usesOf(next).join(',') || '-'}`);
    d.library.touchClassified();
    res.json(keyView(d.db, next, names(d.db, w), { dm: true }));
  });

  r.delete('/:id', (req, res) => {
    needMember(res);
    const w = W(res);
    const k = keyOf(res, String(req.params.id), true);
    if (!k.revoked) { revokeKey(d.db, k, me(res)); auditKey(d.db, w, me(res), 'revoke', `${k.id} owner ${k.owner_id}`); }
    res.json({ ok: true });
  });

  r.post('/:id/probe', requireDM, async (req, res) => {
    const w = W(res);
    const k = keyOf(res, String(req.params.id), false);
    if (k.revoked) throw new HttpError(409, 'That key is revoked');
    const src = one<SourceRow>(d.db, 'SELECT * FROM sources WHERE id = ?', k.source_id);
    if (!src) throw new HttpError(404, 'The source is gone');
    const probe = await probeKey(d, src, k.secret);
    d.db.prepare('UPDATE sourcekeys_keys SET probe = ? WHERE id = ?').run(JSON.stringify(probe), k.id);
    auditKey(d.db, w, me(res), 'probe', `${k.id} ${probe.verdict}`);
    res.json(keyView(d.db, getKey(d.db, w, k.id)!, names(d.db, w), { dm: true }));
  });

  // "Refresh my view": read what this key can see (rate limited; the DM may force it).
  r.post('/:id/refresh', async (req, res) => {
    needMember(res);
    const w = W(res);
    const k = keyOf(res, String(req.params.id), true);
    if (!isDM(res)) limit(`refresh:${me(res)}`, 6, 60_000, 'refreshes');
    const out = await refreshAccess(d, k, me(res), { force: isDM(res) });
    const fresh = getKey(d.db, w, k.id)!;
    res.status(out.ok ? 200 : out.status).json({ ...out, waitMinutes: Math.ceil(waitMs(fresh) / 60_000), key: keyView(d.db, fresh, names(d.db, w), { dm: isDM(res) }) });
  });

  void effectiveStatus;
  void KeyRefused;
  return r;
}
