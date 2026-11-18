// DM → Active mode: the mode switch, per-category auto / ask / off, takeover
// presets, the wake word, and the command log with undo, reject and "wrong".
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { CATEGORY_INFO, seesText, triggerText, useActive, useActiveLog, when, type Setting } from './shared.tsx';
import './active.css';

export default function ActivePage() {
  const [tab, setTab] = useState<'settings' | 'log' | 'rules'>('settings');
  return (
    <div className="page wide stack loose">
      <PageHead title="Active mode" lead="Assistant mode: I act only when you ask. Active mode: while a session records I listen to the table and act on what I hear. Players just see the table change." />
      <Tabs label="Active mode" value={tab} onChange={setTab} items={[['settings', 'Settings'], ['log', 'Log'], ['rules', 'Never again']]} />
      {tab === 'settings' && <Settings />}
      {tab === 'log' && <Log />}
      {tab === 'rules' && <Rules />}
    </div>
  );
}

function Settings() {
  const { w } = useWorld();
  const st = useActive();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [saveN, setSaveN] = useState('4');
  const [saveName, setSaveName] = useState('');
  if (!st.data) return <Loading />;
  const s = st.data;
  const put = (body: Record<string, unknown>) => act.run(async () => { await w.call('PUT', '/active', body); await st.reload(); });
  const cmd = (text: string) => act.run(async () => { const r = await w.call<any>('POST', '/active/command', { text }); toast(r.message); await st.reload(); });
  const optsFor = (c: string): Setting[] => (c === 'notes' ? ['draft', 'off'] : ['auto', 'ask', 'off']);
  return (
    <div className="stack">
      <ErrorBox error={st.error || act.error} />
      <div className="card gold">
        <div className="row between">
          <div className="act-seg" role="group" aria-label="Mode">
            <button type="button" aria-pressed={s.mode === 'assistant'} onClick={() => void put({ mode: 'assistant' })}>Assistant</button>
            <button type="button" aria-pressed={s.mode === 'active'} onClick={() => void put({ mode: 'active' })}>Active</button>
          </div>
          <span className="tiny muted">{s.recording ? `Recording now${s.sessionOverride ? ` · this recording is ${s.sessionOverride}` : ''}` : 'Not recording: Active mode waits for a recording'}</span>
        </div>
        {s.recording && (
          <label className="row"><input type="checkbox" checked={s.sessionOverride === 'active'} onChange={(e) => void put({ mode: e.target.checked ? 'active' : 'assistant', sessionOnly: true })} /> Active for this recording only</label>
        )}
        {!s.model.audit && <p className="small muted" style={{ margin: 0 }}>No audit model is set: I use only the rules, and anything I am unsure about waits for your tap.</p>}
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>Takeover</h3>
        <p className="small muted" style={{ margin: 0 }}>One tap changes every category. Players still only ever see party-level content, never DM-only pages or asides.</p>
        <div className="row">
          <button type="button" className={`btn${s.takeoverOn ? ' primary' : ''}`} disabled={act.busy} onClick={() => void cmd('/takeover')}>{s.takeoverOn ? 'Takeover on: put my settings back' : 'Full takeover (all auto)'}</button>
          {Object.entries(s.presets).sort(([a], [b]) => Number(a) - Number(b)).map(([n, p]) => <button key={n} type="button" className="btn" disabled={act.busy} onClick={() => void cmd(`/takeover-${n}`)} title={`/takeover-${n}`}>{n}: {p.name}</button>)}
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Save these settings as preset"><input value={saveN} inputMode="numeric" style={{ width: 70 }} onChange={(e) => setSaveN(e.target.value.replace(/\D/g, '').slice(0, 2))} /></Field>
          <Field label="Name"><input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="My night" /></Field>
          <button type="button" className="btn" disabled={act.busy || !saveN} onClick={() => void cmd(`/takeover-save ${saveN} ${saveName || `Preset ${saveN}`}`)}>Save</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>What I do by myself</h3>
        <p className="small muted" style={{ margin: 0 }}>Auto: I do it at once and you can undo it. Ask: a card waits for your tap. Off: I leave it alone. Typed: <code>/auto music off</code>.</p>
        {s.categories.map((c) => (
          <div key={c} className="act-cat">
            <div><strong>{CATEGORY_INFO[c]?.label ?? c}</strong><div className="tiny muted">{CATEGORY_INFO[c]?.help}</div></div>
            <div className="act-seg" role="group" aria-label={CATEGORY_INFO[c]?.label ?? c}>
              {optsFor(c).map((o) => <button key={o} type="button" aria-pressed={s.cats[c] === o} disabled={act.busy} onClick={() => void put({ cats: { [c]: o } })}>{o === 'draft' ? 'Draft to Review' : o[0].toUpperCase() + o.slice(1)}</button>)}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>Listening</h3>
        <div className="row">
          <label className="row"><input type="checkbox" checked={s.listen.dm} onChange={(e) => void put({ listen: { ...s.listen, dm: e.target.checked } })} /> Your voice (DM mic)</label>
          <label className="row"><input type="checkbox" checked={s.listen.players} onChange={(e) => void put({ listen: { ...s.listen, players: e.target.checked } })} /> The players' mics (only their own rolls and item use)</label>
          <label className="row" title="A room mic hears everybody and names no speaker. Turn this on only if your table mic is the DM's voice; the wake word never counts from it."><input type="checkbox" checked={s.listen.room} onChange={(e) => void put({ listen: { ...s.listen, room: e.target.checked } })} /> The room mic counts as my voice</label>
          <label className="row"><input type="checkbox" checked={s.scan} onChange={(e) => void put({ scan: e.target.checked })} /> Use the audit model to read narration the rules miss</label>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Wake word" help="Say it, then a command: “Minerva, play something tense”. Only your own mic counts."><input defaultValue={s.wakeWord} key={s.wakeWord} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== s.wakeWord) void put({ wakeWord: e.target.value.trim() }); }} /></Field>
          <Field label="Cards expire after (minutes)"><input type="number" min={1} max={240} defaultValue={s.askTtlMin} key={s.askTtlMin} style={{ width: 90 }} onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 240 && n !== s.askTtlMin) void put({ askTtlMin: n }); }} /></Field>
        </div>
      </div>
      {toastNode}
    </div>
  );
}

