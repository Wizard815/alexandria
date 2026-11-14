// The world the leak crawler runs against: one marker at every secret spot.
// To cover a new feature, add its secret to seedContent() with mark(...).
// See docs/SECURITY.md.
import { run } from '../src/core/db.ts';
import { mark, markNum, tok, type Who } from './security-kit.ts';

export interface H {
  call: (method: string, url: string, token?: string | null, body?: unknown, headers?: Record<string, string>) => Promise<any>;
  ok: (method: string, url: string, token?: string | null, body?: unknown, headers?: Record<string, string>) => Promise<any>;
  deps: any;
}

export interface Seed {
  W: string;
  W2: string;
  T: Record<'admin' | 'ads' | 'dm' | 'dm2' | 'jess' | 'tom' | 'guest', string>;
  ID: Record<'dm' | 'dm2' | 'jess' | 'tom' | 'guest', string>;
  /** Read and write scribe keys. */
  K: Record<'jessRead' | 'tomRead' | 'guestRead' | 'dmRead' | 'dmWrite', string>;
  pages: Record<string, { id: string; path: string }>;
  ids: Record<string, string[]>;
  push: { sourceId: string; key: string };
}

const PW = 'correct horse battery';

/** Accounts, two worlds, players and keys. */
export async function makeAccounts(h: H): Promise<Seed> {
  const T: any = {};
  const ID: any = {};
  T.admin = (await h.ok('POST', '/api/setup', null, { username: 'wizard', password: PW })).token;
  T.ads = (await h.ok('POST', '/api/admin-auth/login', null, { username: 'wizard', password: PW })).token;
  for (const [k, name] of [['dm', 'dungeon'], ['dm2', 'dungeon2']] as const) {
    ID[k] = (await h.ok('POST', '/api/admin/accounts', T.ads, { username: name, password: 'dm password 123' })).account.id;
    T[k] = (await h.ok('POST', '/api/auth/login', null, { username: name, password: 'dm password 123' })).token;
  }
  const W = (await h.ok('POST', '/api/admin/worlds', T.ads, { name: 'Harbourtown', dmAccountId: ID.dm })).id;
  const W2 = (await h.ok('POST', '/api/admin/worlds', T.ads, { name: 'Elsewhere', dmAccountId: ID.dm2 })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await h.ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await h.ok('POST', '/api/join', null, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  {
    const inv = await h.ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'guest' });
    const j = await h.ok('POST', '/api/join', null, { code: inv.code, username: 'visitor', password: 'guest pass 1234', characterName: 'Visitor' });
    T.guest = j.token;
    ID.guest = j.account.id;
  }
  const K: any = {};
  K.guestRead = (await h.ok('POST', '/api/keys', T.guest, { scope: 'scribe', worldId: W, label: 'guest read', access: 'read' })).key;
  K.jessRead = (await h.ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'jess read', access: 'read' })).key;
  K.tomRead = (await h.ok('POST', '/api/keys', T.tom, { scope: 'scribe', worldId: W, label: 'tom read', access: 'read' })).key;
  K.dmRead = (await h.ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'dm read', access: 'read' })).key;
  K.dmWrite = (await h.ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'dm write', access: 'write' })).key;
  return { W, W2, T, ID, K, pages: {}, ids: {}, push: { sourceId: '', key: '' } };
}

const PNG = (token: string) => new Uint8Array([...Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...Buffer.from(`padding ${token} padding`)]);

