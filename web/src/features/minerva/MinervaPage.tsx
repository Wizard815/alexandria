// The GM's page for her assistant: the campaign status first, then the arc, the
// threads by heat, the review queue, promotion suggestions, the revelations
// board and a panel for each player. Phone-friendly: one column, tabs scroll.
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Field, Loading, Markdown, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import './minerva.css';
import { HEATS, KIND_LABEL, type Arc, type Draft, type Mystery, type PlayerRow, type ReviewState, type State } from './shared.ts';

type Tab = 'now' | 'review' | 'revelations' | 'players';
const heatTone = (h: string) => (h === 'on' ? 'gold' : h === 'ongoing' ? 'teal' : h === 'simmering' ? '' : 'red');
const Heat = ({ h }: { h: string }) => <span className={`chip mn-heat ${heatTone(h)}`}>{h}</span>;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export default function MinervaPage() {
  const { w } = useWorld();
  const act = useAction();
  const [params, setParams] = useSearchParams();
  const tab = (['now', 'review', 'revelations', 'players'].includes(params.get('tab') ?? '') ? params.get('tab') : 'now') as Tab;
  const st = useLoad<State>(() => w.call('GET', '/minerva'), [w], ['minerva', 'settings']);
  const review = useLoad<ReviewState>(() => (st.data?.enabled ? w.call('GET', '/minerva/review') : Promise.resolve({ drafts: [], actions: [], recent: [] })), [w, st.data?.enabled, st.data?.pending], ['minerva', 'agent']);
  const s = st.data;
  const name = s?.name || 'Minerva';
  const queue = (review.data?.drafts.length ?? 0) + (review.data?.actions.length ?? 0);
  const file = useRef<HTMLInputElement>(null);
  const { toast, toastNode } = useToast();

  const reloadAll = async () => { await st.reload(); await review.reload(); };
  const exportZip = () => act.run(async () => {
    const c = w.client;
    const r = await fetch(`${c.baseUrl}${w.path('/minerva/export')}`, { headers: { Authorization: `Bearer ${c.token}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Export failed (${r.status})`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = 'vault.zip'; a.click();
    URL.revokeObjectURL(url);
  });
  const [pending, setPending] = useState<{ file: File; unmatched: { folder: string; label: string; files: number }[]; players: { accountId: string; label: string }[]; choice: Record<string, string> } | null>(null);
  const importZip = (f: File, map?: Record<string, string>) => act.run(async () => {
    const c = w.client;
    const r = await fetch(`${c.baseUrl}${w.path('/minerva/import')}${map ? `?map=${encodeURIComponent(JSON.stringify(map))}` : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/zip' }, body: f });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `Import failed (${r.status})`);
    act.setError(null);
    const left = (body.unmatched ?? []).filter((u: any) => !map || map[u.folder] !== 'skip');
    setPending(left.length ? { file: f, unmatched: left, players: body.players ?? [], choice: Object.fromEntries(left.map((u: any) => [u.folder, map?.[u.folder] ?? 'skip'])) } : null);
    toast(`Imported: ${body.created} new, ${body.updated} updated, ${body.skipped?.length ?? 0} skipped, ${body.arcs ?? 0} arcs, ${body.mysteries ?? 0} mysteries.${left.length ? ` ${left.length} player folder${left.length === 1 ? '' : 's'} matched nobody.` : ''}`);
    await reloadAll();
  });

  return (
    <div className="page wide">
      <PageHead title={name} lead="Keeps the campaign's memory: the status, the arc, who knows what.">
        {s?.enabled && (
          <>
            <button type="button" className="btn small" onClick={() => void exportZip()} disabled={act.busy}><i className="fa-solid fa-download" aria-hidden="true" /> Export for Obsidian</button>
            <button type="button" className="btn small" onClick={() => file.current?.click()} disabled={act.busy}><i className="fa-solid fa-upload" aria-hidden="true" /> Import</button>
            <input ref={file} type="file" accept=".zip,application/zip" hidden aria-label="Vault zip to import" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importZip(f); e.target.value = ''; }} />
          </>
        )}
      </PageHead>
      <ErrorBox error={st.error ?? review.error ?? act.error} />
      {toastNode}
      {pending && (
        <section className="card" aria-label="Match players" data-testid="import-mapping">
          <h2 style={{ margin: 0 }}>Match players from the import</h2>
          <p className="small muted">These player folders did not match anyone in this world by account, sign-in name, character or name. Pick who each one is, or skip it. Nothing from a skipped folder was imported.</p>
          {pending.unmatched.map((u) => (
            <Field key={u.folder} label={`${u.label} (${u.files} page${u.files === 1 ? '' : 's'})`}>
              <select value={pending.choice[u.folder] ?? 'skip'} onChange={(e) => setPending({ ...pending, choice: { ...pending.choice, [u.folder]: e.target.value } })}>
                <option value="skip">Skip this folder</option>
                {pending.players.map((p) => <option key={p.accountId} value={p.accountId}>{p.label}</option>)}
              </select>
            </Field>
          ))}
          <div className="row">
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void importZip(pending.file, pending.choice)}>Import again with these matches</button>
            <button type="button" className="btn" onClick={() => setPending(null)}>Leave them out</button>
          </div>
        </section>
      )}
      {!s ? <Loading /> : !s.enabled ? (
        <Empty>
          <div className="stack" style={{ alignItems: 'center' }}>
            <span>{name} is off. Turning her on makes her memory vault in the library (Minerva/) with the campaign status and a notebook for each player. She drafts, you approve.</span>
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', '/minerva/enable', {}); await st.reload(); })}>Turn {name} on</button>
          </div>
        </Empty>
      ) : (
        <>
          <Tabs<Tab> label="Sections" value={tab} onChange={(t) => setParams(t === 'now' ? {} : { tab: t })} items={[['now', 'Now'], ['review', `Review${queue ? ` (${queue})` : ''}`], ['revelations', 'Revelations'], ['players', 'Players']]} />
          {tab === 'now' && <Now s={s} reload={reloadAll} onReview={() => setParams({ tab: 'review' })} queue={queue} />}
          {tab === 'review' && <Review r={review.data} reload={reloadAll} />}
          {tab === 'revelations' && <Revelations s={s} reload={reloadAll} />}
          {tab === 'players' && <Players players={s.players ?? []} />}
        </>
      )}
    </div>
  );
}

// ---- Now: status, arc, threads, suggestions ----

function Now({ s, reload, onReview, queue }: { s: State; reload: () => Promise<void>; onReview: () => void; queue: number }) {
  const { w } = useWorld();
  const act = useAction();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const [arcTitle, setArcTitle] = useState('');
  const body = s.status?.body ?? '';
  const save = () => act.run(async () => { await w.call('PUT', '/minerva/page', { rel: 'gm/state/Campaign Status.md', body: text }); setEdit(false); await reload(); });
  const threads = s.threads ?? [];
  return (
    <div className="mn-grid">
      <div className="stack">
        <section className="card mn-status" aria-label="Campaign status">
          <div className="card-head"><h2 style={{ margin: 0 }}>Campaign status</h2>
            <button type="button" className="btn small" onClick={() => { setText(body); setEdit(!edit); }}>{edit ? 'Cancel' : 'Edit'}</button></div>
          <ErrorBox error={act.error} />
          {edit ? (
            <>
              <Field label="Campaign Status (Markdown)"><textarea className="code" rows={16} value={text} onChange={(e) => setText(e.target.value)} /></Field>
              <div className="row"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save</button></div>
            </>
          ) : (s.sections ?? []).map((x) => (
            <div key={x.title}><h3>{x.title}</h3>{x.text && !/^_.*_$/.test(x.text.trim()) ? <Markdown text={x.text} /> : <p className="muted small" style={{ margin: 0 }}>Nothing here yet.</p>}</div>
          ))}
        </section>
      </div>
      <div className="stack">
        <section className="card" aria-label="Active arc">
          <h2 style={{ margin: 0 }}>Arc</h2>
          {s.arc ? <ArcCard arc={s.arc} reload={reload} /> : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (arcTitle.trim()) void act.run(async () => { await w.call('POST', '/minerva/arcs', { title: arcTitle.trim() }); setArcTitle(''); await reload(); }); }}>
              <span className="muted small">No arc is open. Sessions are filed under the open arc, about eight to twelve to an arc.</span>
              <Field label="Name the next arc"><input value={arcTitle} onChange={(e) => setArcTitle(e.target.value)} placeholder="The Drowned Bell" /></Field>
              <button type="submit" className="btn primary" disabled={act.busy || !arcTitle.trim()}>Start the arc</button>
            </form>
          )}
          {(s.arcs ?? []).filter((a) => a.status === 'closed').length > 0 && <p className="tiny muted" style={{ margin: 0 }}>Closed: {(s.arcs ?? []).filter((a) => a.status === 'closed').map((a) => `${a.n}. ${a.title}`).join(', ')}</p>}
        </section>
        {queue > 0 && (
          <section className="card gold" aria-label="Waiting for you">
            <div className="card-head"><strong>{queue} change{queue === 1 ? '' : 's'} waiting for you</strong><button type="button" className="btn small primary" onClick={onReview}>Review</button></div>
          </section>
        )}
        <section className="card flush" aria-label="Threads by heat">
          <div style={{ padding: '14px 16px 6px' }}><h2 style={{ margin: 0 }}>Threads</h2></div>
          {threads.length ? threads.map((t) => (
            <div key={t.rel} className="list-item"><Heat h={t.heat} /><span className="stack tight grow"><strong style={{ fontWeight: 500 }}>{t.title}</strong><span className="tiny muted">{t.kind === 'hook' ? 'A hook' : `A player's goal`}</span></span></div>
          )) : <p className="muted small" style={{ margin: 0, padding: '4px 16px 14px' }}>No hooks or goals yet. Ask her to start one, or add a page in gm/hooks.</p>}
        </section>
        <section className="card flush" aria-label="Promotion suggestions">
          <div style={{ padding: '14px 16px 6px' }}><h2 style={{ margin: 0 }}>Worth a page</h2><p className="tiny muted" style={{ margin: '4px 0 0' }}>People who keep coming up and have no codex page yet.</p></div>
          {(s.promotions ?? []).length ? (s.promotions ?? []).map((c) => (
            <div key={c.name} className="list-item">
              <span className="stack tight grow"><strong style={{ fontWeight: 500 }}>{c.name}</strong><span className="tiny muted">{c.reasons.join(', ')}</span></span>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', '/minerva/promote', { name: c.name, kind: c.kind }); await reload(); })}>Promote</button>
            </div>
          )) : <p className="muted small" style={{ margin: 0, padding: '4px 16px 14px' }}>Nobody yet. Three sessions, an active thread or a bond makes a suggestion.</p>}
        </section>
      </div>
    </div>
  );
}

function ArcCard({ arc, reload }: { arc: Arc; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  return (
    <div className="stack">
      <div><strong>{arc.n}. {arc.title}</strong><div className="tiny muted">Open since {day(arc.openedAt)}</div></div>
      <ErrorBox error={act.error} />
      <button type="button" className="btn small" disabled={act.busy} onClick={() => { if (confirm(`Close "${arc.title}" and draft its summary for you to review?`)) void act.run(async () => { await w.call('POST', `/minerva/arcs/${arc.id}/close`); await reload(); }); }}>Close the arc</button>
    </div>
  );
}

// ---- Review ----

function Review({ r, reload }: { r: ReviewState | null; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  if (!r) return <Loading />;
  const groups = new Map<string, Draft[]>();
  for (const d of r.drafts) groups.set(d.review || 'Other', [...(groups.get(d.review || 'Other') ?? []), d]);
  const label = (k: string) => (/^session-(\d+)$/.test(k) ? `After session ${k.slice(8)}` : k.startsWith('arc-') ? `End of an arc` : k === 'Other' ? 'From the players and from chat' : k);
  const decideAction = (id: string, decision: 'approve' | 'reject') => act.run(async () => { await w.call('POST', `/agent/actions/${id}`, { decision }); await reload(); });
  if (!r.drafts.length && !r.actions.length) return (
    <div className="stack">
      <Empty>Nothing waiting. When a session log is published she drafts the status update, journals and codex changes here.</Empty>
      {r.recent.length > 0 && <Recent r={r} />}
    </div>
  );
  return (
    <div className="stack">
      <ErrorBox error={act.error} />
      {r.actions.length > 0 && (
        <section className="card flush" aria-label="Proposed in chat">
          <div style={{ padding: '14px 16px 6px' }}><h2 style={{ margin: 0 }}>Proposed in chat</h2></div>
          {r.actions.map((a) => (
            <div key={a.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <span className="stack tight grow" style={{ minWidth: 200 }}><strong style={{ fontWeight: 500 }}>{a.summary.replace(/\s*·\s*Visible to players.*$/, '')}</strong>{/Visible to players/.test(a.summary) && <span className="chip red" role="status">{a.summary.slice(a.summary.indexOf('Visible to players'))}</span>}<span className="tiny muted">{new Date(a.createdAt).toLocaleString()}</span></span>
              <span className="mn-row-actions"><button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decideAction(a.id, 'approve')}>Approve</button><button type="button" className="btn small" disabled={act.busy} onClick={() => void decideAction(a.id, 'reject')}>Reject</button></span>
            </div>
          ))}
        </section>
      )}
      {[...groups.entries()].map(([key, list]) => (
        <section key={key} className="stack" aria-label={label(key)}>
          <div className="row between"><h2 style={{ margin: 0 }}>{label(key)}</h2>
            <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', '/minerva/review/approve-all', { review: key === 'Other' ? '' : key }); await reload(); })}>Approve all ({list.length})</button></div>
          {list.map((d) => <DraftCard key={d.id} d={d} reload={reload} />)}
        </section>
      ))}
      {r.recent.length > 0 && <Recent r={r} />}
    </div>
  );
}

function Recent({ r }: { r: ReviewState }) {
  return (
    <details className="card"><summary>Decided recently ({r.recent.length})</summary>
      <div className="stack tight" style={{ marginTop: 8 }}>{r.recent.map((x) => <div key={x.id} className="small"><span className={`chip ${x.status === 'approved' ? 'green' : 'red'}`}>{x.status}</span> {x.title}{x.note ? <span className="muted"> · {x.note}</span> : null}</div>)}</div>
    </details>
  );
}

function DraftCard({ d, reload }: { d: Draft; reload: () => Promise<void> }) {
  const { w, nameOf } = useWorld();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const original = d.op.text ?? d.op.body ?? '';
  const [text, setText] = useState(original);
  const editable = d.op.text !== undefined || d.op.body !== undefined;
  const decide = (decision: 'approve' | 'reject') => act.run(async () => {
    const edit = editing && text !== original ? (d.op.text !== undefined ? { text } : { body: text }) : {};
    await w.call('POST', `/minerva/review/${d.id}`, { decision, ...edit });
    await reload();
  });
  const p = d.preview;
  return (
    <article className="card">
      <div className="row between" style={{ gap: 8 }}>
        <span className="row" style={{ gap: 8 }}><span className="chip gold">{KIND_LABEL[d.kind] ?? d.kind}</span><strong style={{ fontWeight: 500 }}>{d.title}</strong></span>
        {d.byAccount && <span className="tiny muted">written by {nameOf(d.byAccount)}</span>}
      </div>
      <ErrorBox error={act.error} />
      {p?.visibleToPlayers && <p className="chip red" role="status" style={{ alignSelf: 'flex-start' }}>Visible to players{p.level ? ` · level ${p.level}` : ''}</p>}
      {p && !editing && (
        <div className="mn-diff" aria-label="What changes">
          <div><div className="tiny muted">Now{p.rel ? ` · ${p.rel.split('/').pop()}` : ''}{p.where ? ` · ${p.where}` : ''}</div><pre className="before">{p.before.trim() || '(empty)'}</pre></div>
          <div><div className="tiny muted">After</div><pre className="after">{p.after.trim() || '(empty)'}</pre></div>
        </div>
      )}
      {editing && <Field label="Edit before approving"><textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      <div className="mn-row-actions">
        <button type="button" className="btn primary small" disabled={act.busy} onClick={() => void decide('approve')}>{editing ? 'Approve with my edit' : 'Approve'}</button>
        {editable && <button type="button" className="btn small" onClick={() => { setText(original); setEditing(!editing); }}>{editing ? 'Cancel edit' : 'Edit'}</button>}
        <button type="button" className="btn small danger" disabled={act.busy} onClick={() => void decide('reject')}>Reject</button>
      </div>
    </article>
  );
}

// ---- Revelations board ----

function Revelations({ s, reload }: { s: State; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const ms = s.mysteries ?? [];
  return (
    <div className="stack">
      <div className="row between"><p className="muted small" style={{ margin: 0 }}>Each mystery has a conclusion and at least three clues. Marking a clue found feeds that player's knowledge.</p><button type="button" className="btn small" onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'New mystery'}</button></div>
      {adding && <NewMystery done={async () => { setAdding(false); await reload(); }} />}
      {!ms.length && !adding && <Empty>No mysteries yet. Add one, or ask her to start one from what the table is chasing.</Empty>}
      {ms.map((m) => <MysteryCard key={m.slug} m={m} players={s.players ?? []} reload={reload} />)}
    </div>
  );
}

function NewMystery({ done }: { done: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const [title, setTitle] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [clues, setClues] = useState('');
  const list = clues.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await w.call('POST', '/minerva/revelations', { title, conclusion, clues: list }); await done(); }); }}>
      <ErrorBox error={act.error} />
      <Field label="The mystery, as a question" help="Players who find a clue see this name."><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Who darkened the lighthouse?" /></Field>
      <Field label="The truth"><textarea rows={2} value={conclusion} onChange={(e) => setConclusion(e.target.value)} /></Field>
      <Field label="Clues, one per line" help={`${list.length} of at least 3`}><textarea rows={4} value={clues} onChange={(e) => setClues(e.target.value)} /></Field>
      <button type="submit" className="btn primary" disabled={act.busy || !title.trim() || list.length < 3}>Add the mystery</button>
    </form>
  );
}

function MysteryCard({ m, players, reload }: { m: Mystery; players: PlayerRow[]; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const [who, setWho] = useState(players[0]?.accountId ?? '');
  const mark = (clue: number | null, kind: 'clue' | 'reached') => act.run(async () => { await w.call('POST', '/minerva/revelations/mark', { mystery: m.slug, clue: clue ?? undefined, player: who, kind }); await reload(); });
  const found = m.clues.filter((c) => c.found.length).length;
  return (
    <section className="card flush" aria-label={m.title}>
      <div style={{ padding: '14px 16px 4px' }} className="stack tight">
        <div className="row between"><h2 style={{ margin: 0 }}>{m.title}</h2><span className="chip">{found} of {m.clues.length} clues found</span></div>
        <div className="small"><span className="muted">The truth: </span>{m.conclusion || <em>not written</em>}</div>
        <ErrorBox error={act.error} />
        <div className="row"><label className="small muted" htmlFor={`who-${m.slug}`}>Mark for</label>
          <select id={`who-${m.slug}`} value={who} onChange={(e) => setWho(e.target.value)} style={{ minHeight: 30 }}>{players.map((p) => <option key={p.accountId} value={p.accountId}>{p.character || p.name}</option>)}</select>
          <button type="button" className="btn small" disabled={act.busy || !who} onClick={() => void mark(null, 'reached')}>Reached the truth</button></div>
        {m.reached.length > 0 && <div className="tiny muted">Reached it: {m.reached.map((id) => players.find((p) => p.accountId === id)?.character || 'someone').join(', ')}</div>}
      </div>
      <div style={{ marginTop: 8, borderTop: '1px solid var(--line)' }}>
        {m.clues.map((c) => (
          <div key={c.n} className="mn-clue">
            <span className="t"><span className="tiny muted">{c.n}. </span>{c.text}</span>
            <span className="row" style={{ gap: 6 }}>{c.found.length ? c.found.map((f) => <span key={f.accountId} className="chip teal" title={f.session ? `Session ${f.session}` : f.at.slice(0, 10)}>{f.name}{f.session ? ` · s${f.session}` : ''}</span>) : <span className="chip">not found yet</span>}</span>
            <button type="button" className="btn small" disabled={act.busy || !who} aria-label={`Mark clue ${c.n} found`} onClick={() => void mark(c.n, 'clue')}>Found</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Players ----

function Players({ players }: { players: PlayerRow[] }) {
  if (!players.length) return <Empty>No players have joined this world yet.</Empty>;
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))' }}>
      {players.map((p) => (
        <section key={p.accountId} className="card" aria-label={p.character || p.name}>
          <div><strong>{p.character || p.name}</strong><div className="tiny muted">Played by {p.name} · {p.journal} journal {p.journal === 1 ? 'entry' : 'entries'}</div></div>
          <div className="stack tight">
            <span className="tiny muted">Goals</span>
            {p.goals.length ? p.goals.map((g) => <div key={g.rel} className="row" style={{ gap: 8 }}><Heat h={g.heat} /><span className="small">{g.title}</span></div>) : <span className="small muted">None recorded yet.</span>}
          </div>
          <details><summary className="small">What they know</summary><div style={{ marginTop: 6 }}><Markdown text={p.knowledge} /></div></details>
          <details><summary className="small">Your notes on them</summary><div style={{ marginTop: 6 }}><Markdown text={p.notes} /></div></details>
          {p.shared.includes('- ') && <details><summary className="small">Shared with the party</summary><div style={{ marginTop: 6 }}><Markdown text={p.shared} /></div></details>}
        </section>
      ))}
    </div>
  );
}

void HEATS;
