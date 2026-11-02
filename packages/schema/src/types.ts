// Shared data schemas for Alexandria D&D World App

// Base types
export interface Id {
  id: string;
  createdAt: string;
  updatedAt: string;
}

// World types
export interface World extends Id {
  name: string;
  description?: string;
  ownerId: string;
  rootNodeId?: string;
  role: 'owner' | 'dm' | 'player' | 'guest';
}

// User types
export interface User extends Id {
  username: string;
  role: 'owner' | 'dm' | 'player' | 'guest';
  worldId: string;
}

// Node/Page types
export interface Node extends Id {
  worldId: string;
  parentId?: string;
  title: string;
  type: string;
  visibility: 'public' | 'members' | 'dm';
  content?: string;
  sortKey: string;
}

// Map types
export interface Map extends Id {
  nodeId: string;
  backgroundImage?: string;
  width: number;
  height: number;
  gridSize: number;
}

export interface MapMarker extends Id {
  mapId: string;
  type: 'pin' | 'label' | 'circle' | 'polygon' | 'rectangle';
  x: number;
  y: number;
  title?: string;
  content?: string;
  color?: string;
  linkedNodeId?: string;
  groupId?: string;
}

export interface MapGroup extends Id {
  mapId: string;
  name: string;
  visible: boolean;
  sortKey: string;
}

// Session types
export interface Session extends Id {
  worldId: string;
  title: string;
  date: string;
  dmNotes?: string;
  playerNotes?: string;
  location?: string;
}

// Inventory types
export interface Inventory extends Id {
  worldId: string;
  name: string;
  description?: string;
  type: 'group' | 'individual';
  parentId?: string;
}

export interface InventoryItem extends Id {
  inventoryId: string;
  itemId: string;
  quantity: number;
  description?: string;
}

export interface Item extends Id {
  worldId: string;
  name: string;
  description?: string;
  category: string;
  cost?: number;
  weight?: number;
}

// Travel log types
export interface TravelLog extends Id {
  worldId: string;
  sessionId?: string;
  title: string;
  date: string;
  locations: string[];
  distance?: number;
  time?: string;
  notes?: string;
}

// Transcript types
export interface Transcript extends Id {
  sessionId: string;
  speaker: string;
  content: string;
  timestamp: string;
  type: 'text' | 'audio' | 'video';
}

// DM Notes
export interface DmNote extends Id {
  worldId: string;
  nodeId?: string;
  content: string;
  visibility: 'dm-only' | 'owner-only';
}

// Auth types
export interface AuthToken {
  token: string;
  expiresAt: string;
  userId: string;
  scope: 'read' | 'write' | 'admin';
}

// API response types
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
