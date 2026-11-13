// Separate gateway admin sign-in: admin sessions and their scope, TOTP and
// recovery codes, allowed networks (CIDR), throttling and the audit log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all } from '../src/core/db.ts';
import { parseAllowList, ipAllowed } from '../src/features/adminauth/cidr.ts';
import { hotp, totp, base32Decode, base32Encode, verifyTotp, otpauthUri } from '../src/features/adminauth/totp.ts';

const PW = 'correct horse battery';

async function boot(env: Record<string, string> = {}, extraAccounts = true) {
  const { app, deps } = createApp({ noScheduler: true, env });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // `ip` fakes the client address: the test server trusts X-Forwarded-For from loopback.
  const call = async (method: string, url: string, token?: string, body?: unknown, ip?: string) => {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown, ip?: string) => {
    const r = await call(method, url, token, body, ip);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const tableAdmin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: PW })).token as string;
  let world = '';
  let dm = '';
  if (extraAccounts) {
    // The admin signs in at /admin/login: once there are two accounts, table sessions can't open admin routes.
    const ads = (await ok('POST', '/api/admin-auth/login', undefined, { username: 'wizard', password: PW })).token;
    const acc = await ok('POST', '/api/admin/accounts', ads, { username: 'dungeon', password: 'dm password 123' });
    dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
    world = (await ok('POST', '/api/admin/worlds', ads, { name: 'Authland', dmAccountId: acc.account.id })).id;
  }
  const actions = () => all<any>(deps.db, 'SELECT action, detail, account_id FROM audit ORDER BY rowid').map((a) => a.action);
  return { server, call, ok, tableAdmin, dm, world, deps, actions, close: () => server.close() };
}

const adminLogin = (h: Awaited<ReturnType<typeof boot>>, body: Record<string, unknown> = {}, ip?: string) =>
  h.call('POST', '/api/admin-auth/login', undefined, { username: 'wizard', password: PW, ...body }, ip);

