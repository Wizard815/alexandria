// The page of a feature that is a server mod (WebFeature.serverMod): shown while the rule is on, a plain note while
// it is off. The route itself always exists, so a link or a reload never bounces to the home page.
import type { ReactNode } from 'react';
import { modOn, useServerMods } from '../lib/servermods.ts';
import { Loading } from '../ui/index.tsx';

export default function ServerModGate({ id, children }: { id: string; children?: ReactNode }) {
  const on = useServerMods();
  if (!on) return <Loading />;
  if (modOn(id, on)) return <>{children}</>;
  return (
    <div className="page" data-testid="servermod-off">
      <div className="card"><p className="muted">This page belongs to a server rule (<span className="mono">{id}</span>) that is turned off on this server. The server admin turns it on under Admin → Mods.</p></div>
    </div>
  );
}
