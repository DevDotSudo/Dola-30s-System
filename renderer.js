/**
 * SudoDola Studio Pro v2.5 - Frontend Application Logic
 * Pure Node/Electron frontend - T2V & I2V Pro Mode
 */

document.addEventListener('DOMContentLoaded', async () => {
  // State
  let activeTab = 't2v';
  let selectedRatio = '16:9';
  let selectedImagePath = null;
  let activeLogFilter = 'all';
  let allLogs = [];

  // DOM Elements
  const tabBtnT2v = document.getElementById('tab-btn-t2v');
  const tabBtnI2v = document.getElementById('tab-btn-i2v');
  const tabBtnAccounts = document.getElementById('tab-btn-accounts');
  const paneT2v = document.getElementById('pane-t2v');
  const paneI2v = document.getElementById('pane-i2v');
  const paneAccounts = document.getElementById('pane-accounts');

  const t2vInput = document.getElementById('t2v-prompts-input');
  const btnT2vStart = document.getElementById('btn-t2v-start');
  const btnT2vClear = document.getElementById('btn-t2v-clear');

  const i2vDropzone = document.getElementById('i2v-dropzone');
  const dropzoneEmpty = document.getElementById('dropzone-empty-state');
  const dropzonePreview = document.getElementById('dropzone-preview-state');
  const i2vPreviewImg = document.getElementById('i2v-preview-img');
  const i2vFilename = document.getElementById('i2v-filename');
  const btnRemoveImage = document.getElementById('btn-remove-image');
  const i2vPromptInput = document.getElementById('i2v-prompt-input');
  const btnI2vStart = document.getElementById('btn-i2v-start');

  const btnOpenFolder = document.getElementById('btn-open-folder');
  const folderPathDisplay = document.getElementById('folder-path-display');
  const focusedAccountName = document.getElementById('focused-account-name');

  const statusHeadline = document.getElementById('status-headline');
  const statusSubline = document.getElementById('status-subline');
  const statusSpinner = document.getElementById('status-spinner');
  const metricSaved = document.getElementById('metric-saved');
  const metricQueue = document.getElementById('metric-queue');
  const metricFailed = document.getElementById('metric-failed');
  const btnQueueStop = document.getElementById('btn-queue-stop');

  const logsContainer = document.getElementById('logs-container');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const logsStatsText = document.getElementById('logs-stats-text');

  const accountsTableBody = document.getElementById('accounts-table-body');
  const badgeAccountCount = document.getElementById('badge-account-count');
  const btnLoginDola = document.getElementById('btn-login-dola');
  const btnImportCookies = document.getElementById('btn-import-cookies');

  const btnImportFile = document.getElementById('btn-import-file');

  /* ==========================================================================
     1. TAB SWITCHING & RATIO SELECTOR
     ========================================================================== */

  function switchTab(tabName) {
    activeTab = tabName;
    console.log(`[UI] Switched tab: ${tabName.toUpperCase()}`);
    [tabBtnT2v, tabBtnI2v, tabBtnAccounts].forEach(btn => btn?.classList.remove('active'));
    [paneT2v, paneI2v, paneAccounts].forEach(pane => pane?.classList.remove('active'));

    if (tabName === 't2v') {
      tabBtnT2v?.classList.add('active');
      paneT2v?.classList.add('active');
    } else if (tabName === 'i2v') {
      tabBtnI2v?.classList.add('active');
      paneI2v?.classList.add('active');
    } else if (tabName === 'accounts') {
      tabBtnAccounts?.classList.add('active');
      paneAccounts?.classList.add('active');
      refreshAccounts();
    }
  }

  tabBtnT2v?.addEventListener('click', () => switchTab('t2v'));
  tabBtnI2v?.addEventListener('click', () => switchTab('i2v'));
  tabBtnAccounts?.addEventListener('click', () => switchTab('accounts'));

  // Ratio switches (both tabs)
  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const parent = btn.parentElement;
      parent.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedRatio = btn.getAttribute('data-ratio') || '16:9';
      console.log(`[UI] Selected aspect ratio: ${selectedRatio}`);
    });
  });

  /* ==========================================================================
     2. I2V REFERENCE IMAGE PICKER & DRAG/DROP
     ========================================================================== */

  function setImage(filePath) {
    if (!filePath) return;
    selectedImagePath = filePath;
    i2vPreviewImg.src = `file://${filePath.replace(/\\/g, '/')}`;
    i2vFilename.textContent = filePath.split(/[\\/]/).pop() || 'image.png';
    dropzoneEmpty.classList.add('hidden');
    dropzonePreview.classList.remove('hidden');
  }

  function clearImage() {
    selectedImagePath = null;
    i2vPreviewImg.src = '';
    dropzonePreview.classList.add('hidden');
    dropzoneEmpty.classList.remove('hidden');
  }

  i2vDropzone?.addEventListener('click', async (e) => {
    if (e.target === btnRemoveImage || btnRemoveImage.contains(e.target)) return;
    const path = await window.electronAPI.selectImageFile();
    if (path) setImage(path);
  });

  btnRemoveImage?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearImage();
  });

  // Drag and Drop
  i2vDropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    i2vDropzone.style.borderColor = 'var(--accent-purple)';
  });

  i2vDropzone?.addEventListener('dragleave', () => {
    i2vDropzone.style.borderColor = '';
  });

  i2vDropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    i2vDropzone.style.borderColor = '';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.path) setImage(file.path);
    }
  });

  /* ==========================================================================
     3. QUEUE ACTIONS (START T2V / START I2V / STOP)
     ========================================================================== */


