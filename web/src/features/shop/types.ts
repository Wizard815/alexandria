// Shapes the Shop API answers with (librarian/src/features/shop).
export interface Keeper { name?: string; race?: string; role?: string; look?: string; voice?: string; personality?: string; secret?: string; pageId?: string | null }
export interface Line {
  id: string; name: string; type: string; category: string; rarity: string; weight: number | null; description: string; properties: string;
  attunement: boolean; source: string; attribution: string; priceCp: number | null; qty: number | null; unlimited: boolean;
  // DM only
  itemId?: string; priceOverrideCp?: number | null; costCp?: number | null; baseQty?: number | null; hidden?: boolean; dmNote?: string; dmNotes?: string;
}
export interface Shop {
  id: string; name: string; kind: string; kindLabel: string; description: string; status: 'hidden' | 'closed' | 'open';
  keeper: Keeper | null; location: { id: string; title: string } | null; stock: Line[]; stockCount?: number; sellPct?: number | null;
  // DM only
  locationPageId?: string | null; markupPct?: number; haggle?: string; dmNotes?: string; restock?: { rule: 'manual' | 'days'; days: number; at: string | null };
}
export interface ShopConfig { approval: boolean; sellBack: boolean; sellPct: number; partyPay: boolean; coins: 'gsc' | 'all' | 'gold'; kinds: { id: string; label: string }[]; sizes: string[]; model?: boolean; types?: string[]; rarities?: string[] }
export interface Order { id: string; kind: 'buy' | 'sell'; shopId: string; shopName: string; itemName: string; qty: number; unitCp: number; totalCp: number; from: 'self' | 'party' | null; to: 'me' | 'party'; status: string; by: string; byName: string; at: string; decidedAt: string | null }
export interface Item {
  id: string; name: string; type: string; category: string; rarity: string; costCp: number | null; weight: number | null; description: string; properties: string;
  attunement: boolean; source: string; sourceLabel: string; sourceRef: string | null; attribution: string; tags: string[]; dmNotes: string; updatedAt: string;
}

export const STATUS_LABEL: Record<string, string> = { hidden: 'Hidden', closed: 'Closed', open: 'Open' };
export const statusChip = (s: string) => (s === 'open' ? 'chip green' : s === 'closed' ? 'chip gold' : 'chip red');
export const rarityLabel = (r: string) => (r === 'mundane' ? '' : r.replace(/^./, (c) => c.toUpperCase()));
