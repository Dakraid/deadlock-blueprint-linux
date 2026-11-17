import { describe, expect, it } from 'vitest';
import { ITEMS_DB, getHeroApiId, getItemIdByApiId } from '../data/deadlockData';
import { ApiHeroBuild, phasesFromApiBuild } from './importedBuild';

const mods = (ids: number[]) => ids.map((ability_id) => ({ ability_id }));
const costOf = (id: string) => ITEMS_DB[id]?.cost ?? 0;

// Build 955379 v30 (Rat King, deadlock-api.com), shortened: core build, then categories the author flagged optional
const RAT_KING: ApiHeroBuild = {
  hero_id: 84,
  hero_build_id: 955379,
  name: 'Rat King - Tank-Vampiric',
  version: 30,
  details: {
    mod_categories: [
      {
        name: 'Core Build',
        optional: null,
        // Monster Rounds, Rapid Rounds, Cultist Sacrifice, Titanic Magazine, Swift Striker, Mystic Expansion,
        // Enduring Speed, Fleetfoot, Ballistic Enchantment, Berserker, Siphon Bullets
        mods: mods([
          1009965641, 668299740, 709540378, 2356412290, 4104549924, 754480263, 2447176615, 3403085434, 3294954488,
          1414319208, 1282141666,
        ]),
      },
      // Extended Magazine, an unknown id
      { name: '#Citadel_HeroBuilds_Early', optional: true, mods: mods([1548066885, 12345]) },
      // Return Fire, Metal Skin, Extended Magazine again
      { name: 'Counter Picks', optional: true, mods: mods([3361075077, 1378931225, 1548066885]) },
    ],
  },
};

describe('phasesFromApiBuild', () => {
  it('keeps the author order, cut by souls spent, and the optional categories as situational', () => {
    expect(phasesFromApiBuild(RAT_KING, getItemIdByApiId, costOf)).toEqual({
      early: ['monster_rounds', 'rapid_rounds', 'cultist_sacrifice'],
      mid: ['titanic_magazine', 'swift_striker', 'mystic_reach', 'enduring_speed', 'fleetfoot'],
      late: ['ballistic_enchantment', 'berserker', 'siphon_bullets'],
      situational: ['extended_magazine', 'return_fire', 'metal_skin'],
    });
  });

  it('reads an optional category by its name when the flag is missing, never a standard one', () => {
    const build: ApiHeroBuild = {
      ...RAT_KING,
      details: {
        mod_categories: [
          { name: '#Citadel_HeroBuilds_Lane', mods: mods([1009965641]) },
          { name: 'Situational', mods: mods([3361075077]) },
        ],
      },
    };
    const phases = phasesFromApiBuild(build, getItemIdByApiId, costOf);
    expect(phases.early).toEqual(['monster_rounds']);
    expect(phases.situational).toEqual(['return_fire']);
  });

  it('knows the hero ids of the generated data', () => {
    expect(getHeroApiId('rat_king')).toBe(84);
  });
});
