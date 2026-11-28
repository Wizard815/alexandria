// One line about a world's sources, for the GM's agent: what is connected and who can see it.
import type { DB } from '../../core/db.ts';
import { all, one } from '../../core/db.ts';
import { connectorFor } from '../../intake/registry.ts';
import { AUDIENCE_LABEL, normAudience } from '../../intake/connections.ts';

export function sourceSummary(d: { db: DB }, worldId: string): string {
  const rows = all<any>(d.db, 'SELECT name, kind, audience, enabled, last_sync_at FROM sources WHERE world_id = ? ORDER BY name', worldId);
  if (!rows.length) return '';
  const ago = (t: string | null) => { if (!t) return 'never synced'; const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60_000)); return `synced ${m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`} ago`; };
  const one1 = (r: any) => `${r.name} (${connectorFor(r.kind)?.label ?? r.kind}; ${AUDIENCE_LABEL[normAudience(r.audience)].toLowerCase()}; ${r.enabled ? ago(r.last_sync_at) : 'switched off'})`;
  let unread = '';
  try {
    const n = one<any>(d.db, `SELECT COUNT(*) AS n FROM pages WHERE world_id = ? AND source_id IS NOT NULL AND depth = 'index'`, worldId)?.n ?? 0;
    // Pages only listed so far have a title, type and tags; opening one (or asking about it) reads it from its source.
    if (n) unread = ` ${n} pages are listed but not read yet: they have a title, type and tags only, and are read from their source when opened or asked about.`;
  } catch { /* the depth column is made by the first tiered sync */ }
  return `Sources: ${rows.slice(0, 8).map(one1).join('; ')}${rows.length > 8 ? `; and ${rows.length - 8} more` : ''}.${unread}`;
}

