// The librarian as an MCP server (Streamable HTTP, stateless, JSON replies).
//
// Connect an AI app to POST /mcp with a scribe key as the bearer token:
//  - a read key (players, or a DM who only wants lookups) lists read tools
//  - a DM's write key also lists write tools
// Every tool calls the librarian's own API with the caller's key, so the
// same visibility rules apply: a player's AI only ever sees what the player
// may see, and a read key cannot change anything even if a client tries.
import { Router, type Request, type Response } from 'express';
import type { Deps } from '../app.ts';
import { type Auth, resolveToken } from '../core/auth.ts';
import { one } from '../core/db.ts';

type Tool = {
  name: string;
  description: string;
  write?: boolean;
  props: Record<string, any>;
  required?: string[];
  call: (a: any) => { method: string; path: string; body?: unknown };
};

const enc = encodeURIComponent;
const S = (description: string) => ({ type: 'string', description });

const TOOLS: Tool[] = [
  { name: 'world_info', description: 'This world: name, your role and its settings.', props: {}, call: () => ({ method: 'GET', path: '' }) },
  { name: 'list_members', description: 'People in this world and their characters.', props: {}, call: () => ({ method: 'GET', path: '/members' }) },
  { name: 'list_pages', description: 'Library pages you can see.', props: {}, call: () => ({ method: 'GET', path: '/library/pages' }) },
  { name: 'read_page', description: 'Read one library page by id or path.', props: { page: S('Page id or path') }, required: ['page'], call: (a) => ({ method: 'GET', path: `/library/pages/${enc(a.page)}` }) },
  { name: 'search_library', description: 'Full-text search of the library pages you can see.', props: { query: S('Words to search for') }, required: ['query'], call: (a) => ({ method: 'GET', path: `/library/search?q=${enc(a.query)}` }) },
  { name: 'list_relations', description: 'Relations and family links you can see.', props: {}, call: () => ({ method: 'GET', path: '/library/relations' }) },
  { name: 'list_people', description: 'NPCs the party has met: what they said, recalls, your notes.', props: {}, call: () => ({ method: 'GET', path: '/people' }) },
  { name: 'get_live', description: 'The live session: who is here, party purse, your coin, combat as you may see it.', props: {}, call: () => ({ method: 'GET', path: '/live' }) },
  { name: 'list_calendar', description: 'Upcoming real-life session days with RSVPs.', props: {}, call: () => ({ method: 'GET', path: '/calendar' }) },
  { name: 'list_requests', description: 'Change requests and questions you can see.', props: {}, call: () => ({ method: 'GET', path: '/requests' }) },
  { name: 'get_inventory', description: "An inventory: 'me', 'party', or (DM) a player's account id.", props: { owner: S("'me', 'party' or an account id") }, call: (a) => ({ method: 'GET', path: `/inventory?owner=${enc(a.owner ?? 'me')}` }) },
  { name: 'ask_broker_quote', description: "Ask the world's information broker what an answer would cost and how long it takes. Quote only: it never charges or asks.", props: { question: S('The question'), length: { type: 'string', enum: ['short', 'full'] } }, required: ['question'], call: (a) => ({ method: 'GET', path: `/broker/quote?question=${enc(a.question)}&length=${enc(a.length ?? 'short')}` }) },
  { name: 'list_broker_requests', description: 'Questions put to the information broker (yours; the DM sees all) and answers that are ready.', props: {}, call: () => ({ method: 'GET', path: '/broker' }) },

  { name: 'save_page', write: true, description: 'Create or replace a library page. Markdown may start with frontmatter. Pages are DM-only unless visibility is party.', props: { path: S('Page path, e.g. people/Odda'), markdown: S('Page Markdown'), visibility: { type: 'string', enum: ['dm', 'party'] } }, required: ['path', 'markdown'], call: (a) => ({ method: 'PUT', path: '/library/pages', body: { path: a.path, markdown: a.markdown, visibility: a.visibility } }) },
  { name: 'add_person', write: true, description: 'Add an NPC to the People list.', props: { name: S('Name'), role: S('Role'), attitude: S('Attitude'), kind: { type: 'string', enum: ['ally', 'neutral', 'rival'] }, visibility: { type: 'string', enum: ['dm', 'party'] } }, required: ['name'], call: (a) => ({ method: 'POST', path: '/people', body: a }) },
  { name: 'add_quote', write: true, description: 'Record something an NPC said.', props: { personId: S('Person id'), text: S('What they said'), said: S('When, e.g. Session 14'), visibility: { type: 'string', enum: ['dm', 'party'] } }, required: ['personId', 'text'], call: (a) => ({ method: 'POST', path: `/people/${enc(a.personId)}/quotes`, body: a }) },
  { name: 'schedule_session', write: true, description: 'Put a real-life game night on the calendar.', props: { title: S('Title'), startsAt: S('ISO date and time'), endsAt: S('ISO date and time'), location: S('Where') }, required: ['title', 'startsAt', 'endsAt'], call: (a) => ({ method: 'POST', path: '/calendar', body: a }) },
  { name: 'send_quick_event', write: true, description: 'Send a quick event (recall, save, choice, vote, reaction...) to players.', props: { kind: S('recall, notice, save, read, group, contest, choice, vote, reaction or twist'), title: S('Title'), prompt: S('What players see'), options: { type: 'array', items: { type: 'string' } }, skill: S('Skill'), dc: { type: 'integer' }, successText: S('Shown on success'), failText: S('Shown on failure'), timerS: { type: 'integer' } }, required: ['kind', 'title', 'prompt'], call: (a) => ({ method: 'POST', path: '/quick-events', body: a }) },
  { name: 'add_item', write: true, description: "Give an item to 'party' or a player's account id.", props: { owner: S("'party' or an account id"), name: S('Item'), qty: { type: 'integer' }, note: S('Note the owner sees'), dmNote: S('Note only the DM sees'), reason: S("Why (needed when giving to a player)") }, required: ['owner', 'name'], call: (a) => ({ method: 'POST', path: '/inventory', body: a }) },
  { name: 'add_coin', write: true, description: "Add or take coin (in copper) from 'party' or a player.", props: { owner: S("'party' or an account id"), amountCp: { type: 'integer' }, note: S('Why') }, required: ['owner', 'amountCp'], call: (a) => ({ method: 'POST', path: '/live/ledger', body: a }) },
  { name: 'decide_request', write: true, description: 'Accept or reject a change request; optionally apply it to its page.', props: { id: S('Request id'), decision: { type: 'string', enum: ['accepted', 'rejected'] }, reply: S('Reply'), apply: { type: 'object' } }, required: ['id', 'decision'], call: (a) => ({ method: 'POST', path: `/requests/${enc(a.id)}/decide`, body: { decision: a.decision, reply: a.reply, apply: a.apply } }) },
  { name: 'broker_answer', write: true, description: "DM: answer a broker question. For a guarded secret ('pricing'), set a price (copper), wait and the answer; for a waiting one, edit the answer.", props: { id: S('Broker request id'), answer: S('The answer, in the broker\'s words'), costCp: { type: 'integer' }, waitAmount: { type: 'integer' }, waitUnit: { type: 'string', enum: ['minutes', 'hours', 'days'] }, clock: { type: 'string', enum: ['real', 'game'] } }, required: ['id', 'answer'], call: (a) => (a.costCp !== undefined ? { method: 'POST', path: `/broker/${enc(a.id)}/price`, body: a } : { method: 'PATCH', path: `/broker/${enc(a.id)}`, body: { answer: a.answer } }) },
];

