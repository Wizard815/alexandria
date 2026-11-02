// Player Scribe App Types

import { World, Player, Inventory, InventoryItem, Item, Currency, Wallet, DateTracker, TravelLog, SessionLog } from './index';

// Player-specific views
export type PlayerView = 'overview' | 'inventory' | 'travel' | 'sessions' | 'settings';

// Player state
export interface PlayerAppState {
  currentWorld: World;
  playerProfile: Player;
  inventory: Inventory;
  partyInventory: Inventory;
  currencies: Currency[];
  wallets: Wallet[];
  dateTracker: DateTracker;
  travelLogs: TravelLog[];
  sessionLogs: SessionLog[];
  syncStatus: {
    lastSync: string;
    status: 'idle' | 'syncing' | 'completed' | 'error';
    isOnline: boolean;
    lastError?: string;
  };
}

// Player actions
export interface PlayerAction {
  type: 'update_hp' | 'update_ac' | 'add_item' | 'remove_item' | 'update_inventory' | 'sync';
  payload: any;
}

// API Responses
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

// Sync requests
export interface SyncRequest {
  worldId: string;
  syncType: 'full' | 'incremental' | 'player_inventory' | 'date_tracker' | 'travel_logs';
  lastSync?: string;
}

export interface SyncResponse {
  success: boolean;
  synced: boolean;
  newItems: number;
  updatedItems: number;
  deletedItems: number;
  lastSync: string;
}
