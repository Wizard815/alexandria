import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Field, Loading, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';

interface JobView {
  job: string; uses: string; baseUrl: string; model: string; apiKey: string; options: Record<string, unknown>;
  enabled: boolean; source: 'saved' | 'env' | 'none'; effective: { baseUrl: string; model: string; hasKey: boolean } | null;
}
interface TestResult { ok: boolean; ms: number; sample?: string; error?: string }

const NAMES: Record<string, string> = { chat: 'Chat', audit: 'Audit', audio: 'Audio (speech to text)', voice: 'Voice (text to speech)', extra: 'Extra (embeddings)' };

function JobRow({ j, onSaved }: { j: JobView; onSaved: () => void }) {
  const { client } = useAuth();
  const [baseUrl, setBaseUrl] = useState(j.baseUrl);
  const [model, setModel] = useState(j.model);
  const [apiKey, setApiKey] = useState(j.apiKey);
  const [options, setOptions] = useState(Object.keys(j.options).length ? JSON.stringify(j.options) : '');
  const [enabled, setEnabled] = useState(j.enabled);
  const [result, setResult] = useState<TestResult | null>(null);
  const a = useAction();
  const { toast, toastNode } = useToast();

  const save = () => a.run(async () => {
    await client.request('PUT', '/api/admin/models', { jobs: { [j.job]: { baseUrl, model, apiKey, options: options.trim() || '{}', enabled } } });
    toast('Saved');
    onSaved();
  });
  const test = () => a.run(async () => {
    setResult(null);
    setResult(await client.request<TestResult>('POST', `/api/admin/models/${j.job}/test`, {}));
  });

  return (
    <section className="card" aria-label={NAMES[j.job]} data-job={j.job}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div><h2 style={{ margin: 0 }}>{NAMES[j.job] ?? j.job}</h2><p className="muted small" style={{ margin: 0 }}>{j.uses}</p></div>
        <Switch checked={enabled} onChange={setEnabled} label={`${NAMES[j.job]} on`} />
      </div>
      <p className="tiny muted">
        {j.source === 'saved' && 'Using these saved settings.'}
        {j.source === 'env' && `Using the server's environment settings (${j.effective?.baseUrl}).`}
        {j.source === 'none' && 'No model set. Features that need it fall back or stay off.'}
      </p>
      <Field label="Base URL" help="Ends in /v1, e.g. http://argos:8080/v1"><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://host:port/v1" inputMode="url" /></Field>
      <Field label="Model name"><input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. qwen3-32b" /></Field>
      <Field label="API key" help="Stored on the server and never shown again. Leave the dots to keep it; clear the box to remove it."><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" /></Field>
      <Field label="Extra options (JSON)" help='Sent with every request, e.g. {"voice":"af_heart"}'><input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="{}" /></Field>
      <ErrorBox error={a.error} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" onClick={save} disabled={a.busy}>Save</button>
        <button type="button" className="btn" onClick={test} disabled={a.busy}>Test</button>
        {result && (
          <span role="status" className="small" data-testid={`test-${j.job}`}>
            {result.ok ? `OK in ${result.ms} ms: ${result.sample}` : `Failed: ${result.error}`}
          </span>
        )}
      </div>
      {toastNode}
    </section>
  );
}

export default function ModelsPage() {
  const { client } = useAuth();
  const data = useLoad(() => client.request<{ jobs: JobView[] }>('GET', '/api/admin/models'), []);
  return (
    <div className="page">
      <PageHead title="Models" lead="Five jobs, each pointed at any OpenAI-compatible server. Save first, then Test." />
      <ErrorBox error={data.error} />
      {data.loading && !data.data ? <Loading /> : (data.data?.jobs ?? []).map((j) => <JobRow key={JSON.stringify(j)} j={j} onSaved={() => void data.reload()} />)}
    </div>
  );
}
