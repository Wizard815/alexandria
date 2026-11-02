// Client library for Alexandria D&D World API
import axios, { AxiosInstance } from 'axios';

import type {
  ApiResponse,
  World,
  AuthToken,
  Node,
  Map,
  MapMarker,
  MapGroup,
  Session,
  Inventory,
  InventoryItem,
  Item,
  TravelLog,
  Transcript,
  DmNote,
} from '@alexandria/schema';

export class DndClient {
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private token?: string;

  constructor(config: { baseUrl: string; token?: string }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (this.token) {
      this.client.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;
    }
  }

  // Auth methods
  async login(username: string, password: string): Promise<ApiResponse<{ token: AuthToken }>> {
    const response = await this.client.post('/api/auth/login', { username, password });
    return response.data;
  }

  async register(username: string, password: string): Promise<ApiResponse<{ token: AuthToken }>> {
    const response = await this.client.post('/api/auth/register', { username, password });
    return response.data;
  }

  // World methods
  async listWorlds(): Promise<ApiResponse<{ worlds: World[] }>> {
    const response = await this.client.get('/api/worlds');
    return response.data;
  }

  async getWorld(worldId: string): Promise<ApiResponse<{ world: World }>> {
    const response = await this.client.get(`/api/worlds/${worldId}`);
    return response.data;
  }

  // Node methods
  async listNodes(worldId: string, parentId?: string): Promise<ApiResponse<{ nodes: Node[] }>> {
    const params = parentId ? { parentId } : {};
    const response = await this.client.get(`/api/worlds/${worldId}/nodes`, { params });
    return response.data;
  }

  async getNode(nodeId: string): Promise<ApiResponse<{ node: Node }>> {
    const response = await this.client.get(`/api/nodes/${nodeId}`);
    return response.data;
  }

  async createNode(worldId: string, data: Partial<Node>): Promise<ApiResponse<{ node: Node }>> {
    const response = await this.client.post(`/api/worlds/${worldId}/nodes`, data);
    return response.data;
  }

  async updateNode(nodeId: string, data: Partial<Node>): Promise<ApiResponse<{ node: Node }>> {
    const response = await this.client.patch(`/api/nodes/${nodeId}`, data);
    return response.data;
  }

  // Map methods
  async getMap(nodeId: string): Promise<ApiResponse<{ map: Map }>> {
    const response = await this.client.get(`/api/nodes/${nodeId}/map`);
    return response.data;
  }

  async createMap(nodeId: string, data: Partial<Map>): Promise<ApiResponse<{ map: Map }>> {
    const response = await this.client.post(`/api/nodes/${nodeId}/map`, data);
    return response.data;
  }

  async listMapMarkers(nodeId: string): Promise<ApiResponse<{ markers: MapMarker[] }>> {
    const response = await this.client.get(`/api/nodes/${nodeId}/map/markers`);
    return response.data;
  }

  async createMapMarker(nodeId: string, data: Partial<MapMarker>): Promise<ApiResponse<{ marker: MapMarker }>> {
    const response = await this.client.post(`/api/nodes/${nodeId}/map/markers`, data);
    return response.data;
  }

  async listMapGroups(nodeId: string): Promise<ApiResponse<{ groups: MapGroup[] }>> {
    const response = await this.client.get(`/api/nodes/${nodeId}/map/groups`);
    return response.data;
  }

  // Session methods
  async listSessions(worldId: string): Promise<ApiResponse<{ sessions: Session[] }>> {
    const response = await this.client.get(`/api/worlds/${worldId}/sessions`);
    return response.data;
  }

  async createSession(worldId: string, data: Partial<Session>): Promise<ApiResponse<{ session: Session }>> {
    const response = await this.client.post(`/api/worlds/${worldId}/sessions`, data);
    return response.data;
  }

  // Inventory methods
  async listInventories(worldId: string): Promise<ApiResponse<{ inventories: Inventory[] }>> {
    const response = await this.client.get(`/api/worlds/${worldId}/inventories`);
    return response.data;
  }

  async listInventoryItems(inventoryId: string): Promise<ApiResponse<{ items: InventoryItem[] }>> {
    const response = await this.client.get(`/api/inventories/${inventoryId}/items`);
    return response.data;
  }

  // Travel log methods
  async listTravelLogs(worldId: string): Promise<ApiResponse<{ travelLogs: TravelLog[] }>> {
    const response = await this.client.get(`/api/worlds/${worldId}/travel-logs`);
    return response.data;
  }

  // Search
  async search(worldId: string, query: string): Promise<ApiResponse<{ results: (Node | Session)[] }>> {
    const response = await this.client.get(`/api/worlds/${worldId}/search?q=${encodeURIComponent(query)}`);
    return response.data;
  }
}
