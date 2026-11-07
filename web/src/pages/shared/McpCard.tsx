// Shows a fresh AI (MCP) connection once: the key, a config to paste into
// Claude / Cursor, and the Claude Code command.
import { useState } from 'react';

export interface McpConnection {
  url: string;
  key: string;
  access: 'read' | 'write';
  config: unknown;
  claudeCode: string;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn small" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true)); }}>
      {done ? 'Copied ✓' : label}
    </button>
  );
}

export function McpCard({ mcp }: { mcp: McpConnection }) {
  const json = JSON.stringify(mcp.config, null, 2);
  return (
    <div className="card gold">
      <div className="card-head">
        <h2>Your AI connection</h2>
        <span className={`chip ${mcp.access === 'read' ? 'teal' : 'red'}`}>{mcp.access === 'read' ? 'Read-only' : 'Can make changes'}</span>
      </div>
      <p className="small muted">
        {mcp.access === 'read'
          ? 'Your AI app can look things up in this world: lore, people, the calendar, your inventory. It sees only what you can see, and it cannot change anything.'
          : 'This key lets your AI app make changes as the DM. Keep it to yourself.'}{' '}
        This is the only time the key is shown. You can make a new one any time under “Connect an AI”.
      </p>
      <div className="stack tight">
        <span className="small"><strong>Claude Desktop, Cursor and other MCP apps</strong>: add this to the app's MCP settings.</span>
        <pre className="mono" style={{ margin: 0, padding: 10, borderRadius: 6, background: 'var(--input)', border: '1px solid var(--line)', overflowX: 'auto' }}>{json}</pre>
        <div className="row"><Copy text={json} label="Copy settings" /><Copy text={mcp.key} label="Copy key only" /></div>
      </div>
      <div className="stack tight">
        <span className="small"><strong>Claude Code</strong>: run this once.</span>
        <pre className="mono" style={{ margin: 0, padding: 10, borderRadius: 6, background: 'var(--input)', border: '1px solid var(--line)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{mcp.claudeCode}</pre>
        <div className="row"><Copy text={mcp.claudeCode} label="Copy command" /></div>
      </div>
    </div>
  );
}
