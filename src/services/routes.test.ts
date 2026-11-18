import { describe, expect, it } from 'vitest';
import { HEROES_DB, ITEMS_DB, generateTacticalPlan, getHeroItemStat, getHeroLateItems, getHeroTopItems } from '../data/deadlockData';
import { makeTranslate } from '../i18n';
import { ids } from '../test/queue';
import { inBuyOrder, investmentProgress, spikeOrder } from './investments';
import { getBuildItemIds } from './recommendations';
import { RoutesInput, computeRoutes, withDesiredItems } from './routes';

const t = makeTranslate('en');

function input(heroId: string, overrides: Partial<RoutesInput> = {}, fed: string[] = []): RoutesInput {
  const hero = HEROES_DB.find((h) => h.id === heroId)!;
  const build = hero.builds[0];
  const enemies = HEROES_DB.map((h) => h.id).filter((id) => id !== heroId).slice(0, 6);
  const plan = generateTacticalPlan(heroId, build.id, 'yellow', 'duo', enemies.slice(0, 2), enemies.slice(2), null, 'en', fed);
  const stat = (id: string) => getHeroItemStat(heroId, id);
  const owned = overrides.ownedItems ?? [];
  return {
    build,
    priorityItems: plan.priorityItems,
    matchupAlerts: plan.matchupAlerts,
    items: ITEMS_DB,
    t,
    ownedItems: owned,
    investedItems: owned,
    inventoryStatus: null,
    sellCandidates: [],
    investment: investmentProgress(spikeOrder(inBuyOrder(getBuildItemIds(build), (id) => stat(id)?.buyTimeS)), owned),
    stat,
    laneOver: false,
    lateItems: getHeroLateItems(heroId),
    topItems: getHeroTopItems(heroId),
    myThreatTags: hero.threatTags,
    ...overrides,
  };
}