/** Every secret spot in the product. One unique marker each. */
export async function seedContent(h: H, S: Seed) {
  const { W, T, ID } = S;
  const dm = (m: string, u: string, b?: unknown, hdr?: Record<string, string>) => h.ok(m, `/api/worlds/${W}${u}`, T.dm, b, hdr);
  const as = (who: 'jess' | 'tom') => (m: string, u: string, b?: unknown) => h.ok(m, `/api/worlds/${W}${u}`, T[who], b);
  const jess = as('jess');
  const tom = as('tom');
  const pushId = (k: string, v: any) => { (S.ids[k] ??= []).push(String(v)); };
  const page = async (key: string, path: string, visibility: string, md: string, fm: Record<string, unknown> = {}) => {
    const r = await dm('PUT', '/library/pages', { path, visibility, body: md, frontmatter: fm });
    S.pages[key] = { id: r.id, path: r.path };
    pushId('page', r.id); pushId('page', r.path);
    return r;
  };

  // ---- pages: whole pages at each level --------------------------------------------------
  const sharedTitle = 'Harbour Lore';
  await page('dm', 'dm/Smuggler Queen.md', 'dm', `# ${mark('dm_page', ['dm'], 'a DM-only page')} Smuggler Queen\nThe harbour council secretly answers to the smuggler queen ${tok('dm_page')}.\n`, { title: `Smuggler Queen ${tok('dm_page')}` });
  await page('broker', 'broker/Dockside Rumour.md', 'broker', `# Dockside Rumour\nThe lighthouse keeper sells fog charts to the harbour council ${mark('broker_page', ['dm'], 'a broker-level page')}.\n`, { title: `Dockside Rumour ${tok('broker_page')}`, knowledge: 'local' });
  await page('classified', 'classified/Vault.md', 'classified', `# Vault\nThe harbour council keeps a vault. ${mark('classified_page', ['dm'], 'a classified page', { ai: false, long: true })}\n`, { title: 'Vault' });
  // The page path itself shows in the audit log.
  await page('audit', `dm/${mark('audit_path', ['dm'], 'a DM page path (shows in the audit log)')}.md`, 'dm', '# Audit marker page\nNothing here.\n');

  // ---- one shared page with a secret in every kind of place ------------------------------
  const shared = [
    `# ${sharedTitle}`,
    `The harbour is run by a council of seven captains. ${mark('public_page', ['dm', 'jess', 'tom'], 'a shared paragraph (control)')}`,
    '',
    `> [!secret] DM`,
    `> ${mark('secret_block', ['dm'], 'a secret callout in a shared page')}`,
    '',
    '> [!broker]',
    `> ${mark('broker_block', ['dm'], 'a broker callout in a shared page')}`,
    '',
    '> [!classified]',
    `> ${mark('classified_block', ['dm'], 'a classified callout in a shared page', { ai: false, long: true })}`,
    '',
    '<!-- dm -->',
    mark('dm_comment_block', ['dm'], 'an html dm comment block'),
    '<!-- /dm -->',
    '',
    `%% ${mark('percent_comment', ['dm'], 'an Obsidian %% comment')} %%`,
    '',
    '## Secrets',
    mark('secret_heading', ['dm'], 'a section headed Secrets'),
    '',
    '## Broker',
    mark('broker_heading', ['dm'], 'a section headed Broker'),
    '',
    '## Classified',
    mark('classified_heading', ['dm'], 'a section headed Classified', { ai: false, long: true }),
    '',
    '## Public ending',
    `The captains meet at dusk. See also [[Smuggler Queen ${tok('dm_page')}]].`,
  ].join('\n');
  await page('shared', 'lore/Harbour Lore.md', 'party', shared, {
    title: sharedTitle,
    aliases: ['Old Harbour'],
    tags: ['lore'],
    dm_aliases: [mark('dm_alias', ['dm'], 'a DM-only alias')],
    secret: { note: mark('secret_fm', ['dm'], 'a secret: frontmatter key'), allies: [`[[Smuggler Queen ${tok('dm_page')}]]`] },
    dm_notes: mark('dm_fm_key', ['dm'], 'a dm_ frontmatter key'),
    broker_price: mark('broker_fm_key', ['dm'], 'a broker_ frontmatter key'),
    classified_secret: mark('classified_fm_key', ['dm'], 'a classified_ frontmatter key', { ai: false, long: true }),
    parents: [`[[Smuggler Queen ${tok('dm_page')}]]`],
  });

  // ---- an imported page: fact groups, secret blocks, map pins, tags --------------------------
  const sid = (await h.ok('POST', `/api/admin/worlds/${W}/sources`, T.ads, { kind: 'push', name: 'Tool', config: {}, defaultVisibility: 'party' })).id;
  const key = (await dm('POST', `/intake/sources/${sid}/keys`, { label: 'crawl' })).key;
  S.push = { sourceId: sid, key };
  const p = (text: string) => ({ kind: 'paragraph', content: [{ text }] });
  const row = (k: string, v: string) => ({ key: k, value: [{ text: v }] });
  await h.ok('POST', `/api/intake/${sid}/entries`, key, {
    entries: [
      {
        externalId: 'imp-hall', title: 'Imported Hall', visibility: 'party', type: 'page',
        blocks: [
          p(`The hall has a high roof. ${mark('import_public', ['dm', 'jess', 'tom'], 'an imported shared paragraph (control)')}`),
          { kind: 'secret', children: [p(mark('import_secret_block', ['dm'], 'an imported secret block'))] },
          { kind: 'secret', level: 'broker', children: [p(mark('import_broker_block', ['dm'], 'an imported broker block'))] },
          { kind: 'secret', level: 'classified', children: [p(mark('import_classified_block', ['dm'], 'an imported classified block', { ai: false, long: true }))] },
          { kind: 'map', title: 'Hall map', pins: [{ name: 'Front door', lat: 1, lng: 1 }, { name: mark('dm_pin', ['dm'], 'a DM-only map pin on an imported map'), lat: 2, lng: 2, dm: true }, { name: mark('dm_link_pin', ['dm'], 'a map pin that links a DM page'), lat: 3, lng: 3, ref: 'imp-dm' }] },
        ],
        properties: [
          { title: 'Facts', rows: [row('Seats', `Two hundred ${mark('fact_public', ['dm', 'jess', 'tom'], 'a public fact row (control)')}`)] },
          { title: 'Secrets', rows: [row('Trapdoor', mark('dm_fact_group', ['dm'], 'a DM fact group'))] },
          { title: 'Notes', dm: true, rows: [row('Warden', mark('dm_flag_group', ['dm'], 'a fact group flagged dm'))] },
          { title: 'Broker', rows: [row('Bribe', mark('broker_fact_group', ['dm'], 'a broker fact group'))] },
          { title: 'Classified', rows: [row('Hidden door', mark('classified_fact_group', ['dm'], 'a classified fact group', { ai: false, long: true }))] },
        ],
      },
      { externalId: 'imp-dm', title: 'Imported Dungeon', visibility: 'dm', blocks: [p(`Cells below. ${mark('import_dm_page', ['dm'], 'an imported DM-only page')}`)] },
      { externalId: 'imp-class-tag', title: 'Tagged Classified', visibility: 'party', tags: ['classified'], blocks: [p(mark('tag_classified_page', ['dm'], 'a page tagged classified', { ai: false, long: true }))] },
      { externalId: 'imp-broker-tag', title: 'Tagged Broker', visibility: 'party', tags: ['broker'], blocks: [p(mark('tag_broker_page', ['dm'], 'a page tagged broker'))] },
    ],
  });
  // Private relations, timelines, map markers and calendars from a source.
  const rec = (sql: string, ...a: unknown[]) => run(h.deps.db, sql, ...a);
  for (const [ext, vis, label] of [['r-dm', 'dm', mark('rel_dm', ['dm'], 'a DM-only imported relation')], ['r-party', 'party', 'friend of']] as const) {
    rec('INSERT INTO intake_relations (world_id, source_id, external_id, from_ref, to_ref, label, attitude, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', W, sid, ext, 'imp-hall', 'imp-dm', label, null, vis);
  }
  for (const [ext, vis, name] of [['t-dm', 'dm', mark('timeline_dm', ['dm'], 'a DM-only imported timeline')], ['t-party', 'party', 'Founding']] as const) {
    rec('INSERT INTO intake_timelines (world_id, source_id, external_id, name, visibility, data) VALUES (?, ?, ?, ?, ?, ?)', W, sid, ext, name, vis, JSON.stringify([{ name: 'Era', events: [{ name: vis === 'dm' ? tok('timeline_dm') : 'Founded', start: 1 }] }]));
  }
  for (const [ext, vis, name] of [['m-dm', 'dm', mark('marker_dm', ['dm'], 'a DM-only imported map marker')], ['m-party', 'party', 'Harbour']] as const) {
    rec('INSERT INTO intake_markers (world_id, source_id, external_id, map_ref, name, latitude, longitude, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', W, sid, ext, 'imp-hall', name, 1, 2, vis);
  }

  // ---- items: DM notes, a picture, a player's proposal ---------------------------------------
  await h.ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 50000, note: 'Starting coin' });
  await h.ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.tom, amountCp: 900, note: 'Starting coin' });
  const img = await h.call('POST', `/api/worlds/${W}/inventory/images`, T.dm, PNG(mark('item_image', ['dm', 'jess'], 'a picture on a player item')), { 'Content-Type': 'image/png' });
  if (img.status >= 300) throw new Error(`item image ${img.status} ${img.text}`);
  pushId('image', img.json.id);
  const ring = await dm('POST', '/inventory', { owner: ID.jess, name: 'Plain Ring', qty: 1, note: 'It looks plain', dmNote: mark('item_dm_note', ['dm'], 'a DM note on a player item'), reason: 'found it' });
  pushId('item', ring.id);
  pushId('item', (await dm('POST', '/inventory', { owner: 'party', name: 'Rope', qty: 1, dmNote: mark('item_dm_note_party', ['dm'], 'a DM note on a party item'), reason: 'stash' })).id);
  pushId('item', (await dm('POST', '/inventory', { owner: ID.jess, name: 'Painted Shield', qty: 1, image: img.json.id, reason: 'prize' })).id);
  await dm('PATCH', `/inventory/${ring.id}`, { dmNote: mark('item_dm_note_edit', ['dm'], 'a DM note changed later (alert history)'), qty: 2, reason: 'tweak' });
  pushId('item', (await dm('POST', '/inventory', { owner: ID.tom, name: 'Tom Dagger', qty: 1, note: mark('tom_item_note', ['dm', 'tom'], "an item note on tom's own item"), reason: 'gift' })).id);
  const lantern = await jess('POST', '/inventory', { owner: 'me', name: 'Lantern', qty: 1, note: mark('jess_item_proposal', ['dm', 'jess'], "a player's proposed item"), reason: mark('jess_item_reason', ['dm', 'jess'], "a player's reason for a proposal") });
  pushId('item', lantern.id);

  // ---- people ---------------------------------------------------------------------------------
  pushId('person', (await dm('POST', '/people', { name: `Warden ${mark('person_dm', ['dm'], 'a DM-only person')}`, role: mark('person_dm_role', ['dm'], 'role of a DM-only person'), visibility: 'dm' })).id);
  const odda = await dm('POST', '/people', { name: 'Odda Brightwater', role: 'Innkeeper', attitude: 'friendly', visibility: 'party' });
  pushId('person', odda.id);
  await dm('POST', `/people/${odda.id}/quotes`, { text: mark('quote_dm', ['dm'], 'a DM-only quote of a shared person'), said: 'Day 1', visibility: 'dm' });
  await dm('POST', `/people/${odda.id}/quotes`, { text: mark('quote_party', ['dm', 'jess', 'tom'], 'a shared quote (control)'), said: 'Day 1', visibility: 'party' });
  await dm('POST', `/people/${odda.id}/recalls`, { accountId: ID.jess, text: mark('recall_jess', ['dm', 'jess', 'tom'], 'a recall shown to the party'), success: true });
  await dm('PUT', `/people/${odda.id}/note`, { body: mark('person_note_dm', ['dm'], "the DM's own note on a shared person") });
  await jess('PUT', `/people/${odda.id}/note`, { body: mark('person_note_jess', ['jess'], "jess's private note (only me)") });
  await tom('PUT', `/people/${odda.id}/note`, { body: mark('person_note_tom', ['tom'], "tom's private note (only me)") });
  await jess('PUT', '/profiles/me/blocks', { section: 'story', title: 'Past', body: mark('profile_me', ['jess'], "jess's profile block (only me)"), visibility: 'me' });
  await jess('PUT', '/profiles/me/blocks', { section: 'goals', title: 'Goal', body: mark('profile_dm', ['dm', 'jess'], "jess's profile block shared with the DM"), visibility: 'dm' });
  await tom('PUT', '/profiles/me/blocks', { section: 'story', title: 'Past', body: mark('profile_tom_me', ['tom'], "tom's profile block (only me)"), visibility: 'me' });

  // ---- map marks -----------------------------------------------------------------------------
  await dm('POST', '/map/world/marks', { kind: 'note', x: 10, y: 10, text: mark('mark_dm', ['dm'], "a DM-only map mark"), visibility: 'dm' });
  await jess('POST', '/map/world/marks', { kind: 'note', x: 20, y: 20, text: mark('mark_jess_me', ['jess'], "jess's own map mark"), visibility: 'me' });
  await tom('POST', '/map/world/marks', { kind: 'note', x: 25, y: 25, text: mark('mark_tom_me', ['tom'], "tom's own map mark"), visibility: 'me' });
  const hidden = await tom('POST', '/map/world/marks', { kind: 'note', x: 30, y: 30, text: mark('mark_tom_hidden', ['dm', 'tom'], 'a party mark the DM hid', { eventsOk: true }), visibility: 'party' });
  await dm('PATCH', `/map/world/marks/${hidden.id}`, { hidden: true });

  // ---- combat: hidden combatants and monster HP -----------------------------------------------
  const num = (id: string, n: number, where: string) => markNum(id, ['dm'], where, n);
  await dm('PUT', '/live/combat', { active: true });
  await dm('POST', '/live/combatants', { name: `Ambusher ${mark('hidden_foe', ['dm'], 'a hidden combatant')}`, initiative: 12, hp: num('hidden_hp', 73917, 'hp of a hidden combatant'), hidden: true });
  await dm('POST', '/live/combatants', { name: 'Goblin', initiative: 10, hp: num('monster_hp', 82614, 'monster HP'), maxHp: 82614, ac: 17 });
  await dm('POST', '/live/combatants', { name: 'Jessamine', initiative: 14, hp: 22, accountId: ID.jess });

  // ---- clock events ----------------------------------------------------------------------------
  await dm('POST', '/clock/events', { title: mark('clock_dm', ['dm'], 'a DM-only clock event'), description: mark('clock_dm_desc', ['dm'], 'description of a DM-only clock event'), start: 100, visibility: 'dm' });
  await dm('POST', '/clock/events', { title: 'Harvest festival', description: mark('clock_party', ['dm', 'jess', 'tom'], 'a shared clock event (control)'), start: 200, visibility: 'party' });

  // ---- the broker ---------------------------------------------------------------------------------
  await dm('PATCH', '/settings', { brokerEnabled: true });
  await dm('POST', '/broker/notes', { topic: 'smugglers', text: mark('broker_note', ['dm'], 'a broker note (only sold when asked)'), knowledge: 'local' });
  await dm('PUT', '/broker/spoilers', { topics: [mark('broker_spoiler', ['dm'], 'a guarded broker topic')] });
  await dm('POST', '/broker/offers', { title: `Offer ${mark('offer_tom_title', ['dm', 'tom'], 'title of an offer to tom')}`, teaser: mark('offer_tom_teaser', ['dm', 'tom'], 'teaser of an offer to tom'), info: mark('offer_tom_info', ['dm'], 'the information of an offer to tom (unpaid)'), priceCp: 100, targets: [ID.tom] });
  await dm('POST', '/broker/offers', { title: `Offer ${mark('offer_jess_title', ['dm', 'jess'], 'title of an offer to jess')}`, teaser: mark('offer_jess_teaser', ['dm', 'jess'], 'teaser of an offer to jess'), info: mark('offer_jess_info', ['dm'], 'the information of an offer to jess (unpaid)'), priceCp: 100, targets: [ID.jess] });
  // A question whose DM-side evidence is the DM page.
  for (const [who, f, id] of [['jess', jess, 'broker_q_jess'], ['tom', tom, 'broker_q_tom']] as const) {
    const q = await f('POST', '/broker/quote', { question: `Who secretly answers to the smuggler queen in the harbour council? ${mark(id, ['dm', who], `a question ${who} put to the broker`)}`, length: 'short' });
    if (q.quoteId) { try { await f('POST', '/broker/ask', { quoteId: q.quoteId }); } catch { /* may be refused: still stored */ } }
  }
  await dm('POST', '/broker/classify', { question: 'Who secretly answers to the smuggler queen in the harbour council?' }).catch(() => {});

  // ---- the table: transcript, chat, whiteboard -----------------------------------------------------------
  const db = h.deps.db;
  const asid = 'ses_crawl';
  run(db, 'INSERT INTO audio_sessions (id, world_id, name, started_at, started_by, stopped_at) VALUES (?, ?, ?, ?, ?, ?)', asid, W, 'Crawl night', new Date(Date.now() - 3_600_000).toISOString(), ID.dm, new Date(Date.now() - 1_800_000).toISOString());
  run(db, 'INSERT INTO audio_mics (id, world_id, account_id, device_id, label, mode, players_transcript, aside, room, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'mic_aside', W, ID.dm, 'dev1', 'Aside mic', 'always', 0, 1, 0, new Date().toISOString());
  const line = (n: number, audience: string, text: string, sources = '[]') => run(db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_account, speaker_label, text, words, sources, audience, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', `lin_${n}`, asid, W, n * 4000, n * 4000 + 3000, null, n === 1 ? 'Jessamine' : 'DM', text, '[]', sources, audience, 1, new Date().toISOString());
  line(1, 'players', `We reached the harbour at dawn ${mark('transcript_public', ['dm', 'jess', 'tom'], 'a players transcript line (control)')} and met the captains.`);
  line(2, 'dm', `Behind the screen ${mark('transcript_dm', ['dm'], 'a DM-only transcript line')} the queen is waiting.`);
  line(3, 'dm', `Whispered aside ${mark('transcript_aside', ['dm'], 'a DM aside line')} do not publish.`, JSON.stringify(['mic_aside']));
  const draft = await dm('POST', '/sessionlog/drafts', { audioSessionId: asid, title: 'Crawl night' });
  pushId('draft', draft.id);
  await dm('PUT', `/sessionlog/drafts/${draft.id}`, { markdown: `## Recap\n- ${mark('sessionlog_draft', ['dm'], 'an unpublished session log draft')}\n` });
  const draft2 = await dm('POST', '/sessionlog/drafts', { audioSessionId: asid, title: 'Published night' });
  pushId('draft', draft2.id);
  await dm('PUT', `/sessionlog/drafts/${draft2.id}`, { markdown: `## Recap\n- The party reached the harbour. ${mark('sessionlog_public', ['dm', 'jess', 'tom'], 'a published session summary (control)')}\n` });
  await dm('POST', `/sessionlog/drafts/${draft2.id}/publish`, {});

  await dm('POST', '/sessionchat/sessions/start', { title: 'Crawl night' });
  await jess('POST', '/sessionchat/chat/party', { body: mark('chat_party', ['jess', 'tom'], 'a party chat message (players only)') });
  await tom('POST', '/sessionchat/chat/party', { body: mark('chat_party_tom', ['jess', 'tom'], 'another party chat message') });
  await jess('POST', '/sessionchat/chat/table', { body: mark('chat_table', ['dm', 'jess', 'tom'], 'a table chat message (control)') });
  const thread = await jess('POST', '/messages', { members: [ID.tom], title: 'Plans' });
  pushId('thread', thread.id);
  await jess('POST', `/messages/${thread.id}`, { body: mark('thread_jt', ['jess', 'tom'], 'a player to player chat (the DM is not in it)') });
  const dmThread = await dm('POST', '/messages', { members: [ID.tom], title: 'Psst' });
  pushId('thread', dmThread.id);
  await dm('POST', `/messages/${dmThread.id}`, { body: mark('thread_dm_tom', ['dm', 'tom'], 'a DM to tom chat') });
  await jess('POST', '/requests', { kind: 'question', title: mark('request_jess', ['dm', 'jess'], "jess's change request"), body: 'Please let me add a rope.', visibility: 'dm' });
  await tom('POST', '/requests', { kind: 'question', title: mark('request_tom', ['dm', 'tom'], "tom's change request"), body: 'A dagger.', visibility: 'dm' });
  await dm('POST', '/quick-events', { kind: 'save', title: 'Falling rocks', prompt: 'A rockslide!', skill: 'Dexterity', dc: 17, successText: mark('qe_success', ['dm'], 'success text of an open quick event'), failText: mark('qe_fail', ['dm'], 'fail text of an open quick event') });
  await dm('POST', '/quick-events', { kind: 'recall', title: mark('qe_tom_title', ['dm', 'tom'], 'title of a quick event sent to tom'), prompt: 'You remember something.', audience: [ID.tom], dc: 12, successText: mark('qe_tom_success', ['dm'], 'success text of a quick event for tom') });
  // A resolved check: tom passes, jess fails; each sees only their own result text.
  const check = await dm('POST', '/quick-events', { kind: 'save', title: 'Rope bridge', prompt: 'The bridge sways.', skill: 'Dexterity', dc: 15, successText: mark('qe_pass_tom', ['dm', 'tom'], 'success text: shown to the one who passed'), failText: mark('qe_fail_jess', ['dm', 'jess'], 'fail text: shown to the one who failed') });
  await tom('POST', `/quick-events/${check.id}/respond`, { roll: 20, modifier: 0 });
  await jess('POST', `/quick-events/${check.id}/respond`, { roll: 1, modifier: 0 });
  await dm('POST', `/quick-events/${check.id}/resolve`, {});
  await jess('POST', '/inventory/coin/transfer', { from: 'me', to: ID.tom, amountCp: 5, note: mark('transfer_note', ['dm', 'jess', 'tom'], 'a note on coin given between players (the DM sees transfers)') });
  await jess('POST', '/sessionchat/trades', { to: ID.tom, offerCp: 10, wantCp: 3, note: mark('trade_note', ['jess', 'tom'], 'a trade offer between players (players only)') });
  await dm('POST', '/calendar', { title: 'Game night', startsAt: new Date(Date.now() + 86400_000).toISOString(), endsAt: new Date(Date.now() + 90000_000).toISOString(), location: 'The Gull and Anchor' });
  const board = await dm('PUT', '/whiteboard', { baseVersion: 0, doc: { shapes: [{ type: 'text', text: mark('whiteboard_dm', ['dm', 'jess', 'tom'], 'a whiteboard drawing (the board is shared)') }] } });
  void board;

  // ---- the stage ---------------------------------------------------------------------------------------
  const stageImg = await h.call('POST', `/api/worlds/${W}/stage/images`, T.dm, PNG(mark('stage_image', ['dm'], 'a stage picture not shown yet')), { 'Content-Type': 'image/png' });
  if (stageImg.status >= 300) throw new Error(`stage image ${stageImg.status} ${stageImg.text}`);
  pushId('stageimage', stageImg.json.id);
  pushId('card', (await dm('POST', '/stage/cards', { kind: 'text', title: mark('stage_card', ['dm'], 'a stage card in staging'), text: mark('stage_card_text', ['dm'], 'text of a stage card in staging') })).id);
  pushId('card', (await dm('POST', '/stage/cards', { kind: 'image', ref: stageImg.json.id, title: 'Backdrop' })).id);
  pushId('card', (await dm('POST', '/stage/cards', { kind: 'text', title: mark('stage_card_tom', ['dm', 'tom'], 'a stage card shown to tom only'), text: 'Just for you.', show: true, to: [ID.tom] })).id);

  // ---- generators, sculpting, voice, sound --------------------------------------------------------
  await page('item_dm', 'items/Whisper Blade.md', 'dm', `# Whisper Blade\nA dagger. ${mark('quickgen_item', ['dm'], 'a DM-only page tagged item (quick-gen draws from it)')}\n`, { title: `Whisper Blade ${tok('quickgen_item')}`, tags: ['item'], rarity: 'rare' });
  await page('item_class', 'items/Hollow Crown.md', 'classified', `# Hollow Crown\n${mark('quickgen_item_class', ['dm'], 'a classified page tagged item', { ai: false, long: true })}\n`, { title: 'Hollow Crown', tags: ['item'], rarity: 'rare' });
  await dm('POST', '/sculpt/templates', { name: `Tavern ${mark('sculpt_template', ['dm'], 'a sculpt template name')}`, description: '', perspective: 'dm', fields: [{ key: 'name', label: 'Name', type: 'text' }], body: '# {{name}}', target: { kind: 'none' } }).catch(() => {});
  await dm('POST', '/sculpt/run', { template: 'npc', values: { name: mark('sculpt_history', ['dm'], 'a value in Sculpting history') } }).catch(() => {});
  await dm('POST', '/voice/presets', { name: mark('voice_preset', ['dm'], 'a voice preset name'), voice: 'af_heart', speed: 1 }).catch(() => {});

  // ---- WorldLore: the agent's own wiki, with broker and classified pages -------------------------------------
  await dm('PUT', '/worldlore/config', { kind: 'library', root: 'WorldLore', defaultLevel: 'dm' }).catch(() => {});
  await dm('POST', '/worldlore/pages', { path: 'WorldLore/Broker Lore', title: 'Broker Lore', markdown: `# Broker Lore\n${mark('lore_broker', ['dm'], 'a WorldLore page at level broker')}\n`, level: 'broker' }).catch(() => {});
  await dm('POST', '/worldlore/pages', { path: 'WorldLore/Classified Lore', title: 'Classified Lore', markdown: `# Classified Lore\n${mark('lore_classified', ['dm'], 'a WorldLore page at level classified', { ai: false, long: true })}\n`, level: 'classified' }).catch(() => {});

  // ---- the agent: chats and pending actions -----------------------------------------------------------------------
  const chat = await dm('POST', '/agent/chats', { title: mark('agent_chat_dm', ['dm'], "the DM agent's chat title") });
  pushId('agentchat', chat.id);
  const pchat = await jess('POST', '/agent/chats', { title: mark('agent_chat_jess', ['jess'], "jess's agent chat title") });
  pushId('agentchat', pchat.id);
  run(db, 'INSERT INTO agent_messages (id, chat_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'agm_seed', chat.id, 'user', mark('agent_msg_dm', ['dm'], 'a message in the DM agent chat'), 'done', new Date().toISOString());
  run(db, 'INSERT INTO agent_actions (id, world_id, chat_id, account_id, tool, args, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'aga_seed', W, chat.id, ID.dm, 'add_person', JSON.stringify({ name: 'x' }), mark('agent_action', ['dm'], 'a pending agent action'), 'pending', new Date().toISOString());

  // ---- another world: nothing of it reaches this one ---------------------------------------------------------------------
  const dm2 = (m: string, u: string, b?: unknown) => h.ok(m, `/api/worlds/${S.W2}${u}`, T.dm2, b);
  await dm2('PUT', '/library/pages', { path: 'w2/Other Secret.md', visibility: 'dm', body: `# Other\n${mark('w2_dm_page', ['dm2'], 'a DM page of another world')}\n` });
  await dm2('PUT', '/library/pages', { path: 'w2/Other Classified.md', visibility: 'classified', body: `# Other classified\n${mark('w2_classified', ['dm2'], 'a classified page of another world', { ai: false, long: true })}\n` });
  await dm2('PUT', '/library/pages', { path: 'w2/Other Public.md', visibility: 'party', body: `# Other public\n${mark('w2_public', ['dm2'], 'a shared page of another world')}\n` });
}

export type { Who };
