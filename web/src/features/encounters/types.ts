// What the librarian sends for NPC encounters (librarian/src/features/encounters).

export type Effect =
  | { kind: 'gold'; cp: number } | { kind: 'item'; name: string; qty: number; note?: string } | { kind: 'shop'; shopId: string }
  | { kind: 'pay'; cp: number } | { kind: 'lose'; cp: number } | { kind: 'dmnote'; text: string };
export type EncounterKind = 'npc' | 'event';
export interface PlaceOpt { id: string; label: string }
export interface Option { label: string; next: string | null; effects: Effect[] }
export type GameKind = 'coin' | 'shells' | 'dice' | 'check';
export interface Game { kind: GameKind; stakeCp: number; winCp: number; dc: number | null; dcMax?: number | null; skill: string | null; win: string; lose: string }
/** A timed step: secs to answer from when the player sees it; fallback is the answer picked for them (-1: the check fails). */
export interface Timer { secs: number; fallback: number }
export interface Node { id: string; text: string; options: Option[]; game: Game | null; timer?: Timer | null }
export interface Script { start: string; nodes: Node[] }

export interface Line { who: 'npc' | 'you' | 'game' | 'gain' | 'loss' | 'dm' | 'note' | 'secret'; text: string; at: string }

export interface Encounter {
  id: string; kind?: EncounterKind; npc: { name: string; blurb: string }; status: 'open' | 'done' | 'cancelled'; source: 'dm' | 'wander';
  createdAt: string; updatedAt: string; log: Line[]; text: string | null; options: { label: string }[];
  game: { kind: GameKind; label: string; stakeCp: number; winCp: number; skill: string | null } | null;
  shop: { id: string; name: string } | null;
  /** A timed step. endsAt is null until the player has seen it. */
  timer?: { secs: number; endsAt: string | null } | null;
  // GM only:
  accountId?: string; player?: string; templateId?: string | null; templateName?: string; nodeId?: string; dc?: number | null; dcMax?: number | null; paidCp?: number; script?: Script;
}

export interface Template { id: string; kind?: EncounterKind; places?: string[]; name: string; npcName: string; npcBlurb: string; script: Script; wander: boolean; builtin: boolean; fav?: boolean }
export interface EncounterConfig { wander: boolean; wanderMinutes: number; capCp: number; coins: 'gsc' | 'all' | 'gold'; games: Record<GameKind, string>; nextWanderAt?: string | null; places?: PlaceOpt[] }

export const GAME_HELP: Record<GameKind, string> = {
  coin: 'Call heads or tails. Even odds.',
  shells: 'Find the pea under one of three shells. One in three.',
  dice: 'Both roll 2d6, higher wins. Ties go to the NPC.',
  check: 'The player rolls a d20 with their bonus and types the total. The DC (one number, or a range it is picked from) stays hidden from them.',
};
