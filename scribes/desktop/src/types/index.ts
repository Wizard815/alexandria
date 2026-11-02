// Alexandria Scribe Desktop Types

// Common types
export interface Id {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface World extends Id {
  name: string;
  description?: string;
  ownerId: string;
  rootNodeId?: string;
  role: 'owner' | 'dm' | 'player' | 'guest';
  isDefault?: boolean;
}

export interface User extends Id {
  username: string;
  role: 'dm' | 'player' | 'guest';
  worldId: string;
  playerId?: string; // Reference to Player profile
}

// Player Types
export interface Player extends Id {
  worldId: string;
  userId: string;
  characterName: string;
  characterLevel: number;
  characterClass?: string;
  characterRace?: string;
  imageUrl?: string;
  // Player stats
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
}

// Inventory Types
export interface Inventory extends Id {
  worldId: string;
  playerId?: string; // For player-specific inventory
  partyId?: string; // For party inventory
  name: string;
  description?: string;
  type: 'player' | 'party';
}

export interface InventoryItem extends Id {
  inventoryId: string;
  itemId: string;
  quantity: number;
  description?: string;
  isEquipped?: boolean;
  rarity?: 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary' | 'artifact';
}

export interface Item extends Id {
  worldId: string;
  name: string;
  description?: string;
  category: string;
  cost?: number;
  weight?: number;
  isEquipment?: boolean;
  rarity?: 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary' | 'artifact';
}

// Money tracking
export interface Currency extends Id {
  worldId: string;
  name: string;
  symbol: string;
  exchangeRate: number; // Relative to gold
  isGold?: boolean; // Base currency
}

export interface Wallet extends Id {
  inventoryId: string;
  currencyId: string;
  amount: number;
}

// Date Tracker
export interface DateTracker extends Id {
  worldId: string;
  currentDate: string; // ISO date string
  currentSeason: 'spring' | 'summer' | 'fall' | 'winter';
  currentMonth: number; // 1-12
  currentDay: number; // 1-30/31
  currentYear: number;
  timePassed?: number; // Days passed since tracker start
}

// Travel Log
export interface TravelLog extends Id {
  worldId: string;
  title: string;
  date: string;
  location: string;
  distance?: number; // in miles/km
  duration?: string; // "3 days", "2 hours"
  participants?: string[]; // Player IDs or names
  notes?: string;
  isPartyTravel?: boolean;
}

// Session Log
export interface SessionLog extends Id {
  worldId: string;
  title: string;
  date: string;
  dmNotes?: string;
  playerNotes?: string;
  location?: string;
  duration?: string;
  attendees?: string[];
}

// MCP Module Config
export interface McpConfig extends Id {
  worldId: string;
  type: 'legendkeeper' | 'kanka' | 'generic';
  apiUrl: string;
  apiKey?: string;
  campaignId?: string;
  projectId?: string;
  githubUrl?: string;
  lastSynced?: string;
}

// Sync Status
export interface SyncStatus {
  lastSync: string;
  syncStatus: 'idle' | 'syncing' | 'completed' | 'error';
  lastError?: string;
  pendingUpdates: number;
  localOnly: boolean;
}
