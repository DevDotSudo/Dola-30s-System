/**
 * SudoDola Studio Pro - High-Performance Queue Orchestrator
 * Locked to Pro Mode (Seedance 2.5 • 30s Single Clip Only)
 * Implements deterministic sticky-account focus & limit failover.
 */

const path = require('path');
const fs = require('fs');
const { loadAllAccounts, updateAccountStatus } = require('./cookies');
const { dispatchHeadlessWorkerTask, stopAllHeadlessWorkers } = require('./headless-worker');
const { termLog } = require('./terminal-logger');

const DEFAULT_SAVE_PATH = 'C:\\Users\\Davie\\Videos\\SudoDola';

class OrchestratorErrorClassifier {
  static classify(errorMessage) {
    if (!errorMessage || typeof errorMessage !== 'string') {
      return { isLimit: false, isSessionDead: false, isHighDemand: false, isRefusal: false };
    }

    const msg = errorMessage.toLowerCase();

    // 1. Quota / Pro / Credit Limits
    const isLimit = (
      msg.includes('account_limit_reached') ||
      msg.includes('pro limit') ||
      msg.includes('daily pro limit') ||
      msg.includes('pro mode limit') ||
      msg.includes('limit reached') ||
      msg.includes('quota exceeded') ||
      msg.includes('credit limit') ||
      msg.includes('0 video credits') ||
      msg.includes('insufficient credits')
    );

    // 2. Dead / Expired Session or Guest Mode
    const isSessionDead = (
      msg.includes('account_session_expired') ||
      msg.includes('redirected to login') ||
      msg.includes('session expired') ||
      msg.includes('not available for guests') ||
      msg.includes('log in to start creating') ||
      msg.includes('passport') ||
      msg.includes('http 401') ||
      msg.includes('http 403')
    );

    // 3. GPU High Demand (Capacity Full)
    const isHighDemand = (
      msg.includes('710022002') ||
      msg.includes('high demand') ||
      msg.includes('capacity full') ||
      msg.includes('gpu capacity')
    );

    // 4. Content / Safety Refusal
    const isRefusal = (
      msg.includes('copyright restriction') ||
      msg.includes('content policy') ||
      msg.includes('terms of service')
    );

    return { isLimit, isSessionDead, isHighDemand, isRefusal };
  }
}

class StudioOrchestrator {
  constructor(onLog = console.log, onStatus = () => {}) {
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.isRunning = false;
    this.isPaused = false;
    this.queue = [];
    this.totalQueued = 0;
    this.promptsPosted = 0;
    this.activeWorkers = 0;
    this.savedCount = 0;
    this.failedCount = 0;
    this.saveFolder = DEFAULT_SAVE_PATH;
    this.focusedAccountId = null; // Sticky account lock
    this.activeTasks = new Map();
    this.logs = [];

    // Ensure target output folder exists
    if (!fs.existsSync(this.saveFolder)) {
      try { fs.mkdirSync(this.saveFolder, { recursive: true }); } catch (_) {}
    }
  }

  log(type, message) {
    const timeStr = new Date().toTimeString().split(' ')[0];
    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      time: timeStr,
      timestamp: Date.now(),
      type, // 'info' | 'success' | 'warn' | 'error' | 'progress'
      message
    };

    // Determine channel for clear terminal attribution
    let channel = 'ORCH';
    if (message.includes('[DOLA CHAT]') || message.includes('🤖 [DOLA') || message.includes('💬')) {
      channel = 'DOLA';
    } else if (message.includes('[WORKER') || message.includes('[TRUSTED INPUT') || message.includes('Chromium session') || message.includes('BrowserWindow')) {
      channel = 'WORKER';
    } else if (message.includes('[VAULT') || message.includes('SQLite')) {
      channel = 'VAULT';
    }

    // Output directly to IDE terminal via termLog
    const isTicker = (type === 'progress') && (message.includes('Current Generation Time:') || message.includes('Waiting on Dola'));
    if (isTicker) {
      // Throttle tickers to once every 10 seconds to keep IDE terminal tidy yet informative
      const now = Date.now();
      if (!this._lastTickerTime || now - this._lastTickerTime >= 10000) {
        this._lastTickerTime = now;
        termLog(channel, message, type);
      }
    } else {
      termLog(channel, message, type);
    }

    this.logs.unshift(entry);
    if (this.logs.length > 500) this.logs.pop();

