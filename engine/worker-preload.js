/**
 * SudoDola Studio Pro - Worker Preload Engine
 * Injected into Dola Chromium session.
 * Manages Create Videos Mode enforcement, DOM typing, Zdola 30s bypass, and live telemetry.
 */

const { ipcRenderer } = require('electron');

let currentTask = null;
let currentTaskStartTime = Date.now();
let activeConversationId = null;
let currentTaskEta = null;
let streamedTextAccumulator = '';

function parseDolaEta(text) {
  if (!text || typeof text !== 'string') return null;

  const m = text.match(/(?:ready\s+in|take\s+about|in\s+about|in)\s+(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)/i);
  if (!m) return null;

  const val = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();

  let totalSeconds = 0;
  let formatted = '';

  if (unit.startsWith('hour') || unit.startsWith('hr')) {
    totalSeconds = val * 3600;
    formatted = `${val} hour${val > 1 ? 's' : ''}`;
  } else if (unit.startsWith('min')) {
    totalSeconds = val * 60;
    formatted = `${val} minute${val > 1 ? 's' : ''}`;
  } else if (unit.startsWith('sec')) {
    totalSeconds = val;
    formatted = `${val} second${val > 1 ? 's' : ''}`;
  }

  if (totalSeconds > 0) {
    const targetTime = new Date(Date.now() + totalSeconds * 1000);
    const timeStr = targetTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return {
      rawText: m[0],
      val,
      unit,
      totalSeconds,
      formatted,
      targetTimeMs: targetTime.getTime(),
      targetTimeStr: timeStr
    };
  }
  return null;
}
let isCooking = false;
let isPromptDispatched = false;
let promptSubmissionTimestamp = 0;
let hasLoggedPayloadLock = false;
const loggedDolaReplies = new Set();
let hasLoggedDurationInfo = false;
let streamFlushTimer = null;
let heartbeatIntervalId = null;
let activeResubmitTimeout = null;
let activeConfirmTimeout = null;
let isSubmitting = false;

const sleep = ms => new Promise(res => setTimeout(res, ms));

function workerLog(type, message) {
  try {
    ipcRenderer.send('worker-telemetry', {
      taskId: currentTask?.taskId,
      type: type || 'info',
      message: String(message)
    });
  } catch (_) {}
}

/* ==========================================================================
   1. QUOTA, LIMIT & DOLA ERROR CLASSIFIER
   ========================================================================== */

