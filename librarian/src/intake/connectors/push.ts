// A push source has no sync. Your own tool sends entries (the same format
// connectors yield) to POST /api/intake/<source id>/entries with a source key.
// See features/intake for the endpoints, key handling and limits.
import type { Connector } from '../connector.ts';

export const pushSource: Connector = {
  id: 'push',
  label: 'Push (your own tool sends pages)',
  description: 'For tools that cannot be polled. Create a source key, then your tool sends entries to this source over HTTPS. The key can write to this source only. Entries go through the same leak guard as synced pages.',
  capabilities: ['pages', 'properties', 'tags', 'images'],
  push: true,
  fields: [],
  validate() {},
  async test() {
    return { ok: true, message: 'Nothing to connect to: your tool pushes entries here. Create a source key to get started.' };
  },
  async *sync() {
    // Nothing to read. runSync refuses push sources.
  },
};
