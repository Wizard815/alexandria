// GM → Players' screen: the remote for the TV facing the table, and where its pictures come from.
import { useWorld } from '../../lib/world.tsx';
import { PageHead } from '../../ui/index.tsx';
import { PlayerScreenControls, PictureSources } from './Controls.tsx';

export default function PlayerScreenPage() {
  const { info } = useWorld();
  return (
    <div className="page">
      <PageHead title="Players’ TV" lead="What the TV facing the table shows. Queue a video or pictures to put them on top.">
        <a className="btn small" href={`/w/${info.slug}/screen/players`} target="_blank" rel="noopener">Open the screen</a>
      </PageHead>
      <div className="cols">
        <section className="card col-2" aria-label="Controls"><PlayerScreenControls /></section>
        <section className="card col-2" aria-label="Pictures"><PictureSources /></section>
      </div>
    </div>
  );
}
