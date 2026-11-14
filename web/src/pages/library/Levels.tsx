// The four secrecy levels (see librarian/src/core/levels.ts): party, broker,
// dm and classified. Classified is never sent to any AI model or MCP client.
export type Level = 'party' | 'broker' | 'dm' | 'classified';

export const LEVELS: Level[] = ['party', 'broker', 'dm', 'classified'];
export const LEVEL_LABEL: Record<Level, string> = { party: 'Shared with the party', broker: 'Broker may sell it', dm: 'DM only (AI can read)', classified: 'Classified: never shared with any AI' };
const SHORT: Record<Level, string> = { party: 'Party', broker: 'Broker', dm: 'DM', classified: 'Classified' };

export const levelOf = (v: unknown): Level => (v === 'party' || v === 'broker' || v === 'classified' ? v : 'dm');
/** The level words a title can start with ("Broker", "Classified"). */
export const titleLevel = (t: unknown): Level | null => { const m = /^\s*(broker|classified)\b/i.exec(String(t ?? '')); return m ? (m[1].toLowerCase() as Level) : null; };

/** A small chip: amber Broker, red DM, black Classified with a lock. Party pages show nothing unless `all`. */
export function LevelChip({ level, all }: { level: unknown; all?: boolean }) {
  const l = levelOf(level);
  if (l === 'party' && !all) return null;
  return (
    <span className={`lvl-chip lvl-${l}`} title={LEVEL_LABEL[l]}>
      {l === 'classified' && <i className="fa-solid fa-lock" aria-hidden="true" />} {SHORT[l]}
    </span>
  );
}

/** The red frame at the top of a classified page. */
export function ClassifiedFrame() {
  return (
    <div className="lvl-frame" role="note">
      <i className="fa-solid fa-lock" aria-hidden="true" /> <strong>Classified: never shared with any AI.</strong> Players, the broker and every model or MCP client are kept from it. Only you see it here.
    </div>
  );
}

export const LEVEL_CSS = `
.lvl-chip { display: inline-flex; gap: 4px; align-items: center; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; }
.lvl-broker { background: #fff3d1; color: #7a4a00; border-color: #e0a526; }
.lvl-dm { background: var(--danger-bg); color: var(--danger-text); border-color: var(--danger); }
.lvl-classified { background: #111; color: #fff; border-color: #000; }
.lvl-party { background: var(--panel-2); color: var(--muted); }
.lvl-frame { margin: 0 22px 8px; padding: 10px 14px; border: 2px solid var(--danger); border-radius: 8px; background: var(--danger-bg); color: var(--danger-text); }
.lvl-block { margin: 12px 0; padding: 12px 14px; border-radius: 8px; }
.lvl-block.lvl-broker { border: 1px dashed #e0a526; background: #fff8e6; color: inherit; }
.lvl-block.lvl-classified { border: 2px solid #000; background: rgba(0, 0, 0, 0.06); color: inherit; }
.lvl-block > .lvl-chip { margin-bottom: 6px; }
`;
