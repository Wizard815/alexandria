import { DndClient } from "@alexandria/client";
import { useState, useEffect } from "react";
import { Login } from "./components/Login.tsx";

interface AppState {
  client: DndClient;
  currentWorldId: string | null;
  selectedNodeId: string | null;
  role: 'dm' | 'player' | null;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [nodes, setNodes] = useState<import("@alexandria/schema").Node[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(client: DndClient) {
    setState({ client, currentWorldId: null, selectedNodeId: null, role: null });
  }

  async function loadWorlds(client: DndClient) {
    setLoading(true);
    setError("");
    try {
      const response = await client.listWorlds();
      if (!response.error && response.data?.worlds) {
        setNodes(response.data.worlds as any);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load worlds");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (state?.client) {
      loadWorlds(state.client);
    }
  }, [state?.client]);

  if (!state) {
    return <Login onSuccess={handleLogin} />;
  }

  if (!state.currentWorldId) {
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="bg-gray-800 border-b border-gray-700 px-4 py-3">
          <h1 className="text-lg font-bold">Alexandria Desktop</h1>
        </header>
        <main className="p-4">
          <h2 className="text-xl font-semibold mb-4">Select a World</h2>
          {loading && <p>Loading...</p>}
          {!loading && (
            <WorldPicker onWorldSelect={handleWorldSelect} client={state.client} />
          )}
        </main>
      </div>
    );
  }

  if (!state.role) {
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="bg-gray-800 border-b border-gray-700 px-4 py-3">
          <h1 className="text-lg font-bold">Select Your Role</h1>
        </header>
        <main className="p-4">
          <div className="space-y-4 max-w-md mx-auto">
            <button
              onClick={() => setState({ ...state, role: 'dm' })}
              className="block w-full p-6 bg-gray-800 rounded-lg hover:bg-gray-700 transition"
            >
              <h3 className="text-xl font-bold">DM Mode</h3>
              <p className="text-gray-400 mt-2">Battle maps, transcription logs, session notes</p>
            </button>
            <button
              onClick={() => setState({ ...state, role: 'player' })}
              className="block w-full p-6 bg-gray-800 rounded-lg hover:bg-gray-700 transition"
            >
              <h3 className="text-xl font-bold">Player Mode</h3>
              <p className="text-gray-400 mt-2">Character sheets, inventory, session notes</p>
            </button>
          </div>
        </main>
      </div>
    );
  }

  return <DMView state={state} onLogout={() => setState(null)} />;
}

function handleWorldSelect(worldId: string) {
  // This will be implemented when we have a proper client
}

function WorldPicker({ onWorldSelect, client }: any) {
  const [worlds, setWorlds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const response = await client.listWorlds();
        if (!response.error && response.data?.worlds) {
          setWorlds(response.data.worlds);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to list worlds");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [client]);

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

function DMView({ state, onLogout }: any) {
  const [activeTab, setActiveTab] = useState('tree');
  const [nodes, setNodes] = useState<import("@alexandria/schema").Node[]>([]);

  useEffect(() => {
    if (state?.client && state.currentWorldId) {
      loadNodes();
    }
  }, [state?.client, state?.currentWorldId]);

  async function loadNodes() {
    try {
      const response = await state.client.listNodes(state.currentWorldId!);
      if (!response.error && response.data?.nodes) {
        setNodes(response.data.nodes);
      }
    } catch (err) {
      console.error("Failed to load nodes:", err);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      <header className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex items-center gap-4">
        <h1 className="text-lg font-bold">DM Dashboard</h1>
        <button onClick={onLogout} className="text-xs text-gray-400 hover:text-white ml-auto">
          Logout
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/3 border-r border-gray-700 flex flex-col">
          <div className="border-b border-gray-700 p-2">
            <div className="flex gap-2">
              <TabButton active={activeTab === 'tree'} onClick={() => setActiveTab('tree')} label="Tree" />
              <TabButton active={activeTab === 'map'} onClick={() => setActiveTab('map')} label="Map" />
              <TabButton active={activeTab === 'transcription'} onClick={() => setActiveTab('transcription')} label="Transcription" />
              <TabButton active={activeTab === 'inventory'} onClick={() => setActiveTab('inventory')} label="Inventory" />
            </div>
          </div>

          {activeTab === 'tree' && (
            <div className="flex-1 overflow-y-auto p-2">
              <h3 className="text-sm font-semibold mb-2">World Tree</h3>
              {nodes.map(node => (
                <div key={node.id} className="px-2 py-1 cursor-pointer hover:bg-gray-700">
                  {node.title}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'map' && (
            <div className="flex-1 overflow-y-auto p-2">
              <h3 className="text-sm font-semibold mb-2">Battle Map</h3>
              <div className="text-center text-gray-500 py-8">Map visualization would go here</div>
            </div>
          )}

          {activeTab === 'transcription' && (
            <div className="flex-1 overflow-y-auto p-2">
              <h3 className="text-sm font-semibold mb-2">Transcription Log</h3>
              <div className="text-center text-gray-500 py-8">Session transcripts would go here</div>
            </div>
          )}

          {activeTab === 'inventory' && (
            <div className="flex-1 overflow-y-auto p-2">
              <h3 className="text-sm font-semibold mb-2">Group Inventory</h3>
              <div className="text-center text-gray-500 py-8">Inventory management would go here</div>
            </div>
          )}
        </div>

        <div className="w-2/3 p-4 overflow-y-auto">
          <div className="bg-gray-800 rounded p-4">
            <h2 className="text-xl font-bold mb-2">Content Area</h2>
            <p className="text-gray-400">Select a world from the sidebar to begin</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: any) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-sm rounded transition ${
        active ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
      }`}
    >
      {label}
    </button>
  );
}
