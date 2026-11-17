const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, screen, shell, net, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { writeZip } = require('./zip.cjs');

const REPO_URL = 'https://github.com/Dakraid/deadlock-blueprint-linux';
const RELEASES_API = 'https://api.github.com/repos/Dakraid/deadlock-blueprint-linux/releases/latest';
// Only the AppImage can update itself (electron-updater replaces the file); other runs only offer the download
const isAppImage = Boolean(process.env.APPIMAGE);
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  // Not installed (development checkout): update notices through the GitHub API only
}
const canAutoUpdate = () => app.isPackaged && isAppImage && autoUpdater !== null;

// Linux Wayland only: screen capture (ScreenCast) and global shortcuts (GlobalShortcuts) go through
// xdg-desktop-portal, which refuses apps it cannot match to an installed .desktop file (xdg-desktop-portal 1.21+).
// The same id is the Wayland app_id the KWin window rule of the overlay matches (linux/deadlock-blueprint.kwinrule).
const DESKTOP_ID = 'com.vandicta.deadlock-blueprint';
app.setDesktopName(`${DESKTOP_ID}.desktop`);
app.commandLine.appendSwitch('ozone-platform', 'wayland');
// Suppress noisy Chromium stderr logs
app.commandLine.appendSwitch('log-level', '3');

const APP_ICON = path.join(__dirname, '../dist/icons/upscalemedia-transformed.png');
const OVERLAY_TITLE = 'Deadlock Blueprint Overlay';

/**
 * Writes the .desktop file (and its icon) the portals identify the app by, if missing or pointing elsewhere: a
 * development checkout or an AppImage is not installed. Rewritten when the AppImage moves.
 */
function ensureDesktopEntry() {
  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    // Unthemed icon, found directly in the icons base directory (icon theme spec fallback)
    const icon = path.join(dataHome, 'icons', `${DESKTOP_ID}.png`);
    if (fs.existsSync(APP_ICON) && !fs.existsSync(icon)) {
      fs.mkdirSync(path.dirname(icon), { recursive: true });
      fs.copyFileSync(APP_ICON, icon);
    }
    const quote = (arg) => `"${String(arg).replace(/(["`$\\])/g, '\\$1')}"`;
    const exec = process.env.APPIMAGE
      ? [process.env.APPIMAGE]
      : app.isPackaged
      ? [process.execPath]
      : [process.execPath, app.getAppPath()];
    const content = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Deadlock Blueprint',
      'Comment=Real-time build coach and overlay for Deadlock',
      `Exec=${exec.map(quote).join(' ')}`,
      `Icon=${DESKTOP_ID}`,
      `StartupWMClass=${DESKTOP_ID}`,
      'Categories=Game;Utility;',
      '',
    ].join('\n');
    const file = path.join(dataHome, 'applications', `${DESKTOP_ID}.desktop`);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  } catch (error) {
    console.error('desktop entry', error);
  }
}
ensureDesktopEntry();

/**
 * KDE: global shortcuts worked on the first launch only. Chromium skips BindShortcuts when the portal (version 1)
 * already lists every shortcut id, and the ids are stable (hash of the profile), but KWin only triggers the
 * shortcuts of a session that bound them. cleanUp() drops the component's inactive shortcuts (those of a previous
 * launch, nothing is bound while no instance runs), so this launch binds them again. A trigger changed in System
 * Settings is reset to the app's own at each launch.
 */
function resetKdeShortcuts() {
  if (!/kde/i.test(process.env.XDG_CURRENT_DESKTOP || '')) return;
  try {
    require('child_process').execFileSync(
      'gdbus',
      [
        'call', '--session', '--dest', 'org.kde.kglobalaccel',
        '--object-path', `/component/${DESKTOP_ID.replace(/[.-]/g, '_')}`,
        '--method', 'org.kde.kglobalaccel.Component.cleanUp',
      ],
      { timeout: 2000, stdio: 'ignore' }
    );
  } catch {
    // No such component yet (first launch) or no gdbus: nothing to reset
  }
}
resetKdeShortcuts();

let mainWindow = null;
let overlayWindow = null;
let isOverlayMode = false;
let isClickThrough = false;
// Arrange mode of the overlay (⚙ or Alt+K): the only time it takes the focus, see setOverlayArranging()
let isOverlayArranging = false;
// Size setting of the overlay (App.tsx): its page zoom, and the factor its window was resized by since it was created
let overlayScale = 1;

