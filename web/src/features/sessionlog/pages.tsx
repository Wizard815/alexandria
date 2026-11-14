// The session log: players read published entries; the DM drafts, reviews,
// checks for leaks and publishes.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHead, ErrorBox, Empty, Loading, Field, Markdown, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';

/** "Session 3: Title", unless the title already names the session. */
const entryLabel = (n: number, title: string) => (/^session\b/i.test(title.trim()) ? title : `Session ${n}: ${title}`);

interface Entry { id: string; number: number; title: string; summary: string; sessionAt: string; worldFrom: string; worldTo: string; published: boolean; publishedAt: string; draftId?: string }
interface Proposal { minutes: number; reason: string; travel?: { from: string; to: string; days: number; route: string }; rests?: { kind: string; minutesIn?: number }[] }
interface Draft {
  id: string; title: string; version: number; markdown: string; dmNotes: string; usedModel: boolean; proposal: Proposal | null;
  dateStatus: 'none' | 'pending' | 'accepted' | 'declined'; entryId: string | null; createdAt: string;
  versions: { n: number; note: string; createdAt: string; size: number }[];
}
interface Overlap { text: string; source: string; aside: boolean }
interface DraftRow { id: string; title: string; version: number; entryId: string | null; createdAt: string; dateStatus: string }

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const span = (e: Entry) => (e.worldFrom === e.worldTo ? e.worldFrom : `${e.worldFrom} to ${e.worldTo}`);

// ---- players ----

export function SessionLogPlayer() {
  const { w } = useWorld();
  const list = useLoad<Entry[]>(() => w.call('GET', '/sessionlog'), [w], ['sessionlog']);
  const [params] = useSearchParams(); // global search links here with ?entry=<id>
  const [sel, setSel] = useState<string | null>(() => params.get('entry'));
  useEffect(() => { const e = params.get('entry'); if (e) setSel(e); }, [params]);
  const cur = list.data?.find((e) => e.id === sel) ?? null;
  return (
    <div className="page">
      <PageHead title="Session log" lead="What happened, session by session." />
      <ErrorBox error={list.error} />
      {cur ? (
        <article className="card stack">
          <button className="btn small" onClick={() => setSel(null)}>All sessions</button>
          <h2 style={{ margin: 0 }}>{entryLabel(cur.number, cur.title)}</h2>
          <div className="small muted">{day(cur.sessionAt)} · in the world: {span(cur)}</div>
          <Markdown text={cur.summary} />
        </article>
      ) : !list.data ? <Loading /> : list.data.length ? (
        <div className="card flush list">
          {list.data.map((e) => (
            <button key={e.id} type="button" className="list-item" onClick={() => setSel(e.id)}>
              <span className="stack tight grow"><strong>{entryLabel(e.number, e.title)}</strong><span className="tiny muted">{day(e.sessionAt)} · {span(e)}</span></span>
            </button>
          ))}
        </div>
      ) : <Empty>No sessions have been written up yet.</Empty>}
    </div>
  );
}

// ---- DM ----

