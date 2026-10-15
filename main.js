// Suppress benign internal Electron security & CSP warnings from console
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const {
  loadAllAccounts,
  upsertAccount,
  parseCookieContent,
  deleteAccounts,
  resetAccountStatus,
  updateAccountStatus
} = require('./engine/cookies');
const { checkAccountHealth } = require('./engine/dola-api');
const StudioOrchestrator = require('./engine/orchestrator');
const { termLog, colors } = require('./engine/terminal-logger');

// Catch any unexpected exceptions and output to IDE terminal in high-visibility red
process.on('uncaughtException', (err) => {
  termLog('MAIN', `Uncaught Exception: ${err.stack || err.message}`, 'error');
});
process.on('unhandledRejection', (reason) => {
  termLog('MAIN', `Unhandled Rejection: ${reason?.stack || reason}`, 'error');
});

// User data path
const userDataPath = path.join(__dirname, 'data', 'user-data');
if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
app.setPath('userData', userDataPath);

// Prevent disk cache collision
app.commandLine.appendSwitch('disable-gpu-cache');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  termLog('MAIN', 'Another instance is already running. Exiting.', 'warn');
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let orchestrator = null;

function printStartupBanner() {
  const accounts = loadAllAccounts();
  const liveCount = accounts.filter(a => a.status === 'live' || !a.status).length;
  console.log(`
${colors.cyan}${colors.bold}======================================================================
  ⚡ SudoDola Studio Pro v2.5 — Desktop Video Farm Orchestrator
  Engineered by SudoDotDev • Live IDE Terminal Debugging Active
======================================================================${colors.reset}
  ${colors.white}• Node: ${process.version} | Electron: ${process.versions.electron} | Chrome: ${process.versions.chrome}
  • Main Process PID: ${process.pid}
  • SQLite Account Vault: ${accounts.length} total (${liveCount} live)
  • Target Save Drive: C:\\Users\\Davie\\Videos\\SudoDola
  • Live Stream: Ready for video generation tasks${colors.reset}
${colors.gray}----------------------------------------------------------------------${colors.reset}
`);
}

function createWindow() {
  printStartupBanner();
  termLog('MAIN', 'Creating main application window...', 'info');

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 1060,
    minHeight: 740,
    backgroundColor: '#0d0e12',
    title: 'SudoDola Studio Pro v2.5 — Seedance 2.5 • 30s Pro Mode',
    icon: path.join(__dirname, 'icons', 'icon128.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');

  // Stream all Renderer UI console messages directly to IDE terminal
  mainWindow.webContents.on('console-message', (event, ...rest) => {
    const message = (event && typeof event.message === 'string') ? event.message : (rest[1] || String(event || ''));
    const level = (event && typeof event.level === 'number') ? event.level : (typeof rest[0] === 'number' ? rest[0] : 0);
    if (!message || message.includes('font') || message.includes('favicon')) return;
    const levelStr = level === 3 ? 'error' : level === 2 ? 'warn' : 'info';
    termLog('UI', message, levelStr);
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    termLog('MAIN', `Main renderer crashed or exited: ${details.reason} (code: ${details.exitCode})`, 'error');
  });

  // Initialize Orchestrator with event streams
  orchestrator = new StudioOrchestrator(
    (logEntry) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('studio-log', logEntry);
      }
    },
    (statusSummary) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('studio-status', statusSummary);
      }
    }
  );

  mainWindow.on('closed', () => {
    termLog('MAIN', 'Main window closed. Stopping orchestrator queues.', 'info');
    mainWindow = null;
    if (orchestrator) orchestrator.stopQueue();
  });
}

// IPC Handlers
ipcMain.handle('queue:start', async (event, payload) => {
  if (!orchestrator) return { success: false, error: 'Orchestrator not ready' };
  const promptCount = Array.isArray(payload?.prompts) ? payload.prompts.length : 0;
  termLog('IPC', `Received queue:start for ${promptCount} prompt(s) (${payload?.aspectRatio || '16:9'})`, 'info');
  orchestrator.startQueue(payload);
  return { success: true };
});

ipcMain.handle('queue:stop', async () => {
  termLog('IPC', 'Received queue:stop command from UI', 'warn');
  if (!orchestrator) return { success: false };
  orchestrator.stopQueue();
  return { success: true };
});

ipcMain.handle('queue:status', async () => {
  if (!orchestrator) return null;
  return orchestrator.getStatus();
});

ipcMain.handle('accounts:load', async () => {
  const accs = loadAllAccounts();
  return accs;
});

ipcMain.handle('accounts:delete', async (event, accountId) => {
  termLog('VAULT', `Deleting account ID: ${accountId}`, 'warn');
  const remaining = deleteAccounts([accountId]);
  return remaining;
});

ipcMain.handle('accounts:reset', async (event, accountId) => {
  termLog('VAULT', `Resetting status for account ID: ${accountId}`, 'info');
  resetAccountStatus(accountId);
  return loadAllAccounts();
});