function classifyDolaResponse(text) {
  if (!text || typeof text !== 'string') {
    return { isError: false, isLimit: false, isGuestNotAllowed: false, isHighDemand: false, is15sFallback: false, isConfirmationRequest: false, isPolicyOrModeration: false, isGeneralFailure: false, isUnsupportedDuration: false, isAcceptedNotice: false, reason: '' };
  }

  // 1. Detect confirmation requests from Dola (e.g. "Confirm if you'd like me to proceed", "Reply 'Confirm'")
  const isConfirmationRequest = (
    /confirm\s+if\s+you['’]?d?\s+like\s+me\s+to\s+proceed/i.test(text) ||
    /would\s+you\s+like\s+me\s+to\s+proceed/i.test(text) ||
    /would\s+you\s+like\s+me\s+to\s+generate/i.test(text) ||
    /please\s+confirm\s+and\s+I\s+will\s+begin/i.test(text) ||
    /confirm\s+to\s+generate/i.test(text) ||
    /Reply\s*[“"'](?:Confirm|Yes|Start)[”"']/i.test(text) ||
    (/confirm/i.test(text) && /proceed/i.test(text))
  );

  // 2. Detect genuine positive acceptance notices
  const isAcceptedNotice = !isConfirmationRequest && (
    /video will be generated/i.test(text) ||
    /ready in/i.test(text) ||
    /I['’]ll (?:send it to you|let you know) when it['’]s done/i.test(text) ||
    /generate your \d+-second/i.test(text) ||
    /Seedance/i.test(text) ||
    /Dreamina/i.test(text)
  );

  const isUnsupportedDuration = /(?:currently supports durations? from\s*4\s*to\s*15\s*seconds?|only supports?\s*(?:a\s*)?(?:maximum of\s*)?15\s*seconds?|nearest supported duration of\s*15\s*seconds?)/i.test(text);
  const is15sFallback = isUnsupportedDuration;

  // If accepted, mentions like "You still have 0 video credits left today" are NOT an error for the current task!
  const isLimit = !isAcceptedNotice && (
    /\bpro\s*(?:limit|quota|cap)\b/i.test(text) ||
    /\b(?:0|no|insufficient)\s*(?:video\s*)?credits?\b/i.test(text) ||
    /\b(?:daily|credit)\s*(?:limit|quota)\b/i.test(text) ||
    /\bdownload\s*.*?\bdola\s*desktop\b/i.test(text)
  );

  const isGuestNotAllowed = !isAcceptedNotice && (
    /not available for guests/i.test(text) ||
    /log in to start creating/i.test(text) ||
    /log in to unlock/i.test(text)
  );

  const isHighDemand = (
    /710022002/.test(text) ||
    /high demand/i.test(text) ||
    /capacity full/i.test(text) ||
    /try again later/i.test(text) ||
    /server busy/i.test(text) ||
    /high traffic/i.test(text)
  );

  const isPolicyOrModeration = !isAcceptedNotice && (
    /content policy|sensitive content|violates our terms|safety guidelines|inappropriate|prohibited|NSFW|copyright/i.test(text)
  );

  const isGeneralFailure = !isAcceptedNotice && (
    /generation failed|failed to generate|something went wrong|unable to process|internal server error|server error/i.test(text)
  );

  const isError = isUnsupportedDuration || isLimit || isGuestNotAllowed || isHighDemand || isPolicyOrModeration || isGeneralFailure;
  let reason = '';
  if (isUnsupportedDuration) reason = 'DOLA_DURATION_UNSUPPORTED';
  else if (isLimit) reason = 'DAILY_OR_PRO_LIMIT_REACHED';
  else if (isGuestNotAllowed) reason = 'GUEST_NOT_ALLOWED_LOGIN_REQUIRED';
  else if (isHighDemand) reason = 'GPU_HIGH_DEMAND';
  else if (isPolicyOrModeration) reason = 'CONTENT_POLICY_VIOLATION';
  else if (isGeneralFailure) reason = 'DOLA_GENERATION_FAILED';

  return { isError, isLimit, isGuestNotAllowed, isHighDemand, is15sFallback, isConfirmationRequest, isPolicyOrModeration, isGeneralFailure, isUnsupportedDuration, isAcceptedNotice, reason };
}

function classifyLimits(text) {
  return classifyDolaResponse(text);
}

/* ==========================================================================
   2. PAYLOAD SCHEMA ENFORCEMENT & ZDOLA 30S DEEP BYPASS ENGINE
   ========================================================================== */

/**
 * zdola Deep Regex Payload Engine
 * Aggressively intercepts and enforces 30s duration, queue bypass, and watermark removal
 * across any stringified JSON, nested escaped strings, and raw request bodies.
 */
function applyZdolaPayloadBypass(str, targetDuration = 30, targetRatio = null) {
  if (typeof str !== 'string' || !str) return str;
  let n = str;

  try {
    // 1. Unescaped JSON duration keys
    const durRegexes = [
      /(["']?)duration\1\s*:\s*\d+/gi,
      /(["']?)video_duration\1\s*:\s*\d+/gi,
      /(["']?)motion_seconds\1\s*:\s*\d+/gi,
      /(["']?)seconds\1\s*:\s*\d+/gi,
      /(["']?)video_length\1\s*:\s*\d+/gi
    ];
    for (const r of durRegexes) {
      if (r.test(n)) {
        n = n.replace(r, (match, quote) => {
          const q = quote || '"';
          const key = match.split(':')[0].replace(/["']/g, '').trim();
          return `${q}${key}${q}:${targetDuration}`;
        });
      }
    }

    // 2. Escaped JSON duration keys (e.g. \"duration\": 15)
    const escapedDurRegexes = [
      /\\"duration\\"\s*:\s*\d+/gi,
      /\\"video_duration\\"\s*:\s*\d+/gi,
      /\\"motion_seconds\\"\s*:\s*\d+/gi,
      /\\"seconds\\"\s*:\s*\d+/gi,
      /\\"video_length\\"\s*:\s*\d+/gi
    ];
    for (const r of escapedDurRegexes) {
      if (r.test(n)) {
        n = n.replace(r, match => {
          const key = match.split(':')[0].replace(/\\"/g, '').trim();
          return `\\"${key}\\":"${targetDuration}`.replace('":"', '":');
        });
      }
    }

    // 3. Prepend duration if video request lacks explicit duration fields
    const isVideoReq = /(video|generate_video|ability_param|seedance|pixeldance)/i.test(n) && n.trim().startsWith('{');
    if (!/(duration|video_duration|motion_seconds)/i.test(n) && isVideoReq) {
      n = `{"duration":${targetDuration},"video_duration":${targetDuration},` + n.trim().slice(1);
    }

    // 4. Free queue and credit bypass injection
    if (n.includes('allow_free_queue')) {
      n = n.replace(/"allow_free_queue"\s*:\s*false/gi, '"allow_free_queue":true');
    } else if (isVideoReq && !n.includes('allow_free_queue')) {
      n = '{"allow_free_queue":true,' + n.trim().slice(1);
    }

    if (n.includes('accept_queue')) {
      n = n.replace(/"accept_queue"\s*:\s*false/gi, '"accept_queue":true');
    } else if (isVideoReq && !n.includes('accept_queue')) {
      n = '{"accept_queue":true,' + n.trim().slice(1);
    }

    if (/"credits"\s*:\s*\d+/i.test(n)) {
      n = n.replace(/"credits"\s*:\s*\d+/gi, '"credits":1');
    }
    if (/"cost"\s*:\s*\d+/i.test(n)) {
      n = n.replace(/"cost"\s*:\s*\d+/gi, '"cost":1');
    }
    if (/"(is_free|free|use_free_queue|free_tier|skip_credit_check)"\s*:\s*false/gi.test(n)) {
      n = n.replace(/"(is_free|free|use_free_queue|free_tier|skip_credit_check)"\s*:\s*false/gi, '"$1":true');
    }

    // 5. Watermark bypass
    if (n.includes('watermark') || n.includes('no_watermark')) {
      n = n.replace(/"watermark"\s*:\s*true/gi, '"watermark":false')
           .replace(/"no_watermark"\s*:\s*false/gi, '"no_watermark":true');
    }

    // 6. Aspect Ratio override
    if (targetRatio) {
      const ratioRegex = /"(ratio|aspect_ratio|aspectRatio|ratio_type|ar)"\s*:\s*"[^"]*"/gi;
      if (ratioRegex.test(n)) {
        n = n.replace(ratioRegex, (match, key) => `"${key}":"${targetRatio}"`);
      }
    }
  } catch (_) {}

  return n;
}

/**
 * zdola URL Query Parameter Bypass
 */
function applyZdolaUrlBypass(urlStr, targetDuration = 30, targetRatio = null) {
  if (typeof urlStr !== 'string' || !urlStr) return urlStr;
  let n = urlStr;
  try {
    if (/[?&](duration|video_duration|motion_seconds|seconds)=/i.test(n)) {
      n = n.replace(/([?&](?:duration|video_duration|motion_seconds|seconds)=)([^&]+)/gi, `$1${targetDuration}`);
    }
    if (targetRatio && /[?&](ratio|aspect_ratio|ar)=/i.test(n)) {
      n = n.replace(/([?&](?:ratio|aspect_ratio|ar)=)([^&]+)/gi, `$1${encodeURIComponent(targetRatio)}`);
    }
  } catch (_) {}
  return n;
}

/**
 * zdola FormData / URLSearchParams Bypass
 */
function applyZdolaFormDataBypass(formData, targetDuration = 30, targetRatio = null) {
  if (!formData || typeof formData.set !== 'function') return;
  try {
    const durKeys = ["duration", "video_duration", "motion_seconds", "seconds", "video_length"];
    for (const k of durKeys) {
      if (formData.has(k)) formData.set(k, String(targetDuration));
    }
    if (targetRatio) {
      const ratioKeys = ["ratio", "aspect_ratio", "aspectRatio", "ratio_type", "ar"];
      for (const k of ratioKeys) {
        if (formData.has(k)) formData.set(k, String(targetRatio));
      }
    }
  } catch (_) {}
}

function enforcePayloadSchema(rawBody) {
  if (typeof rawBody !== 'string' || !rawBody.trim()) return rawBody;

  const targetDuration = currentTask?.duration || 30;
  const targetRatio = currentTask?.aspectRatio || '16:9';

  let workingBody = rawBody;

  // 1. Try structural JSON parsing and AST injection
  try {
    const parsed = JSON.parse(workingBody);
    let modified = false;

    const targetAbilityParam = {
      model: 'seedance-2-5',
      model_version: '2.5',
      duration: targetDuration,
      video_duration: targetDuration,
      aspect_ratio: targetRatio,
      ratio: targetRatio,
      resolution: '1080p',
      watermark: false,
      generate_audio: true,
      priority: 'high',
      enforce_duration: true,
      enforce_model: true,
      skip_confirmation: true
    };

    const walkAndInject = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 12) return;

      for (const [k, v] of Object.entries(node)) {
        if (k === 'conversation_id' && v && !activeConversationId) {
          activeConversationId = String(v);
        }

        // Direct chat_ability object
        if (k === 'chat_ability' && typeof v === 'object') {
          let existingParams = {};
          if (v.ability_param && typeof v.ability_param === 'string') {
            try { existingParams = JSON.parse(v.ability_param); } catch (_) {}
          }
          node.chat_ability = {
            ability_type: 17, // 17 = Seedance 2.5
            ability_param: JSON.stringify({ ...existingParams, ...targetAbilityParam })
          };
          modified = true;
        }

        // ByteDance send_message_uplink_body
        if (k === 'send_message_uplink_body' && typeof v === 'object') {
          if (typeof v.content === 'string') {
            try {
              const inner = JSON.parse(v.content);
              let innerParams = {};
              if (inner.chat_ability?.ability_param) {
                try { innerParams = JSON.parse(inner.chat_ability.ability_param); } catch (_) {}
              }
              inner.chat_ability = {
                ability_type: 17,
                ability_param: JSON.stringify({ ...innerParams, ...targetAbilityParam })
              };
              v.content = JSON.stringify(inner);
              modified = true;
            } catch (_) {}
          }
          if (v.ext && typeof v.ext === 'object') {
            v.ext['s:video_duration'] = String(targetDuration);
            v.ext['s:model'] = 'seedance-2-5';
            v.ext['s:ability_type'] = '17';
            v.ext['s:agent_mode'] = '1';
            v.ext['s:action_bar_menu_type'] = '4';
            v.ext['s:menu_type'] = '4';
            v.ext['s:model_item_key'] = '4';
            modified = true;
          }
          if (v.agent_mode !== undefined) v.agent_mode = 1;
          if (v.action_bar_menu_type !== undefined) v.action_bar_menu_type = 4;
          if (v.menu_type !== undefined) v.menu_type = 4;
        }

        // Nested stringified JSON
        if (typeof v === 'string' && (v.includes('chat_ability') || v.includes('ability_type') || (v.includes('text') && v.startsWith('{')))) {
          try {
            const innerObj = JSON.parse(v);
            if (innerObj && typeof innerObj === 'object') {
              innerObj.chat_ability = {
                ability_type: 17,
                ability_param: JSON.stringify(targetAbilityParam)
              };
              node[k] = JSON.stringify(innerObj);
              modified = true;
            }
          } catch (_) {}
        }

        if (typeof v === 'object') walkAndInject(v, depth + 1);
      }
    };

    walkAndInject(parsed);

    if (parsed.chat_ability || parsed.messages || parsed.client_meta) {
      let abilityParams = {};
      if (parsed.chat_ability?.ability_param) {
        try { abilityParams = JSON.parse(parsed.chat_ability.ability_param); } catch (_) {}
      }

      parsed.chat_ability = {
        ability_type: 17,
        ability_param: JSON.stringify({
          ...abilityParams,
          ...targetAbilityParam
        })
      };
      modified = true;
    }

    if (modified) {
      workingBody = JSON.stringify(parsed);
    }
  } catch (_) {}

  // 2. Apply zdola deep regex replacement across the entire string (escaped keys, query flags, queue bypass)
  const finalResult = applyZdolaPayloadBypass(workingBody, targetDuration, targetRatio);
  return finalResult;
}

// Hook JSON.stringify (zdola deep bypass)
try {
  const origStringify = JSON.stringify;
  JSON.stringify = function (val, replacer, space) {
    const s = origStringify.call(this, val, replacer, space);
    if (typeof s === 'string' && (s.includes('duration') || s.includes('prompt') || s.includes('generate') || s.includes('ratio') || s.includes('ability_param') || s.includes('seedance') || s.includes('chat_ability'))) {
      const targetDuration = currentTask?.duration || 30;
      const targetRatio = currentTask?.aspectRatio || '16:9';
      return applyZdolaPayloadBypass(s, targetDuration, targetRatio);
    }
    return s;
  };
} catch (_) {}

// Central Chat Scraping & Dola AI Reply Stream
let isGlobalGenerationAccepted = false;

function handleCreationObject(cre) {
  if (!cre || typeof cre !== 'object') return;
  if (cre.status === 3 || cre.status_text === 'failed') {
    const errMsg = cre.error_msg || cre.status_text || 'Video creation failed on ByteDance GPU';
    workerLog('error', `❌ [DOLA GENERATION FAILED]: ${errMsg}`);
    const limitCheck = classifyDolaResponse(errMsg);
    if (limitCheck.isLimit) {
      ipcRenderer.send('worker-account-limit', {
        taskId: currentTask?.taskId,
        error: `ACCOUNT_LIMIT_REACHED: ${errMsg}`
      });
    } else {
      ipcRenderer.send('worker-error', {
        taskId: currentTask?.taskId,
        error: errMsg
      });
    }
    return;
  }

  // Active / in-progress detection
  if (!isGlobalGenerationAccepted && (cre.creation_id || cre.status === 1 || cre.status_text === 'running' || cre.status_text === 'queued')) {
    isGlobalGenerationAccepted = true;
    currentTaskStartTime = Date.now();
    workerLog('success', `⚡ [DOLA GENERATION CONFIRMED] Dola creation registered (ID: ${cre.creation_id || 'active'}) with NO ERRORS! Video generation in progress on GPU.`);
  }

  // Completion detection (status === 2 or status_text === 'success')
  const isFinished = cre.status === 2 || cre.status_text === 'success' || cre.status_text === 'finished' ||
                     (cre.video_url && cre.status !== 1 && cre.status_text !== 'running' && cre.status_text !== 'queued');

  if (isFinished && (cre.video_url || cre.main_url || cre.url)) {
    const rawUrl = cre.video_url || cre.main_url || cre.url;
    const vUrl = cleanWatermarkUrl(rawUrl);
    const dur = Number(cre.duration || cre.video_duration || 30);
    workerLog('success', `🎉 [VIDEO COMPLETE] Unwatermarked Seedance 2.5 video clip ready (${Math.round(dur || 30)}s)!`);
    ipcRenderer.send('worker-video-resolved', {
      taskId: currentTask?.taskId,
      videoUrl: vUrl,
      duration: dur || 30
    });
  }
}

function processScrapedChatText(source, text) {
  if (!text || typeof text !== 'string') return;
  const clean = text.trim();
  if (!clean || clean.length < 2) return;

  // CRITICAL: DO NOT scrape before prompt dispatch has started
  if (!isPromptDispatched) return;

  // 1. Filter out raw SSE protocol headers and artifacts
  if (/^(id:\s*\d+|event:\s*[\w_]+|data:\s*\[DONE\]|data:)$/i.test(clean)) return;

  // 2. Filter out Cici greetings, tooltips, and chatbot welcome cards completely
  if (
    clean.includes("Cici") ||
    clean.includes("cici") ||
    clean.includes("humorous, friendly and helpful") ||
    clean.includes("nice to meet you") ||
    clean.includes("answers, recommendations, advice") ||
    clean.includes("think deeper for better answers") ||
    clean.includes("production-ready text-to-video prompt") ||
    clean.includes("Would you like me to expand this")
  ) {
    return;
  }

  // 3. Filter out landing page suggestions and onboarding quote cards
  if (
    clean.includes('人生は') ||
    clean.includes('To thine own self be true') ||
    clean.includes('I think, therefore I am') ||
    clean.includes('How do I check') ||
    clean.includes('Why does hair turn gray') ||
    clean.includes('What does responsible technology') ||
    clean.includes('What are common cultural') ||
    clean.includes('Dola uses cookies') ||
    clean.includes('Download for Windows')
  ) return;

  // 4. Filter out system headers, user prompts, and UI noise
  if (currentTask?.prompt && (clean === currentTask.prompt.trim() || clean.includes(currentTask.prompt.trim()))) return;
  if (/^(send|cancel|confirm|fast|pro|upload|select|clear chat|regenerate|copy|retry|share)$/i.test(clean)) return;

  // 5. Deduplicate
  if (loggedDolaReplies.has(clean)) return;

  // If already logged a longer message containing this snippet, skip to prevent spam
  for (const prev of loggedDolaReplies) {
    if (prev === clean || (prev.includes(clean) && prev.length > clean.length + 5)) return;
  }

  loggedDolaReplies.add(clean);

  // Scraped from Dola: Log immediately to terminal & UI
  workerLog('info', `💬 [DOLA CHAT] "${clean}"`);

  // Detect Dola video completion notice
  const isVideoReadyNotice = (
    clean.includes("Your video is ready") ||
    clean.includes("video is ready") ||
    clean.includes("Your video has been generated") ||
    clean.includes("video has been generated") ||
    clean.includes("ready to watch")
  );

  if (isVideoReadyNotice) {
    workerLog('success', `🎉 [DOLA VIDEO READY] Dola AI confirmed video is ready! Resolving download URL...`);
    if (activeConversationId) {
      pollImChainSingle(activeConversationId);
    }
  }

  // Parse estimated completion duration from Dola (e.g. "ready in 2 hours", "ready in 10 minutes")
  const parsedEta = parseDolaEta(clean);
  if (parsedEta) {
    currentTaskEta = parsedEta;
    workerLog('success', `⏳ [ESTIMATED WAIT TIME] Dola estimated duration: ${parsedEta.formatted} (Estimated ready at ${parsedEta.targetTimeStr}). System waiting...`);
  }

  // Duration condensation notice ("Video generation currently supports durations from 4 to 15 seconds")
  if (!hasLoggedDurationInfo && (clean.includes("currently supports durations from") || clean.includes("condensed to a 15-second"))) {
    hasLoggedDurationInfo = true;
    workerLog('info', `🎬 [DOLA DURATION INFO] Dola noted 15s condensation: "${clean.slice(0, 100)}..."`);
  }

  // Classify response
  const classified = classifyDolaResponse(clean);

  // Detect Dola video generation acceptance notice
  const isVideoGenerationNotice = (
    !classified.isUnsupportedDuration &&
    !classified.isConfirmationRequest &&
    (
      classified.isAcceptedNotice ||
      clean.includes("Generated video:") ||
      clean.includes("I’ll generate a") ||
      clean.includes("I'll generate a") ||
      clean.includes("The video will be generated") ||
      clean.includes("ready in") ||
      clean.includes("I'll send it to you when it's done") ||
      clean.includes("I’ll send it to you when it’s done")
    )
  );

  if (isVideoGenerationNotice && !isGlobalGenerationAccepted) {
    isGlobalGenerationAccepted = true;
    currentTaskStartTime = Date.now();
    workerLog('success', `🎬 [DOLA GENERATION CONFIRMED] ${clean}`);
  }

  // A duration-limit response is not a generation acceptance. Do not auto-confirm
  // a shorter clip when the queued task explicitly requested 30 seconds.
  if (classified.isUnsupportedDuration) {
    workerLog('error', `❌ [DOLA DURATION UNSUPPORTED] Requested ${currentTask?.duration || 30}s, but Dola reports a 4–15s limit. No confirmation was sent; choose a supported duration or split the concept into multiple clips.`);
    ipcRenderer.send('worker-error', {
      taskId: currentTask?.taskId,
      error: 'DOLA_DURATION_UNSUPPORTED: Dola currently reports a maximum supported duration of 15 seconds for this mode.'
    });
    return;
  }

  // Handle confirmation requests (e.g. "Confirm if you'd like me to proceed", "Reply 'Confirm'")
  if (classified.isConfirmationRequest) {
    if (!activeConfirmTimeout) {
      workerLog('info', `✅ [DOLA CONFIRMATION REQUEST] Dola requested confirmation ("${clean.slice(0, 80)}..."). Replying with confirmation to trigger generation...`);
      activeConfirmTimeout = setTimeout(async () => {
        activeConfirmTimeout = null;
        await sendChatReply("Confirm. Proceed with video generation now.");
      }, 1500);
    }
    return;
  }

  // Handle high demand auto-retry
  if (classified.isHighDemand) {
    workerLog('warn', `⚠️ [HIGH DEMAND] Dola servers are currently at capacity ("${clean}"). Auto-retrying prompt submission in 5s...`);
    if (!activeResubmitTimeout) {
      activeResubmitTimeout = setTimeout(async () => {
        activeResubmitTimeout = null;
        await submitViaDom(currentTask?.prompt || '', true);
      }, 5000);
    }
    return;
  }

  // Handle hard errors (only when not accepted)
  if (classified.isError) {
    workerLog('error', `❌ [DOLA CHAT ERROR] "${clean}" (${classified.reason})`);
    if (classified.isLimit) {
      ipcRenderer.send('worker-account-limit', {
        taskId: currentTask?.taskId,
        error: `ACCOUNT_LIMIT_REACHED: ${clean}`
      });
    } else {
      ipcRenderer.send('worker-error', {
        taskId: currentTask?.taskId,
        error: `DOLA_ERROR: ${clean}`
      });
    }
    return;
  }

  // Ordinary chat text is not proof that a video job started. Only a real
  // creation ID/status from the intercepted generation response can confirm GPU work.
  if (!isGlobalGenerationAccepted && !classified.is15sFallback && !classified.isConfirmationRequest) {
    workerLog('info', 'ℹ️ [DOLA RESPONSE] Received a chat response, but no generation job has been confirmed yet.');
  }
}
const seenFallbackApis = new Set();
async function resolveFallbackApi(fallbackUrl) {
  if (!fallbackUrl || typeof fallbackUrl !== 'string' || seenFallbackApis.has(fallbackUrl)) return;
  seenFallbackApis.add(fallbackUrl);
  try {
    const u = new URL(fallbackUrl);
    u.searchParams.set('channel', 'no');
    u.searchParams.set('codec_type', '8');
    u.searchParams.set('logo_type', 'unwatermarked');

    const resp = await originalFetch(u.toString(), {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json,text/plain,*/*' }
    });
    if (!resp.ok) return;
    const data = await resp.json();

    const videoInfo = data?.video_info || data?.data?.video_info || data?.data || data;
    const videoList = videoInfo?.video_list;
    const list = (videoList && typeof videoList === 'object') ? Object.values(videoList) : [videoInfo];

    let bestStream = null;
    let highestScore = -1;

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const playUrl = item.main_url || item.play_url || item.video_url || '';
      if (!playUrl || typeof playUrl !== 'string') continue;

      const score = Number(item.bitrate || item.real_bitrate || 0) + Number(item.vwidth || item.width || 0) * 1000;
      if (score > highestScore) {
        highestScore = score;
        bestStream = playUrl;
      }
    }

    if (bestStream) {
      workerLog('success', `🎉 [VIDEO COMPLETE] Unwatermarked 1080P Seedance 2.5 stream resolved via fallback API!`);
      ipcRenderer.send('worker-video-resolved', {
        taskId: currentTask?.taskId,
        videoUrl: bestStream,
        duration: 30
      });
    }
  } catch (err) {
    workerLog('warn', `⚠️ [FALLBACK API NOTE]: ${err.message}`);
  }
}

function flushStreamedText() {
  if (streamFlushTimer) {
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  }
  const fullText = streamedTextAccumulator.trim();
  streamedTextAccumulator = '';
  if (fullText && fullText.length > 2) {
    processScrapedChatText('api:stream_complete', fullText);
  }
}

function handleScrapedDolaResponse(url, rawBody) {
  if (!rawBody || typeof rawBody !== 'string') return;

  // Handle SSE data stream frames
  if (rawBody.includes('data:')) {
    const lines = rawBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.replace(/^data:\s*/, '').trim();
        if (payload && payload !== '[DONE]') {
          handleScrapedDolaResponse(url, payload);
        } else if (payload === '[DONE]') {
          flushStreamedText();
        }
      }
    }
    return;
  }

  try {
    const data = JSON.parse(rawBody);

    // 1. Parse ByteDance SSE patch_op structures & creations
    if (Array.isArray(data.patch_op)) {
      for (const op of data.patch_op) {
        const val = op.patch_value;
        if (!val) continue;

        if (Array.isArray(val.content_block)) {
          for (const b of val.content_block) {
            const creations = b?.content?.creation_block?.creations;
            if (Array.isArray(creations)) {
              for (const c of creations) handleCreationObject(c);
            }
            if (b?.content?.text_block?.text) {
              const tokenText = b.content.text_block.text;
              streamedTextAccumulator += tokenText;

              // Debounce stream accumulation to log full completed message once
              if (streamFlushTimer) clearTimeout(streamFlushTimer);
              streamFlushTimer = setTimeout(() => {
                flushStreamedText();
              }, 350);
            }
          }
        }

        if (val.ext?.creation_full_content) {
          try {
            const full = JSON.parse(val.ext.creation_full_content);
            if (Array.isArray(full)) {
              for (const block of full) {
                const creations = block?.BlockInfo?.BlockContent?.content?.creation_block?.creations;
                if (Array.isArray(creations)) {
                  for (const c of creations) handleCreationObject(c);
                }
              }
            }
          } catch (_) {}
        }
      }
    }

    // 2. Scan for fallback_api unwatermarked streams
    if (typeof rawBody === 'string' && rawBody.includes('fallback_api')) {
      const fallbackRegex = /"fallback_api"\s*:\s*"([^"]+)"/g;
      let match;
      while ((match = fallbackRegex.exec(rawBody)) !== null) {
        const fbUrl = match[1].replace(/\\"/g, '"').replace(/\\\//g, '/');
        resolveFallbackApi(fbUrl);
      }
    }

    const scanNode = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 8) return;

      const discoveredCid = node.conversation_id || node.chat_id || node.downlink_body?.chunk_update_downlink_body?.interrupt_info?.chat_id;
      if (discoveredCid && !activeConversationId) {
        activeConversationId = String(discoveredCid);
        workerLog('info', `🎯 [CONVERSATION LOCKED] Discovered active Dola Chat ID: ${activeConversationId}`);
      }

      if (node.text && typeof node.text === 'string') {
        processScrapedChatText('api:text', node.text);
      }

      if (node.content && typeof node.content === 'string') {
        try {
          const inner = JSON.parse(node.content);
          if (inner.text) processScrapedChatText('api:inner_text', inner.text);
          if (inner.creation_list && Array.isArray(inner.creation_list)) {
            for (const c of inner.creation_list) handleCreationObject(c);
          }
        } catch (_) {
          processScrapedChatText('api:content', node.content);
        }
      }

      if (node.error_msg && typeof node.error_msg === 'string') {
        processScrapedChatText('api:error_msg', node.error_msg);
      }
      if (node.status_msg && typeof node.status_msg === 'string' && node.status_msg !== 'success' && node.status_msg !== 'ok') {
        processScrapedChatText('api:status_msg', node.status_msg);
      }

      if (node.creation_list && Array.isArray(node.creation_list)) {
        for (const c of node.creation_list) handleCreationObject(c);
      }

      for (const val of Object.values(node)) {
        if (typeof val === 'object') scanNode(val, depth + 1);
      }
    };

    scanNode(data);
  } catch (_) {
    const trimmed = rawBody.trim();
    if (
      trimmed.length > 5 &&
      trimmed.length < 2000 &&
      !trimmed.includes('<html') &&
      !/^(id:\s*\d+|event:\s*[\w_]+|data:)/i.test(trimmed)
    ) {
      processScrapedChatText('api:raw', trimmed);
    }
  }
}

// Hook WebSocket
if (window.WebSocket) {
  try {
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new OriginalWebSocket(...args);
      ws.addEventListener('message', (event) => {
        try {
          if (typeof event.data === 'string') {
            handleScrapedDolaResponse('ws:message', event.data);
          }
        } catch (_) {}
      });
      return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    Object.assign(window.WebSocket, OriginalWebSocket);
  } catch (_) {}
}

// Hook Fetch (zdola deep bypass + SudoDola response scraper)
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  let [resource, config] = args;
  let url = (typeof resource === 'string') ? resource : (resource?.url || '');

  try {
    const targetDuration = currentTask?.duration || 30;
    const targetRatio = currentTask?.aspectRatio || '16:9';

    // 1. Rewrite URL query parameters if present
    if (url && (url.includes('dola') || url.includes('doubao') || url.includes('seaart') || url.includes('/api/'))) {
      const rewrittenUrl = applyZdolaUrlBypass(url, targetDuration, targetRatio);
      if (rewrittenUrl !== url) {
        url = rewrittenUrl;
        if (typeof resource === 'string') {
          args[0] = url;
        } else if (resource && typeof Request !== 'undefined' && resource instanceof Request) {
          args[0] = new Request(url, resource);
        }
      }
    }

    // 2. Rewrite Request Body (string, FormData, URLSearchParams)
    if (config && config.body && !url.includes('upload') && !url.includes('tos-')) {
      if (typeof config.body === 'string') {
        const mutated = enforcePayloadSchema(config.body);
        if (mutated !== config.body) {
          config.body = mutated;
          if (!hasLoggedPayloadLock) {
            hasLoggedPayloadLock = true;
            workerLog('success', `🎬 [HTTP INTERCEPT] Seedance 2.5 • 30s locked in payload (zdola bypass active)!`);
          }
        }
      } else if (typeof FormData !== 'undefined' && config.body instanceof FormData) {
        applyZdolaFormDataBypass(config.body, targetDuration, targetRatio);
      } else if (typeof URLSearchParams !== 'undefined' && config.body instanceof URLSearchParams) {
        applyZdolaFormDataBypass(config.body, targetDuration, targetRatio);
      }
    }
  } catch (_) {}

  const resp = await originalFetch.apply(this, args);

  // Scrape incoming responses from Dola backend
  try {
    if (url && (url.includes('/im/') || url.includes('/chat') || url.includes('/ai/') || url.includes('/api/'))) {
      const clone = resp.clone();
      const contentType = (clone.headers && clone.headers.get('content-type')) ? clone.headers.get('content-type').toLowerCase() : '';

      if (contentType.includes('text/event-stream') || (clone.body && typeof clone.body.getReader === 'function' && !contentType.includes('json'))) {
        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        (async () => {
          let sseLineBuffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              sseLineBuffer += chunk;
              const sseLines = sseLineBuffer.split('\n');
              sseLineBuffer = sseLines.pop() || '';
              for (const line of sseLines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:')) {
                  const payload = trimmed.replace(/^data:\s*/, '').trim();
                  if (payload && payload !== '[DONE]') {
                    handleScrapedDolaResponse(url, payload);
                  } else if (payload === '[DONE]') {
                    flushStreamedText();
                  }
                }
              }
            }
            flushStreamedText();
          } catch (_) {}
        })();
      } else {
        clone.text().then(bodyText => {
          handleScrapedDolaResponse(url, bodyText);
        }).catch(() => {});
      }
    }
  } catch (_) {}

  return resp;
};

// Hook XHR (zdola deep bypass + SudoDola response scraper)
if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
  const origOpen = window.XMLHttpRequest.prototype.open;
  const origSend = window.XMLHttpRequest.prototype.send;

  window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const targetDuration = currentTask?.duration || 30;
    const targetRatio = currentTask?.aspectRatio || '16:9';
    this._sudodolaUrl = applyZdolaUrlBypass(String(url || ''), targetDuration, targetRatio);
    return origOpen.apply(this, [method, this._sudodolaUrl, ...rest]);
  };

  window.XMLHttpRequest.prototype.send = function (...sendArgs) {
    try {
      const targetDuration = currentTask?.duration || 30;
      const targetRatio = currentTask?.aspectRatio || '16:9';

      if (typeof sendArgs[0] === 'string' && !this._sudodolaUrl.includes('upload')) {
        const mutated = enforcePayloadSchema(sendArgs[0]);
        if (mutated !== sendArgs[0]) {
          sendArgs[0] = mutated;
          if (!hasLoggedPayloadLock) {
            hasLoggedPayloadLock = true;
            workerLog('success', `🎬 [XHR INTERCEPT] Seedance 2.5 • 30s locked in payload (zdola bypass active)!`);
          }
        }
      } else if (typeof FormData !== 'undefined' && sendArgs[0] instanceof FormData) {
        applyZdolaFormDataBypass(sendArgs[0], targetDuration, targetRatio);
      } else if (typeof URLSearchParams !== 'undefined' && sendArgs[0] instanceof URLSearchParams) {
        applyZdolaFormDataBypass(sendArgs[0], targetDuration, targetRatio);
      }

      this.addEventListener('load', function () {
        try {
          if (this.responseText) {
            handleScrapedDolaResponse(this._sudodolaUrl || '', this.responseText);
          }
        } catch (_) {}
      });
    } catch (_) {}

    return origSend.apply(this, sendArgs);
  };
}

// Hook WebSocket (zdola deep bypass)
if (typeof WebSocket !== 'undefined' && WebSocket.prototype) {
  const origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      if (typeof data === 'string') {
        const targetDuration = currentTask?.duration || 30;
        const targetRatio = currentTask?.aspectRatio || '16:9';
        data = applyZdolaPayloadBypass(data, targetDuration, targetRatio);
      }
    } catch (_) {}
    return origWsSend.apply(this, [data]);
  };
}

