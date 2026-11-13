// World settings tab for the clock: what a long rest does.
import { useWorld } from '../../lib/world.tsx';
import { ErrorBox, useAction, useToast } from '../../ui/index.tsx';

export default function ClockSettings() {
  const { w, info, reloadInfo } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const mode = ((info.settings as unknown as Record<string, unknown>).longRestMode as string) ?? 'morning';
  const set = (v: string) => act.run(async () => { await w.updateSettings({ longRestMode: v }); await reloadInfo(); toast('Saved'); });
  return (
    <section className="card flush">
      <ErrorBox error={act.error} />
      <div className="row between" style={{ padding: '14px 18px' }}>
        <div className="stack tight" style={{ flex: '1 1 300px' }}>
          <strong style={{ fontWeight: 500 }}>Long rest moves the clock</strong>
          <span className="small muted">Either 8 hours on, or to 07:00 the next morning.</span>
        </div>
        <div className="tabs" role="radiogroup" aria-label="Long rest">
          {([['8h', '+8 hours'], ['morning', 'To 07:00']] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={mode === v} disabled={act.busy} className={`btn small${mode === v ? ' on' : ''}`} onClick={() => void set(v)}>{label}</button>
          ))}
        </div>
      </div>
      {toastNode}
    </section>
  );
}
