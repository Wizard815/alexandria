// What the librarian sends for NPC encounters (librarian/src/features/encounters).

export type Effect = { kind: 'gold'; cp: number } | { kind: 'item'; name: string; qty: number } | { kind: 'shop'; shopId: string };
export interface Option { label: string; next: string | null; effects: Effect[] }
export type GameKind = 'coin' | 'shells' | 'dice' | 'check';
export interface Game { kind: GameKind; stakeCp: number; winCp: number; dc: number | null; skill: string | null; win: string; lose: string }
export interface Node { id: string; text: string; options: Option[]; game: Game | null }
export interface Script { start: string; nodes: Node[] }

export interface Line { who: 'npc' | 'you' | 'game' | 'gain' | 'loss' | 'dm' | 'note'; text: string; at: string }

export interface Encounter {
  id: string; npc: { name: string; blurb: string }; status: 'open' | 'done' | 'cancelled'; source: 'dm' | 'wander';
  createdAt: string; updatedAt: string; log: Line[]; text: string | null; options: { label: string }[];
  game: { kind: GameKind; label: string; stakeCp: number; winCp: number; skill: string | null } | null;
  shop: { id: string; name: string } | null;
  // DM only:
  accountId?: string; player?: string; templateId?: string | null; templateName?: string; nodeId?: string; dc?: number | null; paidCp?: number; script?: Script;
}

export interface Template { id: string; name: string; npcName: string; npcBlurb: string; script: Script; wander: boolean; builtin: boolean }
export interface EncounterConfig { wander: boolean; wanderMinutes: number; capCp: number; coins: 'gsc' | 'all' | 'gold'; games: Record<GameKind, string>; nextWanderAt?: string | null }

export const GAME_HELP: Record<GameKind, string> = {
  coin: 'Call heads or tails. Even odds.',
  shells: 'Find the pea under one of three shells. One in three.',
  dice: 'Both roll 2d6, higher wins. Ties go to the NPC.',
  check: 'A d20 plus a modifier against a DC only the DM sees.',
};
