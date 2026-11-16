// Presets for the generic API connector: a saved field mapping (paging, where
// the list is, which fields hold the id, title, body and visibility, the URL
// pattern with {world}-style placeholders) that is not tied to any world and
// holds no secret. Apply one when making a connection; import and export as JSON.
//
// The built-in ones are community examples and unverified: field names were
// not checked against the live apps. The dedicated Kanka and LegendKeeper
// connectors read far more (relations, timelines, maps, hidden content) and
// are the recommended way in; those two presets only show what a mapping looks like.
import { ConfigError } from './connector.ts';
import { genericApi } from './connectors/api.ts';
import { cleanEndpoints } from './connectors/apiEndpoints.ts';
import './registry.ts'; // sets each field's scope

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** The generic connector's connection settings: no secrets, nothing specific to one world. */
  config: Record<string, string | number | boolean>;
  builtin: boolean;
  /** Not checked against the real app. */
  unverified: boolean;
  note?: string;
}

/** The keys a preset may hold: the generic connector's connection settings, except secrets. */
const allowed = () => new Set(genericApi.fields.filter((f) => f.scope === 'connection' && !f.secret && f.type !== 'password').map((f) => f.key));

export const EXPORT_FORMAT = 'alexandria-api-preset';

const COMMUNITY = 'Community example, unverified: not checked against the live service.';

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin:rest-list', name: 'Generic REST list + detail', builtin: true, unverified: true,
    description: 'A paged JSON list where each record carries its own body. Put {world} where the world or project id goes in the URL.',
    note: `${COMMUNITY} Records are read from the list response; a separate per-record detail call is not supported, so the list has to include the body.`,
    config: { transport: 'http', url: 'https://api.example.com/v1/worlds/{world}/articles', paging: 'page', pageParam: 'page', itemsPath: 'data', idField: 'id', titleField: 'name', bodyField: 'body', bodyFormat: 'markdown', tagsField: 'tags', updatedField: 'updated_at', visibilityField: 'is_private', sharedValues: 'false' },
  },
  {
    id: 'builtin:mcp-tool', name: 'Generic MCP tool', builtin: true, unverified: true,
    description: 'Calls one read tool of an MCP server that returns records as JSON. {world} in the tool arguments is filled from each world\'s source.',
    note: `${COMMUNITY} Name the server (or its URL) on the connection and check the tool and the field names.`,
    config: { transport: 'mcp', tool: 'list_pages', toolArgs: '{"world": "{world}"}', paging: 'none', itemsPath: 'pages', idField: 'id', titleField: 'title', bodyField: 'content', bodyFormat: 'markdown', visibilityField: 'visibility', sharedValues: 'public, players' },
  },
  {
    id: 'builtin:kanka-generic', name: 'Kanka via generic API', builtin: true, unverified: true,
    description: 'Example only: Kanka notes through the generic mapping ({world} is the campaign id).',
    note: `${COMMUNITY} The dedicated Kanka connector is richer (relations, timelines, calendars, maps, posts, private entries) and is recommended. This preset only shows how a mapping reads a paged API.`,
    config: { transport: 'http', url: 'https://api.kanka.io/1.0/campaigns/{world}/notes', paging: 'link', nextPath: 'links.next', itemsPath: 'data', idField: 'id', titleField: 'name', bodyField: 'entry', bodyFormat: 'html', typeField: 'type', updatedField: 'updated_at', visibilityField: 'is_private', sharedValues: 'false' },
  },
  {
    id: 'builtin:legendkeeper-generic', name: 'LegendKeeper via generic API', builtin: true, unverified: true,
    description: 'Example only: LegendKeeper resources through the generic mapping ({world} is the project id).',
    note: `${COMMUNITY} The dedicated LegendKeeper connectors are richer (documents, hidden pages and blocks, maps, timelines) and are recommended. The field names here are a guess at the shape.`,
    config: { transport: 'http', url: 'https://www.legendkeeper.com/api/v3/projects/{world}/resources', paging: 'none', itemsPath: 'resources', idField: 'id', titleField: 'name', bodyField: 'content', bodyFormat: 'markdown', parentField: 'parentId', tagsField: 'tags', updatedField: 'updatedAt', visibilityField: 'isHidden', sharedValues: 'false' },
  },
];

/** A preset's settings, cleaned: only known keys, plain values, no secrets. Throws ConfigError on a bad one. */
export function cleanPresetConfig(cfg: unknown): Record<string, string | number | boolean> {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new ConfigError('A preset needs a config object');
  const ok = allowed();
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    if (!ok.has(k)) continue; // secrets, per-world values and unknown keys are dropped, never saved
    if (k === 'endpoints') {
      // The reviewed endpoint list (roles and mappings): cleaned, never anything but plain mapping values.
      const eps = cleanEndpoints(v);
      if (eps.length) out[k] = JSON.stringify(eps);
    } else if (typeof v === 'string') out[k] = v.slice(0, 2000);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  if (out.transport !== undefined && out.transport !== 'http' && out.transport !== 'mcp') throw new ConfigError('transport must be http or mcp');
  if (out.paging !== undefined && !['none', 'page', 'link', 'cursor'].includes(String(out.paging))) throw new ConfigError('Unknown paging');
  if (out.toolArgs) { try { JSON.parse(String(out.toolArgs).replace(/\{\w+\}/g, 'x')); } catch { throw new ConfigError('Tool arguments must be JSON'); } }
  if (!Object.keys(out).length) throw new ConfigError('The preset has no settings the generic API connector knows');
  return out;
}

export const cleanPresetName = (v: unknown) => {
  const s = String(v ?? '').trim().slice(0, 80);
  if (!s) throw new ConfigError('A preset needs a name');
  return s;
};

/** The JSON file for sharing a preset. No secrets, no world-specific values, no ids. */
export function exportPreset(p: Pick<Preset, 'name' | 'description' | 'config'>) {
  return { format: EXPORT_FORMAT, version: 1, name: p.name, description: p.description ?? '', config: cleanPresetConfig(p.config) };
}

/** Read an exported preset (an object or its JSON text). Throws ConfigError when it is not one. */
export function parsePresetImport(input: unknown): { name: string; description: string; config: Record<string, string | number | boolean> } {
  let j: any = input;
  if (typeof input === 'string') { try { j = JSON.parse(input); } catch { throw new ConfigError('That is not valid JSON'); } }
  if (!j || typeof j !== 'object' || j.format !== EXPORT_FORMAT) throw new ConfigError(`Not an Alexandria preset file (format "${EXPORT_FORMAT}" expected)`);
  return { name: cleanPresetName(j.name), description: String(j.description ?? '').slice(0, 500), config: cleanPresetConfig(j.config) };
}