    this.onLog(entry);
    this.broadcastStatus();
    return entry;
  }

  broadcastStatus() {
    this.onStatus(this.getStatus());
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      totalQueued: this.totalQueued,
      promptsPosted: this.promptsPosted,
      activeWorkers: this.activeWorkers,
      savedCount: this.savedCount,
      failedCount: this.failedCount,
      pendingCount: Math.max(0, this.totalQueued - this.promptsPosted),
      focusedAccountId: this.focusedAccountId,
      saveFolder: this.saveFolder
    };
  }

  /**
   * Find unlimited account: stick to current account if healthy,
   * otherwise pick the first available unlimited account in accounts list.
   */
  findNextAvailableAccount(accounts) {
    const now = Date.now();
    const liveAccounts = accounts.filter(a => {
      const isLive = a.status === 'live' || a.status === 'untested' || !a.status;
      const isCooled = !a.cooldownUntil || a.cooldownUntil <= now;
      const hasSufficientCookies = Array.isArray(a.cookies) && a.cookies.length >= 15;
      return isLive && isCooled && hasSufficientCookies;
    });

    if (liveAccounts.length === 0) return null;

    // Prioritize accounts with the highest number of valid cookies (live Chrome imported accounts)
    liveAccounts.sort((a, b) => (b.cookies?.length || 0) - (a.cookies?.length || 0));

    // 1. If we have a focused unlimited account and it is still healthy, KEEP USING IT
    if (this.focusedAccountId) {
      const focused = liveAccounts.find(a => String(a.id) === String(this.focusedAccountId));
      if (focused) return focused;
    }

    // 2. Pick the first available live account and lock onto it
    const candidate = liveAccounts[0];
    this.focusedAccountId = candidate.id;
    this.log('info', `🎯 [ACCOUNT FOCUSED] Locked onto unlimited account "${candidate.name}". Generating consecutively here.`);
    return candidate;
  }

  async startQueue(options = {}) {
    if (this.isRunning) return;

    this.isRunning = true;
    this.isPaused = false;
    this.saveFolder = options.saveFolder || DEFAULT_SAVE_PATH;
    this.savedCount = 0;
    this.failedCount = 0;
    this.promptsPosted = 0;
    this.focusedAccountId = null;

    // Build task queue
    const prompts = Array.isArray(options.prompts) ? options.prompts : [];
    this.queue = prompts.map((p, idx) => ({
      id: `task_${Date.now()}_${idx + 1}`,
      promptIndex: idx + 1,
      prompt: typeof p === 'string' ? p : (p.prompt || ''),
      aspectRatio: options.aspectRatio === '9:16' ? '9:16' : '16:9',
      duration: 30, // Locked Pro Mode 30s
      referenceImage: p.referenceImage || options.referenceImage || null,
      mode: 'pro',
      status: 'pending'
    }));

    this.totalQueued = this.queue.length;

    this.log('info', `🚀 Started Video Queue: ${this.totalQueued} tasks. Mode: 🎬 Create Videos Mode (Zdola Seedance 2.5 • 30s Single Clip).`);
    this.log('info', `📁 Target output drive: ${this.saveFolder}`);
    this.broadcastStatus();

    this.runQueueLoop();
  }

  stopQueue() {
    this.isRunning = false;
    this.focusedAccountId = null;
    stopAllHeadlessWorkers();
    this.log('warn', '⏹ Generation queue stopped by user.');
    this.broadcastStatus();
  }

  async runQueueLoop() {
    while (this.isRunning) {
      if (this.isPaused) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // Find next pending task
      const task = this.queue.find(t => t.status === 'pending');
      if (!task) {
        this.log('success', `🎉 All ${this.totalQueued} video generation tasks finished! Total Saved: ${this.savedCount}/${this.totalQueued}`);
        this.isRunning = false;
        this.broadcastStatus();
        break;
      }

      const allAccounts = loadAllAccounts();
      const account = this.findNextAvailableAccount(allAccounts);

      if (!account) {
        this.log('error', '⚠️ [NO LIVE ACCOUNT] All accounts are expired or dead! Please click "🔑 1-Click Login Dola" in the Account Vault to log in and save a live session.');
        this.isRunning = false;
        this.broadcastStatus();
        break;
      }

      task.status = 'active';
      this.activeWorkers = 1;
      this.promptsPosted++;
      this.broadcastStatus();

      this.log('info', `🔄 [PROMPT #${task.promptIndex}/${this.totalQueued}] Dispatching on "${account.name}" (${task.aspectRatio})...`);

      try {
        const result = await dispatchHeadlessWorkerTask(
          account,
          task,
          this.saveFolder,
          (type, msg) => this.log(type, msg)
        );

        if (result && result.success) {
          task.status = 'completed';
          this.savedCount++;
          this.log('success', `✅ [PROMPT #${task.promptIndex} COMPLETE] Video saved: ${result.filename} (${result.fileSizeMB} MB)`);
        } else {
          task.status = 'failed';
          this.failedCount++;
        }
      } catch (err) {
        const classification = OrchestratorErrorClassifier.classify(err.message);

        if (classification.isLimit) {
          task.status = 'pending';
          this.promptsPosted--;
          this.log('warn', `⚠️ [LIMIT HIT] Account "${account.name}" reached its generation limit. Clearing focus and switching to next available account...`);
          const cooldown = Date.now() + (24 * 60 * 60 * 1000);
          updateAccountStatus(account.id, 'limit_reached', cooldown);
          this.focusedAccountId = null; // Clear lock so next iteration picks next unlimited account
        } else if (classification.isSessionDead) {
          task.status = 'pending';
          this.promptsPosted--;
          this.log('error', `❌ [SESSION DEAD] Account "${account.name}" session expired. Marking dead.`);
          updateAccountStatus(account.id, 'dead', 0);
          this.focusedAccountId = null;
        } else if (classification.isHighDemand) {
          task.status = 'pending';
          this.promptsPosted--;
          this.log('warn', `⚠️ [HIGH DEMAND] ByteDance GPU capacity full. Waiting 5s and retrying...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          // Automatic retry with backoff for transient issues
          task.retryCount = (task.retryCount || 0) + 1;
          if (task.retryCount <= 5) {
            task.status = 'pending';
            this.promptsPosted--;
            this.log('warn', `🔄 [AUTOPILOT RETRY] Task #${task.promptIndex} encountered transient notice ("${err.message}"). Waiting 5s to re-dispatch (Attempt ${task.retryCount}/5)...`);
            await new Promise(r => setTimeout(r, 5000));
          } else {
            task.status = 'failed';
            this.failedCount++;
            this.log('error', `❌ Task #${task.promptIndex} exceeded 5 retry attempts on "${account.name}": ${err.message}`);
          }
        }
      } finally {
        this.activeWorkers = 0;
        this.broadcastStatus();
      }

      // Small breathing delay between consecutive prompts
      if (this.isRunning) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}

module.exports = StudioOrchestrator;