export function SessionLogDM() {
  const { w } = useWorld();
  const act = useAction();
  const drafts = useLoad<DraftRow[]>(() => w.call('GET', '/sessionlog/drafts'), [w], ['sessionlog']);
  const entries = useLoad<Entry[]>(() => w.call('GET', '/sessionlog'), [w], ['sessionlog']);
  const [params] = useSearchParams(); // global search links here with ?entry=<id>: open that entry's draft
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const e = params.get('entry');
    const d = e ? entries.data?.find((x) => x.id === e)?.draftId : null;
    if (d) setSel(d);
  }, [params, entries.data]);
  const [audioId, setAudioId] = useState('');
  const sessions = useLoad<{ id: string; name: string; startedAt: string }[]>(() => w.call<any>('GET', '/audio/sessions').then((r) => (Array.isArray(r) ? r : r?.sessions ?? [])).catch(() => []), [w]);

  const create = () => act.run(async () => {
    const d = await w.call<Draft>('POST', '/sessionlog/drafts', audioId ? { audioSessionId: audioId } : {});
    await drafts.reload();
    setSel(d.id);
  });
  const unpublish = (id: string) => act.run(async () => { await w.call('POST', `/sessionlog/${id}/unpublish`); await entries.reload(); });

  return (
    <div className="page wide">
      <PageHead title="Session log" lead="Draft a summary of a session, review it, then publish it to the players." />
      <ErrorBox error={drafts.error ?? entries.error ?? act.error} />
      <div className="cols">
        <aside className="col-1 stack" style={{ maxWidth: 420 }}>
          <div className="card">
            <h3 style={{ margin: 0 }}>New draft</h3>
            <Field label="From which recording" help="Leave empty to use everything since the last published session.">
              <select value={audioId} onChange={(e) => setAudioId(e.target.value)}>
                <option value="">Everything since the last entry</option>
                {(sessions.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} · {day(s.startedAt)}</option>)}
              </select>
            </Field>
            <button className="btn primary" disabled={act.busy} onClick={() => void create()}>{act.busy ? 'Drafting…' : 'Draft a summary'}</button>
          </div>
          <div className="card flush list">
            <h3 style={{ margin: 0, padding: '12px 14px' }}>Drafts</h3>
            {(drafts.data ?? []).length ? drafts.data!.map((d) => (
              <button key={d.id} type="button" className={`list-item${sel === d.id ? ' active' : ''}`} onClick={() => setSel(d.id)}>
                <span className="stack tight grow"><strong>{d.title}</strong><span className="tiny muted">{day(d.createdAt)} · v{d.version}{d.entryId ? ' · published' : ''}</span></span>
              </button>
            )) : <div style={{ padding: '0 14px 12px' }} className="muted small">No drafts yet.</div>}
          </div>
          <div className="card flush list">
            <h3 style={{ margin: 0, padding: '12px 14px' }}>Published</h3>
            {(entries.data ?? []).length ? entries.data!.map((e) => (
              <div key={e.id} className="list-item">
                <span className="stack tight grow"><strong>{entryLabel(e.number, e.title)}</strong><span className="tiny muted">{span(e)}{e.published ? '' : ' · unpublished'}</span></span>
                {e.published && <button className="btn small" disabled={act.busy} onClick={() => void unpublish(e.id)}>Unpublish</button>}
                {!e.published && e.draftId && <button className="btn small" onClick={() => setSel(e.draftId!)}>Open draft</button>}
              </div>
            )) : <div style={{ padding: '0 14px 12px' }} className="muted small">Nothing published yet.</div>}
          </div>
        </aside>
        <section className="col-2">
          {sel ? <Review key={sel} id={sel} onGone={() => { setSel(null); void drafts.reload(); }} onChange={() => { void drafts.reload(); void entries.reload(); }} /> : <Empty>Pick a draft, or make a new one.</Empty>}
        </section>
      </div>
    </div>
  );
}

