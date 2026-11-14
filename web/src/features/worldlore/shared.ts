export interface LoreConfig { kind: 'source' | 'library'; sourceId?: string; root: string; defaultLevel: 'dm' | 'broker' | 'party'; url?: string }
export interface LoreState {
  enabled: boolean;
  config: LoreConfig | null;
  links: { source: string | null; sourceName: string | null; url: string | null; guess: boolean; libraryFolder: string | null } | null;
}
export interface LoreOptions {
  sources: { id: string; name: string; kind: string; label: string; roots: { id: string; title: string; folder?: boolean }[]; error?: string }[];
  library: { root: string };
}
export interface LorePage { id: string; ref: string; title: string; path: string; level: string; writtenBy: 'agent' | 'dm'; updatedAt: string; parentId: string | null }

export const LEVEL_LABEL: Record<string, string> = {
  dm: 'DM only', broker: 'Broker may sell', party: 'Players', classified: 'Classified (no AI)',
};
