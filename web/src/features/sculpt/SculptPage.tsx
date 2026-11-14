// DM page: pick a template, fill in a few blanks, and "Sculpt" fills the rest.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Field, Markdown, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import TemplateEditor from './TemplateEditor.tsx';
import { type Tpl, type Part, type Values } from './types.ts';

interface Check { ok: boolean; leaks: { key: string; match: string }[]; parts: Part[]; text: string }

export default function SculptPage() {
  const { w } = useWorld();
  const list = useLoad<{ templates: Tpl[] }>(() => w.call('GET', '/sculpt/templates'), [w]);
  const [tplId, setTplId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Tpl | 'new' | null>(null);
  const tpl = list.data?.templates.find((t) => t.id === tplId) ?? null;

  if (editing) return <TemplateEditor initial={editing === 'new' ? null : editing} onDone={(id) => { setEditing(null); if (id) setTplId(id); void list.reload(); }} />;
  return (
    <div className="page wide">
      <PageHead title="Sculpting" lead="Fill in a few blanks; the rest is filled to fit your world.">
        {tpl ? <button type="button" className="btn small ghost" onClick={() => setTplId(null)}>All templates</button> : <button type="button" className="btn small" onClick={() => setEditing('new')}>New template</button>}
        {tpl && <button type="button" className="btn small ghost" onClick={() => setEditing(tpl)}>Edit template</button>}
      </PageHead>
      <ErrorBox error={list.error} />
      {!list.data ? <Loading /> : !tpl ? (
        <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
          {list.data.templates.map((t) => (
            <button key={t.id} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setTplId(t.id)}>
              <strong>{t.name}</strong>
              <span className="small muted">{t.description}</span>
              <span className="tiny faint">{t.perspective === 'player' ? 'Players’ view' : 'DM notes'}{t.builtin ? '' : ' · yours'}</span>
            </button>
          ))}
        </div>
      ) : <Workshop key={tpl.id} tpl={tpl} />}
    </div>
  );
}

