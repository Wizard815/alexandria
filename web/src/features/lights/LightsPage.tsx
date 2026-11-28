// GM → Lights: drivers, light groups, scenes and the event hooks.
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, PageHead, Switch, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';

interface Driver { id: string; kind: string; name: string; enabled: boolean; config: Record<string, any>; paired?: boolean; status: { ok: number; failed: number; lastError: string | null } }
interface Group { id: string; name: string; driverId: string; target: any }
interface Item { group: string; color: string; brightness: number; effect: string; transitionMs: number; off: boolean }
interface Scene { id: string; name: string; items: Item[] }

const KIND_NAMES: Record<string, string> = { wled: 'WLED', hue: 'Philips Hue', ha: 'Home Assistant', openrgb: 'OpenRGB' };

export default function LightsPage() {
  const [tab, setTab] = useState<'drivers' | 'groups' | 'scenes' | 'hooks'>('drivers');
  return (
    <div className="stack loose">
      <PageHead title="Lights" lead="Lights that follow the game. All off until you turn them on." />
      <Tabs label="Lights" value={tab} onChange={setTab} items={[['drivers', 'Drivers'], ['groups', 'Groups'], ['scenes', 'Scenes'], ['hooks', 'Event hooks']]} />
      {tab === 'drivers' && <Drivers />}
      {tab === 'groups' && <Groups />}
      {tab === 'scenes' && <Scenes />}
      {tab === 'hooks' && <Hooks />}
    </div>
  );
}

function Drivers() {
  const { w } = useWorld();
  const list = useLoad(() => w.call<Driver[]>('GET', '/lights/drivers'), [w]);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [kind, setKind] = useState('wled');
  const [name, setName] = useState('');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setCfg({ ...cfg, [k]: v });
  if (!list.data) return <Loading />;
  const add = () => act.run(async () => { await w.call('POST', '/lights/drivers', { kind, name, config: cfg }); setName(''); setCfg({}); await list.reload(); });
  const test = (d: Driver) => act.run(async () => { const r = await w.call<any>('POST', `/lights/drivers/${d.id}/test`, {}); toast(r.ok ? `${d.name}: worked` : `${d.name}: ${r.results.find((x: any) => !x.ok)?.error}`); await list.reload(); });
  const pair = (d: Driver) => act.run(async () => {
    try { await w.call('POST', `/lights/drivers/${d.id}/pair`, {}); toast('Paired'); } catch (e: any) { toast(e.message); }
    await list.reload();
  });
  return (
    <div className="stack">
      <ErrorBox error={list.error || act.error} />
      {list.data.length === 0 && <Empty>No drivers yet.</Empty>}
      {list.data.map((d) => (
        <div key={d.id} className="card row between">
          <span><strong>{d.name}</strong> <span className="tiny muted">{KIND_NAMES[d.kind]} · {d.config.host ?? d.config.baseUrl}{d.kind === 'hue' ? (d.paired ? ' · paired' : ' · not paired') : ''} · {d.status.ok} sent, {d.status.failed} failed{d.status.lastError ? ` (${d.status.lastError})` : ''}</span></span>
          <span className="row">
            {d.kind === 'hue' && !d.paired && <button type="button" className="btn small" onClick={() => void pair(d)}>Pair (press the bridge button first)</button>}
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void test(d)}>Test</button>
            <button type="button" className="btn small ghost" aria-label={`Delete ${d.name}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/lights/drivers/${d.id}`); await list.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
          </span>
        </div>
      ))}
      <div className="card row" style={{ alignItems: 'flex-end' }}>
        <Field label="Kind"><select value={kind} onChange={(e) => { setKind(e.target.value); setCfg({}); }}>{Object.entries(KIND_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Desk strip" /></Field>
        {kind === 'ha' ? (
          <>
            <Field label="Address"><input value={cfg.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)} placeholder="http://homeassistant.local:8123" /></Field>
            <Field label="Long-lived token"><input type="password" value={cfg.token ?? ''} onChange={(e) => set('token', e.target.value)} autoComplete="off" /></Field>
          </>
        ) : (
          <Field label="Host" help={kind === 'openrgb' ? 'The PC running OpenRGB with its SDK server on.' : undefined}><input value={cfg.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.50" /></Field>
        )}
        <button type="button" className="btn primary" disabled={act.busy || !name} onClick={() => void add()}>Add driver</button>
      </div>
      {toastNode}
    </div>
  );
}

function targetHelp(kind: string) {
  return kind === 'hue' ? 'The Hue group number (0 is every light).' : kind === 'ha' ? 'Light entity ids, comma separated, e.g. light.desk, light.shelf.' : kind === 'openrgb' ? 'Device number and LED count, e.g. 0:24, 1:60 (comma separated).' : 'WLED lights the whole device.';
}
const targetOf = (kind: string, text: string) =>
  kind === 'hue' ? { group: text.trim() }
  : kind === 'ha' ? { entities: text.split(/[,\s]+/).filter(Boolean) }
  : kind === 'openrgb' ? { devices: text.split(',').map((p) => p.trim()).filter(Boolean).map((p) => { const [i, l] = p.split(':'); return { index: Number(i), leds: Number(l) }; }) }
  : {};
const textOf = (kind: string, t: any) => kind === 'hue' ? t.group ?? '' : kind === 'ha' ? (t.entities ?? []).join(', ') : kind === 'openrgb' ? (t.devices ?? []).map((x: any) => `${x.index}:${x.leds}`).join(', ') : '';

function Groups() {
  const { w } = useWorld();
  const drivers = useLoad(() => w.call<Driver[]>('GET', '/lights/drivers'), [w]);
  const list = useLoad(() => w.call<Group[]>('GET', '/lights/groups'), [w]);
  const act = useAction();
  const [name, setName] = useState('');
  const [driverId, setDriverId] = useState('');
  const [text, setText] = useState('');
  if (!drivers.data || !list.data) return <Loading />;
  const dr = drivers.data.find((d) => d.id === (driverId || drivers.data![0]?.id));
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>A group is the lights a scene sets together: a whole WLED strip, a Hue group, some Home Assistant lights or some OpenRGB devices.</p>
      <ErrorBox error={list.error || act.error} />
      {list.data.length === 0 && <Empty>No light groups yet.</Empty>}
      {list.data.map((g) => {
        const d = drivers.data!.find((x) => x.id === g.driverId);
        return (
          <div key={g.id} className="card row between">
            <span><strong>{g.name}</strong> <span className="tiny muted">{d?.name} · {textOf(d?.kind ?? '', g.target) || 'whole device'}</span></span>
            <button type="button" className="btn small ghost" aria-label={`Delete ${g.name}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/lights/groups/${g.id}`); await list.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
          </div>
        );
      })}
      {dr ? (
        <div className="card row" style={{ alignItems: 'flex-end' }}>
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ceiling" /></Field>
          <Field label="Driver"><select value={dr.id} onChange={(e) => setDriverId(e.target.value)}>{drivers.data.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Lights" help={targetHelp(dr.kind)}><input value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <button type="button" className="btn primary" disabled={act.busy || !name} onClick={() => void act.run(async () => { await w.call('POST', '/lights/groups', { name, driverId: dr.id, target: targetOf(dr.kind, text) }); setName(''); setText(''); await list.reload(); })}>Add group</button>
        </div>
      ) : <Empty>Add a driver first.</Empty>}
    </div>
  );
}

function Scenes() {
  const { w } = useWorld();
  const list = useLoad(() => w.call<Scene[]>('GET', '/lights/scenes'), [w]);
  const groups = useLoad(() => w.call<Group[]>('GET', '/lights/groups'), [w]);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [e, setE] = useState({ name: '', color: '#ff0000', brightness: 100, effect: '', transitionMs: 400, group: '' });
  if (!list.data || !groups.data) return <Loading />;
  const run = (id: string) => act.run(async () => { await w.call('POST', `/lights/scenes/${id}/run`, {}); toast('Scene sent'); });
  return (
    <div className="stack">
      <ErrorBox error={list.error || act.error} />
      {list.data.length === 0 && <Empty>No scenes yet.</Empty>}
      {list.data.map((s) => (
        <div key={s.id} className="card row between">
          <span className="row"><span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 4, background: s.items[0]?.color, border: '1px solid #8886' }} /><strong>{s.name}</strong> <span className="tiny muted">{s.items[0]?.brightness}%{s.items[0]?.effect ? ` · ${s.items[0].effect}` : ''}</span></span>
          <span className="row">
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void run(s.id)}>Test scene</button>
            <button type="button" className="btn small ghost" aria-label={`Delete ${s.name}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/lights/scenes/${s.id}`); await list.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
          </span>
        </div>
      ))}
      <div className="card row" style={{ alignItems: 'flex-end' }}>
        <Field label="Name"><input value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} placeholder="Combat" /></Field>
        <Field label="Colour"><input type="color" value={e.color} onChange={(x) => setE({ ...e, color: x.target.value })} /></Field>
        <Field label="Brightness %"><input type="number" min={1} max={100} value={e.brightness} onChange={(x) => setE({ ...e, brightness: Number(x.target.value) || 100 })} /></Field>
        <Field label="Effect"><input value={e.effect} onChange={(x) => setE({ ...e, effect: x.target.value })} placeholder="breathe, fire, rainbow…" /></Field>
        <Field label="Fade (ms)"><input type="number" min={0} max={10000} value={e.transitionMs} onChange={(x) => setE({ ...e, transitionMs: Number(x.target.value) || 0 })} /></Field>
        <Field label="Group"><select value={e.group} onChange={(x) => setE({ ...e, group: x.target.value })}><option value="">All groups</option>{groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
        <button type="button" className="btn primary" disabled={act.busy || !e.name} onClick={() => void act.run(async () => { await w.call('POST', '/lights/scenes', e); setE({ ...e, name: '' }); await list.reload(); })}>Add scene</button>
      </div>
      {toastNode}
    </div>
  );
}