describe('computeRoutes', () => {
  it('main route: only the build own items, every hero, with or without a fed enemy', () => {
    for (const hero of HEROES_DB) {
      const base = input(hero.id);
      const buildIds = new Set(getBuildItemIds(base.build));
      for (const fed of [[], [base.matchupAlerts[0].enemyId]]) {
        const routes = computeRoutes(input(hero.id, {}, fed));
        expect(routes.main.length).toBeGreaterThan(0);
        expect(ids(routes.main).filter((id) => !buildIds.has(id))).toEqual([]);
        // Normal alternatives never repeat the build, and no item is in both tiers
        expect(ids(routes.normal).filter((id) => buildIds.has(id))).toEqual([]);
        expect(ids(routes.normal).filter((id) => ids(routes.high).includes(id))).toEqual([]);
        expect(routes.normal.length).toBeLessThanOrEqual(3);
        expect(routes.high.length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('build bought: the main route goes on with the late items, which the alternatives do not repeat', () => {
    const base = input('infernus');
    const routes = computeRoutes(input('infernus', { ownedItems: getBuildItemIds(base.build), clockS: 35 * 60 }));
    expect(routes.main.length).toBeGreaterThan(0);
    expect(routes.main.every((entry) => entry.extra)).toBe(true);
    expect(ids(routes.normal).filter((id) => ids(routes.main).includes(id))).toEqual([]);
  });

  it('a fed enemy puts a counter in the high-priority tier', () => {
    const base = input('infernus');
    const fedId = base.matchupAlerts[0].enemyId;
    expect(computeRoutes(base).high).toEqual([]);
    expect(computeRoutes(input('infernus', {}, [fedId])).high.length).toBeGreaterThan(0);
  });

  it('an enemy who killed me twice gets its best counter in the high-priority tier, once is not enough', () => {
    const base = input('infernus');
    const alert = base.matchupAlerts[3];
    const once = computeRoutes({ ...base, threats: { [alert.enemyId]: { deaths: 1, items: [] } } });
    expect(once.high).toEqual([]);
    const twice = computeRoutes({ ...base, threats: { [alert.enemyId]: { deaths: 2, items: [] } } });
    expect(twice.high[0]).toMatchObject({ item: { id: alert.counters[0].item.id }, enemyId: alert.enemyId, priority: 'high' });
    expect(twice.high[0].reason).toContain('killed you 2 times');
  });

  it('an enemy item that counters my hero brings its answer, not once I own one', () => {
    // Infernus heals: Healbane on the killer answers him, Debuff Remover answers Healbane
    const base = input('infernus');
    const enemyId = base.matchupAlerts[0].enemyId;
    const threats = { [enemyId]: { deaths: 1, items: ['healbane'] } };
    const routes = computeRoutes({ ...base, threats });
    expect(ids(routes.high)).toEqual(['debuff_remover']);
    expect(computeRoutes({ ...input('infernus', { ownedItems: ['debuff_remover'] }), threats }).high).toEqual([]);
  });

  it('an enemy item read on the scoreboard brings its answer too', () => {
    const base = input('infernus');
    const enemyId = base.matchupAlerts[0].enemyId;
    expect(ids(computeRoutes({ ...base, enemyItems: { [enemyId]: ['healbane'] } }).high)).toEqual(['debuff_remover']);
  });

  it('an alternative names the main-route item it replaces: same shop tab, never a key core item; replaced items leave the route', () => {
    let named = 0;
    for (const hero of HEROES_DB) {
      const base = input(hero.id, { clockS: 20 * 60 });
      const routes = computeRoutes({ ...base, maxNormal: 5 });
      for (const alt of routes.normal) {
        if (!alt.replaces) continue;
        named++;
        expect(ids(routes.main)).toContain(alt.replaces);
        expect(ITEMS_DB[alt.replaces].category).toBe(alt.item.category);
        expect(ITEMS_DB[alt.replaces].tier).toBeLessThanOrEqual(alt.item.tier);
        expect(base.stat(alt.replaces)?.pickRate ?? 0).toBeLessThan(0.7);
        expect(ids(computeRoutes({ ...base, replacedItems: [alt.replaces] }).main)).not.toContain(alt.replaces);
      }
    }
    expect(named).toBeGreaterThan(20);
  });

  it('an optional or statistics item is not offered long before players buy it', () => {
    const early = computeRoutes(input('infernus', { clockS: 0, maxNormal: 5 }));
    for (const alt of early.normal) expect(getHeroItemStat('infernus', alt.item.id)?.buyTimeS ?? 0).toBeLessThanOrEqual(300);
  });

  it('owned and sold items are never offered, and the maximums are followed', () => {
    const base = input('infernus', { clockS: 20 * 60 });
    const first = computeRoutes(base).normal[0].item.id;
    expect(ids(computeRoutes({ ...base, soldItems: [first] }).normal)).not.toContain(first);
    expect(ids(computeRoutes(input('infernus', { clockS: 20 * 60, ownedItems: [first] })).normal)).not.toContain(first);
    expect(computeRoutes({ ...base, maxNormal: 5 }).normal).toHaveLength(5);
    expect(computeRoutes({ ...base, maxNormal: 0 }).normal).toEqual([]);
  });

  it('a desired item joins the main route in place of a weaker build item of its shop tab, in both buy modes', () => {
    const base = input('infernus', { clockS: 20 * 60 });
    const buildIds = new Set(getBuildItemIds(base.build));
    const desiredId = Object.values(ITEMS_DB).find(
      (item) => !buildIds.has(item.id) && item.tier === 3 && item.category === 'spirit'
    )!.id;
    const { replaces } = withDesiredItems(base.build, [desiredId], ITEMS_DB, base.stat);
    expect(replaces[desiredId]).toBeDefined();
    for (const mode of ['smart', 'build'] as const) {
      const routes = computeRoutes({ ...base, mode, desiredItems: [desiredId] });
      const entry = routes.main.find((e) => e.item.id === desiredId);
      expect(entry).toMatchObject({ desired: true, reason: t('route.desired'), replaces: replaces[desiredId] });
      if (replaces[desiredId]) {
        expect(ids(routes.main)).not.toContain(replaces[desiredId]);
        expect(ITEMS_DB[replaces[desiredId]].category).toBe('spirit');
        expect(ITEMS_DB[replaces[desiredId]].tier).toBeLessThanOrEqual(3);
      }
      // Never an alternative too, and never the item an alternative replaces
      expect(ids([...routes.high, ...routes.normal])).not.toContain(desiredId);
      expect([...routes.high, ...routes.normal].map((alt) => alt.replaces)).not.toContain(desiredId);
    }
  });

  it('a desired item the hero never buys stays in the route, and is never replaced by an alternative', () => {
    for (const hero of HEROES_DB.slice(0, 10)) {
      const base = input(hero.id, { clockS: 20 * 60, maxNormal: 5 });
      const buildIds = new Set(getBuildItemIds(base.build));
      const desiredId = Object.values(ITEMS_DB).find((item) => !buildIds.has(item.id) && !base.stat(item.id) && item.tier === 2);
      if (!desiredId) continue;
      const routes = computeRoutes({ ...base, desiredItems: [desiredId.id] });
      expect(ids(routes.main)).toContain(desiredId.id);
      expect(routes.normal.map((alt) => alt.replaces)).not.toContain(desiredId.id);
    }
  });

  it('a desired item never takes the place of an item already owned', () => {
    for (const hero of HEROES_DB) {
      const base = input(hero.id);
      const owned = [...base.build.phases.early, ...base.build.phases.mid];
      const buildIds = new Set(getBuildItemIds(base.build));
      for (const desired of Object.values(ITEMS_DB).filter((item) => !buildIds.has(item.id) && item.tier <= 2).slice(0, 6)) {
        const { replaces } = withDesiredItems(base.build, [desired.id], ITEMS_DB, base.stat, owned);
        if (replaces[desired.id]) expect(owned).not.toContain(replaces[desired.id]);
      }
    }
  });

  it('a desired item already required by the build keeps its place; an owned one is not offered', () => {
    const base = input('infernus');
    const buildItem = base.build.phases.mid[0];
    const { build, replaces } = withDesiredItems(base.build, [buildItem], ITEMS_DB, base.stat);
    expect(build.phases).toEqual(base.build.phases);
    expect(replaces).toEqual({});
    const owned = computeRoutes(input('infernus', { ownedItems: [buildItem], desiredItems: [buildItem] }));
    expect(ids(owned.main)).not.toContain(buildItem);
  });
});
