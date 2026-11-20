// Remote: the desktop's table controls under a thumb. Macros (when the
// actions feature is there), sound pads, the music mood, ambience scenes,
// rests, "speak this" and staged cards.
import { useRef, useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { useAction } from '../../ui/index.tsx';
import { loadSpeakers, saveSpeakers } from '../sound/engine.ts';
import { Err } from './Sheet.tsx';
import { InstallHint } from '../../lib/install.tsx';
import { buzz, useFlash } from './hooks.ts';

const safe = <T,>(p: Promise<T>, d: T): Promise<T> => p.catch(() => d);

export default function RemoteTab() {
  const { w } = useWorld();
  const act = useAction();
  const { msg, flash } = useFlash();
  const [text, setText] = useState('');
  const [preset, setPreset] = useState('');
  const [dot, setDot] = useState<{ x: number; y: number } | null>(null);
  const mood = useRef<HTMLDivElement>(null);
  const [tableSound, setTableSound] = useState(() => loadSpeakers().tableOn);

  // The actions feature is built separately. Without it (404) the section is hidden.
  const macros = useLoad<any[] | null>(() => safe(w.call<any>('GET', '/actions/macros').then((r) => (Array.isArray(r) ? r : r?.macros ?? [])), null), [w], ['actions']);
  const pads = useLoad<{ id: string; label: string; sfx?: boolean }[]>(async () => {
    const p = await safe(w.call<any[]>('GET', '/sound/pads'), []);
    if (p.length) return p.map((x) => ({ id: x.id, label: x.label }));
    const lib = await safe(w.call<any>('GET', '/sound/library'), { sfx: [] });
    return (lib.sfx ?? []).slice(0, 12).map((x: any) => ({ id: x.id, label: x.name, sfx: true }));
  }, [w]);
  const scenes = useLoad<any[]>(() => safe(w.call<any[]>('GET', '/sound/scenes'), []), [w]);
  const presets = useLoad<any[]>(() => safe(w.call<any[]>('GET', '/voice/presets'), []), [w]);
  const stage = useLoad<any>(() => safe(w.call<any>('GET', '/stage'), { cards: [] }), [w], ['stage']);

  const go = (label: string, fn: () => Promise<unknown>) => act.run(async () => { buzz(15); await fn(); flash(label); });
  const pinned = (macros.data ?? []).filter((m: any) => m.pinned !== false).slice(0, 8);
  const cards: any[] = stage.data?.cards ?? [];
  const title = (c: any) => c.label || c.data?.title || c.data?.name || c.kind;

  const moodPoint = (e: React.PointerEvent) => {
    const r = mood.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };

  const speak = () => go('Speaking', async () => {
    const id = preset || presets.data?.[0]?.id;
    if (!id || !text.trim()) return;
    try { await w.call('POST', '/voice/speak', { text: text.trim(), presetId: id }); } catch (e: any) {
      if (/DM-only|Confirm/i.test(e.message ?? '') && confirm(`${e.message}\n\nSpeak it anyway?`)) await w.call('POST', '/voice/speak', { text: text.trim(), presetId: id, confirm: true });
      else throw e;
    }
    setText('');
  });

  return (
    <>
      <Err error={act.error} />
      {msg && <div className="pill green" role="status" style={{ alignSelf: 'center', minHeight: 32 }}>{msg}</div>}

      {pinned.length > 0 && (
        <section className="c" aria-label="Macros">
          <h3>Macros</h3>
          <div className="grid g2">{pinned.map((m: any) => <button key={m.id} type="button" className="b big" disabled={act.busy} onClick={() => void go(`Ran ${m.name}`, () => w.call('POST', `/actions/macros/${encodeURIComponent(m.id)}/run`, {}))}>{m.name}</button>)}</div>
        </section>
      )}

      <section className="c" aria-label="Sound pads">
        <h3>Sound pads</h3>
        {pads.data?.length ? <div className="grid g3">{pads.data.map((p) => <button key={p.id} type="button" className="b" style={{ minHeight: 64 }} disabled={act.busy} onClick={() => void go(`Played ${p.label}`, () => w.call('POST', '/sound/sfx/play', p.sfx ? { id: p.id } : { padId: p.id }))}>{p.label}</button>)}</div>
          : <div className="empty">No sound effects yet. Add pads on the desktop sound board.</div>}
        <button type="button" className="b danger big full" disabled={act.busy} onClick={() => void go('Stopped all', async () => { await Promise.all([w.call('POST', '/sound/music/stop', {}), w.call('POST', '/sound/ambience/stop', {})]); })}><i className="fa-solid fa-stop" aria-hidden="true" /> Stop all sound</button>
      </section>

      <section className="c" aria-label="Music mood">
        <h3>Music mood</h3>
        <div ref={mood} className="mood" role="application" aria-label="Mood map: Calm top left, Tense top right, Sneaky bottom left, Combat bottom right"
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDot(moodPoint(e)); }}
          onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') setDot((d) => (d ? moodPoint(e) : d)); }}
          onPointerUp={(e) => { const p = moodPoint(e); setDot(null); void go('Mood set', () => w.call('POST', '/sound/music/mood', p)); }}
          onPointerCancel={() => setDot(null)}>
          <span className="k" style={{ left: 8, top: 6 }}>Calm</span><span className="k" style={{ right: 8, top: 6 }}>Tense</span>
          <span className="k" style={{ left: 8, bottom: 6 }}>Sneaky</span><span className="k" style={{ right: 8, bottom: 6 }}>Combat</span>
          {dot && <span className="dot" style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%` }} />}
        </div>
      </section>

      {scenes.data && scenes.data.length > 0 && (
        <section className="c" aria-label="Ambience scenes">
          <h3>Ambience</h3>
          <div className="grid g2">{scenes.data.map((s: any) => <button key={s.id} type="button" className="b" disabled={act.busy} onClick={() => void go(`Scene: ${s.name}`, () => w.call('POST', `/sound/scenes/${s.id}/play`, {}))}>{s.name}</button>)}</div>
        </section>
      )}

      <section className="c" aria-label="Time">
        <h3>Rests and days</h3>
        <div className="grid g3">
          {([['short-rest', 'Short rest'], ['long-rest', 'Long rest'], ['next-day', 'Next day']] as const).map(([p, l]) => (
            <button key={p} type="button" className="b big" style={{ fontSize: 16 }} disabled={act.busy} onClick={() => void go(l, async () => { await w.call('POST', '/clock/advance', { preset: p, reason: 'From the phone' }); })}>{l}</button>
          ))}
        </div>
      </section>

      <section className="c" aria-label="Speak">
        <h3>Speak</h3>
        {presets.data?.length ? (
          <>
            <label className="f">Voice<select value={preset || presets.data[0].id} onChange={(e) => setPreset(e.target.value)}>{presets.data.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="f">Say<textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What the voice says…" /></label>
            <button type="button" className="b primary big full" disabled={act.busy || !text.trim()} onClick={() => void speak()}><i className="fa-solid fa-comment-dots" aria-hidden="true" /> Speak</button>
          </>
        ) : <div className="empty">No voice presets yet. Make one on the desktop (Voice).</div>}
      </section>

      <section className="c" aria-label="Show on stage">
        <h3>Show on stage</h3>
        {cards.length ? (
          <div className="grid">{cards.map((c) => (
            <button key={c.id} type="button" className={`b${c.shownAt ? ' on' : ''}`} style={{ justifyContent: 'space-between' }} disabled={act.busy}
              onClick={() => void go(c.shownAt ? `Hid ${title(c)}` : `Showing ${title(c)}`, async () => { await w.call('POST', `/stage/cards/${c.id}/${c.shownAt ? 'hide' : 'show'}`, c.shownAt ? {} : { to: 'all' }); await stage.reload(); })}>
              <span className="tx" style={{ textAlign: 'left' }}>{title(c)}</span><span className="pill">{c.shownAt ? 'On stage · hide' : 'Show'}</span>
            </button>
          ))}</div>
        ) : <div className="empty">Nothing staged. Prepare cards on the desktop Stage.</div>}
      </section>

      <section className="c" aria-label="This phone">
        <h3>This phone</h3>
        <button type="button" className={`b${tableSound ? ' on' : ''}`} aria-pressed={tableSound} onClick={() => { const s = loadSpeakers(); saveSpeakers({ ...s, tableOn: !tableSound }); setTableSound(!tableSound); }}>{tableSound ? 'Table sound plays on this phone' : 'Table sound stays off this phone'}</button>
        <span className="tiny">Pads and music play where the desktop is. Turn this on only if this phone is the table speaker.</span>
      </section>
      <InstallHint />
    </>
  );
}
