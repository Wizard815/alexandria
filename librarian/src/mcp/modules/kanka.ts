import { MCPModule } from './base';
import { MCPStatus, FindEntitiesParams, EntityResult, Entity, MapFeature, TimelineEvent, PageContent, SearchResult } from '../types';

export interface KankaConfig {
  apiUrl?: string;
  apiKey: string;
  campaignId: string;
  [key: string]: any;
}

export class KankaModule extends MCPModule {
  readonly name = 'kanka';
  readonly version = '0.1.0';

  private apiUrl: string;
  private apiKey: string;
  private campaignId: string;

  constructor(config: KankaConfig) {
    super(config);
    this.apiUrl = config.apiUrl || 'https://api.kanka.io/1.0';
    this.apiKey = config.apiKey;
    this.campaignId = config.campaignId;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async findEntities(params: FindEntitiesParams): Promise<EntityResult> {
    const url = new URL(`${this.apiUrl}/campaigns/${this.campaignId}/entities`);
    
    if (params.entity_type) url.searchParams.append('type', params.entity_type);
    if (params.name) url.searchParams.append('name', params.name);
    if (params.limit) url.searchParams.append('limit', params.limit.toString());
    if (params.page) url.searchParams.append('page', params.page.toString());
    if (params.include_full !== undefined) url.searchParams.append('include_full', params.include_full.toString());
    if (params.last_synced) url.searchParams.append('last_synced', params.last_synced);

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    
    return {
      entities: data.data || [],
      sync_info: {
        request_timestamp: new Date().toISOString(),
        newest_updated_at: data.data?.[0]?.updated_at || '',
        total_count: data.meta?.total || 0,
        last_page: data.meta?.last_page || 1,
        returned_count: data.data?.length || 0
      }
    };
  }

  async getEntity(entityId: string): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/entities/${entityId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async createEntity(entity: Entity): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/entities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        entity_type: entity.entity_type,
        name: entity.name,
        entry: entity.entry,
        type: entity.type,
        tags: entity.tags,
        is_hidden: entity.is_hidden
      })
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async updateEntity(entity: Entity): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/entities/${entity.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: entity.name,
        entry: entity.entry,
        type: entity.type,
        tags: entity.tags,
        is_hidden: entity.is_hidden
      })
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async deleteEntity(entityId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/entities/${entityId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }
  }

  async getMapFeatures(mapId: string): Promise<MapFeature[]> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/maps/${mapId}/markers`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
  }

  async createMapFeature(feature: MapFeature): Promise<MapFeature> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/maps/${feature.map_id}/markers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: feature.name,
        description: feature.description,
        x: feature.coordinates?.x,
        y: feature.coordinates?.y,
        latitude: feature.coordinates?.latitude,
        longitude: feature.coordinates?.longitude,
        entity_id: feature.linked_page_id,
        type: feature.type
      })
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async getTimelineEvents(timelineId: string): Promise<TimelineEvent[]> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/timelines/${timelineId}/events`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
  }

  async createTimelineEvent(event: TimelineEvent): Promise<TimelineEvent> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/timelines/${event.timeline_id}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: event.name,
        description: event.description,
        date: event.date
      })
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async readPage(pageId: string): Promise<PageContent> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/pages/${pageId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async writePage(pageId: string, content: PageContent): Promise<PageContent> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: content.title,
        entry: content.content
      })
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async search(query: string, options?: any): Promise<SearchResult[]> {
    const url = new URL(`${this.apiUrl}/campaigns/${this.campaignId}/search`);
    url.searchParams.append('search', query);
    if (options?.limit) url.searchParams.append('limit', options.limit.toString());

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.data || []).map((result: any) => ({
      id: result.id,
      name: result.name,
      entity_type: result.entity_type,
      relevance: 100,
      preview: result.entry?.substring(0, 200) || ''
    }));
  }

  async getResource(resourceId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}/resources/${resourceId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Kanka API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  }

  async uploadImage(image: any): Promise<any> {
    // Kanka image upload implementation
    throw new Error('Not implemented: Kanka image upload');
  }
}
