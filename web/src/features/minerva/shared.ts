// Shapes of /minerva (the GM's memory) and /minerva/me (a player's own notes).
export interface Arc { id: string; n: number; slug: string; title: string; status: 'open' | 'closed'; openedAt: string; closedAt: string | null }
export interface Thread { title: string; rel: string; heat: string; kind: 'hook' | 'goal'; owner?: string }
export interface Candidate { name: string; kind: string; sessions: number; reasons: string[]; entity?: string }
export interface Clue { n: number; text: string; found: { accountId: string; name: string; session: number | null; at: string }[] }
export interface Mystery { slug: string; title: string; conclusion: string; status: string; clues: Clue[]; reached: string[]; theories: { accountId: string; text: string }[] }
export interface PlayerRow { accountId: string; name: string; character: string; goals: { rel: string; title: string; heat: string }[]; journal: number; knowledge: string; notes: string; shared: string }
export interface VaultPage { id: string; rel: string; title: string; fm: Record<string, unknown>; body: string; level: string; updatedAt: string }
export interface State {
  enabled: boolean; name: string; model: boolean; root: string;
  status?: VaultPage | null; sections?: { title: string; text: string }[];
  arc?: Arc | null; arcs?: Arc[]; threads?: Thread[]; pending?: number; promotions?: Candidate[]; mysteries?: Mystery[]; players?: PlayerRow[];
}
export interface Op { op: string; rel?: string; text?: string; body?: string; section?: string; mode?: string }
export interface Draft { id: string; review: string; kind: string; title: string; op: Op; byAccount: string | null; createdAt: string; preview: { rel: string; where: string; before: string; after: string; level?: string; visibleToPlayers?: boolean } | null }
export interface ReviewState { drafts: Draft[]; actions: { id: string; tool: string; summary: string; createdAt: string }[]; recent: { id: string; title: string; kind: string; status: string; note: string }[] }

export interface View { key: string; title: string; body: string; heat?: string; updatedAt: string }
export interface Mine { profile: View | null; shared: View | null; bonds: View | null; knowledge: View | null; goals: View[]; journal: View[]; notes: View[]; party: View[]; others: View[]; session: number }

export const HEATS = ['on', 'ongoing', 'simmering', 'sleeping'] as const;
export const KIND_LABEL: Record<string, string> = { status: 'Status', heat: 'Heat', codex: 'Codex', promote: 'New page', journal: 'Journal', knowledge: 'Clue', goal: 'Goal', note: 'Note', share: 'Shared', arc: 'Arc summary', 'suggest-clue': 'Suggestion: clue', 'suggest-npc': 'Suggestion: new NPC', 'suggest-goal': 'Suggestion: promise or goal', 'suggest-hook': 'Suggestion: hook' };
