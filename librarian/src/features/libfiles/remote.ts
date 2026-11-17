// Optional write-back of a library file to the source its page came from,
// when the DM ticks "Also send to <source>". Uses the source's own connection
// credentials (effectiveConfig), one explicit upload per file, never for a
// classified file. Supported:
//   Kanka (API token):    POST /campaigns/{id}/entities/{entity}/entity_assets
//                         (multipart: name, type_id=1 file, visibility_id, file).
//                         visibility_id 1 (everyone) only for a party file, else 2 (admins).
//   LegendKeeper (API key): POST {project api}/assets (multipart: name, file),
//                         into the project's asset library.
// Any other source (mcp-kanka, LegendKeeper MCP, Markdown, generic API: it has
// no upload role) cannot receive files, so the option is not offered.
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { effectiveConfig } from '../../intake/connections.ts';
import { connectorFor } from '../../intake/registry.ts';
import { kankaBase } from '../../intake/connectors/kanka.ts';

export interface Target { sourceId: string; sourceName: string; app: 'Kanka' | 'LegendKeeper' }
export interface Remote { source: string; app: string; id: string | null; error: string | null; at: string }

const KANKA_EID = /^kanka:(\d{1,12})$/;
const LK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Where this file could be sent, or null (option hidden). A classified file is never sent anywhere. */
export function targetFor(d: Deps, worldId: string, page: { source_id: string | null; external_id: string | null }, level: string): Target | null {
  if (level === 'classified' || !page.source_id || !page.external_id) return null;
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ? AND world_id = ?', page.source_id, worldId);
  if (!src || !src.enabled) return null;
  const cfg = effectiveConfig(d.db, src);
  const c = connectorFor(src.kind, cfg);
  if (c?.id === 'kanka-api' && cfg.token && cfg.campaignId && KANKA_EID.test(page.external_id)) return { sourceId: src.id, sourceName: src.name, app: 'Kanka' };
  if (c?.id === 'legendkeeper-api' && cfg.apiKey && cfg.apiUrl && LK_ID.test(page.external_id)) return { sourceId: src.id, sourceName: src.name, app: 'LegendKeeper' };
  return null;
}

const form = (name: string, mime: string, bytes: Uint8Array, extra: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  f.set('name', name);
  f.set('file', new Blob([Buffer.from(bytes)], { type: mime }), name);
  return f;
};

async function post(d: Deps, url: string, token: string, body: FormData): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await d.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body, signal: AbortSignal.timeout(120_000) });
    if (r.status === 429 && attempt < 2) {
      const ra = Number(r.headers.get('retry-after'));
      await new Promise((ok) => setTimeout(ok, Math.min(Number.isFinite(ra) ? ra : 2, 10) * 1000));
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new Error(`The source refused the upload (${r.status}). The token or key must be allowed to write.`);
    if (!r.ok) throw new Error(`The source answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    return r.json().catch(() => ({}));
  }
}

/** Upload one file. Returns the id the source gave it. Throws a readable Error on failure. */
export async function sendFile(d: Deps, worldId: string, page: { source_id: string | null; external_id: string | null }, f: { name: string; mime: string; level: string; bytes: Uint8Array }): Promise<{ target: Target; remoteId: string | null }> {
  const target = targetFor(d, worldId, page, f.level);
  if (!target) throw new Error('This file cannot be sent to a source (classified, or the source has no upload)');
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', target.sourceId)!;
  const cfg = effectiveConfig(d.db, src);
  if (target.app === 'Kanka') {
    const eid = KANKA_EID.exec(page.external_id!)![1];
    const url = `${kankaBase(cfg)}/campaigns/${encodeURIComponent(String(cfg.campaignId))}/entities/${eid}/entity_assets`;
    const j = await post(d, url, String(cfg.token), form(f.name, f.mime, f.bytes, { type_id: '1', visibility_id: f.level === 'party' ? '1' : '2' }));
    return { target, remoteId: j?.data?.id !== undefined ? String(j.data.id) : null };
  }
  const url = `${String(cfg.apiUrl).replace(/\/$/, '')}/assets`;
  const j = await post(d, url, String(cfg.apiKey), form(f.name, f.mime, f.bytes));
  const rid = j?.id ?? j?.data?.id;
  return { target, remoteId: rid !== undefined ? String(rid) : null };
}
