import { useState, useEffect } from 'react';
import { DndClient } from '@alexandria/client';
import { PlayerView, PlayerAppState, World, Player } from './types';
import { Login } from './components/Login.tsx';

export default function App() {
  const [view, setView] = useState<PlayerView>('overview');
  const [world, setWorld] = useState<World | null>(null);
  const [playerProfile, setPlayerProfile] = useState<Player | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load data from local storage on mount
  useEffect(() => {
    const storedWorld = localStorage.getItem('alexandria_world');
    const storedPlayer = localStorage.getItem('alexandria_player');
    
    if (storedWorld) setWorld(JSON.parse(storedWorld));
    if (storedPlayer) setPlayerProfile(JSON.parse(storedPlayer));
  }, []);

  // Save world to local storage
  useEffect(() => {
    if (world) localStorage.setItem('alexandria_world', JSON.stringify(world));
  }, [world]);

  // Save player to local storage
  useEffect(() => {
    if (playerProfile) localStorage.setItem('alexandria_player', JSON.stringify(playerProfile));
  }, [playerProfile]);

  async function handleWorldSelect(worldId: string, client: DndClient) {
    setLoading(true);
    setError('');
    
    try {
      const worldResponse = await client.getWorld(worldId);
      if (!worldResponse.error && worldResponse.data?.world) {
        setWorld(worldResponse.data.world as World);
        
        // Load player profile
        const playerResponse = await client.getPlayerByWorld(worldId);
        if (!playerResponse.error && playerResponse.data?.player) {
          setPlayerProfile(playerResponse.data.player as Player);
        } else if (!playerResponse.error) {
          // Create new player profile
          const newPlayer = await createPlayerProfile(client, worldId);
          setPlayerProfile(newPlayer);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load world');
    } finally {
      setLoading(false);
    }
  }

  async function createPlayerProfile(client: DndClient, worldId: string): Promise<Player> {
    const newPlayer = {
      id: Date.now().toString(),
      worldId,
      userId: 'player-user-id',
      characterName: 'My Character',
      characterLevel: 1,
      characterClass: '',
      characterRace: '',
      imageUrl: '',
      hp: 10,
      maxHp: 10,
      ac: 10,
      speed: 30,
      lastUpdated: new Date().toISOString()
    };
    
    // Save locally
    setPlayerProfile(newPlayer);
    localStorage.setItem('alexandria_player', JSON.stringify(newPlayer));
    
    return newPlayer;
  }

  // If no world selected, show world picker
  if (!world) {
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="bg-gray-800 border-b border-gray-700 px-4 py-3">
          <h1 className="text-lg font-bold">Alexandria Player</h1>
        </header>
        <main className="p-4">
          <h2 className="text-xl font-semibold mb-4">Select a World</h2>
          {loading && <p>Loading...</p>}
          {!loading && (
            <WorldPicker onWorldSelect={handleWorldSelect} />
          )}
        </main>
      </div>
    );
  }

  // If no player profile, create one
  if (!playerProfile) {
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="bg-gray-800 border-b border-gray-700 px-4 py-3">
          <h1 className="text-lg font-bold">Alexandria Player</h1>
        </header>
        <main className="p-4">
          <h2 className="text-xl font-semibold mb-4">Creating Player Profile</h2>
          <p>Loading player data...</p>
        </main>
      </div>
    );
  }

  // Main player app
  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      <header className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex items-center gap-4">
        <h1 className="text-lg font-bold">Alexandria Player</h1>
        <div className="text-sm text-gray-400">{world.name}</div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Navigation */}
        <nav className="w-48 border-r border-gray-700 flex flex-col">
          <div className="p-4">
            <h2 className="text-sm font-semibold text-gray-400 mb-2">PLAYER INFO</h2>
            <div className="bg-gray-800 rounded p-2 mb-4">
              <h3 className="font-bold text-blue-400">{playerProfile.characterName}</h3>
              <p className="text-sm text-gray-400">
                Lvl {playerProfile.characterLevel} {playerProfile.characterRace}
                {playerProfile.characterClass && ` ${playerProfile.characterClass}`}
              </p>
            </div>

            <div className="space-y-2">
              <button
                onClick={() => setView('overview')}
                className={`w-full text-left px-3 py-2 rounded transition ${
                  view === 'overview' ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'
                }`}
              >
                Overview
              </button>
              <button
                onClick={() => setView('inventory')}
                className={`w-full text-left px-3 py-2 rounded transition ${
                  view === 'inventory' ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'
                }`}
              >
                Inventory
              </button>
              <button
                onClick={() => setView('travel')}
                className={`w-full text-left px-3 py-2 rounded transition ${
                  view === 'travel' ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'
                }`}
              >
                Travel Log
              </button>
              <button
                onClick={() => setView('sessions')}
                className={`w-full text-left px-3 py-2 rounded transition ${
                  view === 'sessions' ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'
                }`}
              >
                Sessions
              </button>
              <button
                onClick={() => setView('settings')}
                className={`w-full text-left px-3 py-2 rounded transition ${
                  view === 'settings' ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'
                }`}
              >
                Settings
              </button>
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-4">
          <ViewContent 
            view={view} 
            playerProfile={playerProfile} 
            world={world}
            setView={setView}
          />
        </main>
      </div>
    </div>
  );
}