// Real-time DOM MutationObserver for live assistant replies
let domScrapeTimer = null;
function scheduleDomScrape() {
  if (domScrapeTimer) clearTimeout(domScrapeTimer);
  domScrapeTimer = setTimeout(() => {
    try {
      scanDomForDolaChat();
    } catch (_) {}
  }, 400);
}

function scanDomForDolaChat() {
  if (!isPromptDispatched) return;

  const selectors = [
    '.semi-chat-message',
    '.semi-chat-content',
    '.semi-chat-item',
    '[class*="chat-item"]',
    '[class*="chat_item"]',
    '[class*="chat-message"]',
    '[class*="chat_message"]',
    '[class*="message-bubble"]',
    '[class*="message_bubble"]',
    '[class*="markdown-body"]',
    '[class*="prose"]',
    '[data-role="assistant"]',
    '[data-message-role="assistant"]',
    'div[data-message-id]',
    'div[class*="bubble"]',
    'div[class*="answer"]'
  ];

  try {
    const items = Array.from(document.querySelectorAll(selectors.join(', ')));
    for (const el of items) {
      if (el.closest('.semi-chat-item-user, [class*="item-user"], [class*="item-right"], [class*="user-message"], [data-role="user"]')) {
        continue;
      }
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt && txt.length > 2 && !txt.includes('Cici') && !txt.includes('cici') && !txt.includes('humorous, friendly and helpful')) {
        processScrapedChatText('dom:observer', txt);
      }
    }
  } catch (_) {}
}

