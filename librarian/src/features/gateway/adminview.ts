// The admin's own reads: searching across worlds, and what Alexandria's MCP server offers and to whom.
//
// Search is the same ranked page search players and scribes use, read as the admin: the party copy of each world,
// unless the admin is that world's GM (an admin is not a GM by being an admin). Nothing here returns a key.
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import { HttpError, str } from '../../core/util.ts';
import { adminViewer } from './worlds.ts';
import { logSearch } from '../gatewaystatus/searchlog.ts';

export function adminSearch(d: Deps, accountId: string, query: Record<string, unknown>) {
  const q = str(query.q, 'q', { max: 200 }).trim();
  if (q.length < 2) throw new HttpError(400, 'Type at least two characters');
  const only = typeof query.world === 'string' && query.world ? query.world : null;
  const worlds = all<{ id: string; name: string }>(d.db, 'SELECT id, name FROM worlds ORDER BY name').filter((w) => !only || w.id === only);
  if (only && !worlds.length) throw new HttpError(404, 'World not found');
  const sourceOf = (id: string) => one<{ name: string | null }>(d.db, 'SELECT s.name FROM pages p LEFT JOIN sources s ON s.id = p.source_id WHERE p.id = ?', id)?.name ?? null;
  const results: any[] = [];
  const bySource = new Map<string, number>();
  const perWorld: { id: string; name: string; copy: 'dm' | 'party'; count: number }[] = [];
  for (const w of worlds) {
    const v = adminViewer(d.db, w.id, accountId);
    const hits = d.library.search(w.id, q, v, 25);
    perWorld.push({ id: w.id, name: w.name, copy: v.role === 'dm' ? 'dm' : 'party', count: hits.length });
    logSearch(d.db, { worldId: w.id, role: 'admin', origin: 'admin', q, hitIds: hits.map((h) => h.id) });
    for (const h of hits) {
      const source = sourceOf(h.id);
      const label = source ?? 'Written here';
      bySource.set(label, (bySource.get(label) ?? 0) + 1);
      results.push({ world: { id: w.id, name: w.name }, id: h.id, path: h.path, title: h.title, titleHtml: h.titleHtml, snippetHtml: h.snippetHtml, source, matchedOn: h.matchedOn, score: h.score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { q, worlds: perWorld, sources: [...bySource].map(([name, count]) => ({ name, count })), results: results.slice(0, 60) };
}

/** The MCP server's address, its tools and the keys that can reach it (metadata only). */
export async function mcpAccess(d: Deps) {
  // Loaded now, not at start-up: the tool list comes from the feature registry, which is still loading while features load.
  const { allTools } = await import('../../routes/mcpServer.ts');
  const base = d.env.ALX_PUBLIC_URL?.replace(/\/+$/, '') ?? null;
  const keys = all<any>(d.db, `SELECT k.id, k.scope, k.label, k.access, k.created_at, k.last_used_at, a.display_name AS owner, w.name AS world
    FROM api_keys k JOIN accounts a ON a.id = k.account_id LEFT JOIN worlds w ON w.id = k.world_id WHERE k.revoked = 0 ORDER BY k.created_at DESC`);
  return {
    url: base ? `${base}/mcp` : null,
    tools: allTools().map((t) => ({ name: t.name, description: t.description, write: !!t.write, dmOnly: !!t.dmOnly, playerOnly: !!t.playerOnly })),
    keys: {
      scribe: keys.filter((k) => k.scope === 'scribe').length,
      write: keys.filter((k) => k.scope === 'scribe' && k.access === 'write').length,
      admin: keys.filter((k) => k.scope === 'admin').length,
      list: keys.slice(0, 100).map((k) => ({ id: k.id, owner: k.owner, world: k.world ?? null, label: k.label, scope: k.scope, access: k.scope === 'admin' ? 'admin' : k.access, createdAt: k.created_at, lastUsedAt: k.last_used_at })),
    },
  };
}
