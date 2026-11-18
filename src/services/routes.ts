/**
 * The buy panel as routes (pure, tested in routes.test.ts):
 * - the main route: the active build's own items, nothing else, in the order of the buy queue (services/buyQueue.ts:
 *   usual buy times, key core items, the 4,800 spike nudge; the author's order in "My build" mode); once the build is
 *   bought, the queue's late items;
 * - alternatives, in two tiers. High priority: a counter against an enemy marked fed, against an enemy who killed me
 *   NEMESIS_DEATHS times or more, and an answer to an item that enemy owns against my hero (read on the death cam).
 *   Normal: the counters the buy queue would place now (lane and team ones, by its due-time rules), the build's
 *   optional items and what the hero's players buy outside the build. An alternative names the main-route item it
 *   would replace (replacedItem); once bought, that item leaves the main route (replacedItems).
 */
import type { DeadlockItem, HeroBuildArchetype, TacticalRecommendation, ThreatTag } from '../data/deadlockData';
import { BuyQueueInput, computeBuyQueue, estimateClockS } from './buyQueue';
import { KEY_CORE_PICK_RATE, totalInvested } from './investments';
import {
  QueueEntry,
  counterRole,
  dropAnsweredCounters,
  effectiveOwnedSet,
  getBuildItemIds,
  getComponentIds,
  getNextPurchases,
} from './recommendations';

/** An enemy who killed me this many times gets its counters in the high-priority tier. */
export const NEMESIS_DEATHS = 2;
export const DEFAULT_MAX_NORMAL = 3;
export const DEFAULT_MAX_HIGH = 2;
/** An optional item or one from the statistics is offered at most this long before players usually buy it (seconds). */
const STAT_ITEM_EARLY_S = 300;

/** What the death cam told about an enemy (MatchTracker): how often it killed me, and the items it owned then. */
export interface EnemyThreat {
  deaths: number;
  items: string[];
}
export type Threats = Record<string, EnemyThreat>;

export interface RouteAlt extends QueueEntry {
  priority: 'high' | 'normal';
  /** The enemy the item answers, when there is one */
  enemyId?: string;
  /** The main-route item this one would take the place of (replacedItem), when there is one */
  replaces?: string;
}

export interface Routes {
  main: QueueEntry[];
  high: RouteAlt[];
  normal: RouteAlt[];
  /** The counters the cards highlight (computeBuyQueue) */
  counters: TacticalRecommendation['priorityItems'];
}

export interface RoutesInput extends BuyQueueInput {
  /** My hero's threat tags: an enemy item that counters one of them is an answer to my hero */
  myThreatTags: ThreatTag[];
  threats?: Threats;
  /** Items the hero's players buy, best first (getHeroTopItems) */
  topItems?: string[];
  maxNormal?: number;
  maxHigh?: number;
  /** Main-route items the player replaced by an alternative this match: they leave the main route */
  replacedItems?: string[];
}

/**
 * What to buy when the enemy owns an item that counters this side of my hero.
 * shortcut: a hand-written answer per threat tag, tags without a clear item answer are left out; real statistics
 * (my win rate with item X against an enemy owning item Y) would replace it, the API has no such endpoint yet.
 */
export const ANSWERS: Partial<Record<ThreatTag, string[]>> = {
  healer: ['debuff_remover', 'debuff_reducer'], // they bought anti-heal
  bullet_hose: ['armor_piercer', 'bullet_resist_shredder'], // they bought bullet armour
  spirit_burst: ['mystic_vulnerability', 'escalating_exposure'], // they bought spirit armour
  flier_mobility: ['debuff_remover', 'unstoppable'], // they bought a knockdown or a hex
};