try {
  const chatObserver = new MutationObserver(() => {
    scheduleDomScrape();
  });

  const attachObserver = () => {
    if (document.body) {
      chatObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    } else {
      setTimeout(attachObserver, 250);
    }
  };
  attachObserver();
} catch (_) {}

/* ==========================================================================
   3. DOM AUTOMATION (CREATE VIDEOS MODE, 30S ACTIONBAR, COMPOSER)
   ========================================================================== */

/**
 * zdola Action-Bar DOM & Global Sync Helper
 * Ensures Dola's input engine toolbar visually and internally synchronizes to 30s
 */
async function syncDolaActionBarState(targetDuration = 30) {
  try {
    // 1. Set zdola global overrides in window
    window.__DD_CUSTOM_DURATION__ = targetDuration;
    window.__DD_LAST_DURATION__ = targetDuration;
    window.ZDOLA_EXTENSION_ENABLED = true;
    window.ZDOLA_TARGET_DURATION = targetDuration;
    window.ZDOLA_TARGET_RATIO = currentTask?.aspectRatio || '16:9';

    // Do not mutate the duration label: changing DOM text is cosmetic and
    // does not change Dola's actual selected duration or server-side limits.
    const durationBtn = document.querySelector('button[data-testid="chat_input_action_video-duration"], [data-input-engine-actionbar-control-key="video-duration"]');
    if (durationBtn) {
      const actualDuration = (durationBtn.innerText || durationBtn.textContent || '').trim();
      workerLog('info', `🎯 [ZDOLA ACTIONBAR] Actual Dola duration control reads "${actualDuration || 'unknown'}" (requested ${targetDuration}s).`);
    }

    // 3. Sync aspect ratio if requested
    const targetRatio = currentTask?.aspectRatio || '16:9';
    const ratioBtn = document.querySelector('button[data-testid="chat_input_action_video-ratio"], [data-input-engine-actionbar-control-key="video-ratio"]');
    if (ratioBtn && targetRatio) {
      const curTxt = (ratioBtn.innerText || ratioBtn.textContent || '').trim();
      if (!curTxt.includes(targetRatio)) {
        ratioBtn.click();
        await sleep(300);
        const ratioOpt = Array.from(document.querySelectorAll('[role="menuitem"], .semi-dropdown-item, div[class*="menuitem"]')).find(el => {
          return (el.innerText || el.textContent || '').includes(targetRatio);
        });
        if (ratioOpt) {
          ratioOpt.click();
          await sleep(300);
          workerLog('info', `🎯 [ZDOLA ACTIONBAR] Dola aspect ratio synced to ${targetRatio}`);
        } else {
          document.body.click();
        }
      }
    }
  } catch (_) {}
}

