/**
 * A published in-game build imported from deadlock-api.com by its id or by searching its name: the author's item
 * order and optional categories, for the "My build" buy mode (services/buyQueue.ts › computeBuildOrderQueue).
 * Saved per hero in localStorage (dl_importedBuilds, shared with the overlay), fetched only when the player asks.
 */
import type { HeroBuildArchetype } from '../data/deadlockData';

export const IMPORTED_BUILDS_KEY = 'dl_importedBuilds';
const API_BUILDS = 'https://api.deadlock-api.com/v1/builds';

/** The parts of a deadlock-api build this import reads. */
export interface ApiHeroBuild {
  hero_id: number;
  hero_build_id: number;
  name: string;
  version: number;
  last_updated_timestamp?: number;
  details?: { mod_categories?: { name?: string; optional?: boolean | null; mods?: { ability_id: number }[] }[] };
}

export interface ImportedBuild {
  heroId: string;
  buildId: number;
  version: number;
  name: string;
  phases: HeroBuildArchetype['phases'];
}

// A category is optional when the author flagged it (the shop shows OPTIONAL), or, outside the game's three standard
// categories, when its name says so (scripts/update-builds.mjs › phasesFromPublishedBuild)
const STANDARD_CATEGORIES = new Set(['#Citadel_HeroBuilds_Lane', '#Citadel_HeroBuilds_MidGame', '#Citadel_HeroBuilds_LateGame']);
const SITUATIONAL_CATEGORY_RE = /situ|option|flex|swap|counter|contre|if you need|anti/i;

/** Souls spent on the build where mid game and late game start: about 7 and 15 min (buyQueue.ts › SOULS_BY_MINUTE). */
export const MID_FROM_SOULS = 3200;
export const LATE_FROM_SOULS = 12000;

/**
 * The build's items as phases. Required items keep the author's order across categories: early, mid and late are
 * consecutive runs of that order, cut where the souls spent on the items before reach MID_FROM_SOULS and
 * LATE_FROM_SOULS (the phases only place the counters, buildPurchaseOrder). Cutting by tier put the Tier 3-4
 * counters after 2 items in a build that opens with 2 Tier 1 items and a Tier 3 (build 955379). Optional categories
 * go to `situational`, in order. An item listed twice counts once, at its first place; one the catalog does not know
 * is left out.
 */
export function phasesFromApiBuild(
  build: ApiHeroBuild,
  itemIdOf: (apiId: number) => string | undefined,
  costOf: (itemId: string) => number
): HeroBuildArchetype['phases'] {
  const required: string[] = [];
  const situational: string[] = [];
  const seen = new Set<string>();
  for (const category of build.details?.mod_categories ?? []) {
    const name = category.name ?? '';
    const optional = category.optional === true || (!STANDARD_CATEGORIES.has(name) && SITUATIONAL_CATEGORY_RE.test(name));
    for (const mod of category.mods ?? []) {
      const id = itemIdOf(mod.ability_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      (optional ? situational : required).push(id);
    }
  }
  let spent = 0;
  const spentBefore = required.map((id) => {
    const before = spent;
    spent += costOf(id);
    return before;
  });
  const cut = (souls: number) => {
    const index = spentBefore.findIndex((before) => before >= souls);
    return index < 0 ? required.length : index;
  };
  const mid = cut(MID_FROM_SOULS);
  const late = cut(LATE_FROM_SOULS);
  return { early: required.slice(0, mid), mid: required.slice(mid, late), late: required.slice(late), situational };
}

/** Builds from deadlock-api: one by id, or the most favourited of a hero whose name contains `search`. */
export async function fetchApiBuilds(query: { buildId: number } | { heroApiId: number; search: string }): Promise<ApiHeroBuild[]> {
  const params = new URLSearchParams({ only_latest: 'true', limit: '10' });
  if ('buildId' in query) params.set('build_id', String(query.buildId));
  else {
    params.set('hero_id', String(query.heroApiId));
    if (query.search) params.set('search_name', query.search);
    params.set('sort_by', 'favorites');
    params.set('sort_direction', 'desc');
  }
  const response = await fetch(`${API_BUILDS}?${params}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rows = (await response.json()) as { hero_build?: ApiHeroBuild }[];
  return (Array.isArray(rows) ? rows : [])
    .map((row) => row.hero_build)
    .filter((b): b is ApiHeroBuild => !!b && typeof b.hero_build_id === 'number' && typeof b.hero_id === 'number');
}

export function readImportedBuilds(): Record<string, ImportedBuild> {
  try {
    const value = JSON.parse(localStorage.getItem(IMPORTED_BUILDS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function saveImportedBuild(heroId: string, build: ImportedBuild | null): Record<string, ImportedBuild> {
  const all = readImportedBuilds();
  if (build) all[heroId] = build;
  else delete all[heroId];
  localStorage.setItem(IMPORTED_BUILDS_KEY, JSON.stringify(all));
  return all;
}

export const importedBuildId = (heroId: string) => `${heroId}_imported`;

/**
 * The imported build as one of the hero's builds. Abilities and lane tips come from the hero's first build.
 * shortcut: the build's own ability order is not read (the generated data has no ability ids), add them to
 * metaBuilds.json to use it.
 */
export function importedArchetype(imported: ImportedBuild, base: HeroBuildArchetype, subtitle: string): HeroBuildArchetype {
  return { ...base, id: importedBuildId(imported.heroId), name: imported.name, subtitle, phases: imported.phases };
}
