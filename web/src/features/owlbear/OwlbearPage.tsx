// DM → Owlbear Rodeo: link an Owlbear Rodeo room to this world for casual online play. The extension is served by this
// Alexandria server; here the DM gets its address, makes the link key, picks the map picture the Owlbear scene shows
// and who leads the fog of war.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { CopyButton } from '../../lib/copy.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead, useAction } from '../../ui/index.tsx';

interface Picture { value: string; label: string; group: 'source' | 'library' }
interface Status {
  manifestUrl: string; secure: boolean; version: string;
  key: { prefix: string; createdAt: string } | null;
  lastSeen: string | null; online: boolean; room: string | null; player: string | null; pushedAt: string | null;
  pictures: Picture[];
  link: { follow: boolean; mapId: string | null; pic: string | null; lead: 'alexandria' | 'owlbear'; cells: number } | null;
  target: { mapId: string; pic: string | null; label: string | null; hidden: boolean } | null;
  fog: { enabled: boolean; version: number } | null;
}

const FOLLOW = '__table__';
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};

export default function OwlbearPage() {
  const { w } = useWorld();
  const st = useLoad<Status>(() => w.call('GET', '/owlbear'), [w], ['owlbear', 'table-display', 'fog', 'libfile', 'page']);
  if (!st.data) return <div className="stack loose"><PageHead title="Owlbear Rodeo" /><ErrorBox error={st.error} />{!st.error && <Loading />}</div>;
  const s = st.data;
  return (
    <div className="stack loose" data-testid="owlbear-page">
      <PageHead title="Owlbear Rodeo" lead="Play a casual online session on an Owlbear Rodeo table, with this world's map pictures and fog of war." />
      <StatusCard s={s} />
      <Install s={s} reload={st.reload} />
      {s.link && <LinkCard s={s} reload={st.reload} />}
    </div>
  );
}

function StatusCard({ s }: { s: Status }) {
  return (
    <section className="card row" aria-label="Connection" style={{ justifyContent: 'space-between' }}>
      <span className="row">
        <i className="fa-solid fa-circle" aria-hidden="true" style={{ color: s.online ? '#3fa66b' : 'var(--faint, #888)' }} />
        <span className="stack tight">
          <strong style={{ fontWeight: 500 }} data-testid="owlbear-online">{s.online ? `Connected${s.player ? ` (${s.player} is the GM)` : ''}` : s.key ? 'Not connected' : 'Not set up'}</strong>
          <span className="small muted">
            {s.key ? `The extension was last seen ${ago(s.lastSeen)}.` : 'Make a link key below to start.'}
            {s.target?.label ? ` Owlbear shows ${s.target.label}.` : ''}
            {s.link?.lead === 'owlbear' && s.pushedAt ? ` Owlbear's fog last came in ${ago(s.pushedAt)}.` : ''}
          </span>
        </span>
      </span>
    </section>
  );
}

