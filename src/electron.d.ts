/** Window or screen the player chose in the xdg-desktop-portal picker, for the live capture stream. */
export interface CaptureSourceInfo {
  id: string;
  sourceName: string;
  /** KDE: the frames come back with KWin's screencast curve, undone before the scanner reads them. */
  kwinGamma: boolean;
}

export interface OverlayState {
  isOverlayMode: boolean;
  isClickThrough: boolean;
  /** Arrange mode (⚙ or Alt+K): the overlay has the focus, to be moved, resized and set. */
  isArranging: boolean;
}

export interface AppInfo {
  version: string;
  isPackaged: boolean;
  canAutoUpdate: boolean;
  repoUrl: string;
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'available'; version: string; url: string } // not an AppImage: download it by hand
  | { state: 'downloading' | 'ready'; version: string } // AppImage: electron-updater
  | { state: 'error'; message: string };

export interface ProblemReportResult {
  path: string;
  fileName: string;
  logFolder: string | null;
}

declare global {
  interface Window {
    electronAPI?: {
      /** Opens the xdg-desktop-portal picker (window or screen); null if cancelled. */
      pickCaptureSource: () => Promise<CaptureSourceInfo | null>;
      setOverlayMode: (enable?: boolean) => Promise<OverlayState>;
      setClickThrough: (enable?: boolean) => Promise<OverlayState>;
      /** Arrange mode: the overlay takes the focus until it is turned off or the game is clicked. */
      setOverlayArranging: (enable: boolean) => Promise<OverlayState>;
      /** Overlay window only: resizing from its ↘ corner, by how far the pointer moved since 'start'. */
      overlayResize: (phase: 'start' | 'move' | 'end', dx?: number, dy?: number) => void;
      /** Overlay window only: zoom of its page, its window resized by the same factor. */
      setOverlayScale: (scale: number) => Promise<number>;
      /** Writes to the clipboard (item name for the shop search). */
      copyText: (text: string) => Promise<boolean>;
      /** A build code pasted from the game, base64 then zstd undone: the protobuf bytes, or null if it is not one. */
      decodeBuildCode: (code: string) => Promise<Uint8Array | null>;
      windowControl: (action: 'minimize' | 'maximize' | 'close') => Promise<void>;
      getAppInfo: () => Promise<AppInfo>;
      /** Opens a page of the project's GitHub repository (or deadlock-api.com) in the browser. */
      openExternal: (url: string) => Promise<boolean>;
      /** Match log files (src/services/matchLogger.ts), written by the main process. */
      matchLog: {
        start: () => void;
        write: (text: string) => void;
        image: (name: string, data: ArrayBuffer) => void;
        end: () => void;
        openFolder: () => Promise<string>;
        info: () => Promise<{ latest: string | null }>;
        deleteAll: () => Promise<boolean>;
      };
      createProblemReport: (payload: { info: string; state: string; includeLog: boolean }) => Promise<ProblemReportResult>;
      updates: {
        check: () => Promise<UpdateStatus>;
        status: () => Promise<UpdateStatus>;
        install: () => Promise<void>;
        onStatus: (callback: (status: UpdateStatus) => void) => () => void;
      };
      onOverlayStateChanged: (callback: (state: OverlayState) => void) => () => void;
      onTriggerShortcutScan: (callback: () => void) => () => void;
    };
  }
}
