// The scripted game night (scripts/demo-session.ts) runs start to finish: the
// GM, the agent and three players play a session on the seeded demo, and no
// player view ever holds a GM-only, broker or classified marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('DemoSession: a whole game night passes with no leaks', async () => {
  const script = path.join(import.meta.dirname, '../scripts/demo-session.ts');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
  const code: number | null = await new Promise((r) => child.once('close', r));
  clearTimeout(timer);
  assert.equal(code, 0, `the game night failed:\n${out.slice(-3000)}`);
  for (const step of ['Start the session', 'sculpts a player-view scene', 'party chats', 'spoiler question', 'Combat: the agent adds monsters', 'Loot', 'A trade between two players', 'Travel and a long rest', 'stops the recording', 'published', 'Players see the published log']) assert.ok(out.includes(step), `the timeline has "${step}":\n${out}`);
  assert.match(out, /none leaked/);
  assert.ok(!/FAILED/.test(out));
});