function Install({ s, reload }: { s: Status; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const { client } = useAuth();
  const act = useAction();
  const [key, setKey] = useState<string | null>(null);
  // The address people use for Alexandria: the extension is on the same server.
  const origin = /^https?:\/\//.test(client.baseUrl) ? client.baseUrl : window.location.origin;
  const manifest = origin.startsWith('http') ? `${origin.replace(/\/+$/, '')}/owlbear/manifest.json` : s.manifestUrl;
  const insecure = manifest.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(manifest);
  const makeKey = () => act.run(async () => {
    if (s.key && !window.confirm('A new key unlinks the Owlbear room you linked before (paste the new key there). Make a new one?')) return;
    const r = await w.call<{ key: string }>('POST', '/owlbear/key', {});
    setKey(r.key);
    await reload();
  });
  const unlink = () => act.run(async () => {
    if (!window.confirm('Unlink Owlbear Rodeo? The extension stops working until you make a new key.')) return;
    await w.call('DELETE', '/owlbear/key');
    setKey(null);
    await reload();
  });
  return (
    <section className="card stack" aria-label="Set up">
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Set up</h2>
      <ErrorBox error={act.error} />
      {insecure && <p className="small" role="note" style={{ margin: 0 }}><i className="fa-solid fa-triangle-exclamation" aria-hidden="true" /> Owlbear Rodeo only loads extensions over HTTPS. Open Alexandria through its HTTPS address (see Hosting) and come back here.</p>}
      <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>Add the extension in Owlbear Rodeo.</strong> <span className="small muted">On your Owlbear Rodeo profile: Extensions → Add Custom Extension, paste this address, then turn it on for your room.</span></span>
          <span className="row" style={{ flexWrap: 'wrap' }}>
            <code style={{ userSelect: 'all', wordBreak: 'break-all' }} data-testid="owlbear-manifest">{manifest}</code>
            <CopyButton text={manifest} label="Copy address" />
          </span>
        </li>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>Make a link key and paste it in the extension.</strong> <span className="small muted">In the room, open the Alexandria button in the top-left tools and paste the key. It stays in your browser only and opens nothing but this link: it cannot read pages or sheets.</span></span>
          {s.key && !key && <span className="small muted">Key {s.key.prefix}… made {ago(s.key.createdAt)}.</span>}
          {key && (
            <span className="row" role="status" style={{ flexWrap: 'wrap' }}>
              <code style={{ userSelect: 'all', wordBreak: 'break-all' }} data-testid="owlbear-key">{key}</code>
              <CopyButton text={key} label="Copy key" />
            </span>
          )}
          <span className="row">
            <button type="button" className={`btn small${s.key ? ' ghost' : ' primary'}`} disabled={act.busy} onClick={() => void makeKey()}>{s.key ? 'Make a new key' : 'Make a link key'}</button>
            {s.key && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void unlink()}>Unlink</button>}
          </span>
        </li>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>Invite your players to the Owlbear room as usual.</strong> <span className="small muted">They need no key. Their Alexandria button shows which world the table plays in, with a link to it for their sheet and the party chat.</span></span>
        </li>
      </ol>
    </section>
  );
}

function LinkCard({ s, reload }: { s: Status; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const act = useAction();
  const l = s.link!;
  const change = (body: Record<string, unknown>) => act.run(async () => { await w.call('PUT', '/owlbear/link', body); await reload(); });
  return (
    <section className="card stack" aria-label="What Owlbear shows">
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>What Owlbear shows</h2>
      <ErrorBox error={act.error} />
      <label className="stack tight">
        <span>Map picture</span>
        <select data-testid="owlbear-pic" value={l.follow ? FOLLOW : l.pic ?? ''} disabled={act.busy}
          onChange={(e) => void change(e.target.value === FOLLOW ? { follow: true } : { follow: false, pic: e.target.value || null })}>
          <option value={FOLLOW}>What the table screen shows</option>
          {s.pictures.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <span className="small muted">
          {s.target?.hidden ? 'The table screen shows a picture the players may not see, so Owlbear shows nothing. Share its page with them. ' : ''}
          Only map pictures the players may see are offered: Owlbear shows the picture to everyone in the room, and its fog is drawn in each browser, as on any virtual table. Your map marks are not sent.
        </span>
      </label>
      <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ padding: 0, marginBottom: 4 }}>Fog of war</legend>
        <label className="row"><input type="radio" name="obr-lead" checked={l.lead === 'alexandria'} disabled={act.busy} onChange={() => void change({ lead: 'alexandria' })} data-testid="owlbear-lead-alexandria" />
          <span><strong style={{ fontWeight: 500 }}>Alexandria leads</strong> <span className="small muted">Reveal on the Map page, the table screen or by voice as now; the Owlbear map follows within a couple of seconds.</span></span></label>
        <label className="row"><input type="radio" name="obr-lead" checked={l.lead === 'owlbear'} disabled={act.busy} onChange={() => void change({ lead: 'owlbear' })} data-testid="owlbear-lead-owlbear" />
          <span><strong style={{ fontWeight: 500 }}>Owlbear leads</strong> <span className="small muted">Fog and reveal with Owlbear's fog tools; the table screen, the Map page and which marks players see follow. Each change can be undone here like a stroke.</span></span></label>
      </fieldset>
      {s.fog && !s.fog.enabled && l.lead === 'alexandria' && <p className="small muted" style={{ margin: 0 }}>Fog is off for this picture. Turn it on with the Fog tool on the Map page.</p>}
    </section>
  );
}
