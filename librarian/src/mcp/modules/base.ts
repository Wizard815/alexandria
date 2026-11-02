import { MCPStatus, MCPModuleConfig } from './types';

export abstract class MCPModule {
  abstract readonly name: string;
  abstract readonly version: string;

  protected config: MCPModuleConfig;

  constructor(config: MCPModuleConfig) {
    this.config = config;
  }

  /**
   * Check if the MCP server is healthy
   */
  abstract health(): Promise<boolean>;

  /**
   * Get module status
   */
  async status(): Promise<MCPStatus> {
    const isHealthy = await this.health();
    return {
      name: this.name,
      version: this.version,
      status: isHealthy ? 'healthy' : 'unhealthy',
      lastCheck: new Date().toISOString()
    };
  }

  /**
   * Find entities with optional filtering
   */
  abstract findEntities(params: any): Promise<any>;

  /**
   * Get a single entity by ID
   */
  abstract getEntity(entityId: string): Promise<any>;

  /**
   * Create a new entity
   */
  abstract createEntity(entity: any): Promise<any>;

  /**
   * Update an existing entity
   */
  abstract updateEntity(entity: any): Promise<any>;

  /**
   * Delete an entity
   */
  abstract deleteEntity(entityId: string): Promise<void>;

  /**
   * Get map features for a specific map
   */
  abstract getMapFeatures(mapId: string): Promise<any[]>;

  /**
   * Create a map feature
   */
  abstract createMapFeature(feature: any): Promise<any>;

  /**
   * Get timeline events
   */
  abstract getTimelineEvents(timelineId: string): Promise<any[]>;

  /**
   * Create a timeline event
   */
  abstract createTimelineEvent(event: any): Promise<any>;

  /**
   * Read a page/document
   */
  abstract readPage(pageId: string): Promise<any>;

  /**
   * Write/update a page/document
   */
  abstract writePage(pageId: string, content: any): Promise<any>;

  /**
   * Search across entities
   */
  abstract search(query: string, options?: any): Promise<any[]>;

  /**
   * List available projects/worlds (for multi-world MCPs)
   */
  async listProjects(): Promise<string[]> {
    return ['default'];
  }

  /**
   * Get resource details
   */
  abstract getResource(resourceId: string): Promise<any>;

  /**
   * Upload an image
   */
  abstract uploadImage(image: any): Promise<any>;
}