function Log() {
  const { w } = useWorld();
  const log = useActiveLog(150);
  const act = useAction();
  const [filter, setFilter] = useState('');
  if (!log.data) return <Loading />;
  const rows = log.data.log.filter((r) => !filter || r.status === filter);
  const post = (id: string, verb: string) => act.run(async () => { await w.call('POST', `/active/log/${id}/${verb}`, {}); await log.reload(); });
  return (
    <div className="stack">
      <ErrorBox error={log.error || act.error} />
      <div className="row">
        <label className="row">Show <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by state">{['', 'done', 'pending', 'undone', 'rejected', 'failed', 'blocked', 'expired', 'dismissed'].map((x) => <option key={x} value={x}>{x || 'everything'}</option>)}</select></label>
        <span className="tiny muted">Every action I take or propose, in both modes.</span>
      </div>
      {rows.length === 0 && <Empty>Nothing yet.</Empty>}
      <div data-testid="active-log">
        {rows.map((r) => (
          <div key={r.id} className="act-log-row" data-testid="active-log-row" data-status={r.status}>
            <div className="tiny muted">{when(r.at)}<br />{r.mode === 'active' ? 'Active' : 'Assistant'}</div>
            <div>
              <div><strong>{r.summary}</strong> <span className={`chip ${r.status === 'done' ? 'teal' : r.status === 'failed' || r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'gold' : ''}`}>{r.status}</span>{r.wrong && <span className="chip red">wrong</span>}</div>
              <div className="tiny muted">{triggerText(r)}</div>
              <div className="tiny muted">{r.tool || r.category}{r.source === 'model' ? ' · read by the audit model' : ''} · {seesText(r.visible)}{r.latencyMs !== null ? ` · ${r.latencyMs} ms after the line` : ''}{r.status === 'done' && !r.reversible && r.trigger !== 'chat' ? ' · cannot be undone' : ''}</div>
              {r.result && r.status !== 'done' && <div className="tiny muted">{r.result}</div>}
            </div>
            <div className="row">
              {r.status === 'pending' && <><button type="button" className="btn small primary" disabled={act.busy} onClick={() => void post(r.id, 'approve')}>Do it</button><button type="button" className="btn small" disabled={act.busy} onClick={() => void post(r.id, 'reject')}>Reject</button></>}
              {r.status === 'done' && r.reversible && <button type="button" className="btn small" disabled={act.busy} onClick={() => void post(r.id, 'undo')}>Undo</button>}
              {r.status === 'done' && r.trigger === 'line' && !r.wrong && <button type="button" className="btn small ghost" disabled={act.busy} title="Undo it where possible and never do this for that cue again" onClick={() => void post(r.id, 'wrong')}>Wrong</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Rules() {
  const { w } = useWorld();
  const { data, reload, error } = (() => { const l = useRulesLoad(); return l; })();
  const act = useAction();
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <ErrorBox error={error || act.error} />
      <p className="small muted" style={{ margin: 0 }}>Cues you marked wrong or rejected. I will not act on them in this world until you remove them here.</p>
      {data.rules.length === 0 && <Empty>No rules yet.</Empty>}
      {data.rules.map((r) => (
        <div key={r.key} className="card row between"><code>{r.key}</code><button type="button" className="btn small" onClick={() => void act.run(async () => { await w.call('DELETE', `/active/rules?key=${encodeURIComponent(r.key)}`); await reload(); })}>Allow again</button></div>
      ))}
    </div>
  );
}
import { useLoad } from '../../lib/world.tsx';
function useRulesLoad() {
  const { w } = useWorld();
  return useLoad<{ rules: { key: string; createdAt: string }[] }>(() => w.call('GET', '/active/rules'), [w], ['active']);
}
