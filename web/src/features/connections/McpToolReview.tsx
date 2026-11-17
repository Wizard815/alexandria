// Generic API over an MCP server: choose the tool that lists records and, optionally, the tool that reads one record from its id. With a read
// tool, the list only makes the index and whole pages are read later (on demand and in the background). Blank: the list is all there is.
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Modal, useAction } from '../../ui/index.tsx';
import type { Connection } from './shared.tsx';

interface Guess {
  tools: string[];
  listTool: { name: string; confidence: number } | null;
  detailTools: { name: string; idArg: string; idType: 'string' | 'number'; confidence: number }[];
  notes: string[];
}

export function McpToolReview({ connection, onClose, onDone }: { connection: Connection; onClose: () => void; onDone: (m: string) => void }) {
  const { client } = useAuth();
  const [guess, setGuess] = useState<Guess | null>(null);
  const [list, setList] = useState(String(connection.config.tool ?? ''));
  const [detail, setDetail] = useState(String(connection.config.detailTool ?? ''));
  const [idArg, setIdArg] = useState(String(connection.config.detailIdArg ?? ''));
  const [idType, setIdType] = useState(String(connection.config.detailIdType ?? 'string'));
  const look = useAction();
  const save = useAction();

  const find = () => look.run(async () => {
    const g = await client.request<Guess>('POST', '/api/admin/connections/mcp-discover', { connectionId: connection.id, listTool: list || undefined });
    setGuess(g);
    if (!list && g.listTool) setList(g.listTool.name);
    // Fill in the best guess only when nothing is chosen yet.
    if (!detail && !connection.config.detailTool && g.detailTools[0]) { setDetail(g.detailTools[0].name); setIdArg(g.detailTools[0].idArg); setIdType(g.detailTools[0].idType); }
  });
  useEffect(() => { void find(); /* once, when the dialog opens */ // eslint-disable-line react-hooks/exhaustive-deps
  }, []);

  const pickDetail = (name: string) => {
    setDetail(name);
    const g = guess?.detailTools.find((d) => d.name === name);
    if (g) { setIdArg(g.idArg); setIdType(g.idType); }
  };
  const apply = () => save.run(async () => {
    await client.request('PATCH', `/api/admin/connections/${connection.id}`, { config: { tool: list, detailTool: detail, detailIdArg: detail ? idArg || 'id' : '', detailIdType: detail ? idType : '' } });
    onDone(detail ? `Saved: ${list} lists, ${detail} reads one page.` : `Saved: ${list} lists. No read tool, so the list is all there is.`);
  });

  return (
    <Modal title={`MCP tools · ${connection.name}`} onClose={onClose}>
      <div className="stack">
        {look.busy && <p className="small muted">Asking the server for its tools…</p>}
        <ErrorBox error={look.error} />
        {guess && <div className="note small">{guess.tools.length} tools found. {guess.notes.map((n, i) => <div key={i}>{n}</div>)}</div>}
        <label className="stack tight"><span className="label">List tool</span>
          <input list="mcp-tools" value={list} placeholder="list_articles" onChange={(e) => setList(e.target.value)} /></label>
        <label className="stack tight"><span className="label">Read tool (one page from its id). Blank means no detail tier.</span>
          <select aria-label="Read tool" value={guess?.detailTools.some((d) => d.name === detail) ? detail : detail ? '__other' : ''} onChange={(e) => pickDetail(e.target.value === '__other' ? detail : e.target.value)}>
            <option value="">None: the list is all there is</option>
            {(guess?.detailTools ?? []).map((d) => <option key={d.name} value={d.name}>{d.name} ({Math.round(d.confidence * 100)}% sure)</option>)}
            {detail && !guess?.detailTools.some((d) => d.name === detail) && <option value="__other">{detail}</option>}
          </select></label>
        <label className="stack tight"><span className="label">Or type a tool name</span>
          <input list="mcp-tools" value={detail} placeholder="get_article" onChange={(e) => setDetail(e.target.value)} /></label>
        {!!detail && (
          <div className="row wrap">
            <label className="stack tight"><span className="label">Id argument</span><input value={idArg} placeholder="id" onChange={(e) => setIdArg(e.target.value)} /></label>
            <label className="stack tight"><span className="label">Id is a</span>
              <select value={idType} onChange={(e) => setIdType(e.target.value)}><option value="string">Text</option><option value="number">Number</option></select></label>
          </div>
        )}
        <datalist id="mcp-tools">{(guess?.tools ?? []).map((t) => <option key={t} value={t} />)}</datalist>
        <p className="tiny muted" style={{ margin: 0 }}>Only tools that read are ever called. With a read tool, the list makes the index and each page is read the first time it is opened or searched for, then in the background within the source's budget. A page whose record has no visibility field stays DM-only.</p>
        <ErrorBox error={save.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={save.busy || !list.trim()} onClick={() => void apply()}>Save tools</button></div>
      </div>
    </Modal>
  );
}
