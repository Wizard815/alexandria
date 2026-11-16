// Shared by the Connections page, the world pages and the setup flow: the
// types the admin API returns, the form built from a connector's fields, and
// the audience words ("DM only", "Shared with players", "Follows the source").
import { useState } from 'react';
import { Field, Switch } from '../../ui/index.tsx';

export const SECRET = '••••';

export interface ConfigField {
  key: string; label: string; type: 'text' | 'password' | 'url' | 'number' | 'boolean' | 'select' | 'textarea';
  required?: boolean; help?: string; placeholder?: string; options?: [string, string][]; secret?: boolean; default?: unknown;
  showIf?: Record<string, unknown>; scope?: 'connection' | 'source';
}
export interface Preset { id: string; name: string; description: string; config: Record<string, any>; builtin: boolean; unverified: boolean; note?: string }
export interface Connector {
  id: string; label: string; description?: string; fields: ConfigField[]; capabilities?: string[]; push?: boolean;
  group: 'dedicated' | 'generic'; hasConnection: boolean; presets?: Preset[];
}
export interface Connection {
  id: string; name: string; kind: string; connector: { id: string; label: string } | null; config: Record<string, any>; notes: string;
  sources: number; worlds: number; usage?: { source_id: string; source_name: string; world_id: string; world_name: string }[];
}
export type Audience = 'auto' | 'dm' | 'party';
export interface Run { id: string; status: 'running' | 'ok' | 'error' | 'stopped'; started_at: string; finished_at: string | null; stats: Record<string, number>; error: string | null }
export interface Source {
  id: string; world_id: string; kind: string; connector: { id: string; label: string } | null; name: string; config: Record<string, any>;
  connection: { id: string; name: string } | null; audience: Audience; audience_label: string; schedule_minutes: number | null; enabled: boolean; running: boolean;
  last_sync_at: string | null; last_status: string | null; last_run: Run | null; pages: number;
}
export interface Progress {
  phase: 'sync' | 'embed' | 'done'; sources: { total: number; done: number; current: string | null }; fetched: number; saved: number; skipped: number; removed: number;
  errors: number; errorSamples: string[]; levels: { party: number; broker: number; dm: number; classified: number };
  embedding: { state: 'waiting' | 'running' | 'done' | 'no-model' | 'error' | 'cancelled'; model: string | null; pagesTotal: number; pagesDone: number; chunks: number };
}
export interface Crawl { id: string; world_id: string; mode: 'crawl' | 'reindex'; status: 'running' | 'ok' | 'error' | 'stopped'; progress: Progress; error: string | null; started_at: string; finished_at: string | null; running: boolean }

export const SCHEDULES: [string, string][] = [['', 'Only when I press Sync'], ['15', 'Every 15 minutes'], ['60', 'Every hour'], ['360', 'Every 6 hours'], ['1440', 'Every day'], ['10080', 'Every week']];
export const scheduleLabel = (m: number | null) => SCHEDULES.find(([k]) => k === String(m ?? ''))?.[1] ?? `Every ${m} minutes`;

export const AUDIENCES: { id: Audience; label: string; chip: string; text: string }[] = [
  { id: 'auto', label: 'Follows the source', chip: '', text: 'Use the source’s own visibility flags and levels. Anything it does not clearly share stays DM-only. This is the safe default.' },
  { id: 'dm', label: 'DM only', chip: 'red', text: 'Everything from this source is DM-only, whatever the source says.' },
  { id: 'party', label: 'Shared with players', chip: 'teal', text: 'Everything from this source may be shown to players. Use it when the connection already uses a player-level key (for example a Kanka member token that only sees public entries). Secret blocks, broker and classified parts of a page are still hidden.' },
];
export function AudienceChip({ a }: { a: Audience }) {
  const i = AUDIENCES.find((x) => x.id === a) ?? AUDIENCES[0];
  return <span className={`chip ${i.chip}`}>{i.label}</span>;
}

/** Pick an audience. Sharing with players needs an explicit tick, which the caller sends as confirmParty. */
export function AudiencePicker({ value, onChange, confirmed, onConfirm }: { value: Audience; onChange: (a: Audience) => void; confirmed: boolean; onConfirm: (v: boolean) => void }) {
  return (
    <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label">Who is this source for?</legend>
      {AUDIENCES.map((a) => (
        <label key={a.id} className="row top small" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <input type="radio" name="audience" checked={value === a.id} onChange={() => onChange(a.id)} style={{ marginTop: 3 }} />
          <span style={{ flex: 1, minWidth: 0 }}><strong>{a.label}</strong><br /><span className="muted">{a.text}</span></span>
        </label>
      ))}
      {value === 'party' && (
        <label className="row small note" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
          <span>I confirm players may see everything this source gives, including pages it marks private. This is recorded in the audit log.</span>
        </label>
      )}
    </fieldset>
  );
}

export const shown = (f: ConfigField, v: Record<string, any>, fields: ConfigField[]) =>
  !f.showIf || Object.entries(f.showIf).every(([k, want]) => (v[k] ?? fields.find((x) => x.key === k)?.default) === want);