function getAppUrlOrFile(win) {
  const isDevServer = process.argv.includes('--dev');
  const distIndex = path.join(__dirname, '../dist/index.html');

  if (isDevServer) {
    win.loadURL('http://localhost:5173');
  } else if (fs.existsSync(distIndex)) {
    win.loadFile(distIndex);
  } else {
    win.loadURL('http://localhost:5173');
  }
}

/** Physical pixel resolution of a display (Electron's `bounds` is in logical pixels, divided by the scale factor). */
function getDisplayPixelSize(disp) {
  if (!disp) return { width: 0, height: 0 };
  const scale = disp.scaleFactor || 1;
  return {
    width: Math.round(disp.bounds.width * scale),
    height: Math.round(disp.bounds.height * scale),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 850,
    minWidth: 380,
    minHeight: 450,
    frame: true,
    transparent: false,
    autoHideMenuBar: true,
    backgroundColor: '#0c0b0e',
    title: 'Deadlock Blueprint',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // CRITICAL: Keep auto-scan running in background even when playing Deadlock full-screen on the other monitor!
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  getAppUrlOrFile(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
      overlayWindow = null;
    }
  });
}

function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  // Wayland lets no client place itself, stay above other windows or refuse the focus: the KWin window rule
  // (linux/deadlock-blueprint.kwinrule) matches this title and the app id, and puts the overlay in KWin's overlay
  // layer (above a fullscreen game), keeps the focus on the game when clicked, and remembers its position.
  overlayWindow = new BrowserWindow({
    width: 380,
    height: 640,
    title: OVERLAY_TITLE,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // The page's <title> would replace the one the window rule matches
  overlayWindow.on('page-title-updated', (event) => event.preventDefault());

  const isDevServer = process.argv.includes('--dev');
  const distIndex = path.join(__dirname, '../dist/index.html');
  if (isDevServer) {
    overlayWindow.loadURL('http://localhost:5173/#overlay');
  } else if (fs.existsSync(distIndex)) {
    overlayWindow.loadFile(distIndex, { hash: 'overlay' });
  }

  overlayScale = 1;
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    isOverlayMode = false;
    isClickThrough = false;
    isOverlayArranging = false;
    broadcastOverlayState();
  });

  return overlayWindow;
}

function getOverlayState() {
  return { isOverlayMode, isClickThrough, isArranging: isOverlayArranging };
}

function broadcastOverlayState() {
  const payload = getOverlayState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-state-changed', payload);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-state-changed', payload);
  }
}

function toggleOverlayMode(forceState) {
  const targetState = typeof forceState === 'boolean' ? forceState : !isOverlayMode;
  isOverlayMode = targetState;

  if (isOverlayMode) {
    ensureOverlayWindow().showInactive();
  } else {
    isClickThrough = false;
    setOverlayArranging(false);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(false);
      overlayWindow.hide();
    }
  }

  broadcastOverlayState();
}

function toggleClickThrough(forceState) {
  if (!isOverlayMode) {
    toggleOverlayMode(true);
  }
  isClickThrough = typeof forceState === 'boolean' ? forceState : !isClickThrough;
  if (isClickThrough) setOverlayArranging(false);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (isClickThrough) {
      overlayWindow.setIgnoreMouseEvents(true);
    } else {
      overlayWindow.setIgnoreMouseEvents(false);
    }
  }
  broadcastOverlayState();
}

/**
 * Arrange mode (⚙ or Alt+K): shows the overlay's settings and its resize corner, and lets it be dragged by its
 * header. Ends on Alt+K, ⚙, ghost mode or hiding.
 */
function setOverlayArranging(enable) {
  const next = Boolean(enable);
  if (next && !isOverlayMode) toggleOverlayMode(true);
  if (!overlayWindow || overlayWindow.isDestroyed() || next === isOverlayArranging) return;
  isOverlayArranging = next;

  if (next && isClickThrough) {
    isClickThrough = false;
    overlayWindow.setIgnoreMouseEvents(false);
  }
  broadcastOverlayState();
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register('Alt+O', () => {
    toggleOverlayMode();
  });

  globalShortcut.register('Alt+L', () => {
    toggleClickThrough();
  });

  globalShortcut.register('Alt+K', () => {
    setOverlayArranging(!isOverlayArranging);
  });

  globalShortcut.register('Alt+S', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trigger-shortcut-scan');
    }
  });

  setupAutoUpdater();
  setTimeout(() => checkForUpdates(false), 10000);
  setInterval(() => checkForUpdates(false), 6 * 3600 * 1000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  endMatchLog();
});

