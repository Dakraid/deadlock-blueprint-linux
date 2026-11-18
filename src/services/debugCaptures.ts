/**
 * Debug captures (Alt+P, Diagnostics › Debug captures): the frame of the capture stream as it is, saved as a PNG
 * next to a JSON file the player fills in afterwards (what it shows, which match, stage, flags, notes). Real
 * frames of screens the scanner does not read yet (Tab scoreboard) are needed before their reading can be written.
 */
import { grabGameFrame, releaseGameFrame } from './screenCapture';

export const SHOWS = ['scoreboard', 'hud', 'shop', 'death', 'end', 'other'] as const;
export const STAGES = ['early', 'mid', 'late'] as const;
export const FLAGS = ['amber', 'sapphire', 'dead', 'emptyRows', 'fullRows', 'spectating', 'bug'] as const;
export type Shows = (typeof SHOWS)[number];
export type Stage = (typeof STAGES)[number];
export type Flag = (typeof FLAGS)[number];

export interface DebugCapture {
  /** File name without extension, given by the main process. */
  id: string;
  takenAt: number;
  width: number;
  height: number;
  source: string;
  heroId: string | null;
  appVersion?: string;
  // Filled in by the player
  shows?: Shows;
  /** Captures of one match share it: `m<takenAt of its first capture>`. */
  matchId?: string;
  stage?: Stage;
  flags: Flag[];
  notes: string;
}

// A match can take a capture only this long before or after it started: a later game is another match
export const MATCH_VALID_MS = 2 * 3600 * 1000;

export const matchStart = (matchId: string): number => Number(matchId.slice(1));
export const newMatchId = (capture: DebugCapture): string => `m${capture.takenAt}`;

/** Matches `capture` may join, newest first. */
export function matchesFor(capture: DebugCapture, all: DebugCapture[]): string[] {
  const ids = new Set(all.filter((c) => c.id !== capture.id && c.matchId).map((c) => c.matchId!));
  return [...ids]
    .filter((id) => Math.abs(capture.takenAt - matchStart(id)) <= MATCH_VALID_MS)
    .sort((a, b) => matchStart(b) - matchStart(a));
}

/** What the Tab scoreboard captures cover so far, against what its reader needs (3 matches, both team colours…). */
export function scoreboardCoverage(all: DebugCapture[]) {
  const boards = all.filter((c) => c.shows === 'scoreboard');
  const has = (flag: Flag) => boards.some((c) => c.flags.includes(flag));
  return {
    matches: new Set(boards.map((c) => c.matchId).filter(Boolean)).size,
    amber: has('amber'),
    sapphire: has('sapphire'),
    stages: STAGES.filter((stage) => boards.some((c) => c.stage === stage)),
    dead: boards.filter((c) => c.flags.includes('dead')).length,
  };
}

/** Saves the current frame at its captured size (lossless, never rescaled); null when there is no frame. */
export async function takeDebugCapture(heroId: string | null): Promise<string | null> {
  const api = window.electronAPI;
  if (!api) return null;
  const frame = await grabGameFrame();
  if (!frame) return null;
  try {
    const { width, height } = frame.image;
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(frame.image, 0, 0);
    const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    return await api.debugCaptures.save(png, {
      takenAt: Date.now(),
      width,
      height,
      source: frame.sourceName,
      heroId,
      flags: [],
      notes: '',
    });
  } finally {
    releaseGameFrame(frame);
  }
}
