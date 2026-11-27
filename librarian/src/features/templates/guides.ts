// Guides in the DM's assistant. When a request matches a guide (its triggers, or "use guide X"), the harness calls
// applyGuides before the first model call: the guide's steps that only read (the library, neighbouring places, the
// exemplar pages) run here, the web step becomes a web_research call (a card for the DM unless Auto is on), and what
// they found rides in the model's context with the guide itself. The chat shows "Using guide: <name>" and each step.
// Everything is read as the assistant may read it (the AI copy: never classified text).
import type { Deps } from '../../app.ts';
import { wouldBeRefused } from '../../core/ai.ts';
import { all, one } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { parseJson } from '../../core/util.ts';
import { fillQuery, matchGuides, nameIn, nearIn, referenceIn } from './match.ts';
import { guideText, KIND_LABEL, type Step, type StepKind } from './spec.ts';
import { listTemplates, webConfig, type Template } from './store.ts';
import { blockedQuery, blockedText, type WebResult } from './web.ts';

export interface GuideStepNote { kind: StepKind; label: string; status: 'done' | 'waiting' | 'skipped' | 'blocked'; detail?: string }
export interface GuideNote { id: string; name: string; version: number; why: 'named' | 'trigger'; hits: string[]; steps: GuideStepNote[] }
export interface GuideCite { kind: 'page' | 'web'; id: string; title: string; path?: string; snippet?: string }
export interface Applied { context: string; notes: GuideNote[]; cites: GuideCite[] }
export interface ExecResult { content: string; proposed?: string; ran?: { ok: boolean; status: number } }
export interface GuideRun { worldId: string; viewer: Viewer; chatId: string; text: string; exec: (tool: string, args: any) => Promise<ExecResult> }

const STOP = new Set('a an the and or of to in on at for with from by about is are was be it its this that make create write draft new build design prep prepare called named based near some me my our please town village city'.split(' '));
const termsOf = (text: string) => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []).filter((w) => !STOP.has(w)))].slice(0, 8);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const outline = (body: string) => [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim()).join(' | ');

/** Pages that look like this guide's kind of thing (its folder, or tagged with a trigger word), as the AI may list them. */
function samePages(d: Deps, g: Template, ai: Viewer, max: number): { id: string; title: string; path: string }[] {
  const folder = String((g.spec as any).folder ?? '').toLowerCase();
  const trig = new Set(g.triggers.map((t) => t.toLowerCase()));
  try {
    return (d.library.list(g.worldId, ai) as any[])
      .filter((p) => (folder && String(p.path).toLowerCase().startsWith(`${folder}/`)) || (Array.isArray(p.tags) && p.tags.some((t: string) => trig.has(String(t).toLowerCase()))) || (p.kind && trig.has(String(p.kind).toLowerCase())))
      .filter((p) => !String(p.path).startsWith('Minerva/'))
      .slice(0, max).map((p) => ({ id: p.id, title: p.title, path: p.path }));
  } catch { return []; }
}

const pageByTitle = (d: Deps, worldId: string, title: string): string | null =>
  one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND title = ? COLLATE NOCASE', worldId, title)?.id ?? null;

/**
 * A web search for this guide in this chat in the last half hour (waiting or done), so a follow-up does not ask again:
 * the same words, or (`query` empty: a follow-up such as "continue") any search for the guide.
 */
function earlierSearch(d: Deps, chatId: string, guideId: string, query: string): { status: string; result: string | null } | null {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  for (const a of all<any>(d.db, `SELECT status, args, result FROM agent_actions WHERE chat_id = ? AND tool = 'web_research' AND created_at > ? ORDER BY created_at DESC`, chatId, since)) {
    const args = parseJson<any>(a.args, {});
    if (args?.guide !== guideId || !['pending', 'running', 'done'].includes(a.status)) continue;
    if (!query || (Array.isArray(args.queries) && args.queries.includes(query))) return { status: a.status, result: a.result };
  }
  return null;
}