app.on('window-all-closed', () => app.quit());

// IPC Handlers

// What to capture: on Wayland only the xdg-desktop-portal picker can choose it (window or screen), and the stream the
// renderer opens on the returned id reuses that choice (src/services/screenCapture.ts). Called once per launch and
// when the player asks to choose again, never in a loop: each call opens the picker.
ipcMain.handle('pick-capture-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const source = sources[0];
    // KWin's screencast curve (measured on Plasma 6.8, HDR and SDR outputs alike): undone in screenCapture.ts
    const kwinGamma = /kde/i.test(process.env.XDG_CURRENT_DESKTOP || '');
    return source ? { id: source.id, sourceName: source.name || source.id, kwinGamma } : null;
  } catch {
    return null;
  }
});

ipcMain.handle('set-overlay-mode', (_event, enable) => {
  toggleOverlayMode(enable);
  return getOverlayState();
});

ipcMain.handle('set-click-through', (_event, enable) => {
  toggleClickThrough(enable);
  return getOverlayState();
});

ipcMain.handle('set-overlay-arranging', (_event, enable) => {
  setOverlayArranging(enable);
  return getOverlayState();
});

/**
 * Overlay size: zooms its page (the zoom stays on this window, checked with Electron 33: the main window, same
 * origin, keeps 100%) and resizes the window by the same factor, so that the empty part of a bigger window does not
 * catch the clicks meant for the game. A window the player resized keeps its proportions. Wayland does not let a
 * window move itself: the top-left corner stays in place.
 */
function setOverlayScale(scale) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const next = Math.min(1, Math.max(0.5, Number(scale) || 1));
  const ratio = next / overlayScale;
  overlayScale = next;
  overlayWindow.webContents.setZoomFactor(next);
  if (Math.abs(ratio - 1) < 0.01) return;
  const [width, height] = overlayWindow.getSize();
  overlayWindow.setSize(Math.round(width * ratio), Math.round(height * ratio));
}

/**
 * Resizing from the ↘ corner of the overlay (arrange mode). Its window edges cannot be grabbed: they are in the 8 px
 * transparent margin around the panel. Wayland gives no global cursor position: the renderer sends how far the
 * pointer moved since it pressed the corner (its top-left corner does not move), top-left corner in place.
 */
let overlayResizeStart = null;
const OVERLAY_MIN_SIZE = { width: 240, height: 220 };

ipcMain.on('overlay-resize', (event, phase, dx, dy) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return;
  if (phase === 'start') {
    overlayResizeStart = overlayWindow.getSize();
  } else if (phase === 'move' && overlayResizeStart && Number.isFinite(dx) && Number.isFinite(dy)) {
    const [width, height] = overlayResizeStart;
    overlayWindow.setSize(
      Math.round(Math.max(OVERLAY_MIN_SIZE.width, width + dx)),
      Math.round(Math.max(OVERLAY_MIN_SIZE.height, height + dy))
    );
  } else {
    overlayResizeStart = null;
  }
});

ipcMain.handle('set-overlay-scale', (event, scale) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) setOverlayScale(scale);
  return overlayScale;
});

// "Copy the item name" (to paste it into the shop search): the clipboard only, nothing is sent to the game
ipcMain.handle('copy-text', (_event, text) => {
  if (typeof text !== 'string' || text.length === 0 || text.length > 200) return false;
  clipboard.writeText(text);
  return true;
});

// Build code pasted from the game (base64 of a zstd frame holding a CMsgHeroBuild protobuf): the renderer has no
// zstd (DecompressionStream lacks it in Electron 45), so it is inflated here and parsed in
// src/services/importedBuild.ts › parseBuildCode. A pasted text: capped in and out (zstd bomb).
ipcMain.handle('decode-build-code', (_event, code) => {
  if (typeof code !== 'string' || code.length > 65536) return null;
  try {
    return new Uint8Array(require('zlib').zstdDecompressSync(Buffer.from(code.replace(/\s+/g, ''), 'base64'), { maxOutputLength: 1 << 20 }));
  } catch {
    return null;
  }
});

