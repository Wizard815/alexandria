// Table tools: MCP tools for the DM's table-side actions that live in the
// core routes (approvals, moving items, map marks, People, quick events and
// broker deliveries), so an AI with a DM write key can run a session end to
// end. Every tool calls the existing world API with the caller's key, so the
// normal visibility rules apply: a player key never gets a write tool.
import type { Feature, McpTool } from '../types.ts';

const enc = (v: unknown) => encodeURIComponent(String(v));
const S = (description: string) => ({ type: 'string', description });
const VIS = { type: 'string', enum: ['dm', 'party'] };

const tools: McpTool[] = [
  // ---- approvals ----
  { name: 'list_approvals', dmOnly: true, description: 'DM: everything waiting on you: coin requests, item changes, disputes and alerts, each with its id, plus recent decisions and gives between players.', props: {}, call: () => ({ method: 'GET', path: '/approvals' }) },
  {
    name: 'decide_approval', write: true,
    description: 'DM: decide a waiting coin request or item change from list_approvals. action: approve, edit (approve with changes: amountCp for coin, item {name, qty, note, dmNote, owner} for items), reject, or revert (undo a player\'s own change you were alerted to).',
    props: { id: S('Approval id (led_… for coin, otherwise an item change id)'), action: { type: 'string', enum: ['approve', 'edit', 'reject', 'revert'] }, amountCp: { type: 'integer' }, note: S('Coin note'), item: { type: 'object' } },
    required: ['id', 'action'],
    call: (a) => ({ method: 'POST', path: `/approvals/${enc(a.id)}`, body: { action: a.action, amountCp: a.amountCp, note: a.note, item: a.item } }),
  },

  // ---- inventory ----
  {
    name: 'move_item', write: true,
    description: "DM: move an item (or part of a stack: qty) to 'party' or a player's account id. Get item ids from get_inventory.",
    props: { itemId: S('Item id'), to: S("'party' or an account id"), qty: { type: 'integer' }, reason: S('Why (needed when taking from a player)'), note: S('A note shown with the move') },
    required: ['itemId', 'to'],
    call: (a) => ({ method: 'POST', path: `/inventory/${enc(a.itemId)}/move`, body: { to: a.to, qty: a.qty, reason: a.reason, note: a.note } }),
  },

  // ---- map marks ----
  { name: 'list_map_marks', description: 'Pins, notes, routes and stops on a map as you may see them (the whole world map is "world").', props: { mapId: S('Map id (default world)') }, call: (a) => ({ method: 'GET', path: `/map/${enc(a.mapId ?? 'world')}/marks` }) },
  {
    name: 'add_map_mark', write: true,
    description: 'DM: put a mark on a map: a pin, note, icon or numbered stop at x,y (0 to 100), or a route of points. visibility: party (default), dm (only you) or me.',
    props: {
      mapId: S('Map id (default world)'), kind: { type: 'string', enum: ['pin', 'note', 'route', 'stop', 'icon'] }, x: { type: 'number', description: '0 to 100' }, y: { type: 'number', description: '0 to 100' },
      label: S('Label'), text: S('Note text (kind note)'), icon: S('Icon name (kind icon)'), points: { type: 'array', items: { type: 'object' }, description: 'Route points [{x, y}], 2 or more' }, visibility: { type: 'string', enum: ['party', 'me', 'dm'] },
    },
    required: ['kind'],
    call: (a) => ({ method: 'POST', path: `/map/${enc(a.mapId ?? 'world')}/marks`, body: { kind: a.kind, x: a.x, y: a.y, label: a.label, text: a.text, icon: a.icon, points: a.points, visibility: a.visibility } }),
  },
  { name: 'hide_map_mark', write: true, description: "DM: hide or show a player's mark on a map (its author still sees it).", props: { mapId: S('Map id (default world)'), markId: S('Mark id'), hidden: { type: 'boolean' } }, required: ['markId'], call: (a) => ({ method: 'PATCH', path: `/map/${enc(a.mapId ?? 'world')}/marks/${enc(a.markId)}`, body: { hidden: a.hidden !== false } }) },
  { name: 'delete_map_mark', write: true, description: 'DM: erase a mark from a map.', props: { mapId: S('Map id (default world)'), markId: S('Mark id') }, required: ['markId'], call: (a) => ({ method: 'DELETE', path: `/map/${enc(a.mapId ?? 'world')}/marks/${enc(a.markId)}` }) },

  // ---- people ----
  {
    name: 'update_person', write: true,
    description: 'DM: change an NPC on the People list: attitude, role, kind, where they were met, or who can see them.',
    props: { personId: S('Person id'), name: S('Name'), role: S('Role'), attitude: S('Attitude'), kind: { type: 'string', enum: ['ally', 'neutral', 'rival'] }, met: S('When met, e.g. Session 14'), visibility: VIS },
    required: ['personId'],
    call: (a) => ({ method: 'PATCH', path: `/people/${enc(a.personId)}`, body: { name: a.name, role: a.role, attitude: a.attitude, kind: a.kind, met: a.met, visibility: a.visibility } }),
  },
  { name: 'add_recall', write: true, description: 'DM: record what a player character recalled (or failed to) about an NPC.', props: { personId: S('Person id'), accountId: S("The player's account id"), text: S('What they remembered'), success: { type: 'boolean' } }, required: ['personId', 'accountId', 'text', 'success'], call: (a) => ({ method: 'POST', path: `/people/${enc(a.personId)}/recalls`, body: { accountId: a.accountId, text: a.text, success: a.success } }) },

  // ---- quick events ----
  { name: 'list_quick_events', description: 'Quick events (checks, votes, choices...) and how they stand as you may see them: who answered, results.', props: {}, call: () => ({ method: 'GET', path: '/quick-events' }) },
  { name: 'resolve_quick_event', write: true, description: 'DM: close a quick event and settle it. Results follow the DC for checks and the answers for the rest; results {accountId: "success"|"fail"} overrides.', props: { id: S('Event id'), results: { type: 'object' } }, required: ['id'], call: (a) => ({ method: 'POST', path: `/quick-events/${enc(a.id)}/resolve`, body: { results: a.results } }) },
  { name: 'cancel_quick_event', write: true, description: 'DM: withdraw a quick event from the players without a result.', props: { id: S('Event id') }, required: ['id'], call: (a) => ({ method: 'POST', path: `/quick-events/${enc(a.id)}/cancel`, body: {} }) },

  // ---- broker ----
  { name: 'broker_deliver', write: true, description: "DM: release a waiting broker answer to the player now (approves a 'DM reviews' answer, or delivers one early).", props: { id: S('Broker request id') }, required: ['id'], call: (a) => ({ method: 'POST', path: `/broker/${enc(a.id)}/deliver`, body: {} }) },
  { name: 'broker_refuse', write: true, description: 'DM: refuse a broker question the broker will not answer (pricing, offered or waiting). Anything the player paid is refunded.', props: { id: S('Broker request id'), note: S('Why, shown to the player') }, required: ['id'], call: (a) => ({ method: 'POST', path: `/broker/${enc(a.id)}/refuse`, body: { note: a.note } }) },
];

const feature: Feature = { id: 'tabletools', mcpTools: tools };
export default feature;
