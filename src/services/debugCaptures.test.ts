import { describe, expect, it } from 'vitest';
import { type DebugCapture, MATCH_VALID_MS, matchesFor, newMatchId, scoreboardCoverage } from './debugCaptures';

const cap = (id: string, takenAt: number, rest: Partial<DebugCapture> = {}): DebugCapture => ({
  id,
  takenAt,
  width: 2560,
  height: 1440,
  source: '',
  heroId: null,
  flags: [],
  notes: '',
  ...rest,
});

describe('matchesFor', () => {
  it('offers only the matches started within 2 h of the capture, newest first, never its own', () => {
    const t = 10 * MATCH_VALID_MS;
    const old = cap('a', t - MATCH_VALID_MS - 1, { matchId: `m${t - MATCH_VALID_MS - 1}` });
    const recent = cap('b', t - 60_000, { matchId: `m${t - 60_000}` });
    const earlier = cap('c', t - 120_000, { matchId: `m${t - 120_000}` });
    const mine = cap('d', t, { matchId: newMatchId(cap('d', t)) });
    expect(matchesFor(mine, [old, earlier, recent, mine])).toEqual([recent.matchId, earlier.matchId]);
  });
});

describe('scoreboardCoverage', () => {
  it('counts scoreboard captures only', () => {
    const all = [
      cap('a', 1, { shows: 'scoreboard', matchId: 'm1', stage: 'early', flags: ['amber'] }),
      cap('b', 2, { shows: 'scoreboard', matchId: 'm1', stage: 'late', flags: ['amber', 'dead'] }),
      cap('c', 3, { shows: 'hud', matchId: 'm3', stage: 'mid', flags: ['sapphire', 'dead'] }),
    ];
    expect(scoreboardCoverage(all)).toEqual({ matches: 1, amber: true, sapphire: false, stages: ['early', 'late'], dead: 1 });
  });
});
