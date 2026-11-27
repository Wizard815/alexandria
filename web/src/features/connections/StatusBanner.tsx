// What the GM should know about a world's sources, in plain words: why players see nothing (and what to do), a key the site refuses for page
// content, and a wait for the site. Used on the world page (admin) and at the top of the GM's library. Players never see it.
import { useEffect, useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';

export interface WorldStatus {
  pages: number;
  levels: { party: number; broker: number; dm: number; classified: number };
  dmOnly: null | { pages: number; reasons: { sourceId: string; source: string; kind: string; count: number; text: string }[]; actions: string[] };
  refused: { sourceId: string; source: string; message: string }[];
  waiting: null | { seconds: number; reason: 'asked' | 'limit'; source: string };
}

/** "Waiting for the site (12 s)" while a page somebody opened is held back by the site's limit. */
export const waitText = (w: WorldStatus['waiting']) => (w ? `Waiting for the site (${w.seconds} s)${w.reason === 'asked' ? ': it asked us to slow down' : ''}` : null);

/** The GM's banner. Pass `status` when the page already has it (the world page); otherwise it is loaded here. */
export function StatusBanner({ status, compact = false }: { status?: WorldStatus | null; compact?: boolean }) {
  return status !== undefined ? <Banner s={status} compact={compact} /> : <LoadedBanner compact={compact} />;
}

function LoadedBanner({ compact }: { compact: boolean }) {
  const { w, isDM } = useWorld();
  const st = useLoad<WorldStatus>(() => (isDM ? w.call<WorldStatus>('GET', '/world-sources/status') : Promise.resolve(null as unknown as WorldStatus)), [w, isDM], ['page', 'tiers', 'crawl']);
  const fast = !!st.data?.waiting;
  useEffect(() => {
    if (!isDM) return;
    const t = setInterval(() => void st.reload(), fast ? 2000 : 20000);
    return () => clearInterval(t);
  }, [isDM, fast, st]);
  return <Banner s={st.data} compact={compact} />;
}

function Banner({ s, compact }: { s: WorldStatus | null | undefined; compact: boolean }) {
  if (!s) return null;
  const wait = waitText(s.waiting);
  if (!s.dmOnly && !s.refused.length && !wait) return null;
  return (
    <div className="stack tight" data-testid="source-status">
      {wait && <div role="status" className="note small" style={{ borderStyle: 'solid', borderColor: 'var(--accent)', color: 'var(--accent-strong)' }}>{wait}</div>}
      {s.dmOnly && (
        <div className="note stack tight" role="status" data-testid="dm-only-banner" style={{ borderStyle: 'solid', borderColor: 'var(--accent)', color: 'var(--text)' }}>
          <strong>Players can't see anything yet.</strong>
          <span className="small">All {s.dmOnly.pages.toLocaleString()} page{s.dmOnly.pages === 1 ? ' is' : 's are'} GM-only{compact ? '.' : ', so the table sees an empty library. Why:'}</span>
          {!compact && s.dmOnly.reasons.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{s.dmOnly.reasons.map((r, i) => <li key={`${r.sourceId}-${r.kind}-${i}`}>{r.text}</li>)}</ul>}
          {s.dmOnly.actions.length > 0 && <><span className="small"><strong>What to do</strong></span><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{s.dmOnly.actions.map((a, i) => <li key={i}>{a}</li>)}</ul></>}
        </div>
      )}
      {s.refused.map((r) => <div key={r.sourceId} role="alert" className="error-box small"><strong>{r.source}.</strong> {r.message}</div>)}
    </div>
  );
}

/** Shown under "Loading page" while a page is being read from its source: how long the site is making it wait. */
export function WaitingForSite() {
  const { w, isDM } = useWorld();
  const [s, setS] = useState<WorldStatus['waiting']>(null);
  useEffect(() => {
    if (!isDM) return;
    let live = true;
    const look = () => { w.call<WorldStatus>('GET', '/world-sources/status').then((x) => { if (live) setS(x.waiting); }).catch(() => {}); };
    const first = setTimeout(look, 1200);
    const t = setInterval(look, 1500);
    return () => { live = false; clearTimeout(first); clearInterval(t); };
  }, [w, isDM]);
  const text = waitText(s);
  return text ? <div role="status" className="small" style={{ color: 'var(--accent-strong)', padding: '0 14px 10px' }}>{text}</div> : null;
}