// Match logs (src/services/matchLogger.ts): one folder per game under ~/.config/deadlock-tactical-autobuild/
// match-logs/, with journal.log (what the scanner saw and what the app decided) and images\ (HUD crops
// every 2 s, full frame every minute) so that a game can be replayed and the scanner re-calibrated afterwards.
const MATCH_LOGS_KEPT = 5;
let matchLogDir = null;
let matchLogStream = null;

function matchLogsRoot() {
  return path.join(app.getPath('userData'), 'match-logs');
}

function endMatchLog() {
  if (matchLogStream) matchLogStream.end();
  matchLogStream = null;
  matchLogDir = null;
}

ipcMain.on('match-log-start', () => {
  try {
    endMatchLog();
    const root = matchLogsRoot();
    fs.mkdirSync(root, { recursive: true });
    const previous = fs
      .readdirSync(root)
      .filter((name) => name.startsWith('partie_'))
      .sort();
    for (const name of previous.slice(0, Math.max(0, previous.length - (MATCH_LOGS_KEPT - 1)))) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(
      now.getMinutes()
    )}-${pad(now.getSeconds())}`;
    matchLogDir = path.join(root, `partie_${stamp}`);
    fs.mkdirSync(path.join(matchLogDir, 'images'), { recursive: true });
    matchLogStream = fs.createWriteStream(path.join(matchLogDir, 'journal.log'), { flags: 'a' });
    matchLogStream.write(`Deadlock Blueprint ${app.getVersion()} — journal de partie du ${now.toLocaleString('fr-FR')}\n`);
  } catch (error) {
    console.error('match-log-start', error);
    endMatchLog();
  }
});

ipcMain.on('match-log-write', (_event, text) => {
  if (matchLogStream && typeof text === 'string') matchLogStream.write(text);
});

ipcMain.on('match-log-image', (_event, name, data) => {
  if (!matchLogDir || typeof name !== 'string' || !data) return;
  fs.writeFile(path.join(matchLogDir, 'images', path.basename(name)), Buffer.from(data), () => {});
});

ipcMain.on('match-log-end', () => endMatchLog());

ipcMain.handle('open-match-logs', () => {
  const root = matchLogsRoot();
  fs.mkdirSync(root, { recursive: true });
  return shell.openPath(matchLogDir || root);
});

/** Newest match log folder (the current one if a match is being logged). */
function latestMatchLogDir() {
  if (matchLogDir) return matchLogDir;
  const root = matchLogsRoot();
  if (!fs.existsSync(root)) return null;
  const folders = fs
    .readdirSync(root)
    .filter((name) => name.startsWith('partie_'))
    .sort();
  return folders.length > 0 ? path.join(root, folders[folders.length - 1]) : null;
}

ipcMain.handle('match-logs-info', () => {
  const dir = latestMatchLogDir();
  return { latest: dir ? path.basename(dir) : null };
});

// Game logs turned off or deleted from Settings: nothing is left on disk
ipcMain.handle('delete-match-logs', () => {
  endMatchLog();
  fs.rmSync(matchLogsRoot(), { recursive: true, force: true });
  return true;
});

// Problem report (Diagnostics › Report a problem): a .zip in the Downloads folder with the system info, the
// app state and, if the player wants, the last match log. GitHub can't receive files through a URL: the
// player drags the .zip into the pre-filled issue page opened next.
const REPORT_MAX_BYTES = 20 * 1024 * 1024; // GitHub attachments are limited to 25 MB

function reportImages(dir) {
  const imagesDir = path.join(dir, 'images');
  if (!fs.existsSync(imagesDir)) return [];
  const names = fs.readdirSync(imagesDir).sort().reverse(); // newest first
  // Full frames (1 per minute) first: they show everything; then the most recent HUD crops
  return [...names.filter((n) => n.startsWith('full_')), ...names.filter((n) => !n.startsWith('full_'))].map((n) =>
    path.join(imagesDir, n)
  );
}

/** PRETTY_NAME of /etc/os-release ("CachyOS", "Fedora Linux 43"…). */
function linuxDistro() {
  try {
    const match = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)"?$/m);
    return match ? match[1] : 'Linux';
  } catch {
    return 'Linux';
  }
}

ipcMain.handle('create-problem-report', (_event, payload) => {
  const { info = '', state = '', includeLog = false } = payload || {};
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(
    now.getMinutes()
  )}`;
  const system = [
    `Deadlock Blueprint ${app.getVersion()}${isAppImage ? ' (AppImage)' : app.isPackaged ? ' (packaged)' : ' (dev)'}`,
    `${linuxDistro()} — Linux ${os.release()} ${os.arch()}, ${process.env.XDG_SESSION_TYPE || '?'} session, ${
      process.env.XDG_CURRENT_DESKTOP || '?'
    } — Electron ${process.versions.electron}, Chrome ${process.versions.chrome}`,
    `Displays: ${screen
      .getAllDisplays()
      .map((d) => {
        const px = getDisplayPixelSize(d);
        return `${px.width}x${px.height} @${d.scaleFactor}x${d.id === screen.getPrimaryDisplay().id ? ' (primary)' : ''}`;
      })
      .join(', ')}`,
  ].join('\n');
  const entries = [
    { name: 'info.txt', data: Buffer.from(`${system}\n\n${info}\n`, 'utf8') },
    { name: 'state.json', data: Buffer.from(String(state), 'utf8') },
  ];

  let logFolder = null;
  const dir = includeLog ? latestMatchLogDir() : null;
  if (dir && fs.existsSync(path.join(dir, 'journal.log'))) {
    logFolder = path.basename(dir);
    const journal = fs.readFileSync(path.join(dir, 'journal.log'));
    entries.push({ name: `${logFolder}/journal.log`, data: journal });
    let total = journal.length;
    for (const file of reportImages(dir)) {
      const data = fs.readFileSync(file);
      if (total + data.length > REPORT_MAX_BYTES) continue;
      total += data.length;
      entries.push({ name: `${logFolder}/images/${path.basename(file)}`, data, compress: false });
    }
  }

  let outDir = app.getPath('downloads');
  if (!fs.existsSync(outDir)) outDir = app.getPath('userData');
  const zipPath = path.join(outDir, `Deadlock-Blueprint-report-${stamp}.zip`);
  writeZip(zipPath, entries);
  shell.showItemInFolder(zipPath);
  return { path: zipPath, fileName: path.basename(zipPath), logFolder };
});

