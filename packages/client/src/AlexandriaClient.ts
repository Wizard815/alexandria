// Typed client for the Alexandria librarian API, for the desktop and mobile
// scribe apps. No dependencies: it uses fetch, so it runs in browsers,
// Tauri, React Native and Node 18+.

export type Role = 'dm' | 'player' | 'guest';
export type Visibility = 'dm' | 'party' | 'me';

export class AlexandriaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LiveEvent {
  type: string;
  data: any;
}

type Q = Record<string, string | number | undefined>;

export class AlexandriaClient {
  baseUrl: string;
  token: string | null;
  private fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; token?: string | null; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  async request<T = any>(method: string, path: string, body?: unknown, query?: Q): Promise<T> {
    const qs = query ? '?' + Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
    const r = await this.fetchImpl(this.baseUrl + path + qs, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const json = text ? JSON.parse(text) : null;
    if (!r.ok) throw new AlexandriaError(r.status, json?.error ?? `Request failed (${r.status})`);
    return json as T;
  }

  // ---- Accounts ----
  needsSetup() { return this.request<{ needsSetup: boolean }>('GET', '/api/setup'); }
  async setup(username: string, password: string) { return this.keep(await this.request('POST', '/api/setup', { username, password })); }
  async login(username: string, password: string) { return this.keep(await this.request('POST', '/api/auth/login', { username, password })); }
  async join(code: string, username: string, password: string, characterName?: string) { return this.keep(await this.request('POST', '/api/join', { code, username, password, characterName })); }
  async resetPassword(username: string, code: string, password: string) { return this.keep(await this.request('POST', '/api/auth/reset', { username, code, password })); }
  async logout() { await this.request('POST', '/api/auth/logout'); this.token = null; }
  me() { return this.request('GET', '/api/me'); }
  setTheme(theme: { race?: string; mode?: 'dark' | 'light'; effects?: boolean }) { return this.request('PUT', '/api/me/theme', theme); }
  keys() { return this.request<any[]>('GET', '/api/keys'); }
  createKey(scope: 'admin' | 'scribe', label: string, worldId?: string) { return this.request<{ id: string; key: string }>('POST', '/api/keys', { scope, label, worldId }); }
  revokeKey(id: string) { return this.request('DELETE', `/api/keys/${id}`); }
  worlds() { return this.request<{ id: string; slug: string; name: string; role: Role }[]>('GET', '/api/worlds'); }

  private keep(r: any) {
    if (r?.token) this.token = r.token;
    return r;
  }

  /** Everything inside one world. */
  world(worldId: string) {
    return new WorldClient(this, worldId);
  }
}

export class WorldClient {
  private c: AlexandriaClient;
  readonly id: string;
  constructor(c: AlexandriaClient, id: string) {
    this.c = c;
    this.id = id;
  }
  private r<T = any>(method: string, path: string, body?: unknown, query?: Q) {
    return this.c.request<T>(method, `/api/worlds/${encodeURIComponent(this.id)}${path}`, body, query);
  }

  info() { return this.r('GET', ''); }
  members() { return this.r<any[]>('GET', '/members'); }
  settings() { return this.r('GET', '/settings'); }
  updateSettings(patch: Record<string, unknown>) { return this.r('PATCH', '/settings', patch); }
  invite(role: 'player' | 'guest' = 'player', days?: number) { return this.r<{ code: string }>('POST', '/invites', { role, days }); }

  // Library / Lore
  pages() { return this.r<any[]>('GET', '/library/pages'); }
  page(idOrPath: string) { return this.r('GET', `/library/pages/${encodeURIComponent(idOrPath)}`); }
  savePage(p: { path: string; markdown?: string; body?: string; title?: string; frontmatter?: Record<string, unknown>; visibility?: 'dm' | 'party' }) { return this.r('PUT', '/library/pages', p); }
  deletePage(id: string) { return this.r('DELETE', `/library/pages/${id}`); }
  search(q: string) { return this.r<any[]>('GET', '/library/search', undefined, { q }); }
  relations() { return this.r<any[]>('GET', '/library/relations'); }

  // Requests
  requests() { return this.r<any[]>('GET', '/requests'); }
  request(req: { kind: 'edit' | 'new' | 'question'; title: string; body: string; pageId?: string; visibility?: 'dm' | 'party' }) { return this.r('POST', '/requests', req); }
  decide(id: string, decision: 'accepted' | 'rejected', opts: { reply?: string; apply?: { mode: 'append' | 'replace' | 'create'; path?: string; body?: string; visibility?: 'dm' | 'party' } } = {}) { return this.r('POST', `/requests/${id}/decide`, { decision, ...opts }); }

  // Messages
  threads() { return this.r<any[]>('GET', '/messages'); }
  startThread(members: string[], title?: string) { return this.r('POST', '/messages', { members, title }); }
  thread(id: string) { return this.r('GET', `/messages/${id}`); }
  send(threadId: string, body: string) { return this.r('POST', `/messages/${threadId}`, { body }); }
  keepThread(threadId: string, kept = true) { return this.r('POST', `/messages/${threadId}/keep`, { kept }); }