function Review({ id, onGone, onChange }: { id: string; onGone: () => void; onChange: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const d = useLoad<Draft>(() => w.call('GET', `/sessionlog/drafts/${id}`), [w, id]);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [instr, setInstr] = useState('');
  const [leaks, setLeaks] = useState<{ overlaps: Overlap[]; blocked: boolean } | null>(null);
  const [prop, setProp] = useState<{ minutes: number; reason: string; edit: boolean } | null>(null);
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!d.data) return;
    setText(d.data.markdown); setTitle(d.data.title);
    setProp(d.data.proposal ? { minutes: d.data.proposal.minutes, reason: d.data.proposal.reason, edit: false } : null);
    setLeaks(null);
  }, [d.data?.version, d.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = <T,>(method: string, path: string, body?: unknown) => w.call<T>(method, `/sessionlog/drafts/${id}${path}`, body);
  const reloadAll = async () => { await d.reload(); onChange(); };

  const save = () => act.run(async () => { await call('PUT', '', { markdown: text, title }); await reloadAll(); });
  const revise = () => act.run(async () => { await call('POST', '/revise', { instruction: instr }); setInstr(''); await reloadAll(); });
  const restore = (n: number) => act.run(async () => { await call('POST', '/restore', { version: n }); await reloadAll(); });
  const check = () => act.run(async () => setLeaks(await call('GET', '/leakcheck')));
  const date = (accept: boolean) => act.run(async () => { await call('POST', '/date', accept ? { accept: true, minutes: prop?.minutes, reason: prop?.reason } : { accept: false }); await reloadAll(); });
  const publish = (force: boolean) => act.run(async () => {
    if (text !== d.data?.markdown || title !== d.data?.title) await call('PUT', '', { markdown: text, title });
    try {
      const e = await call<Entry>('POST', '/publish', force ? { force: true } : {});
      setDone(`Published as session ${e.number}.`); setLeaks(null);
      await reloadAll();
    } catch (err) {
      // Show what overlaps, so the DM can fix it or publish anyway.
      setLeaks(await call('GET', '/leakcheck'));
      throw err;
    }
  });
  const remove = () => act.run(async () => { await call('DELETE', ''); onGone(); });

  if (!d.data) return d.error ? <ErrorBox error={d.error} /> : <Loading />;
  const dr = d.data;
  const dirty = text !== dr.markdown || title !== dr.title;
  return (
    <div className="stack">
      <ErrorBox error={act.error ?? d.error} />
      {done && <div className="card" role="status">{done}</div>}
      <div className="card stack">
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <Field label={`Summary (Markdown) · version ${dr.version}`} help={dr.usedModel ? 'Written by the model from the players’ transcript. Check it before publishing.' : 'Built from the recorded data (no model). Edit freely.'}>
          <textarea rows={16} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', fontFamily: 'inherit' }} />
        </Field>
        <div className="row">
          <button className="btn primary" disabled={act.busy || !dirty} onClick={() => void save()}>Save as new version</button>
          <button className="btn danger" disabled={act.busy} onClick={() => void remove()}>Delete draft</button>
        </div>
        <Field label="Ask the model to revise it"><input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Make it shorter, and mention the lighthouse" maxLength={2000} /></Field>
        <button className="btn" disabled={act.busy || !instr.trim() || dirty} onClick={() => void revise()}>Revise</button>
        {dirty && <p className="tiny muted">Save your edits before asking for a revision.</p>}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Date change</h3>
        {dr.dateStatus === 'accepted' ? <p className="small">Applied: the world clock moved{dr.proposal?.travel ? ` (travel ${dr.proposal.travel.from} to ${dr.proposal.travel.to})` : ''}.</p>
          : dr.dateStatus === 'declined' ? <p className="small muted">Declined. The clock was not changed.</p>
          : prop ? (
            <>
              <p className="small">The model suggests that {Math.round(prop.minutes / 144) / 10} days passed{dr.proposal?.travel ? `, travelling from ${dr.proposal.travel.from} to ${dr.proposal.travel.to}` : ''}. Nothing moves until you accept.</p>
              {prop.edit && (
                <div className="row">
                  <Field label="Minutes"><input type="number" min={1} value={prop.minutes} onChange={(e) => setProp({ ...prop, minutes: Number(e.target.value) })} style={{ width: 120 }} /></Field>
                  <Field label="Reason (goes in the clock log)"><input value={prop.reason} onChange={(e) => setProp({ ...prop, reason: e.target.value })} maxLength={200} /></Field>
                </div>
              )}
              <div className="row">
                <button className="btn primary" disabled={act.busy} onClick={() => void date(true)}>Accept</button>
                <button className="btn" onClick={() => setProp({ ...prop, edit: !prop.edit })}>{prop.edit ? 'Done editing' : 'Edit'}</button>
                <button className="btn" disabled={act.busy} onClick={() => void date(false)}>Decline</button>
              </div>
            </>
          ) : <p className="small muted">No date change proposed. Use the World clock page to move time.</p>}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Publish</h3>
        <p className="small muted">Publishing first checks the summary against DM-only pages, secrets and everything said off the record.</p>
        <div className="row">
          <button className="btn" disabled={act.busy} onClick={() => void check()}>Check for leaks</button>
          <button className="btn primary" disabled={act.busy} onClick={() => void publish(false)}>{dr.entryId ? 'Publish this revision' : 'Publish'}</button>
          {leaks && leaks.overlaps.length > 0 && !leaks.blocked && <button className="btn danger" disabled={act.busy} onClick={() => void publish(true)}>Publish anyway</button>}
        </div>
        {leaks && (leaks.overlaps.length === 0 ? <p className="small" role="status">No overlap with DM-only text found.</p> : (
          <div className="stack tight" role="alert">
            <strong>{leaks.blocked ? 'Remove the aside passages before publishing (they can never be published):' : 'These passages repeat DM-only text:'}</strong>
            {leaks.overlaps.map((o, i) => <div key={i} className="error-box"><div>“{o.text}”</div><div className="tiny">From: {o.source}{o.aside ? ' (never publishable)' : ''}</div></div>)}
          </div>
        ))}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Versions</h3>
        {dr.versions.map((v) => (
          <div key={v.n} className="row between">
            <span className="small">v{v.n} · {new Date(v.createdAt).toLocaleString()} · {v.note}</span>
            {v.n !== dr.version && <button className="btn small" disabled={act.busy} onClick={() => void restore(v.n)}>Restore</button>}
          </div>
        ))}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>DM notes <span className="chip">never published</span></h3>
        {dr.dmNotes ? <Markdown text={dr.dmNotes} /> : <p className="small muted">No DM-only lines were recorded.</p>}
      </div>
    </div>
  );
}