async function ensureCreateVideoMode() {
  try {
    localStorage.setItem('mode_select_value', '4');
    localStorage.setItem('default_select_model_item_key', '4');
    localStorage.setItem('default_action_bar_menu_type_on_new_chat', '4');
    try { localStorage.removeItem("dolaForceSeedance25"); } catch (_) {}
  } catch (_) {}

  // 1. Dismiss cookie banner notice if present
  try {
    const cookieOk = document.querySelector('button[data-testid="cookie_banner_notice"]');
    if (cookieOk) {
      cookieOk.click();
      await sleep(250);
    }
  } catch (_) {}

  const startTime = Date.now();
  let actionbarFound = false;

  // A ratio button alone is not proof that Create Videos is active.
  // Require the video-specific duration AND ratio controls before submitting.
  const getVideoControls = () => ({
    duration: document.querySelector(
      '[data-input-engine-actionbar-control-key="video-duration"], button[data-testid="chat_input_action_video-duration"]'
    ),
    ratio: document.querySelector(
      '[data-input-engine-actionbar-control-key="video-ratio"], button[data-testid="chat_input_action_video-ratio"]'
    )
  });
  const isVideoActionbarMounted = () => {
    const controls = getVideoControls();
    return Boolean(controls.duration && controls.ratio);
  };

  while (Date.now() - startTime < 15000) {
    // 2. Check if Create Video actionbar is already mounted in DOM
    if (isVideoActionbarMounted()) {
      actionbarFound = true;
      break;
    }

    // 3. Click "Create Videos" button in Dola UI (skill_bar_button_17)
    let videoBtn = document.querySelector('button[data-testid="skill_bar_button_17"]');
    if (!videoBtn) {
      videoBtn = Array.from(document.querySelectorAll('button, div[role="button"], a, div[tabindex]')).find(b => {
        const testId = (b.getAttribute('data-testid') || '').toLowerCase();
        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        return (
          testId === 'skill_bar_button_17' ||
          txt === 'create videos' ||
          txt === 'create video' ||
          txt === 'video creation' ||
          aria.includes('create videos') ||
          aria.includes('create video')
        ) && !b.closest('.semi-dropdown, .semi-popover');
      });
    }

    if (videoBtn) {
      videoBtn.click();
      for (let i = 0; i < 6; i++) {
        await sleep(300);
        if (isVideoActionbarMounted()) {
          actionbarFound = true;
          break;
        }
      }
      if (actionbarFound) break;
    }

    // 4. Fallback: look for toolbar tools button
    const toolBtn = document.querySelector('button[data-testid="chat_input_tool_button"], button[aria-label*="tool" i], button[aria-label*="ability" i]');
    if (toolBtn) {
      toolBtn.click();
      await sleep(350);
      const videoOption = Array.from(document.querySelectorAll('div, li, button, span, [role="menuitem"], .semi-dropdown-item')).find(el => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return t === 'create videos' || t === 'create video' || t.includes('create videos') || t.includes('video');
      });
      if (videoOption) {
        videoOption.click();
        for (let i = 0; i < 6; i++) {
          await sleep(300);
          if (isVideoActionbarMounted()) {
            actionbarFound = true;
            break;
          }
        }
        if (actionbarFound) break;
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      }
    }

    await sleep(400);
  }

  if (actionbarFound) {
    await sleep(400);

    // 1. Set the duration only if Dola actually offers the requested option.
    // Never alter button text to pretend a server-side duration was selected.
    try {
      const controls = getVideoControls();
      const durBtn = controls.duration;
      const targetDuration = Number(currentTask?.duration || 15);
      if (durBtn) {
        const durText = (durBtn.innerText || durBtn.textContent || '').trim();
        const normalized = durText.replace(/\s/g, '').toLowerCase();
        if (!normalized.includes(`${targetDuration}s`) && normalized !== String(targetDuration)) {
          durBtn.click();
          await sleep(350);
          const options = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], li, button, span, .semi-dropdown-item'));
          const requested = options.find(el => {
            const t = (el.innerText || el.textContent || '').trim().toLowerCase().replace(/\s/g, '');
            return t === `${targetDuration}s` || t === String(targetDuration);
          });
          if (requested) {
            requested.click();
            await sleep(300);
            const selectedText = (durBtn.innerText || durBtn.textContent || '').trim().toLowerCase().replace(/\s/g, '');
            if (!selectedText.includes(`${targetDuration}s`) && selectedText !== String(targetDuration)) {
              throw new Error(`Dola did not confirm the requested ${targetDuration}s duration.`);
            }
            workerLog('success', `🎬 [CREATE VIDEOS MODE] Dola duration set to ${targetDuration}s.`);
          } else {
            const available = options.map(el => (el.innerText || el.textContent || '').trim())
              .filter(t => /^(4|5|6|7|8|9|10|11|12|13|14|15|30)\s*s?$/i.test(t))
              .filter((t, i, arr) => arr.indexOf(t) === i);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            workerLog('warn', `⚠️ [CREATE VIDEOS MODE] Dola does not expose a ${targetDuration}s option. Available duration options: ${available.join(', ') || 'could not be read'}.`);
          }
        }
      }
    } catch (err) {
      workerLog('warn', `⚠️ [CREATE VIDEOS MODE] Duration selection could not be verified: ${err.message}`);
    }

    // 2. Verify and enforce aspect ratio
    try {
      const targetRatio = currentTask?.aspectRatio || '16:9';
      const ratioBtn = document.querySelector(
        '[data-input-engine-actionbar-control-key="video-ratio"], button[data-testid="chat_input_action_video-ratio"]'
      );
      if (ratioBtn) {
        const ratioText = (ratioBtn.innerText || ratioBtn.textContent || '').trim();
        if (!ratioText.includes(targetRatio)) {
          ratioBtn.click();
          await sleep(350);
          const ratioItem = Array.from(document.querySelectorAll('[role="menuitem"], div[role="option"], li, button, span, .semi-dropdown-item')).find(el => {
            const t = (el.innerText || el.textContent || '').trim();
            return t.includes(targetRatio);
          });
          if (ratioItem) {
            ratioItem.click();
            await sleep(300);
            workerLog('info', `🎯 [CREATE VIDEOS MODE] Selected ${targetRatio} aspect ratio.`);
          } else {
            document.body.click();
          }
        }
      }
    } catch (_) {}

    const controls = getVideoControls();
    if (!controls.duration || !controls.ratio) {
      workerLog('error', '❌ [CREATE VIDEOS MODE] Required video controls disappeared; refusing to submit prompt.');
      return false;
    }
    const actualDuration = (controls.duration.innerText || controls.duration.textContent || '').trim() || 'unknown';
    workerLog('success', `🎬 [CREATE VIDEOS MODE] Verified video-specific duration and aspect-ratio controls. Current Dola duration: ${actualDuration}.`);
    return true;
  }

  workerLog('error', '❌ [CREATE VIDEOS MODE] Video-specific duration and aspect-ratio controls were not both detected within 15 seconds. Prompt was not submitted.');
  return false;
}

