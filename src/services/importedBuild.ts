/**
 * A published in-game build imported from deadlock-api.com by its id or by searching its name, or a build code
 * copied in the game and pasted: the author's item order and optional categories, for the "My build" buy mode (services/buyQueue.ts › computeBuildOrderQueue).
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
  /** Pasted build code: its build id is the copy's local id, so it is never fetched again ("Update"). */
  pasted?: boolean;
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

/** Every zstd frame starts with 28 B5 2F FD, "KLUv/" in base64: a pasted build code, not an id or a name. */
export const isBuildCode = (text: string) => /^KLUv\/[A-Za-z0-9+/]+=*$/.test(text.replace(/\s+/g, ''));

type ProtoValue = number | Uint8Array;

/** The fields of a protobuf message. Varints by multiplication: item ids go past 2^31, `|` and `<<` made them negative. */
function* protoFields(bytes: Uint8Array): Generator<[number, ProtoValue]> {
  let pos = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (pos >= bytes.length || shift > 63) throw new Error('bad varint');
      const byte = bytes[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  };
  while (pos < bytes.length) {
    const key = varint();
    const wire = key % 8;
    if (wire === 0) yield [Math.floor(key / 8), varint()];
    else if (wire === 2) {
      const length = varint();
      if (pos + length > bytes.length) throw new Error('truncated');
      yield [Math.floor(key / 8), bytes.subarray(pos, (pos += length))];
    } else if (wire === 1 || wire === 5) pos += wire === 1 ? 8 : 4; // fixed64, fixed32 (category width / height)
    else throw new Error(`wire type ${wire}`);
  }
  if (pos > bytes.length) throw new Error('truncated');
}

const isBytes = (value: ProtoValue): value is Uint8Array => typeof value !== 'number';

/**
 * A build code copied in the game, once main.cjs › decode-build-code has undone base64 and zstd: Valve's
 * CMsgHeroBuild protobuf, read into the fields deadlock-api returns as JSON (same field numbers: 1 hero_build_id,
 * 2 hero_id, 5 name, 8 version, 10 details › 1 mod_categories › 1 mods › 1 ability_id, 2 name, 6 optional).
 */
export function parseHeroBuild(bytes: Uint8Array): ApiHeroBuild {
  const text = (value: Uint8Array) => new TextDecoder().decode(value);
  const categories: NonNullable<NonNullable<ApiHeroBuild['details']>['mod_categories']> = [];
  const build: ApiHeroBuild = { hero_id: 0, hero_build_id: 0, name: '', version: 0, details: { mod_categories: categories } };
  for (const [no, value] of protoFields(bytes)) {
    if (no === 1 && !isBytes(value)) build.hero_build_id = value;
    else if (no === 2 && !isBytes(value)) build.hero_id = value;
    else if (no === 5 && isBytes(value)) build.name = text(value);
    else if (no === 8 && !isBytes(value)) build.version = value;
    else if (no === 10 && isBytes(value)) {
      for (const [n, rawCategory] of protoFields(value)) {
        if (n !== 1 || !isBytes(rawCategory)) continue;
        const category: (typeof categories)[number] = { mods: [] };
        for (const [field, v] of protoFields(rawCategory)) {
          if (field === 2 && isBytes(v)) category.name = text(v);
          else if (field === 6 && !isBytes(v)) category.optional = v !== 0;
          else if (field === 1 && isBytes(v)) {
            for (const [m, id] of protoFields(v)) if (m === 1 && !isBytes(id)) category.mods!.push({ ability_id: id });
          }
        }
        categories.push(category);
      }
    }
  }
  if (!build.hero_id) throw new Error('no hero');
  return build;
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