function parsePrompts(rawText) {
  if (!rawText || !rawText.trim()) return [];
  const text = rawText.trim();

  // 1. Explicit delimiter: --- (triple dash on its own line)
  if (/\n\s*---\s*\n/.test(text)) {
    return text.split(/\n\s*---\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 0 && !p.startsWith('#'));
  }

  // 2. Structured markdown prompt detection (headings, scene breakdown, multi-paragraph story)
  const isStructuredSinglePrompt = (
    text.includes('**') ||
    text.includes('##') ||
    /\b(SCENE|ACTION|CAMERA|LIGHTING|SUBJECT|PROMPT|ATMOSPHERE):/i.test(text)
  );

  if (isStructuredSinglePrompt) {
    return [text];
  }

  // 3. Paragraph-separated prompts (separated by double newline)
  if (text.includes('\n\n')) {
    return text.split(/\n\s*\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0 && !p.startsWith('#'));
  }

  // 4. Line-by-line fallback (simple list of one-line prompts)
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

  btnT2vStart?.addEventListener('click', async () => {
    const rawText = (t2vInput.value || '').trim();
    if (!rawText) {
      alert('Please enter at least one video prompt.');
      return;
    }

    // Smart prompt parser: preserves multi-paragraph & structured prompts intact!
    const lines = parsePrompts(rawText);
    if (lines.length === 0) return;

    console.log(`[UI] Triggered T2V generation for ${lines.length} prompt(s) (ratio: ${selectedRatio})`);
    btnT2vStart.disabled = true;
    try {
      await window.electronAPI.startQueue({
        prompts: lines,
        aspectRatio: selectedRatio,
        mode: 'pro'
      });
    } finally {
      btnT2vStart.disabled = false;
    }
  });

  btnT2vClear?.addEventListener('click', () => {
    console.log('[UI] T2V prompt input cleared');
    t2vInput.value = '';
  });

  btnI2vStart?.addEventListener('click', async () => {
    if (!selectedImagePath) {
      alert('Please attach a reference starting image for Image-to-Video.');
      return;
    }

    const motionPrompt = (i2vPromptInput.value || '').trim() || 'Dynamic cinematic motion, smooth camera movements';
    console.log(`[UI] Triggered I2V generation (image: "${selectedImagePath.split(/[\\/]/).pop()}", ratio: ${selectedRatio})`);
    btnI2vStart.disabled = true;
    try {
      await window.electronAPI.startQueue({
        prompts: [{ prompt: motionPrompt, referenceImage: selectedImagePath }],
        aspectRatio: selectedRatio,
        mode: 'pro'
      });
    } finally {
      btnI2vStart.disabled = false;
    }
  });

  btnQueueStop?.addEventListener('click', async () => {
    console.log('[UI] User requested to stop queue');
    await window.electronAPI.stopQueue();
  });

  btnOpenFolder?.addEventListener('click', () => {
    console.log('[UI] User clicked open output folder');
    window.electronAPI.openOutputFolder();
  });

  /* ==========================================================================
     4. TELEMETRY LOGS STREAM & FILTERING
     ========================================================================== */

  let userIsAtBottom = true;

  if (logsContainer) {
    logsContainer.addEventListener('scroll', () => {
      // User is at bottom if within 30px of bottom
      const distFromBottom = logsContainer.scrollHeight - logsContainer.clientHeight - logsContainer.scrollTop;
      userIsAtBottom = distFromBottom <= 30;
      if (userIsAtBottom) {
        logsStatsText.textContent = `${allLogs.length} events logged (Live)`;
      } else {
        logsStatsText.innerHTML = `${allLogs.length} events • <span style="color:var(--accent-cyan);cursor:pointer;" id="jump-to-bottom">📜 Jump to bottom</span>`;
        const jumpBtn = document.getElementById('jump-to-bottom');
        if (jumpBtn) {
          jumpBtn.onclick = () => {
            logsContainer.scrollTop = logsContainer.scrollHeight;
            userIsAtBottom = true;
            logsStatsText.textContent = `${allLogs.length} events logged (Live)`;
          };
        }
      }
    });
  }

  function renderLogEntry(entry) {
    allLogs.push(entry);
    if (allLogs.length > 500) allLogs.shift();

    const isChat = entry.message.includes('[DOLA CHAT]') || entry.message.includes('🤖 [DOLA');
    const isError = entry.type === 'error' || entry.message.includes('❌') || entry.message.includes('FAILED');

    // Filter check
    if (activeLogFilter === 'chat' && !isChat) return;
    if (activeLogFilter === 'error' && !isError) return;

    const el = document.createElement('div');
    const itemClass = isChat ? 'log-entry log-chat' : `log-entry log-${entry.type || 'info'}`;
    el.className = itemClass;

    let badgeClass = entry.type || 'info';
    let badgeText = (entry.type || 'INFO').toUpperCase();

    if (isChat) {
      badgeClass = 'chat';
      badgeText = 'DOLA';
    }

    el.innerHTML = `
      <span class="log-time">${entry.time || '00:00:00'}</span>
      <span class="log-badge ${badgeClass}">${badgeText}</span>
      <span class="log-text">${escapeHtml(entry.message)}</span>
    `;

    logsContainer.appendChild(el);

    if (userIsAtBottom) {
      logsContainer.scrollTop = logsContainer.scrollHeight;
      logsStatsText.textContent = `${allLogs.length} events logged (Live)`;
    }

    if (entry.message.includes('[ESTIMATED WAIT TIME]') || entry.message.includes('Dola estimated duration:')) {
      const match = entry.message.match(/Dola estimated duration:\s*([^(]+)/);
      if (match && statusSubline) {
        statusSubline.textContent = `⏳ Rendering on Dola GPU • ETA: ${match[1].trim()}`;
      }
    } else if (entry.message.includes('Time Remaining:') || entry.message.includes('Remaining:')) {
      const match = entry.message.match(/(?:Time Remaining:|Remaining:)\s*([^|(]+)/);
      if (match && statusSubline) {
        statusSubline.textContent = `⏳ Rendering on Dola GPU • Remaining: ${match[1].trim()}`;
      }
    } else if (entry.message.includes('[HIGH DEMAND]')) {
      if (statusSubline) statusSubline.textContent = '⚠️ Dola high demand detected • Auto-retrying in 5s...';
    } else if (entry.message.includes('[DOLA DURATION INFO]')) {
      if (statusSubline) statusSubline.textContent = '🎬 Dola 15s condensed mode • Proceeding with generation';
    } else if (entry.message.includes('[DOLA GENERATION CONFIRMED]')) {
      if (statusSubline) statusSubline.textContent = '⚡ Dola AI accepted prompt • Rendering on GPU';
    } else if (entry.message.includes('[AWAITING DOLA RESPONSE]') || entry.message.includes('[VERIFYING]')) {
      if (statusSubline) statusSubline.textContent = '⏳ Waiting for Dola AI response to ensure no errors...';
    } else if (entry.type === 'error' || entry.message.includes('❌')) {
      if (statusSubline) statusSubline.textContent = '⚠️ Dola error encountered • Handling error';
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function refilterLogs() {
    logsContainer.innerHTML = '';
    const filtered = allLogs.filter(entry => {
      if (activeLogFilter === 'chat') return entry.message.includes('[DOLA CHAT]') || entry.message.includes('🤖 [DOLA');
      if (activeLogFilter === 'error') return entry.type === 'error' || entry.message.includes('❌') || entry.message.includes('FAILED');
      return true;
    });
    filtered.forEach(entry => {
      const el = document.createElement('div');
      const isChat = entry.message.includes('[DOLA CHAT]') || entry.message.includes('🤖 [DOLA');
      let badgeClass = isChat ? 'chat' : (entry.type || 'info');
      let badgeText = isChat ? 'DOLA' : (entry.type || 'INFO').toUpperCase();
      el.className = isChat ? 'log-entry log-chat' : `log-entry log-${entry.type || 'info'}`;
      el.innerHTML = `
        <span class="log-time">${entry.time || '00:00:00'}</span>
        <span class="log-badge ${badgeClass}">${badgeText}</span>
        <span class="log-text">${escapeHtml(entry.message)}</span>
      `;
      logsContainer.appendChild(el);
    });
    logsContainer.scrollTop = logsContainer.scrollHeight;
    userIsAtBottom = true;
  }

  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeLogFilter = pill.getAttribute('data-filter') || 'all';
      refilterLogs();
    });
  });

  btnClearLogs?.addEventListener('click', () => {
    allLogs = [];
    logsContainer.innerHTML = '';
    logsStatsText.textContent = 'Logs cleared';
  });

  /* ==========================================================================
     5. STATUS & METRICS UPDATE
     ========================================================================== */

  function updateStatus(status) {
    if (!status) return;

    metricSaved.textContent = status.savedCount || 0;
    metricQueue.textContent = status.totalQueued ? `${status.promptsPosted}/${status.totalQueued}` : '0';
    metricFailed.textContent = status.failedCount || 0;

    if (status.isRunning) {
      btnQueueStop.classList.remove('hidden');
      statusSpinner.style.display = 'block';
      statusHeadline.textContent = `Generating Videos (${status.promptsPosted}/${status.totalQueued})`;
      statusSubline.textContent = `Create Videos Mode active • Rendering Seedance 2.5 30s clips via Zdola`;
    } else {
      btnQueueStop.classList.add('hidden');
      statusSpinner.style.display = 'none';
      if (status.totalQueued > 0 && status.savedCount > 0) {
        statusHeadline.textContent = `Generation Completed (${status.savedCount}/${status.totalQueued})`;
        statusSubline.textContent = `All video clips downloaded to output folder`;
      } else {
        statusHeadline.textContent = 'Ready for Video Generation';
        statusSubline.textContent = 'Select Text or Image mode and click Start';
      }
    }

    if (status.focusedAccountId) {
      focusedAccountName.textContent = `Account: ${status.focusedAccountId.slice(0, 15)}`;
    }
  }

  /* ==========================================================================
     6. ACCOUNT VAULT MANAGEMENT
     ========================================================================== */

  async function refreshAccounts() {
    const accounts = await window.electronAPI.loadAccounts();
    badgeAccountCount.textContent = accounts.length;

    if (accounts.length > 0) {
      const active = accounts.find(a => a.status === 'live');
      focusedAccountName.textContent = active ? `Active: ${active.name}` : `${accounts.length} Accounts Loaded`;
    }

    if (!accountsTableBody) return;
    if (accounts.length === 0) {
      accountsTableBody.innerHTML = `<tr><td colspan="5" class="empty-cell">No accounts found in SQLite vault. Click "📁 Import Cookie File" to add accounts.</td></tr>`;
      return;
    }

    accountsTableBody.innerHTML = accounts.map(acc => {
      const isLive = acc.status === 'live' || !acc.status;
      const cooldownText = acc.cooldownUntil && acc.cooldownUntil > Date.now()
        ? `Cooling down (${Math.round((acc.cooldownUntil - Date.now()) / 60000)}m left)`
        : 'Ready';

      return `
        <tr>
          <td><strong>${escapeHtml(acc.name)}</strong></td>
          <td><span class="badge-${isLive ? 'live' : 'dead'}">${isLive ? '● Live' : '✕ Dead'}</span></td>
          <td>${acc.savedCount || 0}</td>
          <td>${cooldownText}</td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="window.checkAccount('${acc.id}')">Test</button>
            <button class="btn btn-secondary btn-sm" onclick="window.resetAccount('${acc.id}')">Reset</button>
            <button class="btn btn-danger btn-sm" onclick="window.deleteAccount('${acc.id}')">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.checkAccount = async (id) => {
    console.log(`[UI] Testing authentication health for account ${id}`);
    const res = await window.electronAPI.checkAccountHealth(id);
    alert(`Account Health: ${res.live ? 'LIVE (Authenticated)' : 'FAILED: ' + res.reason}`);
    refreshAccounts();
  };

  window.resetAccount = async (id) => {
    console.log(`[UI] Resetting cooldown/status for account ${id}`);
    await window.electronAPI.resetAccount(id);
    refreshAccounts();
  };

  window.deleteAccount = async (id) => {
    if (confirm('Delete this account from vault?')) {
      console.log(`[UI] Deleting account ${id}`);
      await window.electronAPI.deleteAccount(id);
      refreshAccounts();
    }
  };

  btnLoginDola?.addEventListener('click', async () => {
    const origHtml = btnLoginDola.innerHTML;
    btnLoginDola.disabled = true;
    btnLoginDola.innerHTML = `<span>⏳ Logging In...</span>`;
    console.log('[UI] Opening 1-Click Login window...');

    try {
      const res = await window.electronAPI.loginDolaWindow();
      if (res.success) {
        console.log(`[UI] 1-Click Login successful: ${res.accountName} (${res.cookieCount} cookies)`);
        alert(`🎉 Successfully logged into ${res.accountName}!\n${res.cookieCount} session cookies saved and verified live!`);
        await refreshAccounts();
      } else {
        console.log(`[UI] 1-Click Login aborted or closed: ${res.reason}`);
        alert(res.reason || 'Login window closed before authentication was completed.');
      }
    } catch (err) {
      console.error(`[UI] 1-Click Login error: ${err.message}`);
      alert(`Login error: ${err.message}`);
    } finally {
      btnLoginDola.disabled = false;
      btnLoginDola.innerHTML = origHtml;
    }
  });


  btnImportFile?.addEventListener('click', async () => {
    console.log('[UI] User clicked Import Cookie File');
    try {
      const res = await window.electronAPI.importCookieFile();
      if (res && res.success) {
        console.log(`[UI] Imported file "${res.accountName}" (${res.cookieCount} cookies)`);
        alert(`🎉 Successfully imported "${res.accountName}" with ${res.cookieCount} cookies into SQLite Vault!\nTotal accounts: ${res.total}`);
        refreshAccounts();
      } else if (res && res.error) {
        console.error(`[UI] Import file failed: ${res.error}`);
        alert('Import failed: ' + res.error);
      }
    } catch (err) {
      console.error(`[UI] Import file error: ${err.message}`);
      alert('Error importing file: ' + err.message);
    }
  });

  btnImportCookies?.addEventListener('click', async () => {
    const raw = prompt('Paste cookies JSON content:');
    if (raw) {
      console.log('[UI] Pasted cookie JSON submitted for import');
      const res = await window.electronAPI.importCookies(raw);
      if (res.success) {
        console.log('[UI] Pasted cookies successfully imported');
        alert('Cookies imported successfully into SQLite Vault!');
        refreshAccounts();
      } else {
        console.error(`[UI] Pasted cookie import failed: ${res.error}`);
        alert('Import failed: ' + res.error);
      }
    }
  });

  /* ==========================================================================
     7. IPC LISTENERS
     ========================================================================== */

  window.electronAPI.onLog((entry) => renderLogEntry(entry));
  window.electronAPI.onStatus((status) => updateStatus(status));
  window.electronAPI.onAccountsUpdated(() => refreshAccounts());

  // Initial load
  await refreshAccounts();
  const initStatus = await window.electronAPI.getQueueStatus();
  updateStatus(initStatus);
});
