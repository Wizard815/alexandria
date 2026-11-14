export type Kind = 'image' | 'combat' | 'person' | 'shop' | 'place' | 'event' | 'text' | 'drawing';

export interface PageOut { id: string; title: string; kind: string; icon: any; facts: any[]; excerpt: any[]; truncated: boolean; links: Record<string, string>; openPath: string }
export interface StockItem { name: string; price: string; priceCp: number | null }

export interface StageCard {
  id: string; kind: Kind; x: number; y: number; w: number; h: number; z: number; shownAt: string | null;
  data: any; unavailable?: boolean;
  // DM only
  label?: string; visibility?: 'all' | 'players' | 'dm'; audience?: string[]; ref?: string | null; text?: string; caption?: string; options?: Record<string, any>;
}
export interface StageView { version: number; layout: 'spotlight' | 'grid' | 'free'; spotlightId: string | null; cards: StageCard[] }
