// The Assistant / Active badge: visible on every GM screen, one tap to switch.
import { Link, useLocation } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { useActive } from './shared.tsx';

export default function ModeBadge({ phone = false }: { phone?: boolean }) {
  const { w, info } = useWorld();
  const st = useActive();
  const loc = useLocation();
  // The phone assistant covers the whole screen and has its own badge.
  if (info?.role !== 'dm' || !st.data || (!phone && /\/gm\/phone\/?$/.test(loc.pathname))) return null;
  const s = st.data;
  const active = s.effective === 'active';
  const label = s.takeoverOn ? 'Takeover' : active ? 'Active' : 'Assistant';
  const flip = async () => { await w.call('PUT', '/active', { mode: active ? 'assistant' : 'active', sessionOnly: s.recording && s.sessionOverride !== null ? true : undefined }); await st.reload(); };
  return (
    <span className="act-badge-wrap" data-testid="mode-badge">
      <button type="button" className={`chip act-badge${active ? ' on' : ''}${phone ? ' phone' : ''}`} aria-pressed={active} onClick={() => void flip()}
        title={active ? 'Active mode: I listen to the table while recording and act on what I hear. Tap to switch to Assistant.' : 'Assistant mode: I act only when you ask. Tap to switch to Active.'}>
        <span className="act-dot" aria-hidden="true" />{label}{s.sessionOverride ? ' (this recording)' : ''}{s.cards.length > 0 ? ` · ${s.cards.length}` : ''}
      </button>
      {!phone && <Link to={`/w/${info.slug}/gm/active`} className="tiny muted" style={{ textDecoration: 'none' }} aria-label="Active mode settings"><i className="fa-solid fa-gear" aria-hidden="true" /></Link>}
    </span>
  );
}