const HOOKS: [string, string, boolean][] = [
  ['combatStart', 'Combat starts', true], ['combatEnd', 'Combat ends', true], ['longRest', 'Long rest', true], ['recording', 'Recording starts', true], ['quickEvent', 'A quick event is sent', true],
  ['turn', 'A player’s turn (each player picks a colour)', false], ['damage', 'A player takes damage (short flash)', false], ['mood', 'Music mood (colour follows the mood map)', false],
];

function Hooks() {
  const { w } = useWorld();
  const hooks = useLoad(() => w.call<any>('GET', '/lights/hooks'), [w]);
  const scenes = useLoad(() => w.call<Scene[]>('GET', '/lights/scenes'), [w]);
  const act = useAction();
  if (!hooks.data || !scenes.data) return <Loading />;
  const patch = (body: any) => act.run(async () => { hooks.setData(await w.call('PUT', '/lights/hooks', body)); });
  return (
    <div className="stack">
      <ErrorBox error={hooks.error || act.error} />
      {HOOKS.map(([k, label, hasScene]) => (
        <div key={k} className="card row between">
          <Switch checked={!!hooks.data[k].on} onChange={(v) => void patch({ [k]: { on: v } })} label={label} />
          {hasScene && (
            <select aria-label={`${label}: scene`} value={hooks.data[k].scene} onChange={(e) => void patch({ [k]: { scene: e.target.value } })}>
              <option value="">(choose a scene)</option>{scenes.data!.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>
      ))}
    </div>
  );
}
