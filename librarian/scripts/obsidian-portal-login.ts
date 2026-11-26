// One-time Obsidian Portal sign-in (OAuth 1.0a PIN flow) for the obsidian-portal world source.
//
//   ALX_OBSIDIANPORTAL_KEY=... ALX_OBSIDIANPORTAL_SECRET=... npm run op-login
//
// It asks Obsidian Portal for a request token, prints the address to open, waits for the PIN Obsidian Portal shows after you allow the
// app, and prints the access token and secret to paste into the source's settings. Nothing is saved.
import { createInterface } from 'node:readline/promises';
import { oauthHeader, OP_SITE } from '../src/intake/connectors/obsidianportal.ts';

const consumerKey = process.env.ALX_OBSIDIANPORTAL_KEY ?? '';
const consumerSecret = process.env.ALX_OBSIDIANPORTAL_SECRET ?? '';
if (!consumerKey || !consumerSecret) {
  console.error('Set ALX_OBSIDIANPORTAL_KEY and ALX_OBSIDIANPORTAL_SECRET (register an app at https://www.obsidianportal.com/oauth/clients/new).');
  process.exit(1);
}

async function post(path: string, keys: Parameters<typeof oauthHeader>[2], extra: Record<string, string>) {
  const url = `${OP_SITE}${path}`;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: oauthHeader('POST', url, keys, extra) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} answered ${r.status}: ${text.slice(0, 200)}`);
  return new URLSearchParams(text);
}

const req = await post('/oauth/request_token', { consumerKey, consumerSecret }, { oauth_callback: 'oob' });
const token = req.get('oauth_token') ?? '';
const tokenSecret = req.get('oauth_token_secret') ?? '';
console.log(`\nOpen this address, sign in and allow the app:\n\n  ${OP_SITE}/oauth/authorize?oauth_token=${encodeURIComponent(token)}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pin = (await rl.question('PIN shown by Obsidian Portal: ')).trim();
rl.close();
const acc = await post('/oauth/access_token', { consumerKey, consumerSecret, token, tokenSecret }, { oauth_verifier: pin });
console.log(`\nAccess token:        ${acc.get('oauth_token')}\nAccess token secret: ${acc.get('oauth_token_secret')}\n\nPaste both into the Obsidian Portal source (they are kept as secrets).`);
