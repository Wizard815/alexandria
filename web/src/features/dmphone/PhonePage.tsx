// The DM phone assistant at /w/:world/dm/phone: five tabs, one job each.
// A near-square screen (a Fold's inner screen) shows two panes: the chosen
// tab beside Ask, with the tabs as a side rail.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { OfflineBanner } from '../../ui/index.tsx';
import { loadSpeakers, saveSpeakers } from '../sound/engine.ts';
import NowTab, { type Summary } from './NowTab.tsx';
import RemoteTab from './RemoteTab.tsx';
import QueueTab from './QueueTab.tsx';
import AskTab from './AskTab.tsx';
import NotesTab from './NotesTab.tsx';
import { buzz, lsGet, lsSet, useShape, useUndo } from './hooks.ts';
import './dmphone.css';

type Tab = 'now' | 'remote' | 'queue' | 'ask' | 'notes';
const TABS: [Tab, string, string][] = [['now', 'Now', 'fa-shield-halved'], ['remote', 'Remote', 'fa-sliders'], ['queue', 'Queue', 'fa-inbox'], ['ask', 'Ask', 'fa-comments'], ['notes', 'Notes', 'fa-pen-to-square']];
const LABELS: Record<Tab, string> = { now: 'Now', remote: 'Remote', queue: 'Queue', ask: 'Ask', notes: 'Notes' };

export default function PhonePage() {
  const { w, info, connected } = useWorld();
  const shape = useShape();
  const key = `alx.dmphone.tab.${info.id}`;
  const [tab, setTab] = useState<Tab>(() => { const t = lsGet(key); return (TABS.some((x) => x[0] === t) ? t : 'now') as Tab; });
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set<Tab>(['now', 'ask']));
  const { undo, show, clear } = useUndo();
  const sum = useLoad<Summary>(() => w.call<Summary>('GET', '/dmphone/summary?next=2'), [w], ['combat', 'approval', 'coin', 'item', 'item-removed', 'request', 'broker', 'clock', 'recording', 'agent', 'models-warm']);

  const pick = (t: Tab) => { buzz(8); setTab(t); lsSet(key, t); setSeen((s) => (s.has(t) ? s : new Set(s).add(t))); };
  const left: Tab = shape.wide && tab === 'ask' ? 'now' : tab;
  const visible = (k: Tab) => (shape.wide ? k === left || k === 'ask' : k === tab);
  useEffect(() => { if (shape.wide) setSeen((s) => (s.has(left) ? s : new Set(s).add(left))); }, [shape.wide, left]);

  // The desktop plays the table's sound. This phone stays quiet unless the DM turns it on in Remote.
  useEffect(() => {
    if (lsGet('alx.dmphone.soundInit')) return;
    lsSet('alx.dmphone.soundInit', '1');
    saveSpeakers({ ...loadSpeakers(), tableOn: false });
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = 'hidden';
    return () => { el.style.overflow = prev; };
  }, []);

  const badge = (t: Tab) => (t === 'queue' ? sum.data?.counts.all ?? 0 : 0);
  const body = (k: Tab) => {
    if (!seen.has(k)) return null;
    return k === 'now' ? <NowTab sum={sum} onUndo={show} goQueue={() => pick('queue')} />
      : k === 'remote' ? <RemoteTab />
        : k === 'queue' ? <QueueTab />
          : k === 'notes' ? <NotesTab /> : <AskTab />;
  };

  return (
    <div className={`dmp${shape.wide ? ' wide' : ''}`} data-testid="dmphone" data-layout={shape.wide ? 'two-pane' : 'one-pane'}>
      <div className="dmp-col">
        <header className="dmp-top">
          <Link to={`/w/${info.slug}/dm`} className="b" style={{ minHeight: 40, padding: '0 10px', textDecoration: 'none' }} aria-label="Back to the desktop view"><i className="fa-solid fa-arrow-left" aria-hidden="true" /></Link>
          <span className="brand">{info.name}</span>
          <span className="date" data-testid="phone-date"><span className={`live-dot${connected ? '' : ' off'}`} style={{ marginRight: 6 }} />{sum.data?.date.label ?? ''}</span>
        </header>
        <OfflineBanner />
        <div className={`dmp-main${shape.wide ? ' rail' : ''}`}>
          <div className="dmp-panes">
            {(['now', 'remote', 'queue', 'notes', 'ask'] as Tab[]).map((k) => (
              <section key={k} className="dmp-pane" role="tabpanel" aria-label={LABELS[k]} hidden={!visible(k)} style={{ order: k === 'ask' ? 9 : 1, display: visible(k) ? 'flex' : 'none' }}>
                {k === 'ask' ? body(k) : <div className="dmp-body">{body(k)}</div>}
              </section>
            ))}
          </div>
          <nav className="dmp-tabs" role="tablist" aria-label="Phone assistant">
            {TABS.map(([k, label, icon]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className="dmp-tab" onClick={() => pick(k)} aria-label={badge(k) ? `${label}, ${badge(k)} waiting` : label}>
                <i className={`fa-solid ${icon}`} aria-hidden="true" />{label}
                {badge(k) > 0 && <span className="dmp-badge" aria-hidden="true">{badge(k)}</span>}
              </button>
            ))}
          </nav>
        </div>
      </div>
      {undo && <div className="dmp-undo" role="status"><span className="grow tx">{undo.text}</span><button type="button" className="b" onClick={() => { buzz(10); undo.undo(); clear(); }}>Undo</button></div>}
    </div>
  );
}