ipcMain.handle('accounts:import', async (event, rawJson) => {
  try {
    const cookies = parseCookieContent(rawJson);
    if (!cookies.length) {
      termLog('VAULT', 'Import failed: No valid cookies detected', 'warn');
      return { success: false, error: 'No valid cookies found in pasted content.' };
    }
    const shortId = Date.now().toString().slice(-4);
    const newAccount = {
      id: `acc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name: `Imported_${shortId}`,
      filename: `Imported_${shortId}.json`,
      cookies,
      status: 'live',
      savedCount: 0,
      savedToday: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      createdAt: Date.now()
    };
    upsertAccount(newAccount);
    const total = loadAllAccounts().length;
    termLog('VAULT', `Imported "${newAccount.name}" with ${cookies.length} cookies (Vault total: ${total})`, 'success');
    return { success: true, count: total };
  } catch (err) {
    termLog('VAULT', `Import error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
});

ipcMain.handle('accounts:check-health', async (event, accountId) => {
  const all = loadAllAccounts();
  const acc = all.find(a => String(a.id) === String(accountId));
  if (!acc) return { live: false, reason: 'Account not found' };
  termLog('VAULT', `Testing authentication for "${acc.name}"...`, 'info');
  const res = await checkAccountHealth(acc);
  if (res.live) {
    updateAccountStatus(acc.id, 'live', 0);
    termLog('VAULT', `Authentication check PASSED for "${acc.name}" (Live: true, User: ${res.user || 'OK'})`, 'success');
  } else {
    updateAccountStatus(acc.id, 'dead', 0);
    termLog('VAULT', `Authentication check FAILED for "${acc.name}": ${res.reason}`, 'warn');
  }
  return res;
});

async function launchCollectorWindow(customTitle) {
  return new Promise((resolve) => {
    const partitionName = `persist:dola_collect_${Date.now()}`;
    const loginWin = new BrowserWindow({
      width: 980,
      height: 780,
      parent: mainWindow,
      modal: false,
      title: customTitle || '⚡ Dola AI — Auto Session Cookie Collector',
      webPreferences: {
        partition: partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      },
      autoHideMenuBar: true
    });

    loginWin.loadURL('https://www.dola.com/chat');

    let resolved = false;
    let pollInterval = null;

    const checkCookies = async () => {
      if (resolved || loginWin.isDestroyed()) return;
      try {
        const ses = loginWin.webContents.session;
        const cookies = await ses.cookies.get({ domain: '.dola.com' });
        const validCookies = cookies.filter(c => c.value && c.value.trim().length > 0);
        const sessionCookie = validCookies.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss');

        if (sessionCookie) {
          const health = await checkAccountHealth({ cookies: validCookies });
          if (health.live) {
            resolved = true;
            clearInterval(pollInterval);

            const userName = String(health.user || sessionCookie.value.slice(-6))
              .replace(/[^a-zA-Z0-9_-]/g, '_');
            const accName = `Dola_${userName}`;

            const newAccount = {
              id: `acc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
              name: accName,
              filename: `${accName}.json`,
              cookies: validCookies,
              status: 'live',
              savedCount: 0,
              savedToday: 0,
              lastUsed: 0,
              cooldownUntil: 0,
              createdAt: Date.now()
            };
            upsertAccount(newAccount);
            const all = loadAllAccounts();

            if (orchestrator) {
              orchestrator.log('success', `🎉 [1-CLICK LOGIN] Successfully authenticated and saved "${accName}" with ${validCookies.length} session cookies in SQLite!`);
            }

            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('accounts-updated', all);
            }

            loginWin.close();
            resolve({ success: true, accountName: accName, cookieCount: validCookies.length });
          }
        }
      } catch (_) {}
    };

    pollInterval = setInterval(checkCookies, 1200);

    loginWin.on('closed', () => {
      clearInterval(pollInterval);
      if (!resolved) {
        resolve({ success: false, reason: 'Collector window closed.' });
      }
    });
  });
}

ipcMain.handle('accounts:login-window', async () => {
  termLog('VAULT', 'Launching interactive 1-Click Login window for Dola session capture...', 'info');
  return launchCollectorWindow('🔑 Dola AI — Log In & Auto-Collect Session');
});

ipcMain.handle('fs:open-folder', async (event, folderPath) => {
  const target = folderPath || 'C:\\Users\\Davie\\Videos\\SudoDola';
  if (!fs.existsSync(target)) {
    try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
  }
  termLog('MAIN', `Opening target output directory: ${target}`, 'info');
  shell.openPath(target);
  return true;
});

ipcMain.handle('fs:select-image', async () => {
  if (!mainWindow) return null;
  termLog('UI', 'Opening image file picker dialog...', 'info');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Reference Image for Image-to-Video',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) {
    termLog('UI', 'Image selection canceled', 'info');
    return null;
  }
  termLog('UI', `Selected reference image: ${result.filePaths[0]}`, 'success');
  return result.filePaths[0];
});

ipcMain.handle('accounts:import-file', async () => {
  if (!mainWindow) return { success: false, error: 'No main window' };
  termLog('VAULT', 'Opening cookie file picker dialog...', 'info');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Cookie JSON File',
    filters: [
      { name: 'JSON & Cookie Files', extensions: ['json', 'txt'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) {
    termLog('VAULT', 'Cookie file selection canceled', 'info');
    return { success: false, canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const cookies = parseCookieContent(rawContent);
    if (!cookies.length) {
      termLog('VAULT', `File "${path.basename(filePath)}" contains no valid cookies`, 'warn');
      return { success: false, error: 'No valid cookies found in selected file.' };
    }

    const baseName = path.basename(filePath, path.extname(filePath))
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const newAccount = {
      id: `acc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name: baseName,
      filename: `${baseName}.json`,
      cookies,
      status: 'live',
      savedCount: 0,
      savedToday: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      createdAt: Date.now()
    };
    upsertAccount(newAccount);
    const all = loadAllAccounts();

    termLog('VAULT', `Imported "${baseName}" with ${cookies.length} cookies from file. (Total accounts: ${all.length})`, 'success');

    if (orchestrator) {
      orchestrator.log('success', `🎉 [COOKIE IMPORT] Successfully imported "${baseName}" with ${cookies.length} cookies into SQLite Vault!`);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('accounts-updated', all);
    }

    return {
      success: true,
      accountName: baseName,
      cookieCount: cookies.length,
      total: all.length
    };
  } catch (err) {
    termLog('VAULT', `Cookie file import error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
