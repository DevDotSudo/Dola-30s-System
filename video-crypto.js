/**
 * Dola Automator - ByteDance / Doubao Video Crypto Engine
 * Decrypts ByteDance proprietary AES-CBC / SHA-512 qAAB stream tokens into clean unwatermarked MP4 URLs.
 * Runs in both Window and Service Worker environments.
 */

(() => {
  'use strict';

  const FPLAY_KDF_SALT = 'TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==';

  function b64ToBytes(value) {
    const text = String(value || '').trim();
    if (!text) return new Uint8Array(0);
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
    const binary = atob(normalized);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  function bytesToHttpUrl(bytes) {
    if (!bytes || bytes.length === 0) return '';
    try {
      const text = new TextDecoder().decode(bytes).trim();
      return /^https?:\/\/[^\s]+$/i.test(text) ? text : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * Decrypts a single raw encrypted ByteDance video token using keySeed
   */
  async function decodeMainUrl(token, keySeed = '') {
    token = String(token || '').trim();
    if (/^https?:\/\//i.test(token)) return token;
    if (!token || !keySeed) return '';

    try {
      const encrypted = b64ToBytes(token);
      const seed = b64ToBytes(keySeed);
      if (encrypted.length <= 4 || seed.length === 0) return '';

      const ciphertext = encrypted.slice(4);
      const subtle = crypto.subtle;

      // 1. SHA-512 on seed
      const firstHash = new Uint8Array(await subtle.digest('SHA-512', seed));

      // 2. Combine with FPLAY_KDF_SALT (64 bytes firstHash + 64 bytes salt = 128 bytes)
      const keyMaterial = new Uint8Array(128);
      const salt = b64ToBytes(FPLAY_KDF_SALT);
      keyMaterial.set(firstHash, 0);
      keyMaterial.set(salt, 64);

      // 3. Derive key and IV via SHA-512
      const derived = new Uint8Array(await subtle.digest('SHA-512', keyMaterial));
      const keyBytes = derived.slice(0, 16);
      const iv = derived.slice(16, 32);

      // 4. AES-CBC decrypt
      const cryptoKey = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
      const decrypted = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, ciphertext));

      // 5. PKCS#7 Unpadding
      let end = decrypted.length;
      const pad = decrypted[end - 1];
      if (pad >= 1 && pad <= 16) {
        let valid = true;
        for (let i = 0; i < pad; i++) {
          if (decrypted[end - 1 - i] !== pad) {
            valid = false;
            break;
          }
        }
        if (valid) end -= pad;
      }

      const cleanUrl = bytesToHttpUrl(decrypted.slice(0, end));
      return cleanUrl;
    } catch (err) {
      console.warn('[Dola Automator Crypto] Token decryption failed:', err.message);
      return '';
    }
  }

  /**
   * Decrypts all available URLs in a ByteDance video_info data object
   */
  async function decipherUrlsFromVideoInfoData(videoInfoData) {
    if (!videoInfoData) return [];
    const keySeed = videoInfoData.key_seed || '';
    if (!keySeed) return [];

    const candidates = [];
    const vList = videoInfoData.video_list || {};

    let items = [];
    if (Array.isArray(vList)) {
      items = [...vList];
    } else if (vList && typeof vList === 'object') {
      items = Object.values(vList).filter(item => item && typeof item === 'object');
    }

    // Prioritize 1080p and highest resolution/quality streams first
    items.sort((a, b) => {
      const getScore = (item) => {
        let score = 0;
        const def = String(item.definition || item.quality || item.vtype || item.gear || '').toLowerCase();
        if (def.includes('1080')) score += 100000;
        else if (def.includes('720')) score += 50000;
        else if (def.includes('480')) score += 10000;

        const h = Number(item.vheight || item.height || 0);
        const w = Number(item.vwidth || item.width || 0);
        const maxDim = Math.max(h, w);
        if (maxDim >= 1920) score += 90000;
        else if (maxDim >= 1080) score += 60000;
        else if (maxDim >= 720) score += 30000;

        const br = Number(item.bitrate || 0);
        score += Math.min(20000, Math.floor(br / 1000));
        return score;
      };
      return getScore(b) - getScore(a);
    });

    items.forEach(item => {
      if (item.main_url) candidates.push(item.main_url);
      if (item.backup_url) candidates.push(item.backup_url);
      if (item.backup_url_1) candidates.push(item.backup_url_1);
    });

    if (videoInfoData.main_url) candidates.push(videoInfoData.main_url);

    const decryptedUrls = [];
    for (const rawToken of candidates) {
      const clean = await decodeMainUrl(rawToken, keySeed);
      if (clean && clean.startsWith('http') && !decryptedUrls.includes(clean)) {
        decryptedUrls.push(clean);
      }
    }

    return decryptedUrls;
  }

  const exportObj = Object.freeze({
    decodeMainUrl,
    decipherUrlsFromVideoInfoData
  });

  const scope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
  try {
    Object.defineProperty(scope, 'DoubaoVideoCrypto', {
      value: exportObj,
      configurable: true,
      enumerable: false,
      writable: true
    });
  } catch (_) {
    scope.DoubaoVideoCrypto = exportObj;
  }
})();