  // Quick events
  quickEvents() { return this.r<any[]>('GET', '/quick-events'); }
  sendQuickEvent(ev: Record<string, unknown>) { return this.r('POST', '/quick-events', ev); }
  respond(id: string, answer: { choice?: number; roll?: number; modifier?: number; pass?: boolean }) { return this.r('POST', `/quick-events/${id}/respond`, answer); }
  resolve(id: string, results?: Record<string, 'success' | 'fail'>) { return this.r('POST', `/quick-events/${id}/resolve`, { results }); }

  // Calendar
  calendar(from?: string, to?: string) { return this.r<any[]>('GET', '/calendar', undefined, { from, to }); }
  scheduleSession(s: { title: string; startsAt: string; endsAt: string; location?: string }) { return this.r('POST', '/calendar', s); }
  rsvp(sessionId: string, answer: 'yes' | 'maybe' | 'no') { return this.r('PUT', `/calendar/${sessionId}/rsvp`, { answer }); }
  dayChat(sessionId: string) { return this.r<any[]>('GET', `/calendar/${sessionId}/chat`); }
  sayAboutDay(sessionId: string, body: string) { return this.r('POST', `/calendar/${sessionId}/chat`, { body }); }
  askReschedule(sessionId: string, reason: string, proposed: string[]) { return this.r('POST', `/calendar/${sessionId}/reschedule`, { reason, proposed }); }
  icsUrl() { return `${this.c.baseUrl}/dav/worlds/${encodeURIComponent(this.id)}/sessions.ics`; }

  // Live session and combat
  live(session?: string) { return this.r('GET', '/live', undefined, { session }); }
  here(location: string) { return this.r('PUT', '/live/presence', { location }); }
  leave() { return this.r('DELETE', '/live/presence'); }
  coin(owner: 'me' | 'party' | string = 'me') { return this.r('GET', '/live/ledger', undefined, { owner }); }
  addCoin(owner: 'me' | 'party' | string, amountCp: number, note?: string, session?: string) { return this.r('POST', '/live/ledger', { owner, amountCp, note, session }); }
  combat() { return this.r('GET', '/live/combat'); }
  nextTurn() { return this.r('POST', '/live/combat/next'); }
  addCombatant(x: Record<string, unknown>) { return this.r('POST', '/live/combatants', x); }
  updateCombatant(id: string, patch: Record<string, unknown>) { return this.r('PATCH', `/live/combatants/${id}`, patch); }

  // Inventory
  inventory(owner: 'me' | 'party' | string = 'me') { return this.r('GET', '/inventory', undefined, { owner }); }
  addItem(item: Record<string, unknown>) { return this.r('POST', '/inventory', item); }
  updateItem(id: string, patch: Record<string, unknown>) { return this.r('PATCH', `/inventory/${id}`, patch); }
  removeItem(id: string) { return this.r('DELETE', `/inventory/${id}`); }

  // Map marks
  marks(mapId: string) { return this.r<any[]>('GET', `/map/${encodeURIComponent(mapId)}/marks`); }
  addMark(mapId: string, mark: Record<string, unknown>) { return this.r('POST', `/map/${encodeURIComponent(mapId)}/marks`, mark); }
  removeMark(mapId: string, id: string) { return this.r('DELETE', `/map/${encodeURIComponent(mapId)}/marks/${id}`); }

  // Me and People
  profile(accountId: string = 'me') { return this.r('GET', `/profiles/${accountId}`); }
  saveBlock(b: { id?: string; section: string; title: string; body: string; visibility: Visibility; sort?: number }) { return this.r('PUT', '/profiles/me/blocks', b); }
  people() { return this.r<any[]>('GET', '/people'); }
  notePerson(personId: string, body: string) { return this.r('PUT', `/people/${personId}/note`, { body }); }

  // Whiteboard
  whiteboard() { return this.r('GET', '/whiteboard'); }
  saveWhiteboard(baseVersion: number, doc: unknown) { return this.r('PUT', '/whiteboard', { baseVersion, doc }); }

  /**
   * Live updates. EventSource cannot send an Authorization header, so this
   * reads the stream with fetch. Returns a function that stops it.
   */
  subscribe(onEvent: (e: LiveEvent) => void, onError?: (err: unknown) => void): () => void {
    const ctl = new AbortController();
    (async () => {
      const res = await fetch(`${this.c.baseUrl}/api/worlds/${encodeURIComponent(this.id)}/events`, {
        headers: this.c.token ? { Authorization: `Bearer ${this.c.token}` } : {},
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new AlexandriaError(res.status, 'Could not open live updates');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = 'message';
          const data: string[] = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length) onEvent({ type, data: JSON.parse(data.join('\n')) });
        }
      }
    })().catch((err) => {
      if (!ctl.signal.aborted) onError?.(err);
    });
    return () => ctl.abort();
  }
}
