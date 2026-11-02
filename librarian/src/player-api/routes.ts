import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

// In-memory storage (will be replaced with database)
let playerProfiles: Array<{
  id: string;
  worldId: string;
  userId: string;
  characterName: string;
  characterLevel: number;
  characterClass?: string;
  characterRace?: string;
  imageUrl?: string;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
  lastUpdated: string;
}> = [];

let inventories: Array<{
  id: string;
  worldId: string;
  playerId?: string;
  partyId?: string;
  name: string;
  type: 'player' | 'party';
  items: Array<{
    itemId: string;
    quantity: number;
    description?: string;
    isEquipped?: boolean;
    rarity?: 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary' | 'artifact';
  }>;
  lastUpdated: string;
}> = [];

let currencies: Array<{
  id: string;
  worldId: string;
  name: string;
  symbol: string;
  exchangeRate: number;
  isGold?: boolean;
}> = [
  { id: 'gold', worldId: 'default', name: 'Gold', symbol: 'gp', exchangeRate: 1, isGold: true },
  { id: 'silver', worldId: 'default', name: 'Silver', symbol: 'sp', exchangeRate: 0.1, isGold: false },
  { id: 'copper', worldId: 'default', name: 'Copper', symbol: 'cp', exchangeRate: 0.01, isGold: false },
];

let wallets: Array<{
  inventoryId: string;
  currencyId: string;
  amount: number;
}> = [];

let dateTrackers: Array<{
  id: string;
  worldId: string;
  currentDate: string;
  currentSeason: 'spring' | 'summer' | 'fall' | 'winter';
  currentMonth: number;
  currentDay: number;
  currentYear: number;
  timePassed?: number;
  lastUpdated: string;
}> = [];

let travelLogs: Array<{
  id: string;
  worldId: string;
  title: string;
  date: string;
  location: string;
  distance?: number;
  duration?: string;
  participants?: string[];
  notes?: string;
  isPartyTravel?: boolean;
  lastUpdated: string;
}> = [];

let sessionLogs: Array<{
  id: string;
  worldId: string;
  title: string;
  date: string;
  dmNotes?: string;
  playerNotes?: string;
  location?: string;
  duration?: string;
  attendees?: string[];
  lastUpdated: string;
}> = [];

// Helper to get world from token (simplified)
function getWorldId(req: Request): string {
  return 'default';
}

// Player Profile Endpoints
router.get('/players', (req, res) => {
  const worldId = getWorldId(req);
  res.json(playerProfiles.filter(p => p.worldId === worldId));
});

router.get('/players/:id', (req, res) => {
  const player = playerProfiles.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  res.json(player);
});

router.post('/players', (req, res) => {
  const { worldId, userId, characterName, characterLevel, characterClass, characterRace, imageUrl, hp, maxHp, ac, speed } = req.body;
  
  const newPlayer = {
    id: Date.now().toString(),
    worldId,
    userId,
    characterName,
    characterLevel,
    characterClass,
    characterRace,
    imageUrl,
    hp,
    maxHp,
    ac,
    speed,
    lastUpdated: new Date().toISOString()
  };
  
  playerProfiles.push(newPlayer);
  res.status(201).json(newPlayer);
});

router.put('/players/:id', (req, res) => {
  const playerIndex = playerProfiles.findIndex(p => p.id === req.params.id);
  if (playerIndex === -1) return res.status(404).json({ error: 'Player not found' });
  
  const updates = req.body;
  playerProfiles[playerIndex] = {
    ...playerProfiles[playerIndex],
    ...updates,
    lastUpdated: new Date().toISOString()
  };
  
  res.json(playerProfiles[playerIndex]);
});

// Inventory Endpoints
router.get('/inventories', (req, res) => {
  const worldId = getWorldId(req);
  res.json(inventories.filter(i => i.worldId === worldId));
});

router.get('/inventories/:id', (req, res) => {
  const inventory = inventories.find(i => i.id === req.params.id);
  if (!inventory) return res.status(404).json({ error: 'Inventory not found' });
  res.json(inventory);
});

router.post('/inventories', (req, res) => {
  const { worldId, playerId, partyId, name, type, items } = req.body;
  
  const newInventory = {
    id: Date.now().toString(),
    worldId,
    playerId,
    partyId,
    name,
    type,
    items: items || [],
    lastUpdated: new Date().toISOString()
  };
  
  inventories.push(newInventory);
  res.status(201).json(newInventory);
});