/** "this template", "change the template", "add a step": the DM is working on the template itself. */
const ABOUT_TEMPLATE = /\b(templates?|guides?|this (?:one|spec)|add (?:a |another )?(?:step|section|place|trigger)|(?:change|edit|improve|update|rename|tweak) (?:it|this))\b/i;

/** The template a chat was started from (agent_chats.template), from the world's templates. */
function pinnedTemplate(d: Deps, chatId: string, list: Template[]): Template | null {
  let tid = '';
  try { tid = String(one<{ template: string }>(d.db, 'SELECT template FROM agent_chats WHERE id = ?', chatId)?.template ?? ''); } catch { return null; }
  if (!tid) return null;
  return list.find((t) => t.id === tid) ?? null;
}

/** Run the guides this request calls for. Null when none does. */
export async function applyGuides(d: Deps, r: GuideRun): Promise<Applied | null> {
  let list: Template[];
  try { list = listTemplates(d.db, r.worldId); } catch { return null; }
  let matched = matchGuides(r.text, list);
  // A template chat (started from one template, kept apart from the main chats) always has its template at hand:
  // asked about the template itself, the assistant gets its content to change it; asked to make something, the
  // template is followed as if the DM had named it.
  const pinned = pinnedTemplate(d, r.chatId, list);
  let about = '';
  if (pinned) {
    if (ABOUT_TEMPLATE.test(r.text)) about = `TEMPLATE CHAT: this chat is about the DM's ${KIND_LABEL[pinned.kind].toLowerCase()} "${pinned.name}" (id ${pinned.id}: change it with update_dm_template). It is now:\n${JSON.stringify({ name: pinned.name, description: pinned.description, triggers: pinned.triggers, spec: pinned.spec }).slice(0, 4000)}`;
    else if (pinned.enabled && !matched.some((m) => m.t.id === pinned.id)) matched = [{ t: pinned, why: 'named' as const, hits: [pinned.name] }, ...matched].slice(0, 2);
  }
  // Like a guide: a template that would carry classified words is never sent.
  if (about && wouldBeRefused(d, about)) about = `TEMPLATE CHAT: this chat is about one of the DM's templates, which repeats classified text, so its content is not shown here. Ask the DM to edit it on the Templates page.`;
  if (!matched.length) return about ? { context: about, notes: [], cites: [] } : null;
  const ai = { ...r.viewer, audience: 'ai' } as Viewer;
  const ctx: string[] = [];
  const notes: GuideNote[] = [];
  const cites: GuideCite[] = [];
  const cite = (c: GuideCite) => { if (!cites.some((x) => x.kind === c.kind && x.id === c.id)) cites.push(c); };
  let webDone = false;
  for (const m of matched) {
    const g = m.t;
    const note: GuideNote = { id: g.id, name: g.name, version: g.version, why: m.why, hits: m.hits, steps: [] };
    notes.push(note);
    const text = guideText(g);
    // A guide that would carry classified words is never sent (it was checked when saved; the library may have changed since).
    if (wouldBeRefused(d, text)) { note.steps.push({ kind: 'instruction', label: 'Guide not used', status: 'blocked', detail: 'It repeats classified text, which never goes to a model. Edit the guide.' }); continue; }
    const found: string[] = [];
    const steps: Step[] = g.kind === 'guide' ? (g.spec as any).steps : [];
    // A guide with no steps still reads its own exemplars.
    const plan: Step[] = steps.length ? steps : [{ kind: 'library', text: 'Search the world library.' }, { kind: 'exemplars', text: 'Read pages made the same way.' }];
    for (const st of plan) {
      try {
        if (st.kind === 'library') {
          const q = [...new Set([...nearIn(r.text), nameIn(r.text), ...termsOf(`${r.text} ${st.query ?? ''}`)].filter(Boolean))];
          const hits = new Map<string, any>();
          for (const term of q.slice(0, 6)) for (const h of d.library.search(r.worldId, term, ai, 4)) if (!hits.has(h.id) && !String(h.path).startsWith('Minerva/')) hits.set(h.id, h);
          const top = [...hits.values()].slice(0, 6);
          if (top.length) {
            found.push(`Library lore (search: ${q.slice(0, 6).join(', ')}):\n${top.map((h) => `- [${h.title}] (${h.id}): ${clip(String(h.snippet ?? '').replace(/\s+/g, ' '), 220)}`).join('\n')}`);
            for (const h of top) cite({ kind: 'page', id: h.id, title: h.title, path: h.path, snippet: clip(String(h.snippet ?? ''), 140) });
          }
          note.steps.push({ kind: 'library', label: 'Searched the world library', status: 'done', detail: top.length ? top.map((h) => h.title).join(', ') : 'nothing matched' });
        } else if (st.kind === 'neighbours') {
          const anchors = nearIn(r.text);
          const near = new Map<string, string>();
          for (const a of anchors) {
            const pid = pageByTitle(d, r.worldId, a);
            if (!pid) continue;
            try {
              const p: any = d.library.get(r.worldId, pid, ai);
              near.set(p.title, `- [${p.title}] (${p.id}): ${clip(String(p.body ?? '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim(), 260)}`);
              for (const t of Object.values<string>(p.linkTitles ?? {})) if (!near.has(t)) near.set(t, `- [${t}] (linked from ${p.title})`);
              cite({ kind: 'page', id: p.id, title: p.title, path: p.path });
            } catch { /* not readable by the assistant */ }
          }
          try {
            const anchorSet = new Set(anchors.map((a) => a.toLowerCase()));
            for (const rel of d.library.relations(r.worldId, ai) as any[]) {
              const from = String(rel.from_title), to = String(rel.to_title);
              if (anchorSet.has(from.toLowerCase()) && !near.has(to)) near.set(to, `- [${to}] (${rel.kind} of ${from})`);
              if (anchorSet.has(to.toLowerCase()) && !near.has(from)) near.set(from, `- [${from}] (${rel.kind} ${to})`);
            }
          } catch { /* no relations */ }
          // Nothing named: the places of this kind the world already has, so the new one fits among them.
          if (!near.size) for (const p of samePages(d, g, ai, 6)) near.set(p.title, `- [${p.title}] (${p.id}) in ${p.path}`);
          if (near.size) found.push(`Neighbouring places${anchors.length ? ` (around ${anchors.join(', ')})` : ' (the ones of this kind the world has)'}:\n${[...near.values()].slice(0, 8).join('\n')}`);
          note.steps.push({ kind: 'neighbours', label: 'Found the neighbouring places', status: near.size ? 'done' : 'skipped', detail: near.size ? [...near.keys()].slice(0, 6).join(', ') : 'no place named and none of this kind yet' });
        } else if (st.kind === 'exemplars') {
          const ids = ((g.spec as any).exemplars?.length ? (g.spec as any).exemplars as string[] : samePages(d, g, ai, 2).map((p) => p.id)).slice(0, 2);
          const read: string[] = [];
          for (const pid of ids) {
            try {
              const p: any = d.library.get(r.worldId, pid, ai);
              const body = String(p.body ?? '');
              found.push(`Exemplar [${p.title}] (${p.id}). Its headings: ${outline(body) || 'none'}.\n${clip(body.replace(/\n{3,}/g, '\n\n'), 900)}`);
              cite({ kind: 'page', id: p.id, title: p.title, path: p.path });
              read.push(p.title);
            } catch { /* gone, or not readable by the assistant */ }
          }
          note.steps.push({ kind: 'exemplars', label: 'Read the exemplar pages', status: read.length ? 'done' : 'skipped', detail: read.length ? read.join(', ') : 'no example pages yet' });
        } else if (st.kind === 'web') {
          const label = 'Web research';
          if (webDone) { note.steps.push({ kind: 'web', label, status: 'skipped', detail: 'done for the first guide' }); continue; }
          const cfg = webConfig(d.db, r.worldId);
          if (!cfg.enabled) { note.steps.push({ kind: 'web', label, status: 'skipped', detail: 'web research is off for this world (Templates & guides → Web research)' }); continue; }
          const q = fillQuery(st.query || '{reference}', r.text);
          // A follow-up ("continue with the results above") takes the search this chat already has for the guide.
          const before = q || /\b(continue|carry on|go on|results above)\b/i.test(r.text) ? earlierSearch(d, r.chatId, g.id, q) : null;
          if (before) {
            webDone = true;
            note.steps.push({ kind: 'web', label, status: before.status === 'done' ? 'done' : 'waiting', detail: before.status === 'done' ? 'results above, from the search you approved' : 'waiting for your approval (the card above)' });
            continue;
          }
          if (!q) { note.steps.push({ kind: 'web', label, status: 'skipped', detail: 'the request names no real-world reference (say "based on <place>")' }); continue; }
          const b = blockedQuery(d, r.worldId, [q], cfg);
          if (b) { note.steps.push({ kind: 'web', label, status: 'blocked', detail: blockedText(b) }); continue; }
          webDone = true;
          const res = await r.exec('web_research', { queries: [q], purpose: `Guide ${g.name}: ${clip(referenceIn(r.text) || r.text, 80)}`, guide: g.id });
          if (res.proposed) {
            found.push(`Web research for "${q}" waits for the DM's approval (a card in the chat). Draft from the library now and mark where real-world details will go; the search results come in a later message.`);
            note.steps.push({ kind: 'web', label, status: 'waiting', detail: `search "${q}": waiting for your approval` });
          } else if (res.ran?.ok) {
            const j = parseJson<any>(res.content, null);
            const results: WebResult[] = Array.isArray(j?.results) ? j.results : [];
            found.push(`Web research for "${q}" (cite these by their links):\n${results.map((x, i) => `${i + 1}. ${x.title}${x.url ? ` <${x.url}>` : ''}: ${clip(x.snippet, 300)}`).join('\n') || 'no results'}`);
            for (const x of results) if (x.url) cite({ kind: 'web', id: x.url, title: x.title, path: x.url, snippet: clip(x.snippet, 140) });
            note.steps.push({ kind: 'web', label, status: 'done', detail: `search "${q}": ${results.length} source${results.length === 1 ? '' : 's'}` });
          } else {
            note.steps.push({ kind: 'web', label, status: 'skipped', detail: clip(res.content.replace(/^Error \d+:\s*/, ''), 200) });
          }
        } else {
          note.steps.push({ kind: 'instruction', label: clip(st.text, 120), status: 'done' });
        }
      } catch (e: any) {
        note.steps.push({ kind: st.kind, label: st.text.slice(0, 80), status: 'skipped', detail: String(e?.message ?? e).slice(0, 160) });
      }
    }
    ctx.push(`${text}\n\nWhat the guide's steps found:\n${found.length ? found.join('\n\n') : 'nothing yet'}`);
  }
  if (!ctx.length) return { context: about, notes, cites };
  const names = notes.map((n) => n.name).join(', ');
  const kinds = new Set(matched.map((m) => m.t.kind));
  // Where the result goes: a story event and a spell have their own tools; everything else is a library page.
  const save = [
    kinds.has('event') ? 'Save a quick event with save_encounter_template (kind event, with its places); it is sent later from Encounters → Story events.' : '',
    kinds.has('spell') ? 'Save a new spell with save_homebrew_spell (it stays DM only until the DM shares it).' : '',
    [...kinds].some((k) => k !== 'event' && k !== 'spell') ? 'Write a new page with save_page: DM only (visibility dm) unless the DM asks otherwise, in the guide\'s folder. End the page with a "Sources" section: library pages as [[Title]], web results as links.' : '',
  ].filter(Boolean).join('\n');
  return {
    context: `GUIDE IN USE: ${names}. The DM wrote ${notes.length === 1 ? 'this guide' : 'these guides'} for this kind of request; follow the steps, the structure and the tone. The chat already shows "Using guide: ${names}"; do not repeat it.\n${save}\n\n${ctx.join('\n\n---\n\n')}${about ? `\n\n${about}` : ''}`.slice(0, 14_000),
    notes, cites,
  };
}