function WorldPicker({ onWorldSelect }: { onWorldSelect: (worldId: string) => void }) {
  const [worlds, setWorlds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch('/api/worlds');
        if (!response.ok) throw new Error('Failed to load worlds');
        const data = await response.json();
        if (data.worlds) {
          setWorlds(data.worlds);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to list worlds');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <p className="text-gray-400">Loading worlds...</p>;
  if (error) return <p className="text-red-400">{error}</p>;
  if (worlds.length === 0) return <p className="text-gray-400">No worlds found.</p>;

  return (
    <div className="space-y-2">
      {worlds.map((w) => (
        <div
          key={w.id}
          className="bg-gray-800 p-3 rounded cursor-pointer hover:bg-gray-700"
          onClick={() => onWorldSelect(w.id)}
        >
          <div className="font-medium">{w.name}</div>
          <div className="text-xs text-gray-500 mt-1">Role: {w.role}</div>
        </div>
      ))}
    </div>
  );
}

function ViewContent({ view, playerProfile, world, setView }: any) {
  switch (view) {
    case 'overview':
      return <OverviewView playerProfile={playerProfile} world={world} setView={setView} />;
    case 'inventory':
      return <InventoryView playerProfile={playerProfile} />;
    case 'travel':
      return <TravelLogView playerProfile={playerProfile} />;
    case 'sessions':
      return <SessionLogView playerProfile={playerProfile} />;
    case 'settings':
      return <SettingsView playerProfile={playerProfile} />;
    default:
      return <OverviewView playerProfile={playerProfile} world={world} setView={setView} />;
  }
}

function OverviewView({ playerProfile, world, setView }: any) {
  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4">Character Overview</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-700 p-4 rounded">
            <h3 className="text-gray-400 text-sm">Hit Points</h3>
            <p className="text-2xl font-bold">{playerProfile.hp} / {playerProfile.maxHp}</p>
          </div>
          <div className="bg-gray-700 p-4 rounded">
            <h3 className="text-gray-400 text-sm">Armor Class</h3>
            <p className="text-2xl font-bold">{playerProfile.ac}</p>
          </div>
          <div className="bg-gray-700 p-4 rounded">
            <h3 className="text-gray-400 text-sm">Speed</h3>
            <p className="text-2xl font-bold">{playerProfile.speed} ft</p>
          </div>
          <div className="bg-gray-700 p-4 rounded">
            <h3 className="text-gray-400 text-sm">Level</h3>
            <p className="text-2xl font-bold">{playerProfile.characterLevel}</p>
          </div>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-xl font-bold mb-4">World Status</h3>
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-gray-400">World Name</span>
            <span className="font-bold">{world.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Date Tracker</span>
            <button onClick={() => setView('travel')} className="text-blue-400 hover:text-blue-300">
              View/Update Date
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InventoryView({ playerProfile }: any) {
  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4">Inventory</h2>
        <div className="bg-gray-700 p-4 rounded mb-4">
          <h3 className="text-lg font-bold mb-2">Player Inventory</h3>
          <p className="text-gray-400">No items yet</p>
        </div>
        <div className="bg-gray-700 p-4 rounded">
          <h3 className="text-lg font-bold mb-2">Party Inventory</h3>
          <p className="text-gray-400">No party items yet</p>
        </div>
      </div>
    </div>
  );
}

function TravelLogView({ playerProfile }: any) {
  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4">Travel Log</h2>
        <div className="bg-gray-700 p-4 rounded">
          <h3 className="text-lg font-bold mb-2">Current Date</h3>
          <p className="text-xl">Year 1 - Spring - Day 1</p>
          <p className="text-gray-400">Time Passed: 0 days</p>
        </div>
        <div className="mt-4 bg-gray-700 p-4 rounded">
          <h3 className="text-lg font-bold mb-2">Recent Travel Logs</h3>
          <p className="text-gray-400">No travel logs yet</p>
        </div>
      </div>
    </div>
  );
}

function SessionLogView({ playerProfile }: any) {
  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4">Session Logs</h2>
        <div className="bg-gray-700 p-4 rounded">
          <h3 className="text-lg font-bold mb-2">Your Session Notes</h3>
          <p className="text-gray-400">No session logs yet</p>
        </div>
        <div className="mt-4 bg-gray-700 p-4 rounded">
          <h3 className="text-lg font-bold mb-2">Party Session Notes</h3>
          <p className="text-gray-400">No party session logs yet</p>
        </div>
      </div>
    </div>
  );
}

function SettingsView({ playerProfile }: any) {
  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4">Settings</h2>
        <div className="space-y-4">
          <div className="bg-gray-700 p-4 rounded">
            <h3 className="text-lg font-bold mb-2">Character Settings</h3>
            <button className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">
              Edit Character
            </button>
          </div>
          <div className="bg-gray-700 p-4 rounded">
            <h3 className="text-lg font-bold mb-2">Sync Settings</h3>
            <p className="text-gray-400 mb-2">Sync with Library: Online</p>
            <p className="text-gray-400">Last Sync: Just now</p>
          </div>
        </div>
      </div>
    </div>
  );
}
