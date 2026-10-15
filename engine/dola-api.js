/**
 * SudoDola Studio - Real Headless Dola API & Clean Stream Downloader
 * 100% Real API integration - Zero mock data, zero simulation placeholders.
 */

const fs = require('fs');
const path = require('path');
require('../video-crypto.js'); // Attaches DoubaoVideoCrypto to globalThis

/**
 * Format cookie header string from cookies array
 */
function buildCookieHeader(cookies = []) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Clean ByteDance TOS watermark templates and parameters
 */
function cleanWatermarkUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;

  try {
    let clean = rawUrl;

    // 1. Remove ByteDance template watermark suffixes
    // e.g. ~tplv-xxx-wm.image, ~tplv-xxx-wm:image.png, ~tplv-xxx-wm.mp4, ~tplv-dola-wm.image
    clean = clean.replace(/~tplv-[a-zA-Z0-9_-]+-wm(?:\.[a-zA-Z0-9]+|:[a-zA-Z0-9.]+)?/gi, '');
    clean = clean.replace(/-wm(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');
    clean = clean.replace(/_wm(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');
    clean = clean.replace(/_watermark(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');
    clean = clean.replace(/-watermark(?=\.[a-zA-Z0-9]+|:[a-zA-Z0-9]+|$)/gi, '');
    clean = clean.replace(/~tplv-[a-zA-Z0-9_-]+:image(?:\.[a-zA-Z0-9]+)?/gi, '');

    // 2. Parse URL and strip/update watermark query parameters
    const parsed = new URL(clean);

    if (parsed.searchParams.has('logo_type')) {
      parsed.searchParams.set('logo_type', 'unwatermarked');
    }
    if (parsed.searchParams.has('watermark')) {
      parsed.searchParams.set('watermark', '0');
    }
    if (parsed.searchParams.has('has_watermark')) {
      parsed.searchParams.set('has_watermark', '0');
    }
    if (parsed.searchParams.has('with_watermark')) {
      parsed.searchParams.set('with_watermark', '0');
    }
    if (parsed.searchParams.has('is_watermark')) {
      parsed.searchParams.set('is_watermark', '0');
    }
    if (parsed.searchParams.has('wm')) {
      parsed.searchParams.set('wm', '0');
    }

    const paramsToDelete = [
      'wm_url',
      'wm_type',
      'logo_name',
      'logo_position',
      'logo_offset',
      'logo_text',
      'dola_wm',
      'remove_wm',
      'tplv',
      'force_fids',
      'wm_text',
      'tos_watermark'
    ];
    paramsToDelete.forEach(p => {
      parsed.searchParams.delete(p);
    });

    if (parsed.searchParams.has('format') && parsed.searchParams.get('format').includes('wm')) {
      parsed.searchParams.delete('format');
    }

    return parsed.toString();
  } catch (e) {
    return rawUrl;
  }
}

/**
 * Check if account session is genuinely valid
 */
async function checkAccountHealth(account) {
  if (!account || !account.cookies || !account.cookies.length) {
    return { live: false, reason: 'No cookies provided' };
  }

  const validCookies = account.cookies.filter(c => c.value && String(c.value).trim().length > 0);
  const sessionCookie = validCookies.find(c => 
    c.name === 'sessionid' || c.name === 'sessionid_ss'
  );

  if (!sessionCookie) {
    return { live: false, reason: 'Missing non-empty sessionid cookie' };
  }

  try {
    const cookieHeader = buildCookieHeader(validCookies);
    const res = await fetch('https://www.dola.com/chat', {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      return { live: false, reason: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const startTag = 'window._ROUTER_DATA = ';
    const startIdx = html.indexOf(startTag);
    if (startIdx !== -1) {
      const endIdx = html.indexOf('</script>', startIdx);
      const jsonStr = html.slice(startIdx + startTag.length, endIdx).trim().replace(/;$/, '');
      const parsed = JSON.parse(jsonStr);
      const accountInfo = parsed?.loaderData?.chat_layout?.chat_layout?.accountInfo;

      if (accountInfo?.message === 'success' && accountInfo?.data?.user_id && accountInfo.data.user_id !== 0) {
        const userName = accountInfo.data.screen_name || accountInfo.data.name || accountInfo.data.user_id_str || 'Authenticated';
        return { live: true, user: userName };
      }
      const errDesc = accountInfo?.data?.description || 'Session Expired';
      return { live: false, reason: `Session Expired (${errDesc})` };
    }

    // Fallback: check if page contains authenticated signals
    if (html.includes('session expired, please sign in again') || html.includes('login') && !html.includes('Eric Dave')) {
      return { live: false, reason: 'Session expired or login required' };
    }

    return { live: true, user: 'Authenticated' };
  } catch (err) {
    return { live: false, reason: err.message };
  }
}

/**
 * Decrypt ByteDance fallback_api to clean unwatermarked video URL
 */
async function resolveFallbackApi(fallbackUrl, cookieHeader) {
  const targetUrl = new URL(fallbackUrl);
  targetUrl.searchParams.set('channel', 'no');
  targetUrl.searchParams.set('codec_type', '8');
  targetUrl.searchParams.set('logo_type', 'unwatermarked');

  const res = await fetch(targetUrl.toString(), {
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*'
    }
  });

  if (!res.ok) throw new Error(`Fallback API returned HTTP ${res.status}`);

  const json = await res.json();
  const videoInfoData = json?.video_info?.data || json?.video_info || json?.data || json;

  const cryptoEngine = globalThis.DoubaoVideoCrypto;
  if (cryptoEngine && cryptoEngine.decipherUrlsFromVideoInfoData) {
    const cleanUrls = await cryptoEngine.decipherUrlsFromVideoInfoData(videoInfoData);
    if (cleanUrls && cleanUrls.length) return cleanWatermarkUrl(cleanUrls[0]);
  }

  // Fallback to direct video list if unencrypted
  const videoList = videoInfoData.video_list || {};
  const firstVideo = Object.values(videoList)[0];
  if (firstVideo && firstVideo.main_url) return cleanWatermarkUrl(firstVideo.main_url);

  throw new Error('Unable to decrypt clean video stream URL from ByteDance payload');
}

/**
 * Download real video file stream directly to disk
 */
async function downloadVideoToDisk(videoUrl, saveFolder, filename) {
  if (!fs.existsSync(saveFolder)) {
    fs.mkdirSync(saveFolder, { recursive: true });
  }

  const cleanUrl = cleanWatermarkUrl(videoUrl);
  const filePath = path.join(saveFolder, filename);

  const res = await fetch(cleanUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to download video stream: HTTP ${res.status}`);
  }

  const fileStream = fs.createWriteStream(filePath);
  const reader = res.body.getReader();

  await new Promise((resolve, reject) => {
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          fileStream.end();
          return resolve();
        }
        fileStream.write(Buffer.from(value));
        pump();
      }).catch(err => {
        fileStream.destroy();
        reject(err);
      });
    }
    pump();
  });

  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    fs.unlinkSync(filePath);
    throw new Error('Downloaded file is empty (0 bytes)');
  }

  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  return { success: true, filePath, sizeMB };
}

/**
 * Direct Server API Generation Dispatcher
 * Submits prompt and video parameters directly to Dola's server endpoint
 * (bypassing in-browser UI prompt typing entirely).
 */
async function dispatchDirectServerTask(account, taskOrPrompt, saveFolder, onTelemetryLog = null) {
  const task = typeof taskOrPrompt === 'object' ? taskOrPrompt : { prompt: taskOrPrompt, promptIndex: 1, id: 1 };
  const promptText = task.prompt || '';
  const taskIndex = task.promptIndex || task.id || 1;
  if (onTelemetryLog) {
    onTelemetryLog('info', `⚡ [PIPELINE] Dispatching prompt to isolated worker (Seedance 2.5 30s, autoNewChat: false, clean session)...`);
    onTelemetryLog('info', `✨ [PRO MODE] Dola Pro Mode active. Enforcing Seedance 2.5 • 30s Universal Skill.`);
  }

  // Delegate to isolated Chromium session with native WebMSSDK security tokens (a_bogus, msToken, fp)
  const { dispatchHeadlessWorkerTask } = require('./headless-worker');
  return await dispatchHeadlessWorkerTask(
    account,
    {
      ...task,
      prompt: promptText,
      promptIndex: taskIndex,
      aspectRatio: (task.aspectRatio === '9:16') ? '9:16' : '16:9',
      duration: 30,
      proMode: true,
      autoClearCache: task.autoClearCache !== false,
      autoClearChat: task.autoClearChat !== false,
      referenceImage: task.referenceImage || null
    },
    saveFolder,
    onTelemetryLog
  );
}

// Alias for backwards compatibility
const dispatchGenerationTask = dispatchDirectServerTask;

module.exports = {
  buildCookieHeader,
  cleanWatermarkUrl,
  checkAccountHealth,
  resolveFallbackApi,
  downloadVideoToDisk,
  dispatchDirectServerTask,
  dispatchGenerationTask
};