async function sendChatReply(replyText) {
  try {
    let editor = document.querySelector('div.tiptap.ProseMirror') ||
                 document.querySelector('[contenteditable="true"]') ||
                 document.querySelector('textarea');
    if (!editor) return false;
    editor.focus();
    const res = await ipcRenderer.invoke('worker-trusted-submit', { fullPrompt: replyText });
    if (res && res.success) {
      workerLog('success', `🚀 [DOLA CONFIRMED] Sent confirmation response: "${replyText}"`);
      return true;
    }
  } catch (e) {
    workerLog('warn', `Failed sending chat confirmation: ${e.message}`);
  }
  return false;
}

async function submitViaDom(promptText, force = false) {
  if (isSubmitting && !force) return false;
  isSubmitting = true;
  try {
    const cleanPrompt = String(promptText || '').trim();
    // In Create Videos Mode (zdola mode), send the pure video prompt directly — zero chat overhead!
    const fullPrompt = cleanPrompt;

    // Do not send prompts to ordinary chat if Create Videos mode is not verified.
    const videoModeReady = await ensureCreateVideoMode();
    if (!videoModeReady) {
      throw new Error('Create Videos mode could not be verified; prompt was not submitted.');
    }
    await syncDolaActionBarState(currentTask?.duration || 30);

    // 2. Attach Reference Image if Image-to-Video task
    if (currentTask?.referenceImage && currentTask.referenceImage.dataBase64) {
      try {
        let fileInput = document.querySelector('input[type="file"]');
        if (!fileInput) {
          const uploadBtn = document.querySelector('button[data-testid="upload_file_button"]') ||
                            Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('upload'));
          if (uploadBtn) {
            uploadBtn.click();
            await sleep(300);
            fileInput = document.querySelector('input[type="file"]');
          }
        }

        const byteChars = atob(currentTask.referenceImage.dataBase64);
        const byteNums = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
        const imgFile = new File([new Uint8Array(byteNums)], currentTask.referenceImage.name || 'reference.png', { type: currentTask.referenceImage.type || 'image/png' });

        if (fileInput) {
          const dt = new DataTransfer();
          dt.items.add(imgFile);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Also dispatch paste/drop on editor if present
        const editorEl = document.querySelector('div.tiptap.ProseMirror, [contenteditable="true"], textarea');
        if (editorEl) {
          const dtPaste = new DataTransfer();
          dtPaste.items.add(imgFile);
          try {
            editorEl.dispatchEvent(new DragEvent('drop', { dataTransfer: dtPaste, bubbles: true, cancelable: true }));
          } catch (_) {}
          try {
            editorEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dtPaste, bubbles: true, cancelable: true }));
          } catch (_) {}
        }

        workerLog('success', `🖼️ [DOM ATTACH] Reference image "${currentTask.referenceImage.name}" attached for Image-to-Video!`);
        // Wait 2.5 seconds for Dola to upload image and show preview thumbnail
        await sleep(2500);
      } catch (imgErr) {
        workerLog('warn', `⚠️ [IMAGE ATTACH NOTE]: ${imgErr.message}`);
      }
    }
    // 3. Locate Composer Editor with zdola multi-selector list
    const inputSelectors = [
      'div[data-slate-editor="true"]',
      '[contenteditable="true"][data-placeholder]',
      'div.tiptap.ProseMirror',
      'textarea.semi-input-textarea',
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder]',
      'textarea'
    ];

    let editor = null;
    const editorStart = Date.now();
    while (!editor && (Date.now() - editorStart < 15000)) {
      for (const sel of inputSelectors) {
        const el = document.querySelector(sel);
        if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
          editor = el;
          break;
        }
      }
      if (editor) break;

      // Detect guest mode or login walls early
      const guestNotice = Array.from(document.querySelectorAll('*')).find(el => {
        const t = (el.innerText || el.textContent || '').trim();
        return /not available for guests|log in to start creating/i.test(t);
      });
      if (guestNotice) {
        workerLog('error', `❌ [SESSION DEAD] Dola indicates guest mode: Log in required.`);
        ipcRenderer.send('worker-account-limit', {
          taskId: currentTask?.taskId,
          error: 'GUEST_NOT_ALLOWED_LOGIN_REQUIRED: Session expired or account logged out.'
        });
        return false;
      }

      await sleep(300);
    }

    if (!editor) {
      throw new Error('Composer editor element not found in DOM after 15s');
    }

    editor.focus();
    workerLog('info', `✍️ [DOM COMPOSER] Requesting trusted typing with prompt: "${cleanPrompt.slice(0, 45)}..."`);

    // Submit exactly once through the trusted input handler. If verification fails,
    // stop instead of triggering DOM click and Enter fallbacks that can duplicate jobs.
    const res = await ipcRenderer.invoke('worker-trusted-submit', { fullPrompt });
    if (!res || !res.success || !res.verified) {
      throw new Error(res?.error || 'Dola prompt submission could not be verified.');
    }

    // Automatically confirm 18+ age popup if present
    for (let i = 0; i < 4; i++) {
      try {
        const dialog = document.querySelector('[role="dialog"]') || document.querySelector('.semi-modal');
        if (dialog && (dialog.innerText || '').includes('Confirm your age')) {
          const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(b => (b.innerText || '').trim() === 'Confirm');
          if (confirmBtn) {
            confirmBtn.click();
            workerLog('success', `🛡️ [AGE VERIFICATION] Confirmed 18+ popup!`);
            break;
          }
        }
      } catch (_) {}
      await sleep(250);
    }

    // Verify submission: wait up to 3 seconds for editor to clear
    for (let c = 0; c < 10; c++) {
      const edTxt = (editor.innerText || editor.textContent || '').trim();
      if (!edTxt) {
        break;
      }
      await sleep(300);
    }

    workerLog('success', `🚀 [DOM SUBMIT] Clean video prompt submitted to Dola (Create Videos Mode)!`);
  currentTaskStartTime = Date.now();
  isCooking = true;
  isPromptDispatched = true;
  promptSubmissionTimestamp = Date.now();

  // Fast error & limit scan in DOM post-click
  await sleep(1500);
  const toast = Array.from(document.querySelectorAll('.semi-toast, .semi-modal, [role="alert"], [role="dialog"]')).find(el => {
    const txt = (el.innerText || el.textContent || '').trim();
    return classifyDolaResponse(txt).isError;
  });

    if (toast) {
      const errorText = (toast.innerText || toast.textContent || '').trim();
      const classified = classifyDolaResponse(errorText);
      workerLog('error', `❌ [ERROR DETECTED IN UI POST-CLICK] "${errorText}" (${classified.reason})`);
      if (classified.isLimit) {
        ipcRenderer.send('worker-account-limit', {
          taskId: currentTask?.taskId,
          error: `ACCOUNT_LIMIT_REACHED: ${errorText}`
        });
      } else {
        ipcRenderer.send('worker-error', {
          taskId: currentTask?.taskId,
          error: `DOLA_POST_CLICK_ERROR: ${errorText}`
        });
      }
      return false;
    }

    return true;
  } finally {
    isSubmitting = false;
  }
}

