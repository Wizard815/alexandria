// The shop generator is its own feature (features/shop, `generateShop(d, worldId, opts, guide?)`). A shop generation
// template passes its guide to it. When that feature is not installed the adapter says so and nothing else happens.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Deps } from '../../app.ts';
import { guideText } from './spec.ts';
import type { Template } from './store.ts';

type GenerateShop = (d: Deps, worldId: string, opts: Record<string, unknown>, guide?: string) => Promise<unknown>;
const CANDIDATES = ['../shop/index.ts', '../shop/generate.ts', '../shop/gen.ts', '../shop/generator.ts'];

/** The shop feature's generateShop, or null when it is not there. */
export async function shopGenerator(): Promise<GenerateShop | null> {
  for (const rel of CANDIDATES) {
    const url = new URL(rel, import.meta.url);
    if (!fs.existsSync(fileURLToPath(url))) continue;
    try {
      const m: any = await import(url.href);
      if (typeof m.generateShop === 'function') return m.generateShop as GenerateShop;
    } catch { /* a broken module counts as missing */ }
  }
  return null;
}

/** Generate a shop with the template's guide, or null when the shop generator is not installed. */
export async function generateShopWithTemplate(d: Deps, worldId: string, t: Template, opts: Record<string, unknown> = {}): Promise<{ result: unknown } | null> {
  const gen = await shopGenerator();
  if (!gen) return null;
  const sp: any = t.spec;
  return { result: await gen(d, worldId, { ...(sp.shopType ? { type: sp.shopType } : {}), ...opts }, guideText(t)) };
}
