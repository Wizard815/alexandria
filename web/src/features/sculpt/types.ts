export type FieldType = 'text' | 'longtext' | 'number' | 'select' | 'list' | 'name' | 'item' | 'coins' | 'page' | 'statblock';
export const FIELD_TYPES: FieldType[] = ['text', 'longtext', 'number', 'select', 'list', 'name', 'item', 'coins', 'page', 'statblock'];
export interface Field { key: string; label: string; type: FieldType; options?: string[]; hint?: string; required?: boolean; dmOnly?: boolean; gen?: 'clock' | 'stock' }
export interface Target { kind: 'page' | 'person' | 'combat' | 'shop' | 'none'; path?: string; visibility?: 'dm' | 'party'; alsoPage?: boolean; listField?: string }
export interface Tpl { id: string; builtin: boolean; key: string | null; name: string; description: string; perspective: 'dm' | 'player'; fields: Field[]; body: string; target: Target }
export interface Part { dm: boolean; md: string }
export type Values = Record<string, string>;
