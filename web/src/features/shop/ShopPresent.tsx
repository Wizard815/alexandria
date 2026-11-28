// A shopkeeper walks up: when the GM (or an NPC encounter) sends a shop to
// this player, a card pops up in the corner with the keeper's line and a
// button to browse. Players only; the GM never gets these.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';

interface Present { shopId: string; shopName: string; keeper: string | null; role: string | null; message: string | null }

export default function ShopPresent() {
  const { info, on } = useWorld();
  const nav = useNavigate();
  const [cur, setCur] = useState<Present | null>(null);
  const player = info.role === 'player';
  useEffect(() => {
    if (!player) return;
    return on(['shop-present'], (e) => setCur(e.data as Present));
  }, [on, player]);
  if (!player || !cur) return null;
  const who = cur.keeper ? `${cur.keeper}${cur.role ? `, ${cur.role},` : ''}` : 'A shopkeeper';
  return (
    <div className="card stack tight shop-present" role="dialog" aria-live="polite" aria-label={`${cur.shopName} offers its wares`} data-testid="shop-present">
      <strong>{cur.shopName}</strong>
      <span className="small">{who} waves you over.</span>
      {cur.message && <span className="small read">“{cur.message}”</span>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn small ghost" onClick={() => setCur(null)}>Not now</button>
        <button type="button" className="btn small primary" onClick={() => { nav(`/w/${info.slug}/shop?shop=${encodeURIComponent(cur.shopId)}`); setCur(null); }}>Browse</button>
      </div>
    </div>
  );
}
