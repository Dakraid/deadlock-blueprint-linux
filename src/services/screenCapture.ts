/**
 * Capture d'écran du jeu pour le scan temps réel (toutes les 350 ms), sous Linux Wayland.
 *
 * Wayland ne laisse pas une application lister les fenêtres ni les capturer d'elle-même : la capture passe par le
 * portail xdg-desktop-portal (ScreenCast, PipeWire), qui affiche son propre sélecteur (fenêtre ou écran). Le joueur
 * y choisit la fenêtre Deadlock (ou l'écran du jeu) une fois par lancement ; un seul flux vidéo est ouvert sur ce
 * choix et chaque scan en lit l'image courante (~5 ms).
 *
 * Le sélecteur ne s'ouvre jamais tout seul plus d'une fois : premier scan du lancement, puis seulement à la demande
 * du joueur (`requestCapturePick`) après une annulation ou la fin du flux (fenêtre fermée). Le relancer à chaque scan
 * ferait réapparaître la fenêtre du portail sans fin.
 */
import type { CaptureSourceInfo } from '../electron';

export interface GameFrame {
  /** Live frame, to close once analysed. */
  image: ImageBitmap;
  sourceName: string;
  isDeadlockWindow: boolean;
}

/** idle: never opened · picking: the portal picker is open · live: frames flowing · stopped: cancelled or ended. */
export type CaptureState = 'idle' | 'picking' | 'live' | 'stopped';

interface FrameGrabber {
  grabFrame(): Promise<ImageBitmap>;
}

// ImageCapture (Chromium) is not in TypeScript's DOM lib
const ImageCaptureCtor = (
  globalThis as unknown as { ImageCapture?: new (track: MediaStreamTrack) => FrameGrabber }
).ImageCapture;

// A window that is hidden or on another desktop may deliver no frame: give up on this scan instead of blocking the loop
const GRAB_TIMEOUT_MS = 1500;
// Capture size: 16:9 screens up to 1440p arrive at their own size (4K at 2560x1440), 16:10 (2560x1600) and
// ultrawide (3440x1440 -> 2560x1072) with their HUD at about the 1080p scale or more. The scanner normalizes every
// frame to 1920x1080: a 4K frame would cost four times the pixels for the same reading.
const MAX_CAPTURE_WIDTH = 2560;
const MAX_CAPTURE_HEIGHT = 1600;

let stream: MediaStream | null = null;
let grabber: FrameGrabber | null = null;
let activeSource: CaptureSourceInfo | null = null;
let state: CaptureState = 'idle';
const listeners = new Set<(state: CaptureState) => void>();

function setState(next: CaptureState): void {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener(next));
}

export function getCaptureState(): CaptureState {
  return state;
}

export function onCaptureStateChange(listener: (state: CaptureState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function closeStream(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  grabber = null;
  activeSource = null;
}

/** Portal picker, then one stream on the chosen window or screen. No timeout: the player may take a while to choose. */
async function openCapture(): Promise<void> {
  closeStream();
  setState('picking');
  try {
    const source = await window.electronAPI!.pickCaptureSource();
    if (!source) throw new Error('Aucune source choisie');
    // Legacy Chromium constraints: the only way to capture a given desktopCapturer source with getUserMedia
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxWidth: MAX_CAPTURE_WIDTH,
          maxHeight: MAX_CAPTURE_HEIGHT,
          maxFrameRate: 5,
        },
      },
    } as unknown as MediaStreamConstraints;
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = newStream.getVideoTracks()[0];
    if (!track) {
      newStream.getTracks().forEach((t) => t.stop());
      throw new Error('Flux sans piste vidéo');
    }
    // Window closed (Deadlock quit) or sharing stopped from the desktop: wait for the player to choose again
    track.addEventListener('ended', () => {
      if (stream !== newStream) return;
      closeStream();
      setState('stopped');
    });
    stream = newStream;
    grabber = new ImageCaptureCtor!(track);
    activeSource = source;
    setState('live');
  } catch (err) {
    console.warn('Capture :', err);
    closeStream();
    setState('stopped');
  }
}

/** Player's action ("Choose the Deadlock window"): opens the portal picker again. */
export function requestCapturePick(): void {
  if (state === 'picking' || !window.electronAPI || !ImageCaptureCtor) return;
  void openCapture();
}

/** Next frame or null after GRAB_TIMEOUT_MS; a frame arriving after the timeout is closed right away. */
function grabWithTimeout(g: FrameGrabber): Promise<ImageBitmap | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, GRAB_TIMEOUT_MS);
    g.grabFrame().then(
      (bitmap) => {
        if (settled) {
          bitmap.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(bitmap);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** Current image of the chosen window or screen, or null (picker open, cancelled, no frame yet). */
export async function grabGameFrame(): Promise<GameFrame | null> {
  // First scan of the session: the picker opens once by itself, later only on the player's request
  if (state === 'idle') requestCapturePick();
  const source = activeSource;
  if (state !== 'live' || !grabber || !source) return null;
  const bitmap = await grabWithTimeout(grabber);
  // The portal hides window titles: what the player picked is taken as the game (format checks, "no HUD" hint)
  return bitmap ? { image: bitmap, sourceName: source.sourceName, isDeadlockWindow: true } : null;
}

/** Releases a frame once analysed (live frames hold ~8 MB until closed). */
export function releaseGameFrame(frame: GameFrame): void {
  frame.image.close();
}
