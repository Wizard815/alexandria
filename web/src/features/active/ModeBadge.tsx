// The Assistant / Active badge: visible on every DM screen, one tap to switch.
import { Link } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { useActive } from './shared.tsx';

export default function ModeBadge({ phone = false }: { phone?: boolean }) {
  const { w, info } = useWorld();
  const st = useActive();
  if (info?.role !== 'dm' || !st.data) return null;
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
      {!phone && <Link to={`/w/${info.slug}/dm/active`} className="tiny muted" style={{ textDecoration: 'none' }} aria-label="Active mode settings"><i className="fa-solid fa-gear" aria-hidden="true" /></Link>}
    </span>
  );
}
