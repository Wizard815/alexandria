export type FieldType = 'text' | 'longtext' | 'number' | 'select' | 'list' | 'name' | 'item' | 'coins' | 'page' | 'statblock' | 'dice' | 'table' | 'image' | 'pageLink' | 'rollTable';
export const FIELD_TYPES: FieldType[] = ['text', 'longtext', 'number', 'select', 'list', 'name', 'item', 'coins', 'page', 'statblock', 'dice', 'table', 'image', 'pageLink', 'rollTable'];
export const CATEGORIES = ['Combat', 'NPCs', 'Places', 'Loot', 'Story', 'Prep'] as const;
export interface Field {
  key: string; label: string; type: FieldType; options?: string[]; hint?: string; required?: boolean; gmOnly?: boolean;
  gen?: string; fallback?: string; default?: string; columns?: string[]; dieField?: string; die?: number; optional?: boolean;
}
export interface Target { kind: 'page' | 'person' | 'combat' | 'shop' | 'none'; path?: string; visibility?: 'gm' | 'party'; alsoPage?: boolean; listField?: string }
export interface Outputs { page?: boolean; stage?: boolean; combat?: boolean; send?: boolean; broker?: boolean; stageKind?: 'text' | 'event'; stageShow?: boolean; combatField?: string }
export interface Tpl {
  id: string; builtin: boolean; key: string | null; name: string; description: string; perspective: 'gm' | 'player'; category: string;
  fields: Field[]; body: string; target: Target; outputs: Outputs; favorite?: boolean; uses?: number; lastUsedAt?: string | null;
}
export interface Part { gm: boolean; md: string }
export type Values = Record<string, string>;
export interface SculptContext { location?: string; partyLevel?: number; page?: string }
export type OutputKey = 'page' | 'stage' | 'combat' | 'send' | 'broker';