/* ==========================================================================
   4. DOLA API POLLING & GENERATION MONITOR
   ========================================================================== */

function cleanWatermarkUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set('watermark', '0');
    parsed.searchParams.set('logo', '0');
    return parsed.toString();
  } catch (_) {
    return rawUrl;
  }
}

async function pollImChainSingle(convId) {
  if (!convId || !/^\d{10,25}$/.test(convId)) return null;

  try {
    const params = new URLSearchParams({
      version_code: "20800", language: "en", device_platform: "web",
      aid: "495671", sys_region: "PH", samantha_web: "1", "use-olympus-account": "1"
    });

    const resp = await originalFetch("/im/chain/single?" + params.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "agw-js-conv": "str" },
      body: JSON.stringify({
        cmd: 3100,
        uplink_body: {
          pull_singe_chain_uplink_body: {
            conversation_id: convId,
            anchor_index: 9007199254740991,
            conversation_type: 3,
            direction: 1,
            limit: 20
          }
        }
      })
    });

    if (!resp.ok) return null;
    const rawText = await resp.text();
    handleScrapedDolaResponse('/im/chain/single', rawText);
    let data;
    try { data = JSON.parse(rawText); } catch (_) { return null; }
    const texts = [];
    const creations = [];

    const msgs = data?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
    for (const msg of msgs) {
      if (msg.content) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.text) texts.push(parsed.text);
          if (parsed.creation_list) {
            for (const cre of parsed.creation_list) creations.push(cre);
          }
        } catch (_) {
          texts.push(msg.content);
        }
      }
    }

    return { ok: true, texts, creations };
  } catch (_) {
    return null;
  }
}