export const scopeOf = (f: ConfigField) => (f.scope === 'connection' ? 'connection' : 'source');

export function defaultsFor(c: Connector | undefined, scope: 'connection' | 'source') {
  const out: Record<string, any> = {};
  for (const f of c?.fields ?? []) if (scopeOf(f) === scope && f.default !== undefined) out[f.key] = f.default;
  return out;
}

/** The settings of one scope the form shows, without empty values. */
export function pickConfig(c: Connector | undefined, v: Record<string, any>, scope: 'connection' | 'source') {
  const out: Record<string, any> = {};
  for (const f of c?.fields ?? []) {
    if (scopeOf(f) !== scope || !shown(f, v, c!.fields)) continue;
    const x = v[f.key];
    if (x === undefined || x === '') continue;
    out[f.key] = f.type === 'number' ? Number(x) : x;
  }
  return out;
}

export function ConfigInput({ f, value, editing, onChange }: { f: ConfigField; value: any; editing: boolean; onChange: (v: any) => void }) {
  const help = f.secret || f.type === 'password'
    ? <>{f.help ? <>{f.help} </> : null}Stored on the server and never shown again.{editing && value === SECRET ? ' Leave it as is to keep it.' : ''}</>
    : f.help;
  if (f.type === 'boolean') return <label className="row small"><Switch checked={!!value} onChange={onChange} label={f.label} /> {f.label}{f.help && <span className="muted"> · {f.help}</span>}</label>;
  const common = { value: value ?? '', placeholder: f.placeholder, required: f.required };
  return (
    <Field label={`${f.label}${f.required ? '' : ' (optional)'}`} help={help}>
      {f.type === 'select' ? (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} required={f.required}>
          {!f.required && <option value="">—</option>}
          {(f.options ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea className="code" rows={4} {...common} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
          className={f.type === 'url' || f.type === 'password' ? 'mono' : undefined} autoComplete={f.type === 'password' ? 'new-password' : 'off'}
          onFocus={(e) => { if (f.type === 'password' && value === SECRET) e.target.select(); }} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

/** The inputs of one scope of a connector. */
export function ConfigFields({ c, scope, v, onChange, editing }: { c: Connector; scope: 'connection' | 'source'; v: Record<string, any>; onChange: (key: string, x: any) => void; editing: boolean }) {
  const list = c.fields.filter((f) => scopeOf(f) === scope && shown(f, v, c.fields));
  return <>{list.map((f) => <ConfigInput key={f.key} f={f} value={v[f.key]} editing={editing} onChange={(x) => onChange(f.key, x)} />)}</>;
}

/** The connectors in the order of the picker: the dedicated ones, then the generic API and its presets. */
export function ConnectorPicker({ connectors, kind, presetId, onPick, only }: {
  connectors: Connector[]; kind: string; presetId: string; onPick: (kind: string, preset: Preset | null) => void; only?: (c: Connector) => boolean;
}) {
  const list = connectors.filter((c) => (only ? only(c) : true));
  const dedicated = list.filter((c) => c.group === 'dedicated');
  const generic = list.find((c) => c.group === 'generic');
  return (
    <div className="stack tight">
      <span className="label">Kind of source</span>
      {dedicated.map((c) => (
        <label key={c.id} className="row top small" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <input type="radio" name="kind" checked={kind === c.id} onChange={() => onPick(c.id, null)} style={{ marginTop: 3 }} />
          <span style={{ flex: 1, minWidth: 0 }}><strong>{c.label}</strong>{c.description && <><br /><span className="muted">{c.description}</span></>}</span>
        </label>
      ))}
      {generic && (
        <>
          <span className="label" style={{ marginTop: 6 }}>Generic API</span>
          <label className="row top small" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <input type="radio" name="kind" checked={kind === generic.id && !presetId} onChange={() => onPick(generic.id, null)} style={{ marginTop: 3 }} />
            <span style={{ flex: 1, minWidth: 0 }}><strong>{generic.label}</strong><br /><span className="muted">Map the fields yourself.</span></span>
          </label>
          {(generic.presets ?? []).map((p) => (
            <label key={p.id} className="row top small" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input type="radio" name="kind" checked={kind === generic.id && presetId === p.id} onChange={() => onPick(generic.id, p)} style={{ marginTop: 3 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{p.name}</strong> {p.unverified && <span className="chip gold">Community example · unverified</span>}
                <br /><span className="muted">{p.description}</span>
                {p.note && <><br /><span className="tiny muted">{p.note}</span></>}
              </span>
            </label>
          ))}
        </>
      )}
    </div>
  );
}

/** A mono block with a Copy button. */
export function CopyBox({ text, rows = 8 }: { text: string; rows?: number }) {
  const [done, setDone] = useState(false);
  return (
    <div className="stack tight">
      <textarea readOnly className="mono" rows={rows} value={text} onFocus={(e) => e.target.select()} aria-label="JSON" />
      <div className="row end"><button type="button" className="btn small" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false)); }}>{done ? 'Copied' : 'Copy'}</button></div>
    </div>
  );
}