// Links opened in the browser: only the project's GitHub pages and the data source
ipcMain.handle('open-external', (_event, url) => {
  if (typeof url !== 'string') return false;
  if (!url.startsWith(`${REPO_URL}/`) && url !== REPO_URL && !url.startsWith('https://deadlock-api.com')) return false;
  shell.openExternal(url);
  return true;
});

ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  canAutoUpdate: canAutoUpdate(),
  repoUrl: REPO_URL,
}));

// Updates. AppImage: electron-updater downloads the new AppImage from the GitHub release (latest-linux.yml) and
// replaces the file on restart. Other runs (development, unpacked): only a notice with a link to the release page.
let updateStatus = { state: 'idle' };

function sendUpdateStatus(status) {
  updateStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', status);
}

/** -1, 0 or 1, comparing "1.4.0" style versions (a "v" prefix and pre-release tags are ignored). */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

function setupAutoUpdater() {
  if (!canAutoUpdate()) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'downloading', version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'none' }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => sendUpdateStatus({ state: 'error', message: String(err && err.message) }));
}

async function checkForUpdates(manual) {
  if (['checking', 'downloading', 'ready'].includes(updateStatus.state)) return updateStatus;
  if (canAutoUpdate()) {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      sendUpdateStatus({ state: 'error', message: String(err && err.message) });
    }
    return updateStatus;
  }
  if (!app.isPackaged && !manual) return updateStatus; // no automatic check from a development checkout
  sendUpdateStatus({ state: 'checking' });
  try {
    const res = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    if (release.tag_name && compareVersions(release.tag_name, app.getVersion()) > 0) {
      sendUpdateStatus({
        state: 'available',
        version: String(release.tag_name).replace(/^v/, ''),
        url: release.html_url || `${REPO_URL}/releases/latest`,
      });
    } else {
      sendUpdateStatus({ state: 'none' });
    }
  } catch (err) {
    sendUpdateStatus({ state: 'error', message: String(err && err.message) });
  }
  return updateStatus;
}

ipcMain.handle('check-for-updates', () => checkForUpdates(true));
ipcMain.handle('get-update-status', () => updateStatus);
ipcMain.handle('install-update', () => {
  if (canAutoUpdate() && updateStatus.state === 'ready') autoUpdater.quitAndInstall();
});

ipcMain.handle('window-control', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
  if (action === 'close') mainWindow.close();
});
