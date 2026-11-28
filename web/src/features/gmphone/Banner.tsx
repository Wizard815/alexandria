// On the GM's table page at phone width: a dismissible link to the phone assistant.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { lsGet, lsSet } from './hooks.ts';
import './gmphone.css';

export default function PhoneBanner() {
  const { info } = useWorld();
  const key = `alx.gmphone.banner.${info.id}`;
  const [hidden, setHidden] = useState(() => lsGet(key) === 'dismissed');
  if (hidden) return null;
  return (
    <div className="gmp-banner t-fantasy" data-testid="phone-banner" role="region" aria-label="Phone assistant">
      <Link to={`/w/${info.slug}/gm/phone`}><i className="fa-solid fa-mobile-screen" aria-hidden="true" /> Open the phone assistant</Link>
      <button type="button" aria-label="Dismiss" onClick={() => { lsSet(key, 'dismissed'); setHidden(true); }}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
    </div>
  );
}