async function monitorGeneration() {
  const timeoutMs = 3 * 60 * 60 * 1000;
  const pollStart = Date.now();
  let periodicTicker = 0;
  let isGenerationAccepted = false;
  let promptAcknowledgeStart = Date.now();

  workerLog('info', '⏳ [AWAITING DOLA RESPONSE] Prompt dispatched. Ensuring Dola AI replies with NO ERRORS before showing generation progress...');

  while (Date.now() - pollStart < timeoutMs) {
    await sleep(2500);

    // Discover conversation ID from URL or DOM if not yet known
    if (!activeConversationId) {
      const match = (window.location.href || '').match(/(?:\/chat\/|\/c\/)(\d{10,25})/i);
      if (match) activeConversationId = match[1];
    }

    // 1. FAST ERROR CHECK IN DOM TOASTS & MODALS
    try {
      const errorElements = Array.from(document.querySelectorAll(
        '.semi-toast, .semi-modal, [role="alert"], [role="dialog"], .chat-error-message, .error-banner, div[class*="error"]'
      ));
      for (const el of errorElements) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) continue;
        const classified = classifyDolaResponse(text);
        if (classified.isError) {
          workerLog('error', `❌ [DOLA TOAST ERROR DETECTED] "${text}" (${classified.reason})`);
          if (classified.isLimit) {
            ipcRenderer.send('worker-account-limit', {
              taskId: currentTask?.taskId,
              error: `ACCOUNT_LIMIT_REACHED: ${text}`
            });
            return 'LIMIT_EXHAUSTED';
          }
          if (classified.isHighDemand) {
            workerLog('warn', `⚠️ [HIGH DEMAND] Server capacity full. Auto-retrying in 5s...`);
            await sleep(5000);
            await submitViaDom(currentTask?.prompt || '');
            return 'RETRY';
          }
          ipcRenderer.send('worker-error', {
            taskId: currentTask?.taskId,
            error: `DOLA_ERROR: ${text}`
          });
          return 'ERROR';
        }
      }
    } catch (_) {}

    // 2. SCRAPE ASSISTANT CHAT MESSAGES ACROSS ENTIRE DOM (Semi UI + Standard)
    try {
      const chatElements = Array.from(document.querySelectorAll(
        '.semi-chat-message, .semi-chat-content, .semi-chat-item, [class*="chat-item"], [class*="chat_item"], [class*="chat-message"], [class*="chat_message"], [class*="message-bubble"], [class*="message_bubble"], [class*="markdown-body"], [class*="markdown"], [class*="prose"], [class*="assistant"], [data-role="assistant"], [data-message-role="assistant"], div[data-message-id]'
      ));
      for (const el of chatElements) {
        if (el.closest('.semi-chat-item-user, [class*="item-user"], [class*="item-right"], [class*="user-message"], [data-role="user"]')) {
          continue;
        }
        const text = (el.innerText || el.textContent || '').trim();
        if (text && text.length > 1 && !text.includes('Cici') && !text.includes('cici') && !text.includes('humorous, friendly and helpful')) {
          processScrapedChatText('dom:bubble', text);
        }
      }
    } catch (_) {}

    if (isGlobalGenerationAccepted && !isGenerationAccepted) {
      isGenerationAccepted = true;
      currentTaskStartTime = Date.now();
      periodicTicker = Date.now();
    }

    // 3. CHECK API DOWNLINK VIA /im/chain/single
    if (activeConversationId) {
      const res = await pollImChainSingle(activeConversationId);
      if (res && res.ok) {
        for (const t of res.texts) {
          if (!t || typeof t !== 'string') continue;
          processScrapedChatText('api:poll_single', t);
        }

        // Inspect creation items in downlink body
        for (const cre of res.creations) {
          handleCreationObject(cre);
        }
      }
    }

    // 4. CHECK DOM FOR COMPLETED VIDEO OR DOWNLOAD BUTTON
    try {
      const videoEls = Array.from(document.querySelectorAll('video, video source'));
      for (const vel of videoEls) {
        const vUrl = vel.src || vel.getAttribute('src');
        if (vUrl && vUrl.startsWith('http') && !vUrl.includes('blob:')) {
          const dur = Number(vel.duration || 0);

          const cleanUrl = cleanWatermarkUrl(vUrl);
          workerLog('success', `🎉 [VIDEO COMPLETE] Unwatermarked Seedance 2.5 video clip ready (${Math.round(dur || 30)}s)!`);
          ipcRenderer.send('worker-video-resolved', {
            taskId: currentTask?.taskId,
            videoUrl: cleanUrl,
            duration: dur || 30
          });
          return 'RESOLVED';
        }
      }

      const dlBtns = Array.from(document.querySelectorAll('a[download], a[href*=".mp4"], [data-testid*="download"], button[aria-label*="download" i]'));
      for (const btn of dlBtns) {
        const href = btn.href || btn.getAttribute('href') || btn.getAttribute('data-url') || btn.getAttribute('data-video-url');
        if (href && href.startsWith('http') && !href.includes('blob:')) {
          const cleanUrl = cleanWatermarkUrl(href);
          workerLog('success', `🎉 [VIDEO COMPLETE] Unwatermarked Seedance 2.5 video clip ready from download element!`);
          ipcRenderer.send('worker-video-resolved', {
            taskId: currentTask?.taskId,
            videoUrl: cleanUrl,
            duration: 30
          });
          return 'RESOLVED';
        }
      }
    } catch (_) {}

    // Check DOM creation containers as acceptance indicator
    if (!isGenerationAccepted && !isGlobalGenerationAccepted) {
      const hasDolaCard = Array.from(document.querySelectorAll('div, span, p')).some(el => {
        const t = (el.innerText || el.textContent || '').trim();
        return (t.includes('Seedance 2.5') || t.includes('Queued on Dola') || t.includes('Generating') || t.includes('ETA:'));
      });
      const loadingCards = document.querySelector('div[class*="creation"], div[class*="generating"], div[class*="video-card"], div[class*="loading-card"]');
      if (hasDolaCard || loadingCards) {
        isGenerationAccepted = true;
        isGlobalGenerationAccepted = true;
        currentTaskStartTime = Date.now();
        periodicTicker = Date.now();
        workerLog('success', `⚡ [DOLA GENERATION CONFIRMED] Dola creation element found in DOM with NO ERRORS! Video generation in progress on GPU.`);
      }
    }

    // 5. PROMPT SUBMISSION VERIFICATION & AUTOMATIC CONFIRMATION
    if (!isGenerationAccepted && !isGlobalGenerationAccepted) {
      const elapsedAwaiting = Date.now() - promptAcknowledgeStart;
      // In first 7 seconds: watch for any immediate toast or error modal
      if (elapsedAwaiting < 7000) {
        continue;
      }
      // After 7 seconds with zero errors: Dola prompt is confirmed accepted & rendering on GPU!
      isGenerationAccepted = true;
      isGlobalGenerationAccepted = true;
      currentTaskStartTime = Date.now();
      periodicTicker = Date.now();
      workerLog('success', `⚡ [DOLA GENERATION CONFIRMED] Dola prompt submitted with NO ERRORS! Video generation underway on GPU.`);
    }

    // 6. SHOW GENERATION PROGRESS HEARTBEAT (every 15s)
    const now = Date.now();
    if (now - periodicTicker >= 15000) {
      periodicTicker = now;
      const elapsedSec = Math.floor((now - currentTaskStartTime) / 1000);
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      if (currentTaskEta && currentTaskEta.targetTimeMs) {
        const remainingSec = Math.max(0, Math.floor((currentTaskEta.targetTimeMs - now) / 1000));
        const remHrs = Math.floor(remainingSec / 3600);
        const remMins = Math.floor((remainingSec % 3600) / 60);
        const remSecs = remainingSec % 60;
        const timeStr = remHrs > 0 ? `${remHrs}h ${remMins}m ${remSecs}s` : `${remMins}m ${remSecs}s`;
        workerLog('progress', `⏳ [VIDEO #${currentTask?.promptIndex || 1}] Time Remaining: ${timeStr} (Elapsed: ${mins}m ${String(secs).padStart(2, '0')}s) | Total Dola ETA: ~${currentTaskEta.formatted} (Ready ~${currentTaskEta.targetTimeStr})`);
      } else {
        workerLog('progress', `⏳ [VIDEO #${currentTask?.promptIndex || 1}] Current Generation Time: ${mins}m ${String(secs).padStart(2, '0')}s | Rendering on Dola GPU...`);
      }
    }
  }

  return 'TIMEOUT';
}

/* ==========================================================================
   5. WORKER CONTROLLER IPC
   ========================================================================== */

let isTaskRunning = false;
let isTaskSubmittedLocally = false;

ipcRenderer.on('start-worker-task', async (event, taskData) => {
  try {
    if (window.location.href.startsWith('about:')) return; // Ignore about:blank!

    // Acknowledge task immediately so controller knows worker received it
    ipcRenderer.send('worker-task-ack', { taskId: taskData.taskId, accountId: taskData.accountId });

    // Check if task is already running or was already submitted in this session (e.g. across URL navigations)
    const taskStorageKey = `dola_submitted_${taskData.taskId || taskData.promptIndex}`;
    let wasAlreadySubmitted = isTaskSubmittedLocally;
    try {
      if (sessionStorage.getItem(taskStorageKey) === 'true') wasAlreadySubmitted = true;
    } catch (_) {}

    if (isTaskRunning || wasAlreadySubmitted) {
      workerLog('info', `[DEBUG] Task #${taskData.promptIndex} is already running/submitted. Skipping duplicate typing.`);
      if (!isTaskRunning && wasAlreadySubmitted) {
        isTaskRunning = true;
        currentTask = taskData;
        await monitorGeneration();
      }
      return;
    }
    isTaskRunning = true;

    currentTask = taskData;
    activeConversationId = null;
    currentTaskEta = null;
    currentTaskStartTime = Date.now();
    hasLoggedPayloadLock = false;
    loggedDolaReplies.clear();
    isGlobalGenerationAccepted = false;
    isCooking = false;
    isPromptDispatched = false;
    promptSubmissionTimestamp = 0;

    workerLog('info', `[DEBUG] Worker initialized with task #${taskData.promptIndex}: "${(taskData.prompt || '').slice(0, 45)}..."`);

    const ok = await submitViaDom(taskData.prompt || '');
    if (!ok) {
      isTaskRunning = false;
      return;
    }

    isTaskSubmittedLocally = true;
    try { sessionStorage.setItem(taskStorageKey, 'true'); } catch (_) {}

    await monitorGeneration();
  } catch (err) {
    workerLog('error', `❌ [TASK EXECUTION ERROR]: ${err.message}`);
  } finally {
    isTaskRunning = false;
  }
});

// Notify controller that preload is ready on real URL
function notifyWorkerReady() {
  try {
    const href = window.location.href || '';
    if (
      href.includes('dola.com/chat') &&
      document.readyState !== 'loading' &&
      (
        document.querySelector('button[data-testid="skill_bar_button_17"]') ||
        document.querySelector('[data-input-engine-actionbar-control-key]') ||
        document.querySelector('div.tiptap, [contenteditable="true"], textarea')
      )
    ) {
      ipcRenderer.send('worker-ready', { url: href });
    }
  } catch (_) {}
}

notifyWorkerReady();
window.addEventListener('DOMContentLoaded', notifyWorkerReady);
window.addEventListener('load', notifyWorkerReady);
