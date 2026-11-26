// The player sheet: a small, modular companion to the paper character sheet
// that each player arranges and fills in, and the DM's status bar with every
// player's health and mana. See librarian/src/features/sheet.
import { useSearchParams } from 'react-router-dom';
import type { WebFeature } from '../registry.ts';
import { useWorld } from '../../lib/world.tsx';
import { Empty, PageHead, Tabs } from '../../ui/index.tsx';
import Sheet from './Sheet.tsx';
import PartyStatusBar from './StatusBar.tsx';
import { CSS, ChangeLog } from './shared.tsx';

function PlayerSheetPage() {
  return (
    <div className="page">
      <style>{CSS}</style>
      <PageHead title="Sheet" lead="Your quick sheet next to the paper one. Tap Arrange to add, move or hide modules." />
      <Sheet account="me" />
    </div>
  );
}

function DMSheetsPage() {
  const { members } = useWorld();
  const [q, setQ] = useSearchParams();
  const players = members.filter((m) => m.role === 'player');
  const pick = q.get('player');
  const cur = players.find((p) => p.id === pick)?.id ?? 'log';
  return (
    <div className="page">
      <style>{CSS}</style>
      <PageHead title="Player sheets" lead="Each player's sheet as they arranged it (private modules stay private), and every HP and mana change." />
      {!players.length ? <Empty>No players in this world yet.</Empty> : <>
        <Tabs label="Player" value={cur} onChange={(v) => setQ(v === 'log' ? {} : { player: v }, { replace: true })}
          items={[['log', 'All changes'], ...players.map((p) => [p.id, p.character_name || p.display_name] as [string, string])]} />
        {cur === 'log' ? <section className="card"><ChangeLog account={null} limit={200} /></section> : <Sheet key={cur} account={cur} />}
      </>}
    </div>
  );
}

function Band() {
  return <><style>{CSS}</style><PartyStatusBar /></>;
}

const feature: WebFeature = {
  id: 'sheet',
  playerRoutes: [{ path: 'sheet', element: <PlayerSheetPage /> }],
  dmRoutes: [{ path: 'sheets', element: <DMSheetsPage /> }],
  playerNav: [{ to: 'sheet', label: 'Sheet', icon: 'fa-id-card' }],
  dmNav: [{ to: 'sheets' }],
  dmBand: Band,
};
export default feature;
