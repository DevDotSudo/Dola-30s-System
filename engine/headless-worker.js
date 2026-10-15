/**
 * SudoDola Studio Pro - Headless Chromium Worker Runner
 * Spawns isolated session partition with zero background throttling.
 */

const { BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { termLog } = require('./terminal-logger');
require('../video-crypto.js'); // Attaches DoubaoVideoCrypto to globalThis

function cleanWatermarkUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    let clean = rawUrl;
    clean = clean.replace(/~tplv-[a-zA-Z0-9_-]+-wm(?:\.[a-zA-Z0-9]+|:[a-zA-Z0-9.]+)?/gi, '');
    clean = clean.replace(/-wm(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');
    clean = clean.replace(/_wm(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');
    clean = clean.replace(/_watermark(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');
    clean = clean.replace(/-watermark(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');

    const parsed = new URL(clean);
    if (parsed.searchParams.has('logo_type')) parsed.searchParams.set('logo_type', 'unwatermarked');
    if (parsed.searchParams.has('watermark')) parsed.searchParams.set('watermark', '0');
    if (parsed.searchParams.has('has_watermark')) parsed.searchParams.set('has_watermark', '0');
    if (parsed.searchParams.has('with_watermark')) parsed.searchParams.set('with_watermark', '0');
    if (parsed.searchParams.has('is_watermark')) parsed.searchParams.set('is_watermark', '0');
    if (parsed.searchParams.has('wm')) parsed.searchParams.set('wm', '0');

    ['wm_url', 'wm_type', 'logo_name', 'logo_position', 'dola_wm', 'remove_wm', 'force_fids', 'tos_watermark'].forEach(p => {
      parsed.searchParams.delete(p);
    });

    return parsed.toString();
  } catch (_) {
    return rawUrl;
  }
}

async function downloadStreamToFile(videoUrl, saveFolder, filename, onLog) {
  if (!fs.existsSync(saveFolder)) fs.mkdirSync(saveFolder, { recursive: true });
  const filePath = path.join(saveFolder, filename);

  const fetchClient = videoUrl.startsWith('https:') ? https : http;

  return new Promise((resolve, reject) => {
    fetchClient.get(videoUrl, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadStreamToFile(res.headers.location, saveFolder, filename, onLog).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading video stream`));
      }

      const fileStream = fs.createWriteStream(filePath);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          const stats = fs.statSync(filePath);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          resolve({ filePath, sizeMB });
        });
      });

      fileStream.on('error', (err) => {
        try { fs.unlinkSync(filePath); } catch (_) {}
        reject(err);
      });
    }).on('error', reject);
  });
}

const activeWorkerCleanups = new Set();

function stopAllHeadlessWorkers() {
  for (const cleanup of Array.from(activeWorkerCleanups)) {
    try { cleanup('Worker stopped by queue controller.'); } catch (_) {}
  }
  activeWorkerCleanups.clear();
}

function attachLightweightNetworkBlocker(ses) {
  if (!ses || !ses.webRequest) return;
  try {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const type = details.resourceType;
      const url = (details.url || '').toLowerCase();

      // Block heavy background media & analytics tracking
      if (type === 'media' || type === 'font') {
        return callback({ cancel: true });
      }
      if (
        url.includes('slardar') ||
        url.includes('tea.js') ||
        url.includes('google-analytics') ||
        url.includes('googletagmanager') ||
        url.includes('sentry.io')
      ) {
        return callback({ cancel: true });
      }

      callback({ cancel: false });
    });
  } catch (_) {}
}

function dispatchHeadlessWorkerTask(account, task, saveFolder, onTelemetryLog) {
  return new Promise(async (resolve, reject) => {
    let workerWin = null;
    let isFinished = false;
    let isPromptSubmitted = false;
    const targetTaskId = String(task.id || task.taskId || '');

    // Timeout guard: 3 hours for deep queues
    const timeoutTimer = setTimeout(() => {
      cleanup('Task timed out after 3 hours.');
    }, 3 * 60 * 60 * 1000);

    function cleanup(errorMsg = null) {
      if (isFinished) return;
      isFinished = true;
      activeWorkerCleanups.delete(cleanup);
      clearTimeout(timeoutTimer);

      if (ackInterval) {
        clearInterval(ackInterval);
        ackInterval = null;
      }

      ipcMain.removeListener('worker-telemetry', handleTelemetry);
      ipcMain.removeListener('worker-video-resolved', handleVideoResolved);
      ipcMain.removeListener('worker-error', handleWorkerError);
      ipcMain.removeListener('worker-account-limit', handleAccountLimit);
      ipcMain.removeListener('worker-ready', handleWorkerReady);
      ipcMain.removeListener('worker-task-ack', handleTaskAck);
      try { ipcMain.removeHandler('worker-trusted-submit'); } catch (_) {}

      if (workerWin && !workerWin.isDestroyed()) {
        try { workerWin.destroy(); } catch (_) {}
      }
      workerWin = null;

      if (errorMsg) {
        reject(new Error(errorMsg));
      } else {
        resolve();
      }
    }

    function handleTelemetry(event, data) {
      if (isFinished) return;
      if (data && (String(data.taskId) === targetTaskId || !data.taskId)) {
        if (onTelemetryLog) onTelemetryLog(data.type || 'info', data.message || '');
      }
    }

    function handleVideoResolved(event, data) {
      if (isFinished) return;
      if (data && String(data.taskId) === targetTaskId) {
        cleanup();
      }
    }

    function handleWorkerError(event, data) {
      if (isFinished) return;
      if (data && String(data.taskId) === targetTaskId) {
        cleanup(data.error || 'Worker reported error');
      }
    }

    function handleAccountLimit(event, data) {
      if (isFinished) return;
      if (data && String(data.taskId) === targetTaskId) {
        cleanup(data.error || 'ACCOUNT_LIMIT_REACHED');
      }
    }

    let isNavigationFinished = false;
    let isTaskAcknowledged = false;
    let ackInterval = null;

    function handleWorkerReady(event, data) {
      if (isFinished || isPromptSubmitted || !isNavigationFinished || !workerWin || workerWin.isDestroyed()) return;
      if (workerWin.webContents.isLoading()) return;
      const curUrl = workerWin.webContents.getURL() || '';
      if (!curUrl.includes('dola.com/chat')) return;

      if (!isTaskAcknowledged) {
        sendTask(true);
      }
    }

    function handleTaskAck(event, data) {
      if (data && String(data.taskId) === targetTaskId) {
        isTaskAcknowledged = true;
        if (ackInterval) {
          clearInterval(ackInterval);
          ackInterval = null;
        }
      }
    }

    ipcMain.on('worker-telemetry', handleTelemetry);
    ipcMain.on('worker-video-resolved', handleVideoResolved);
    ipcMain.on('worker-error', handleWorkerError);
    ipcMain.on('worker-account-limit', handleAccountLimit);
    ipcMain.on('worker-ready', handleWorkerReady);
    ipcMain.on('worker-task-ack', handleTaskAck);

    try { ipcMain.removeHandler('worker-trusted-submit'); } catch (_) {}
    ipcMain.handle('worker-trusted-submit', async (event, { fullPrompt }) => {
      if (isFinished || !workerWin || workerWin.isDestroyed()) return { success: false, error: 'Worker destroyed' };
      if (isPromptSubmitted) {
        return { success: true, verified: true, duplicate: true };
      }
      try {
        if (onTelemetryLog) onTelemetryLog('info', `✍️ [TRUSTED INPUT] Typing prompt (${fullPrompt.length} chars) via bulletproof input engine...`);

        // STEP 1: Focus ProseMirror editor and select contents
        const focusResult = await workerWin.webContents.executeJavaScript(`(() => {
          const inputSelectors = [
            'div.tiptap.ProseMirror',
            'div[data-slate-editor="true"]',
            '[contenteditable="true"][data-placeholder]',
            'textarea.semi-input-textarea',
            '[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            'textarea'
          ];
          let ed = null;
          for (const sel of inputSelectors) {
            const el = document.querySelector(sel);
            if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
              ed = el;
              break;
            }
          }
          if (!ed) ed = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"], textarea');
          if (!ed) return { found: false };

          ed.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          const skillTag = ed.querySelector('.semi-tag, [data-slate-node="element"], span[data-type="mention"], span[contenteditable="false"], [class*="skill"]');
          if (skillTag) {
            range.setStartAfter(skillTag);
            range.setEndAfter(skillTag);
          } else {
            range.selectNodeContents(ed);
          }
          sel.removeAllRanges();
          sel.addRange(range);
          return { found: true };
        })()`);

        if (!focusResult?.found) {
          if (onTelemetryLog) onTelemetryLog('warn', `⚠️ [INPUT WARNING] Could not find editor in DOM before typing.`);
          return { success: false, error: 'Editor not found in DOM' };
        }

        await new Promise(r => setTimeout(r, 100));

        // STEP 2: Insert text via trusted Electron typing
        await workerWin.webContents.insertText(fullPrompt);
        await new Promise(r => setTimeout(r, 200));

        // STEP 3: Verify text landed and check if send button is active
        let buttonState = await workerWin.webContents.executeJavaScript(`(() => {
          const ed = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"], textarea');
          const sendBtnSelectors = [
            'button[data-testid="chat_input_send_button"]',
            '#flow-end-msg-send',
            'button[type="submit"]',
            'button[aria-label*="send" i]',
            'button[title*="send" i]',
            'button[data-testid*="send" i]',
            'button[aria-label*="发送"]',
            'div[role="button"][class*="send"]',
            'button[class*="send"]'
          ];
          let sendBtn = null;
          for (const sel of sendBtnSelectors) {
            const el = document.querySelector(sel);
            const btn = el ? (el.closest('button, div[role="button"]') || el) : null;
            if (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0)) {
              sendBtn = btn;
              break;
            }
          }

          const currentText = (ed ? (ed.innerText || ed.textContent) : '').trim();
          const isDisabled = sendBtn ? (
            sendBtn.disabled ||
            sendBtn.getAttribute('aria-disabled') === 'true' ||
            sendBtn.classList.contains('cursor-not-allowed') ||
            (sendBtn.className || '').includes('disabled')
          ) : true;

          return {
            hasText: currentText.length > 0,
            textLen: currentText.length,
            hasBtn: Boolean(sendBtn),
            isDisabled
          };
        })()`);

        // If editor text is still empty, fallback to in-page text insertion
        if (!buttonState.hasText) {
          await workerWin.webContents.executeJavaScript(`(() => {
            const ed = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"], textarea');
            if (ed) {
              const p = ed.querySelector('p') || ed;
              p.textContent = ${JSON.stringify(fullPrompt)};
              ed.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: ${JSON.stringify(fullPrompt)}, inputType: 'insertText' }));
              ed.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: ${JSON.stringify(fullPrompt)}, inputType: 'insertText' }));
              ed.dispatchEvent(new Event('input', { bubbles: true }));
              ed.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()`);
          await new Promise(r => setTimeout(r, 150));
        }

        // STEP 4: If send button is still disabled, wake up Tiptap state with a physical keystroke!
        if (buttonState.isDisabled) {
          workerWin.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
          await new Promise(r => setTimeout(r, 50));
          workerWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
          workerWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
          await new Promise(r => setTimeout(r, 150));
        }

        // STEP 5: Click active Send Button
        const sendClick = await workerWin.webContents.executeJavaScript(`(() => {
          const sendBtnSelectors = [
            'button[data-testid="chat_input_send_button"]',
            '#flow-end-msg-send',
            'button[type="submit"]',
            'button[aria-label*="send" i]',
            'button[title*="send" i]',
            'button[data-testid*="send" i]',
            'button[aria-label*="发送"]',
            'div[role="button"][class*="send"]',
            'button[class*="send"]'
          ];
          let sendBtn = null;
          for (const sel of sendBtnSelectors) {
            const el = document.querySelector(sel);
            const btn = el ? (el.closest('button, div[role="button"]') || el) : null;
            if (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0)) {
              sendBtn = btn;
              break;
            }
          }

          if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.setAttribute('aria-disabled', 'false');
            const r = sendBtn.getBoundingClientRect();
            sendBtn.click();
            return {
              clicked: true,
              coords: {
                x: Math.round(r.x + r.width / 2),
                y: Math.round(r.y + r.height / 2)
              }
            };
          }
          return { clicked: false, coords: null };
        })()`);

        if (sendClick?.clicked) {
          if (onTelemetryLog) onTelemetryLog('success', `🎯 [SEND BUTTON CLICKED] Send button triggered successfully!`);
          if (sendClick.coords && sendClick.coords.x > 0 && sendClick.coords.y > 0) {
            workerWin.webContents.sendInputEvent({ type: 'mouseMove', x: sendClick.coords.x, y: sendClick.coords.y });
            await new Promise(r => setTimeout(r, 40));
            workerWin.webContents.sendInputEvent({ type: 'mouseDown', x: sendClick.coords.x, y: sendClick.coords.y, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 40));
            workerWin.webContents.sendInputEvent({ type: 'mouseUp', x: sendClick.coords.x, y: sendClick.coords.y, button: 'left' });
          }
        }

        // Fallback Enter key
        await workerWin.webContents.executeJavaScript(`(() => {
          const ed = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"], textarea');
          if (ed) {
            ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            ed.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            ed.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          }
        })()`);
        workerWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        workerWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });

        // STEP 6: Confirm 18+ age popup if it appears
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 250));
          const ageConfirmed = await workerWin.webContents.executeJavaScript(`(() => {
            const dialog = document.querySelector('[role="dialog"]') || document.querySelector('.semi-modal');
            if (dialog && (dialog.innerText || '').includes('Confirm your age')) {
              const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(b => (b.innerText || '').trim() === 'Confirm');
              if (confirmBtn) {
                confirmBtn.click();
                return true;
              }
            }
            return false;
          })()`);
          if (ageConfirmed) {
            if (onTelemetryLog) onTelemetryLog('success', `🛡️ [AGE VERIFICATION] Automatically confirmed 18+ age verification popup!`);
            break;
          }
        }

        // STEP 7: Verify that the prompt was actually submitted (editor cleared or chat bubble appeared)
        let verifiedSubmitted = false;
        for (let v = 0; v < 8; v++) {
          await new Promise(r => setTimeout(r, 300));
          const checkRes = await workerWin.webContents.executeJavaScript(`(() => {
            const ed = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"], textarea');
            const currentText = (ed ? (ed.innerText || ed.textContent) : '').trim();
            // If editor cleared, Dola definitely submitted!
            const cleared = currentText === '' || currentText === '\\n';
            return { cleared, text: currentText.slice(0, 30) };
          })()`);

          if (checkRes.cleared) {
            verifiedSubmitted = true;
            break;
          }
        }

        if (verifiedSubmitted) {
          isPromptSubmitted = true;
          isTaskAcknowledged = true;
          if (ackInterval) {
            clearInterval(ackInterval);
            ackInterval = null;
          }
          if (onTelemetryLog) onTelemetryLog('success', `✅ [SUBMISSION VERIFIED] Dola accepted prompt! Editor cleared and dispatch confirmed.`);
          return { success: true, verified: true };
        } else {
          if (onTelemetryLog) onTelemetryLog('warn', `⚠️ [SUBMISSION NOTICE] Editor not cleared yet; falling back to in-page submit...`);
          return { success: false, verified: false, error: 'Editor not cleared' };
        }
      } catch (err) {
        if (onTelemetryLog) onTelemetryLog('warn', `⚠️ [TRUSTED SUBMIT ERROR]: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    let sendTask = () => {};

    try {
      const partitionKey = `persist:dola_acc_${account.id}`;
      if (onTelemetryLog) {
        onTelemetryLog('info', `[DEBUG] Initializing Chromium session for "${account.name}" (${partitionKey})...`);
      }

      const ses = session.fromPartition(partitionKey);
      attachLightweightNetworkBlocker(ses);

      // Inject account cookies into session
      let injectedCount = 0;
      for (const c of account.cookies || []) {
        const rawDomain = c.domain || '.dola.com';
        const cleanDomain = rawDomain.replace(/^\.+/, '');
        const url = `https://${cleanDomain}${c.path || '/'}`;
        try {
          await ses.cookies.set({
            url,
            name: c.name,
            value: c.value,
            domain: rawDomain.startsWith('.') ? rawDomain : ('.' + rawDomain),
            path: c.path || '/',
            secure: c.secure !== false,
            httpOnly: c.httpOnly === true,
            sameSite: c.sameSite === 'no_restriction' ? 'no_restriction' : (c.sameSite || 'lax'),
            expirationDate: c.expirationDate || (Date.now() / 1000 + 86400 * 30)
          });
          injectedCount++;
        } catch (_) {}
      }

      if (onTelemetryLog) {
        onTelemetryLog('info', `[DEBUG] Injected ${injectedCount} session cookies. Creating BrowserWindow...`);
      }

      // CRITICAL: backgroundThrottling: false ensures Chromium NEVER sleeps or delays timers
      workerWin = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          partition: partitionKey,
          preload: path.join(__dirname, 'worker-preload.js'),
          contextIsolation: false,
          nodeIntegration: false,
          webSecurity: false,
          backgroundThrottling: false
        }
      });

      // Stream worker console messages directly to IDE terminal
      workerWin.webContents.on('console-message', (event, ...rest) => {
        const message = (event && typeof event.message === 'string') ? event.message : (rest[1] || String(event || ''));
        const level = (event && typeof event.level === 'number') ? event.level : (typeof rest[0] === 'number' ? rest[0] : 0);
        // Suppress noisy third-party telemetry, font errors, chunk misses, and internal Dola site logging
        if (
          !message ||
          message.includes('font') ||
          message.includes('tea.js') ||
          message.includes('slardar') ||
          message.includes('favicon') ||
          message.includes('analytics') ||
          message.includes("Unexpected token '<'") ||
          message.includes('[object HTMLImageElement]')
        ) return;
        const levelStr = level === 3 ? 'error' : level === 2 ? 'warn' : 'info';
        termLog('WORKER-DOM', `[${account.name}] ${message}`, levelStr);
      });

      workerWin.webContents.on('render-process-gone', (e, details) => {
        if (onTelemetryLog) onTelemetryLog('error', `Worker process terminated: ${details.reason} (exit: ${details.exitCode})`);
      });

      workerWin.webContents.on('preload-error', (e, p, err) => {
        if (onTelemetryLog) onTelemetryLog('error', `[PRELOAD ERROR]: ${err}`);
      });

      workerWin.webContents.on('did-navigate', (e, url) => {
        if (url && (url.includes('/login') || url.includes('/passport'))) {
          cleanup('ACCOUNT_SESSION_EXPIRED: Redirected to login');
        }
      });

      // Prepare reference image if I2V
      let refImagePayload = null;
      if (task.referenceImage && typeof task.referenceImage === 'string' && fs.existsSync(task.referenceImage)) {
        try {
          const fileBuffer = fs.readFileSync(task.referenceImage);
          const ext = path.extname(task.referenceImage).toLowerCase().replace('.', '');
          const mimeType = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
          refImagePayload = {
            name: path.basename(task.referenceImage),
            type: mimeType,
            dataBase64: fileBuffer.toString('base64'),
            size: fileBuffer.length
          };
          if (onTelemetryLog) {
            onTelemetryLog('info', `🖼️ [I2V ATTACHED] Reference image loaded: ${refImagePayload.name} (${(refImagePayload.size / 1024).toFixed(1)} KB)`);
          }
        } catch (rErr) {
          if (onTelemetryLog) onTelemetryLog('warn', `Failed reading reference image: ${rErr.message}`);
        }
      }

      // Pure Video Generation Payload (Zdola 30s bypass mode)
      const taskPayload = {
        accountId: account.id,
        accountName: account.name,
        taskId: task.id,
        promptIndex: task.promptIndex,
        prompt: task.prompt,
        aspectRatio: task.aspectRatio || '16:9',
        duration: 30,
        referenceImage: refImagePayload
      };

      sendTask = (force = false) => {
        if (isFinished || isPromptSubmitted || !workerWin || workerWin.isDestroyed()) return;
        if (isTaskAcknowledged && !force) return;
        if (onTelemetryLog) {
          onTelemetryLog('info', `[DEBUG] Dispatching task payload #${taskPayload.promptIndex} to live Dola page...`);
        }
        workerWin.webContents.send('start-worker-task', taskPayload);
      };

      if (onTelemetryLog) {
        onTelemetryLog('info', `[DEBUG] Navigating window to https://www.dola.com/chat...`);
      }

      // 1. Await full page navigation
      try {
        await workerWin.loadURL('https://www.dola.com/chat');
      } catch (navErr) {
        if (onTelemetryLog) onTelemetryLog('warn', `[DEBUG] Navigation note: ${navErr.message}`);
      }

      // Wait until webContents is fully finished loading
      while (!isFinished && workerWin && !workerWin.isDestroyed() && workerWin.webContents.isLoading()) {
        await new Promise(r => setTimeout(r, 200));
      }

      // Wait 1.2s for React DOM hydration and toolbar buttons to mount
      await new Promise(r => setTimeout(r, 1200));
      isNavigationFinished = true;

      if (onTelemetryLog) {
        onTelemetryLog('info', `[DEBUG] Navigation completed. Current URL: ${workerWin.webContents.getURL()}`);
      }

      // 2. Dispatch task on hydrated live page
      if (!isTaskAcknowledged) {
        sendTask(true);
      }

      // 3. Retry ping until worker confirms task receipt (ACK)
      let ackRetries = 0;
      ackInterval = setInterval(() => {
        if (isFinished || isTaskAcknowledged || ackRetries >= 15) {
          if (ackInterval) clearInterval(ackInterval);
          return;
        }
        ackRetries++;
        sendTask(true);
      }, 1500);

    } catch (err) {
      cleanup(`Failed launching headless worker window: ${err.message}`);
    }
  });
}

module.exports = {
  dispatchHeadlessWorkerTask,
  stopAllHeadlessWorkers
};