export function computeRoutes(input: RoutesInput): Routes {
  const { build, items, t, ownedItems, stat, threats = {}, matchupAlerts } = input;
  const buildIds = new Set(getBuildItemIds(build));
  const owned = effectiveOwnedSet(ownedItems);
  const sold = effectiveOwnedSet(input.soldItems ?? []);
  const nowS = input.clockS ?? estimateClockS(totalInvested(ownedItems));

  // Main route: the buy queue without any counter or late item, so nothing outside the build moves its order
  const replaced = new Set(input.replacedItems ?? []);
  const ownQueue = computeBuyQueue({ ...input, priorityItems: [] }).queue.filter((entry) => !replaced.has(entry.item.id));
  const buildOnly = ownQueue.filter((entry) => !entry.extra);
  // Build bought: the route goes on with the queue's late items (lateGameEntries), or the #1, "Now" and the game log
  // would have nothing to buy for the rest of a long game
  const main = buildOnly.length > 0 ? buildOnly : ownQueue;
  // The same queue with the counters: which ones are due now (lane threat, laning over, first spike done)
  const smart = computeBuyQueue({ ...input, mode: 'smart' });

  const seen = new Set<string>(buildOnly.length > 0 ? [] : main.map((entry) => entry.item.id));
  const alts: RouteAlt[] = [];
  const add = (id: string, reason: string, priority: RouteAlt['priority'], enemyId?: string, phase?: QueueEntry['phase']) => {
    const item: DeadlockItem | undefined = items[id];
    if (!item || seen.has(id) || owned.has(id) || sold.has(id)) return;
    // A normal alternative never repeats the main route; a high-priority one may move a build item up
    if (priority === 'normal' && buildIds.has(id)) return;
    seen.add(id);
    alts.push({ item, reason, priority, phase, extra: true, ...(enemyId ? { enemyId } : {}) });
  };

  // ---- High priority ----
  const nemeses = matchupAlerts
    .filter((alert) => (threats[alert.enemyId]?.deaths ?? 0) >= NEMESIS_DEATHS)
    .sort((a, b) => threats[b.enemyId].deaths - threats[a.enemyId].deaths);
  for (const alert of nemeses) {
    const counter = alert.counters.find((c) => !owned.has(c.item.id) && !sold.has(c.item.id));
    if (counter) {
      add(counter.item.id, t('route.killedBy', alert.enemyName, threats[alert.enemyId].deaths, counter.reason), 'high', alert.enemyId);
    }
  }
  const answered = new Set([...owned, ...buildIds]);
  const priorityItems = dropAnsweredCounters(input.priorityItems, matchupAlerts, answered);
  for (const r of priorityItems) {
    if (counterRole(r) === 'fed') add(r.item.id, r.reasons[0] ?? '', 'high');
  }
  // An enemy item that counters my hero, seen on the death cam: its answer, unless I already own one
  for (const alert of matchupAlerts) {
    for (const enemyItemId of threats[alert.enemyId]?.items ?? []) {
      const tag = items[enemyItemId]?.countersTags?.find((c) => input.myThreatTags.includes(c));
      const answers = tag ? ANSWERS[tag] : undefined;
      if (!answers || answers.some((id) => owned.has(id))) continue;
      add(answers[0], t('route.enemyOwns', alert.enemyName, items[enemyItemId].name.split('(')[0].trim()), 'high', alert.enemyId);
    }
  }

  // ---- Normal ----
  for (const entry of smart.queue) {
    if (entry.role && entry.role !== 'fed') add(entry.item.id, entry.reason, 'normal');
  }
  const pickRate = (id: string) => stat(id)?.pickRate ?? -1;
  // Not long before players usually buy it: a Tier 4 item is no alternative at 5 min
  const isTimely = (id: string) => {
    const buyTimeS = stat(id)?.buyTimeS;
    return !buyTimeS || buyTimeS <= nowS + STAT_ITEM_EARLY_S;
  };
  const optional = build.phases.situational.filter(isTimely).sort((a, b) => pickRate(b) - pickRate(a));
  const fromStats = [...new Set([...(input.topItems ?? []), ...(input.lateItems ?? [])])].filter(isTimely);
  // One from the statistics, one optional item of the build, and so on: neither source fills the tier alone
  for (let i = 0; i < Math.max(optional.length, fromStats.length); i++) {
    const statId = fromStats[i];
    const itemStat = statId ? stat(statId) : undefined;
    if (statId) {
      add(
        statId,
        itemStat?.winRate !== undefined
          ? t('route.stat', Math.round(itemStat.pickRate * 100), (itemStat.winRate * 100).toFixed(1))
          : t('reason.lateExtra'),
        'normal'
      );
    }
    if (optional[i]) add(optional[i], t('reason.optional'), 'normal', undefined, 'situational');
  }

  // Inventory full: like the queue's late items, an alternative must be worth more than the weakest item to sell
  const fits = new Set(
    getNextPurchases(alts, ownedItems, input.inventoryStatus, input.sellCandidates).map((entry) => entry.item.id)
  );
  const tier = (priority: RouteAlt['priority'], max: number) =>
    alts
      .filter((alt) => alt.priority === priority && fits.has(alt.item.id))
      .slice(0, Math.max(0, max))
      .map((alt) => {
        // Never an item another alternative moves up
        const replaces = buildIds.has(alt.item.id)
          ? undefined
          : replacedItem(alt.item, main.filter((entry) => !seen.has(entry.item.id)), stat);
        return replaces ? { ...alt, replaces } : alt;
      });
  return {
    main,
    high: tier('high', input.maxHigh ?? DEFAULT_MAX_HIGH),
    normal: tier('normal', input.maxNormal ?? DEFAULT_MAX_NORMAL),
    counters: smart.counters,
  };
}

/**
 * The main-route item an alternative would take the place of: still to buy, in the same shop tab, of the same tier or
 * lower, the one the hero's players buy least. Never a key core item (KEY_CORE_PICK_RATE), nor a component of the
 * alternative. None: the alternative is an addition to the route.
 */
export function replacedItem(alt: DeadlockItem, main: QueueEntry[], stat: BuyQueueInput['stat']): string | undefined {
  const pickRate = (id: string) => stat(id)?.pickRate ?? 0;
  const components = getComponentIds(alt.id);
  return main
    .map((entry) => entry.item)
    .filter(
      (item) =>
        item.category === alt.category &&
        item.tier <= alt.tier &&
        !components.has(item.id) &&
        pickRate(item.id) < KEY_CORE_PICK_RATE
    )
    .sort((a, b) => pickRate(a.id) - pickRate(b.id) || b.tier - a.tier)[0]?.id;
}

/** The share of the build bought so far, for the route's header. */
export function routeProgress(build: HeroBuildArchetype, ownedItems: string[]): { bought: number; total: number } {
  const owned = effectiveOwnedSet(ownedItems);
  const ids = getBuildItemIds(build);
  return { bought: ids.filter((id) => owned.has(id)).length, total: ids.length };
}
