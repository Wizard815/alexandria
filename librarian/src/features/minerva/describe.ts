// What a Minerva write will do, in words, for the GM to confirm (the agent's
// pending-action list uses it).
/** The words appended to a codex write's approval card: where it lands and whether players can read it. */
export const visibilityNote = (t: { level: string; visible: boolean }): string => (t.visible ? `Visible to players (level ${t.level})` : t.level === 'party' ? `GM-only block on a level ${t.level} page` : `GM-only (level ${t.level})`);

export const MINERVA_WRITE_TOOLS = ['memory_log', 'memory_capture', 'conversation_log', 'status_update', 'revelation_mark', 'revelation_create', 'codex_upsert', 'promote', 'arc_close', 'arc_start', 'goal_update'] as const;
export const MINERVA_READ_TOOLS = ['context_for', 'who_is'] as const;
export const PLAYER_TOOLS = ['my_context', 'my_who_is', 'my_memory_log', 'my_memory_capture', 'my_goal_update'] as const;
export const MINERVA_TOOLS: readonly string[] = [...MINERVA_READ_TOOLS, ...MINERVA_WRITE_TOOLS];

const n = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const clip = (v: unknown, k = 80) => n(v).replace(/\s+/g, ' ').slice(0, k);

/** Words for a Minerva tool call, or null when the tool is not hers. */
export function describeMinerva(tool: string, a: any): string | null {
  switch (tool) {
    case 'memory_log': return `Log for the session: ${clip(a.text, 100)}`;
    case 'memory_capture': return `Capture a note${a.about ? ` about ${clip(a.about, 40)}` : ''}: ${clip(a.text, 100)}`;
    case 'conversation_log': return `File a conversation of ${Array.isArray(a.lines) ? a.lines.length : 0} lines into the players' journals`;
    case 'status_update': return `Campaign Status, ${clip(a.section, 40)} (${n(a.mode) || 'replace'}): ${clip(a.text, 100)}`;
    case 'revelation_mark': return `Mark ${clip(a.player, 40)} as having ${a.kind === 'reached' ? 'reached' : a.kind === 'theory' ? 'a theory on' : 'found a clue of'} "${clip(a.mystery, 60)}"${a.clue ? `: ${clip(a.clue, 80)}` : ''}`;
    case 'revelation_create': return `New mystery "${clip(a.title, 80)}" with ${Array.isArray(a.clues) ? a.clues.length : 0} clues`;
    case 'codex_upsert': return `Codex: add to ${clip(a.name ?? a.entity, 60)} (${clip(a.section, 30)}): ${clip(a.text, 100)}`;
    case 'promote': return `Promote ${clip(a.name, 60)} to a codex page`;
    case 'arc_close': return `Close the arc ${clip(a.arc, 60) || 'now open'} and draft its summary`;
    case 'arc_start': return `Start the arc "${clip(a.title, 80)}"`;
    case 'goal_update': return `Goal of ${clip(a.player, 40)}: ${clip(a.goal, 60)}${a.heat ? ` to ${n(a.heat)}` : ''}${a.text ? `: ${clip(a.text, 80)}` : ''}`;
    default: return null;
  }
}
