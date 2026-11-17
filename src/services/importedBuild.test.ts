import { describe, expect, it } from 'vitest';
import { ITEMS_DB, getHeroApiId, getItemIdByApiId } from '../data/deadlockData';
import * as zlib from 'node:zlib';
import { ApiHeroBuild, isBuildCode, parseHeroBuild, phasesFromApiBuild } from './importedBuild';

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

// A build code copied in the game (Rat King, a local copy of "[Infinite Sustain BOMB Rat]"), as a player pastes it
const PASTED_CODE = `KLUv/WAwBG0bAGatqzKQ9hziNPhBYSsA91SgrMmay6JbK0z3Tp2Wkstl6xUjd+b255hVIV3CiKVeEGeSRUSbBJsAnACfAFyNgO8GXLBm1dMToNj0NieltJpyewXgAqe9L7SL6NW+cvtz2s9WW5vDO9exa37L3ErbVol4+pgYGfRWYZhXa4/TXziWvvL79jOv/rl7bKf7lXutTfMKjw2MGCARr8zu7YCnTDCBZIv0JBoSBYluzPzewkVWWER4Lfd/b124/3It39QoMvzG5t0ce4QCQyBwkuuSe0QB7TW8KEzfA0ydoVQvRvXLfEe+4dVq9dee9lzbZktz23N7lnd99lvEVCM4wqxXA4Y/txoLhorUDBOc4iS1qFWJiG1Y8IhRTTRj5K8mWhF18HQ36c7aXkJzX2d5K2Jr/QnN7K/9yyMUEfGAIBQYFAff6TTPflnno3C/nTsM93W/axSI+EDuj8rwtYABqj6hHKN1z35sLeP0z2uf1eHdrfUiDvgKNa+7p/n9/TxvrQ/xAQ/iE9ZbAVMBnwqjAOYss4gKBv3ojLD8WnvetfIva+Wcm9/yv21aIn6DAvV+3gvYIC7wEOgI8zGLoO7SLYgKlmqMTLxx/7sKQTyAxYe0Rl0EI1QcwOvyUaqa/DwgPGNsvIjyaHywVan09SrAKVs8/CqvvDE1bevRiaApU+pta3f5zeVar2PPN/+2nb3rLZbPc+dxAoFhVl5ZKagnqCeoVEAIi09sahelNiUNbZgqvAvwtC+20rYItep/p+U/b7nPfq/tMbz6vZXfOFpbp6v13JKPGKBMK2jzDYENlJKmAKOxwdVSEOer0Hm/4d35Z7HyfDPEUrO7vEKpk2fIrfX/tm0RkoR4+pa5iIXA9oMIFWBF9gSZYCSEF4U5dsWEhmmkydL98ixbO1fmarcuB7H9s98OUyhwRGimdgNhMVRkJhCZNFpoLAbIDVc+tB2q+AOiGQsX8EMaMlgUvbaqoOSR8oVh4eoc/SwwK3bCyDM7qtMC9+rdwCDLKfxctzomk6TVXGoCpTCpbBMut2GDbXW0UYCRiEZ8erw3y9dJ0R4pELzfqjc0XG9keu931aJgIQPBzvOo79XUMZ1GPdTHkH2h3FRjbr43ZguHwGLafm9+Joa+ydsnrf6e7A6+/90xD5IYsVHHaLP1kGMrCTUJJgo=`;

describe('parseHeroBuild', () => {
  // electron/main.cjs › decode-build-code (Node ≥ 22.15; the installed @types/node predates zstd)
  const { zstdDecompressSync } = zlib as unknown as { zstdDecompressSync: (data: Buffer) => Buffer };
  const decode = (code: string) => new Uint8Array(zstdDecompressSync(Buffer.from(code.replace(/\s+/g, ''), 'base64')));

  it('reads a build code copied in the game', () => {
    expect(isBuildCode(PASTED_CODE)).toBe(true);
    expect(isBuildCode(`${PASTED_CODE.slice(0, 40)}\n${PASTED_CODE.slice(40)}`)).toBe(true);
    expect(isBuildCode('955379')).toBe(false);
    expect(isBuildCode('Rat King')).toBe(false);
    const build = parseHeroBuild(decode(PASTED_CODE));
    expect(build.hero_id).toBe(getHeroApiId('rat_king'));
    expect(build.name).toBe('Copy of [Infinite Sustain BOMB Rat]');
    const categories = build.details?.mod_categories ?? [];
    expect(categories.map((c) => [c.name, c.optional ?? false])).toEqual([
      ['#Citadel_HeroBuilds_EarlyGame', false],
      ['Mid Game', false],
      ['Late Game', true],
      ['Survivability', true],
      ['Damage Boosters', true],
      ['Bomb', true],
    ]);
    // ids past 2^31 (3077079169) stay positive: read with bitwise ops they were lost
    expect(categories[0].mods?.map((m) => m.ability_id)).toContain(3077079169);
    const phases = phasesFromApiBuild(build, getItemIdByApiId, costOf);
    const required = [...phases.early, ...phases.mid, ...phases.late];
    expect(required).toHaveLength(categories[0].mods!.length + categories[1].mods!.length);
    expect(required.every((id) => ITEMS_DB[id])).toBe(true);
    expect(phases.situational.length).toBeGreaterThan(0);
  });

  it('refuses what is not a build', () => {
    expect(() => parseHeroBuild(new Uint8Array([0x0a, 0x05, 1]))).toThrow();
    expect(() => parseHeroBuild(new TextEncoder().encode('hello'))).toThrow();
  });
});