test('TestAdminAuth_SessionOpensAdminRoutesButNotWorlds', async () => {
  const h = await boot();
  try {
    const r = await adminLogin(h);
    assert.equal(r.status, 200);
    const t = r.body.token as string;
    assert.ok(t.startsWith('alx_ads_'));
    assert.equal(r.body.account.is_admin, true);
    // Admin routes and admin-auth routes work.
    assert.equal((await h.call('GET', '/api/admin/accounts', t)).status, 200);
    assert.equal((await h.call('GET', '/api/admin/overview', t)).status, 200);
    assert.equal((await h.call('GET', '/api/admin-auth/me', t)).body.via, 'admin_session');
    // World routes, even for a world the admin plays in, and everything else: 403.
    for (const url of [`/api/worlds/${h.world}`, `/api/worlds/${h.world}/library/pages`, '/api/worlds', '/api/me', '/api/keys']) {
      const x = await h.call('GET', url, t);
      assert.equal(x.status, 403, `${url} -> ${x.status}`);
    }
    assert.equal((await h.call('POST', '/mcp', t, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    assert.equal((await h.call('POST', '/api/worlds/' + h.world + '/library/pages', t, {})).status, 403);
    // Wrong password, and a non-admin account, can't get one.
    assert.equal((await adminLogin(h, { password: 'nope nope nope' })).status, 401);
    assert.equal((await adminLogin(h, { username: 'dungeon', password: 'dm password 123' })).status, 401);
    // Signing out kills it.
    await h.ok('POST', '/api/admin-auth/logout', t);
    assert.equal((await h.call('GET', '/api/admin/accounts', t)).status, 401);
  } finally { h.close(); }
});

test('TestAdminAuth_TableSessionsAndAdminKeys', async () => {
  // Two accounts, no env: a table session is refused on admin routes.
  const h = await boot();
  try {
    const r = await h.call('GET', '/api/admin/accounts', h.tableAdmin);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /admin\/login/);
    assert.equal((await h.call('GET', '/api/admin-auth/me', h.tableAdmin)).status, 403);
    // A DM table session is not an admin either way.
    assert.equal((await h.call('GET', '/api/admin/accounts', h.dm)).status, 403);
    // The admin's table session still opens the admin's own worlds (membership permitting), unchanged.
    assert.equal((await h.call('GET', '/api/me', h.tableAdmin)).status, 200);
    // An admin key keeps working. Keys are made from a table session, which still can.
    const k = await h.ok('POST', '/api/keys', h.tableAdmin, { scope: 'admin', label: 'ops' });
    assert.ok(k.key.startsWith('alx_adm_'));
    assert.equal((await h.call('GET', '/api/admin/accounts', k.key)).status, 200);
    assert.equal((await h.call('GET', '/api/admin/audit', k.key)).status, 200);
  } finally { h.close(); }
  // The env var keeps the old behaviour.
  const g = await boot({ ALX_ADMIN_TABLE_LOGIN: '1' });
  try {
    assert.equal((await g.call('GET', '/api/admin/accounts', g.tableAdmin)).status, 200);
  } finally { g.close(); }
  // One account only: allowed without the env var.
  const s = await boot({}, false);
  try {
    assert.equal((await s.call('GET', '/api/admin/accounts', s.tableAdmin)).status, 200);
    assert.equal((await s.call('GET', '/api/admin-auth/status')).body.tableLogin, true);
    // Adding a second account closes it.
    await s.ok('POST', '/api/admin/accounts', s.tableAdmin, { username: 'dungeon', password: 'dm password 123' });
    assert.equal((await s.call('GET', '/api/admin/accounts', s.tableAdmin)).status, 403);
  } finally { s.close(); }
});

test('TestAdminAuth_TotpSetupLoginAndRecoveryCodes', async () => {
  const h = await boot();
  try {
    const t = (await adminLogin(h)).body.token as string;
    // Setup, with a wrong code first.
    const setup = await h.ok('POST', '/api/admin-auth/totp/setup', t);
    assert.match(setup.secret, /^[A-Z2-7]{32}$/);
    assert.ok(setup.uri.startsWith('otpauth://totp/Alexandria:wizard?secret=' + setup.secret));
    assert.equal((await h.call('POST', '/api/admin-auth/totp/enable', t, { code: '000000' })).status, 400);
    assert.equal((await h.call('GET', '/api/admin-auth/me', t)).body.totp.enabled, false);
    const en = await h.ok('POST', '/api/admin-auth/totp/enable', t, { code: totp(setup.secret) });
    assert.equal(en.recoveryCodes.length, 10);
    assert.equal(new Set(en.recoveryCodes).size, 10);
    // Codes are stored hashed.
    const stored = all<any>(h.deps.db, 'SELECT code_hash FROM adminauth_recovery').map((r) => r.code_hash).join(' ');
    for (const c of en.recoveryCodes) assert.ok(!stored.includes(c));

    // Password alone now gets a "need a code" answer and no token.
    const need = await adminLogin(h);
    assert.equal(need.status, 428);
    assert.equal(need.body.totpRequired, true);
    assert.equal(need.body.token, undefined);
    // The code just used to enable can't be replayed; the next step's code works.
    assert.equal((await adminLogin(h, { totp: totp(setup.secret) })).status, 401);
    const later = hotp(setup.secret, Math.floor(Date.now() / 30000) + 1);
    const good = await adminLogin(h, { totp: later });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.ok(good.body.token.startsWith('alx_ads_'));

    // Recovery codes work once each.
    const rc = en.recoveryCodes[0] as string;
    assert.equal((await adminLogin(h, { totp: rc })).status, 200);
    assert.equal((await adminLogin(h, { totp: rc })).status, 401);
    assert.equal((await adminLogin(h, { totp: en.recoveryCodes[1].toUpperCase() })).status, 200);
    assert.equal((await h.call('GET', '/api/admin-auth/me', t)).body.totp.recoveryCodesLeft, 8);

    // With TOTP on, a table session is no longer accepted for this account, even with the env var.
    // (Checked below with a second server.)
    // Disabling needs a valid code.
    assert.equal((await h.call('POST', '/api/admin-auth/totp/disable', t, { code: '123456' })).status, 400);
    assert.equal((await h.call('POST', '/api/admin-auth/totp/disable', t, {})).status, 400);
    const rc2 = en.recoveryCodes[2] as string;
    await h.ok('POST', '/api/admin-auth/totp/disable', t, { code: rc2 });
    assert.equal((await adminLogin(h)).status, 200);
    assert.equal(all<any>(h.deps.db, 'SELECT 1 FROM adminauth_recovery').length, 0);

    const a = h.actions();
    for (const want of ['admin.totp.setup', 'admin.totp.enable', 'admin.totp.disable', 'admin.totp.fail', 'admin.login', 'admin.login.fail', 'admin.recovery.used']) {
      assert.ok(a.includes(want), `audit has ${want}: ${a.join(',')}`);
    }
  } finally { h.close(); }
});

test('TestAdminAuth_TotpOnBlocksTableSessionOnAdminRoutes', async () => {
  const h = await boot({ ALX_ADMIN_TABLE_LOGIN: '1' });
  try {
    assert.equal((await h.call('GET', '/api/admin/accounts', h.tableAdmin)).status, 200);
    const t = (await adminLogin(h)).body.token as string;
    const s = await h.ok('POST', '/api/admin-auth/totp/setup', t);
    await h.ok('POST', '/api/admin-auth/totp/enable', t, { code: totp(s.secret) });
    assert.equal((await h.call('GET', '/api/admin/accounts', h.tableAdmin)).status, 403);
    assert.equal((await h.call('GET', '/api/admin/accounts', t)).status, 200);
    // Admin keys are unaffected.
    const k = await h.ok('POST', '/api/keys', h.tableAdmin, { scope: 'admin', label: 'ops' });
    assert.equal((await h.call('GET', '/api/admin/accounts', k.key)).status, 200);
  } finally { h.close(); }
});

test('TestTotp_Rfc6238Vectors', () => {
  // RFC 6238 appendix B: secret "12345678901234567890", SHA-1, 8 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const at = (s: number) => hotp(secret, Math.floor(s / 30), 8);
  assert.equal(at(59), '94287082');
  assert.equal(at(1111111109), '07081804');
  assert.equal(at(1111111111), '14050471');
  assert.equal(at(1234567890), '89005924');
  assert.equal(at(2000000000), '69279037');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  // Drift of one step is accepted, two is not; a step can't be reused.
  const ms = 1_700_000_000_000;
  const code = totp(secret, ms);
  assert.notEqual(verifyTotp(secret, code, -1, ms + 30_000), null);
  assert.equal(verifyTotp(secret, code, -1, ms + 90_000), null);
  const step = verifyTotp(secret, code, -1, ms)!;
  assert.equal(verifyTotp(secret, code, step, ms), null);
  assert.equal(verifyTotp(secret, '12345', -1, ms), null);
  assert.ok(otpauthUri('Alexandria', 'a b', secret).includes('a%20b'));
});

test('TestCidr_Ipv4AndIpv6', () => {
  const l = parseAllowList('127.0.0.1/32, 192.168.0.0/16,::1/128,fd00:abcd::/48,10.0.0.0/8');
  const yes = ['127.0.0.1', '192.168.5.9', '192.168.255.255', '::1', 'fd00:abcd::1', 'fd00:abcd:0:ffff::5', '::ffff:192.168.1.1', '::ffff:7f00:1', '10.200.3.4'];
  const no = ['127.0.0.2', '192.169.0.1', '8.8.8.8', '::2', 'fd00:abce::1', '2001:db8::1', '::ffff:8.8.8.8', 'not an ip', '', undefined];
  for (const ip of yes) assert.equal(ipAllowed(ip, l), true, String(ip));
  for (const ip of no) assert.equal(ipAllowed(ip, l), false, String(ip));
  // No list: everyone. A bare address is a single host. /0 matches its whole family only.
  assert.equal(ipAllowed('8.8.8.8', []), true);
  assert.equal(ipAllowed('1.2.3.4', parseAllowList('1.2.3.4')), true);
  assert.equal(ipAllowed('1.2.3.5', parseAllowList('1.2.3.4')), false);
  assert.equal(ipAllowed('8.8.8.8', parseAllowList('0.0.0.0/0')), true);
  assert.equal(ipAllowed('2001:db8::1', parseAllowList('0.0.0.0/0')), false);
  assert.equal(ipAllowed('2001:db8::1', parseAllowList('2001:db8::/32')), true);
  assert.equal(ipAllowed('2001:db9::1', parseAllowList('2001:db8::/32')), false);
  assert.equal(ipAllowed('172.16.0.1', parseAllowList('172.16.0.0/12')), true);
  assert.equal(ipAllowed('172.32.0.1', parseAllowList('172.16.0.0/12')), false);
  // Typos fail loudly instead of opening or closing access silently.
  for (const bad of ['300.1.1.1/8', '1.2.3.4/33', '::1/129', 'nope', '1.2.3.4/x', '1.2.3.4/8/8']) assert.throws(() => parseAllowList(bad), bad);
});

test('TestAdminAuth_AllowedNetworksRefuseOtherAddresses', async () => {
  const h = await boot({ ALX_ADMIN_ALLOW: '127.0.0.1/32,192.168.0.0/16,::1/128,fd00::/8', ALX_ADMIN_TABLE_LOGIN: '1' });
  try {
    // setup in boot came from 127.0.0.1. Inside the ranges: fine.
    assert.equal((await adminLogin(h, {}, '192.168.1.20')).status, 200);
    assert.equal((await adminLogin(h, {}, 'fd12::5')).status, 200);
    const t = (await adminLogin(h, {}, '192.168.1.20')).body.token as string;
    // Outside: login, the admin API with a session, a table session and an admin key are all 403.
    assert.equal((await adminLogin(h, {}, '203.0.113.9')).status, 403);
    assert.equal((await adminLogin(h, {}, '2001:db8::9')).status, 403);
    assert.equal((await h.call('GET', '/api/admin/accounts', t, undefined, '203.0.113.9')).status, 403);
    assert.equal((await h.call('GET', '/api/admin/accounts', h.tableAdmin, undefined, '203.0.113.9')).status, 403);
    const k = await h.ok('POST', '/api/keys', h.tableAdmin, { scope: 'admin', label: 'ops' });
    assert.equal((await h.call('GET', '/api/admin/accounts', k.key, undefined, '203.0.113.9')).status, 403);
    assert.equal((await h.call('GET', '/api/admin/accounts', undefined, undefined, '203.0.113.9')).status, 403);
    assert.equal((await h.call('GET', '/api/admin-auth/status', undefined, undefined, '203.0.113.9')).status, 403);
    // The same key from an allowed address works. Table routes are not restricted.
    assert.equal((await h.call('GET', '/api/admin/accounts', k.key, undefined, '192.168.9.9')).status, 200);
    assert.equal((await h.call('GET', '/api/me', h.tableAdmin, undefined, '203.0.113.9')).status, 200);
    assert.equal((await h.call('POST', '/api/auth/login', undefined, { username: 'wizard', password: PW }, '203.0.113.9')).status, 200);
    const me = await h.ok('GET', '/api/admin-auth/me', t, undefined, '192.168.1.20');
    assert.deepEqual(me.network.ranges, ['127.0.0.1/32', '192.168.0.0/16', '::1/128', 'fd00::/8']);
    assert.equal(me.network.yourIp, '192.168.1.20');
    assert.equal(me.network.yourIpAllowed, true);
    const refused = all<any>(h.deps.db, `SELECT detail FROM audit WHERE action = 'admin.ip.refused'`);
    assert.ok(refused.length >= 6);
    assert.ok(refused.some((r) => r.detail.includes('203.0.113.9')));
  } finally { h.close(); }
  // A bad range stops the server from starting rather than guessing.
  assert.throws(() => createApp({ noScheduler: true, env: { ALX_ADMIN_ALLOW: '10.0.0.0/99' } }));
});

test('TestAdminAuth_LoginIsThrottledStricterThanTableLogin', async () => {
  const h = await boot();
  try {
    // The table login allows 5 wrong tries; the admin login 3.
    for (let i = 0; i < 3; i++) assert.equal((await adminLogin(h, { password: 'wrong wrong wrong' })).status, 401);
    // Even the right password is refused while locked.
    assert.equal((await adminLogin(h)).status, 429);
    // A different address has its own per-account counter.
    assert.equal((await adminLogin(h, {}, '198.51.100.7')).status, 200);
    // Wrong codes count as well.
    const t = (await adminLogin(h, {}, '198.51.100.7')).body.token as string;
    const s = await h.ok('POST', '/api/admin-auth/totp/setup', t, undefined, '198.51.100.7');
    await h.ok('POST', '/api/admin-auth/totp/enable', t, { code: totp(s.secret) }, '198.51.100.7');
    for (let i = 0; i < 3; i++) assert.equal((await adminLogin(h, { totp: '111111' }, '198.51.100.8')).status, 401);
    assert.equal((await adminLogin(h, { totp: '111111' }, '198.51.100.8')).status, 429);
    assert.ok(h.actions().includes('admin.login.blocked'));
  } finally { h.close(); }
});

test('TestAdminAuth_AuditRecordsLoginsFailuresAndLogout', async () => {
  const h = await boot();
  try {
    h.deps.db.exec(`DELETE FROM audit WHERE action LIKE 'admin.%'`);
    await adminLogin(h, { password: 'wrong wrong wrong' });
    await adminLogin(h, { username: 'dungeon', password: 'dm password 123' });
    const t = (await adminLogin(h)).body.token as string;
    await h.ok('POST', '/api/admin-auth/logout', t);
    const rows = all<any>(h.deps.db, `SELECT action, detail FROM audit WHERE action LIKE 'admin.%' ORDER BY rowid`);
    assert.deepEqual(rows.map((r) => r.action), ['admin.login.fail', 'admin.login.fail', 'admin.login', 'admin.logout']);
    assert.ok(rows[1].detail.includes('not an admin'));
    // Secrets are never in the log.
    assert.ok(!JSON.stringify(rows).includes(PW) && !JSON.stringify(rows).includes(t));
    // The audit page shows them to admins.
    const k = await h.ok('POST', '/api/keys', h.tableAdmin, { scope: 'admin', label: 'ops' });
    const page = await h.ok('GET', '/api/admin/audit', k.key);
    assert.ok(JSON.stringify(page).includes('admin.login'));
  } finally { h.close(); }
});
