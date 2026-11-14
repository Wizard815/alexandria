// A feature is a self-contained part of the librarian: its own tables,
// settings, routes, MCP tools and background jobs, in its own folder under
// src/features/<id>/index.ts. The registry finds every folder and wires it
// in, so adding a feature never means editing app.ts, db.ts, policy.ts or
// mcpServer.ts.
import type { Router } from 'express';
import type { Express } from 'express';
import type { Deps } from '../app.ts';
import type { DB } from '../core/db.ts';

/** One world setting a feature adds. Stored in the world's settings JSON. */
export type SettingSpec =
  | { type: 'boolean'; default: boolean }
  | { type: 'enum'; default: string; values: readonly string[] }
  | { type: 'int'; default: number | null; min?: number; max?: number; nullable?: boolean }
  | { type: 'string'; default: string; max?: number }
  /** Any JSON value; validate() must throw on a bad one. */
  | { type: 'json'; default: unknown; validate?: (v: unknown) => void };

/** An MCP tool: calls the librarian's own world API with the caller's key. */
export interface McpTool {
  name: string;
  description: string;
  /** Only listed for a DM's write key. */
  write?: boolean;
  /** Only listed for a player's key (never a DM's, read or write). */
  playerOnly?: boolean;
  props: Record<string, any>;
  required?: string[];
  /** The world API request to make; the path is relative to /api/worlds/:world. */
  call: (args: any) => { method: string; path: string; body?: unknown };
}

export interface Feature {
  /** Folder name; also used in logs. */
  id: string;
  /** SQL run on every start: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only. */
  schema?: string;
  /** Additive changes to tables (ALTER TABLE ... ADD COLUMN after a PRAGMA check). Must be safe to run again. */
  migrate?: (db: DB) => void;
  /** World settings this feature adds, with defaults. Keys must not clash with other features. */
  settings?: Record<string, SettingSpec>;
  /** Mounted at /api/worlds/:world/<worldMount>, after sign-in and world loading (ctx(res) works). */
  worldMount?: string;
  worldRoutes?: (d: Deps) => Router;
  /** Mounted at /api/admin/<adminMount>, admins only. */
  adminMount?: string;
  adminRoutes?: (d: Deps) => Router;
  /** Anything else on the app (e.g. public routes). Runs before the 404 handler. */
  appRoutes?: (app: Express, d: Deps) => void;
  /** MCP tools this feature adds. */
  mcpTools?: McpTool[];
  /** Background work (timers). Not started in tests (noScheduler). Return a stop function. */
  start?: (d: Deps) => (() => void) | void;
  /** Folders under ALX_DATA_DIR this feature keeps files in; included in backups. */
  dataDirs?: string[];
}