function Workshop({ tpl }: { tpl: Tpl }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [values, setValues] = useState<Values>({});
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [pageId, setPageId] = useState<string | undefined>();
  const pages = useLoad<any[]>(() => w.call('GET', '/library/pages'), [w]);
  const player = tpl.perspective === 'player';

  // Live preview: the server renders it, so DM-only parts and leak checks match what is saved.
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(() => { w.call<Check>('POST', '/sculpt/check', { templateId: tpl.id, values }).then((c) => { if (n === seq.current) setCheck(c); }).catch(() => {}); }, 300);
    return () => clearTimeout(t);
  }, [w, tpl, values]);

  const set = (k: string, v: string) => { setValues((o) => ({ ...o, [k]: v })); setPageId(undefined); if (v.trim()) setLocked((s) => new Set(s).add(k)); else setLocked((s) => { const n = new Set(s); n.delete(k); return n; }); };
  const toggle = (k: string) => setLocked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const run = async (only?: string) => {
    setBusyKey(only ?? '*');
    try {
      const r = await act.run(() => w.call<any>('POST', '/sculpt/run', { templateId: tpl.id, values, lock: [...locked], only: only ? [only] : undefined }));
      if (r) {
        setValues(r.values); setNotes(r.notes ?? []); setPageId(undefined);
        // What was filled stays unlocked, so the next Sculpt can change it; what you typed stays locked.
      }
    } finally { setBusyKey(null); }
  };

  const save = () => act.run(async () => {
    const r = await w.call<any>('POST', '/sculpt/save', { templateId: tpl.id, values });
    setPageId(r.pageId);
    toast(`Saved${r.path ? ` to ${r.path}` : ''}`);
  });
  const toCombat = () => act.run(async () => {
    const r = await w.call<any>('POST', '/sculpt/combat', { templateId: tpl.id, values, pageId });
    setPageId(r.pageId);
    toast(`${r.combatant.name} added to combat (initiative ${r.combatant.initiative})`);
  });
  const send = () => act.run(async () => { await w.call('POST', '/sculpt/send', { templateId: tpl.id, values }); toast('Sent to the players as a message'); });
  const readAloud = () => act.run(async () => {
    const c = await w.call<Check>('POST', '/sculpt/check', { templateId: tpl.id, values });
    if (!c.ok) throw new Error('Blocked: the text repeats DM-only notes.');
    const presets = await w.call<any[]>('GET', '/voice/presets');
    if (!presets.length) throw new Error('No voice yet. Add one in World settings → Voice.');
    await w.call('POST', '/voice/speak', { text: c.text.slice(0, 2000), presetId: presets[0].id });
    toast('Reading aloud');
  });

  const missing = tpl.fields.some((f) => f.required && !values[f.key]?.trim());
  const hasBlock = tpl.fields.some((f) => f.type === 'statblock');
  const pageOptions = useMemo(() => (pages.data ?? []).filter((p) => !player || p.visibility === 'party').map((p) => p.title as string), [pages.data, player]);

  return (
    <div className="cols">
      <section className="col-1 stack" style={{ minWidth: 0 }}>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{tpl.name}</h2>
          {tpl.fields.map((f) => {
            const id = `sc_${f.key}`;
            const v = values[f.key] ?? '';
            const common = { id, value: v, 'aria-label': f.label };
            const input = f.type === 'longtext' || f.type === 'list' ? <textarea {...common} rows={f.type === 'list' ? 5 : 3} onChange={(e) => set(f.key, e.target.value)} />
              : f.type === 'statblock' ? <textarea {...common} rows={3} readOnly placeholder="Filled by Sculpt" style={{ fontFamily: 'monospace', fontSize: 12 }} />
              : f.type === 'select' ? <select {...common} onChange={(e) => set(f.key, e.target.value)}><option value="">(fill for me)</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
              : f.type === 'page' ? <><input {...common} list={`${id}_l`} onChange={(e) => set(f.key, e.target.value)} placeholder="A library page" /><datalist id={`${id}_l`}>{pageOptions.map((o) => <option key={o} value={o} />)}</datalist></>
              : <input {...common} type={f.type === 'number' ? 'number' : 'text'} onChange={(e) => set(f.key, e.target.value)} />;
            return (
              <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}${f.dmOnly ? ' (DM only)' : ''}`} help={f.hint}>
                <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>{input}</div>
                  <button type="button" className="btn small ghost" aria-pressed={locked.has(f.key)} title={locked.has(f.key) ? 'Locked: Sculpt keeps this' : 'Unlocked: Sculpt may change this'} aria-label={`${locked.has(f.key) ? 'Unlock' : 'Lock'} ${f.label}`} onClick={(e) => { e.preventDefault(); toggle(f.key); }}>{locked.has(f.key) ? '🔒' : '🔓'}</button>
                  <button type="button" className="btn small ghost" title="Re-roll this field" aria-label={`Re-roll ${f.label}`} disabled={act.busy || f.type === 'page'} onClick={(e) => { e.preventDefault(); void run(f.key); }}>{busyKey === f.key ? '…' : '🎲'}</button>
                </div>
              </Field>
            );
          })}
          <div className="row">
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void run()}>{busyKey === '*' ? 'Sculpting…' : 'Sculpt'}</button>
            <span className="tiny muted">Fills every empty, unlocked field.</span>
          </div>
          <ErrorBox error={act.error} />
          {notes.map((n, i) => <div key={i} className="small muted" role="status">{n}</div>)}
        </div>
      </section>
      <section className="col-2 stack" style={{ minWidth: 0 }}>
        <div className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Preview</h3>
            <span className="tiny faint">{player ? 'What the players get' : 'Grey boxes are DM-only and become secret blocks'}</span>
          </div>
          {check && !check.ok && <div className="error-box" role="alert">Blocked by the leak check: {check.leaks.map((l) => l.key).join(', ')} repeats DM-only notes and was left out.</div>}
          {!check ? <Loading /> : check.parts.length === 0 ? <Empty>Nothing yet. Fill a field or press Sculpt.</Empty> : check.parts.map((p, i) => (
            <div key={i} style={p.dm ? { borderLeft: '3px solid var(--danger, #b44)', background: 'rgba(128,128,128,.12)', padding: '2px 10px', borderRadius: 4 } : undefined}>
              {p.dm && <div className="tiny faint">DM only</div>}
              <Markdown text={p.md} />
            </div>
          ))}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={act.busy || missing || tpl.target.kind === 'none'} onClick={() => void save()}>Save{tpl.target.kind === 'person' ? ' to People' : tpl.target.kind === 'combat' ? ' statblock' : ''}</button>
            {hasBlock && <button type="button" className="btn" disabled={act.busy || !values.statblock} onClick={() => void toCombat()}>Add to combat</button>}
            {player && <button type="button" className="btn" disabled={act.busy || !check?.text} onClick={() => void readAloud()}>Read aloud</button>}
            {player && <button type="button" className="btn" disabled={act.busy || !check?.text || !check.ok} onClick={() => void send()}>Send to players</button>}
          </div>
          {missing && <span className="tiny muted">Fill the fields marked * to save.</span>}
        </div>
        <History onPick={(vals) => { setValues(vals); setLocked(new Set()); setPageId(undefined); }} tplId={tpl.id} />
      </section>
      {toastNode}
    </div>
  );
}

function History({ tplId, onPick }: { tplId: string; onPick: (v: Values) => void }) {
  const { w } = useWorld();
  const h = useLoad<{ history: { id: string; templateId: string; templateName: string; values: Values; at: string }[] }>(() => w.call('GET', '/sculpt/history'), [w, tplId]);
  const mine = (h.data?.history ?? []).filter((x) => x.templateId === tplId).slice(0, 8);
  if (!mine.length) return null;
  return (
    <details className="card">
      <summary>Recent sculpts</summary>
      <div className="stack">
        {mine.map((x) => <button key={x.id} type="button" className="btn small ghost" style={{ justifyContent: 'space-between' }} onClick={() => onPick(x.values)}><span>{Object.values(x.values).find((v) => v) ?? x.templateName}</span><span className="tiny faint">{new Date(x.at).toLocaleTimeString()}</span></button>)}
      </div>
    </details>
  );
}