export default function mcpServerRoutes(d: Deps) {
  const r = Router();

  r.get('/', (_req, res) => res.status(405).json({ error: 'Use POST with JSON-RPC (MCP Streamable HTTP)' }));
  r.delete('/', (_req, res) => res.status(204).end());

  r.post('/', async (req: Request, res: Response) => {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const auth: Auth | null = token ? resolveToken(d.db, token) : null;
    const rpcError = (id: unknown, code: number, message: string, status = 200) => res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!auth || auth.via !== 'scribe_key' || !auth.keyWorldId) return rpcError(req.body?.id, -32001, 'Use a scribe key made for one world', 401);
    const m = one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', auth.keyWorldId, auth.account.id);
    if (!m) return rpcError(req.body?.id, -32001, 'This key no longer has a world', 401);
    const canWrite = auth.access === 'write' && m.role === 'dm';
    const tools = TOOLS.filter((t) => !t.write || canWrite);

    const msg = req.body;
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request', 400);
    if (msg.id === undefined) return res.status(202).end(); // notification

    const ok = (result: unknown) => res.json({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'alexandria-librarian', version: '0.3.0' },
          instructions: canWrite
            ? 'Alexandria librarian, DM access. You can read everything in this world and make changes. Pages are DM-only unless saved with visibility party.'
            : 'Alexandria librarian, read-only. You see only what this player may see. Nothing can be changed with this key.',
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required ?? [] }, annotations: { readOnlyHint: !t.write } })) });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === msg.params?.name);
        if (!tool) return rpcError(msg.id, -32602, canWrite ? 'Unknown tool' : 'Unknown tool, or a write tool and this key is read-only');
        const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
        for (const k of tool.required ?? []) if (args[k] === undefined) return ok({ isError: true, content: [{ type: 'text', text: `Missing ${k}` }] });
        const c = tool.call(args);
        const base = `http://127.0.0.1:${req.socket.localPort}/api/worlds/${enc(auth.keyWorldId)}`;
        try {
          const up = await d.fetch(base + c.path, { method: c.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: c.body === undefined ? undefined : JSON.stringify(c.body) });
          const text = await up.text();
          return ok({ isError: !up.ok, content: [{ type: 'text', text }] });
        } catch (err: any) {
          return ok({ isError: true, content: [{ type: 'text', text: `Librarian call failed: ${String(err.message).slice(0, 200)}` }] });
        }
      }
      default:
        return rpcError(msg.id, -32601, 'Method not found');
    }
  });
  return r;
}