router.put('/inventories/:id/items', (req, res) => {
  const inventoryIndex = inventories.findIndex(i => i.id === req.params.id);
  if (inventoryIndex === -1) return res.status(404).json({ error: 'Inventory not found' });
  
  const { itemId, quantity, description, isEquipped, rarity } = req.body;
  const existingItemIndex = inventories[inventoryIndex].items.findIndex(i => i.itemId === itemId);
  
  if (existingItemIndex === -1) {
    inventories[inventoryIndex].items.push({ itemId, quantity, description, isEquipped, rarity });
  } else {
    inventories[inventoryIndex].items[existingItemIndex] = {
      ...inventories[inventoryIndex].items[existingItemIndex],
      quantity,
      description,
      isEquipped,
      rarity
    };
  }
  
  inventories[inventoryIndex].lastUpdated = new Date().toISOString();
  res.json(inventories[inventoryIndex]);
});

// Currency Endpoints
router.get('/currencies', (req, res) => {
  const worldId = getWorldId(req);
  res.json(currencies.filter(c => c.worldId === worldId));
});

router.get('/wallets/:inventoryId', (req, res) => {
  const inventoryWallets = wallets.filter(w => w.inventoryId === req.params.inventoryId);
  res.json(inventoryWallets.map(w => ({
    ...w,
    currency: currencies.find(c => c.id === w.currencyId)
  })));
});

router.post('/wallets', (req, res) => {
  const { inventoryId, currencyId, amount } = req.body;
  
  const existingWallet = wallets.find(w => w.inventoryId === inventoryId && w.currencyId === currencyId);
  if (existingWallet) {
    existingWallet.amount = amount;
    res.json(existingWallet);
  } else {
    const newWallet = { inventoryId, currencyId, amount };
    wallets.push(newWallet);
    res.status(201).json(newWallet);
  }
});

// Date Tracker Endpoints
router.get('/date-tracker', (req, res) => {
  const worldId = getWorldId(req);
  let tracker = dateTrackers.find(d => d.worldId === worldId);
  if (!tracker) {
    // Create default tracker
    tracker = {
      id: Date.now().toString(),
      worldId,
      currentDate: new Date().toISOString().split('T')[0],
      currentSeason: 'spring',
      currentMonth: 1,
      currentDay: 1,
      currentYear: 1,
      timePassed: 0,
      lastUpdated: new Date().toISOString()
    };
    dateTrackers.push(tracker);
  }
  res.json(tracker);
});

router.put('/date-tracker', (req, res) => {
  const worldId = getWorldId(req);
  let tracker = dateTrackers.find(d => d.worldId === worldId);
  
  if (!tracker) {
    tracker = {
      id: Date.now().toString(),
      worldId,
      currentDate: new Date().toISOString().split('T')[0],
      currentSeason: 'spring',
      currentMonth: 1,
      currentDay: 1,
      currentYear: 1,
      timePassed: 0,
      lastUpdated: new Date().toISOString()
    };
    dateTrackers.push(tracker);
  }
  
  const updates = req.body;
  tracker = {
    ...tracker,
    ...updates,
    lastUpdated: new Date().toISOString()
  };
  
  res.json(tracker);
});

// Travel Log Endpoints
router.get('/travel-logs', (req, res) => {
  const worldId = getWorldId(req);
  res.json(travelLogs.filter(t => t.worldId === worldId));
});

router.post('/travel-logs', (req, res) => {
  const { worldId, title, date, location, distance, duration, participants, notes, isPartyTravel } = req.body;
  
  const newLog = {
    id: Date.now().toString(),
    worldId,
    title,
    date,
    location,
    distance,
    duration,
    participants,
    notes,
    isPartyTravel,
    lastUpdated: new Date().toISOString()
  };
  
  travelLogs.push(newLog);
  res.status(201).json(newLog);
});

// Session Log Endpoints
router.get('/session-logs', (req, res) => {
  const worldId = getWorldId(req);
  res.json(sessionLogs.filter(s => s.worldId === worldId));
});

router.post('/session-logs', (req, res) => {
  const { worldId, title, date, dmNotes, playerNotes, location, duration, attendees } = req.body;
  
  const newLog = {
    id: Date.now().toString(),
    worldId,
    title,
    date,
    dmNotes,
    playerNotes,
    location,
    duration,
    attendees,
    lastUpdated: new Date().toISOString()
  };
  
  sessionLogs.push(newLog);
  res.status(201).json(newLog);
});

// Sync Status
router.get('/sync-status', (req, res) => {
  const worldId = getWorldId(req);
  res.json({
    lastSync: new Date().toISOString(),
    syncStatus: 'completed',
    pendingUpdates: 0,
    localOnly: false
  });
});

export default router;
