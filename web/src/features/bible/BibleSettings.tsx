// World settings: when the story bible may use the chat model in the background.
import { useWorld } from '../../lib/world.tsx';
import { ErrorBox, useAction, useToast } from '../../ui/index.tsx';

const CHOICES: [string, string, string][] = [
  ['session', 'During sessions', 'Reads while a session is running and stops when it ends.'],
  ['always', 'Any time', 'Reads whenever pages are waiting. Keeps the chat model busy until it catches up.'],
  ['off', 'Off', 'Never reads by itself. What it has written stays.'],
];

export default function BibleSettings() {
  const { w, info, reloadInfo } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const cur = String((info.settings as unknown as Record<string, unknown>).bibleRuns ?? 'session');
  return (
    <section className="card">
      <h2>When the story bible reads</h2>
      <p className="small muted">Each page it reads is one request to your chat model. Your own requests always go first.</p>
      <ErrorBox error={act.error} />
      <div className="tabs" role="radiogroup" aria-label="When the story bible reads">
        {CHOICES.map(([v, label]) => <button key={v} type="button" role="radio" aria-checked={cur === v} disabled={act.busy} className={`btn small${cur === v ? ' on' : ''}`} onClick={() => void act.run(async () => { await w.updateSettings({ bibleRuns: v } as any); await reloadInfo(); toast('Saved'); })}>{label}</button>)}
      </div>
      <p className="small muted">{CHOICES.find((c) => c[0] === cur)?.[2]}</p>
      {toastNode}
    </section>
  );
}
