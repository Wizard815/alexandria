// A player picks the colour the lights show on their turn.
import { useState } from 'react';
import { ErrorBox, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';

export default function MyColour() {
  const { w } = useWorld();
  const mine = useLoad(() => w.call<{ color: string | null }>('GET', '/lights/me'), [w]);
  const act = useAction();
  const [pick, setPick] = useState<string | null>(null);
  if (!mine.data) return <Loading />;
  const color = pick ?? mine.data.color ?? '#ffffff';
  return (
    <div className="stack loose">
      <PageHead title="My light colour" lead="If your GM uses table lights, they show this colour on your turn." />
      <ErrorBox error={mine.error || act.error} />
      <div className="card row" style={{ alignItems: 'flex-end' }}>
        <input type="color" aria-label="Colour" value={color} onChange={(e) => setPick(e.target.value)} />
        <button type="button" className="btn primary" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('PUT', '/lights/me', { color }); await mine.reload(); })}>Save</button>
        {mine.data.color && <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('PUT', '/lights/me', { color: null }); setPick(null); await mine.reload(); })}>Clear</button>}
      </div>
    </div>
  );
}
