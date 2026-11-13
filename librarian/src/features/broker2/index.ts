// Broker v2 additions: delivery mode per tier, a scope lock, "Other" (free
// rules and item answers), a link to the world's site, and question routing
// with the audit model. The routes themselves live in routes/broker.ts; this
// feature adds the columns and world settings they use. See routing.ts,
// other.ts, guard.ts and clock.ts.
import type { Feature } from '../types.ts';

const strings = (max: number, each: number) => (v: unknown) => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length > each)) throw new Error(`Give up to ${max} short texts`);
};

const feature: Feature = {
  id: 'broker2',
  migrate(db) {
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    // DM-only: free-text spoiler topics, and whether the clock was moved to the world clock.
    if (!cols('broker_config').includes('spoiler_topics')) db.exec(`ALTER TABLE broker_config ADD COLUMN spoiler_topics TEXT NOT NULL DEFAULT '[]'`);
    if (!cols('broker_config').includes('clock_migrated')) db.exec('ALTER TABLE broker_config ADD COLUMN clock_migrated INTEGER NOT NULL DEFAULT 0');
    if (!cols('broker_page_rules').includes('spoiler')) db.exec('ALTER TABLE broker_page_rules ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0');
    // needs_review: held for the DM to approve; dm_written: a person wrote the answer.
    if (!cols('broker_requests').includes('needs_review')) db.exec('ALTER TABLE broker_requests ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0');
    if (!cols('broker_requests').includes('dm_written')) db.exec('ALTER TABLE broker_requests ADD COLUMN dm_written INTEGER NOT NULL DEFAULT 0');
  },
  settings: {
    brokerTopics: { type: 'json', default: [], validate: strings(30, 300) },
    brokerSiteUrl: { type: 'string', default: '', max: 500 },
    brokerSiteLabel: { type: 'string', default: '', max: 80 },
  },
};
export default feature;
