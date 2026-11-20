// DM → Players' screen: the remote for the TV facing the table, and where its pictures come from.
import { useWorld } from '../../lib/world.tsx';
import { PageHead } from '../../ui/index.tsx';
import { PlayerScreenControls, PictureSources } from './Controls.tsx';

export default function PlayerScreenPage() {
  const { info } = useWorld();
  return (
    <div className="page">
      <PageHead title="Players' screen" lead="The TV facing the table shows the stage cards you have shown to everyone and the fight, as players see them. Queue a video or pictures here to put them on top.">
        <a className="btn small" href={`/w/${info.slug}/screen/players`} target="_blank" rel="noopener">Open the screen</a>
      </PageHead>
      <div className="cols">
        <section className="card col-2" aria-label="Controls"><PlayerScreenControls /></section>
        <section className="card col-2" aria-label="Pictures"><PictureSources /></section>
      </div>
    </div>
  );
}
