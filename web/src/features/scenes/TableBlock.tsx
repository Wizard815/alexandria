// Scenes on the GM's Table: one press sets the TV, sound, lights and the table map.
import { TableCard } from '../../ui/TableCard.tsx';
import { SceneButtons } from './ScenePanel.tsx';
import { useScenes } from './useScenes.ts';

export default function TableScenes() {
  const api = useScenes();
  if (api.loading && !api.scenes.length) return null;
  if (!api.scenes.length) return <TableCard id="scenes" title="Scenes" icon="fa-clapperboard" link={['scenes', 'Make one']} quiet="No scenes yet: one button can set the TV, sound, lights and map." />;
  return (
    <TableCard id="scenes" title="Scenes" icon="fa-clapperboard" link={['scenes', 'Scenes']} badge={api.last ? `now: ${api.last.name}` : undefined} className="tb-scenes">
      <SceneButtons api={api} />
    </TableCard>
  );
}
