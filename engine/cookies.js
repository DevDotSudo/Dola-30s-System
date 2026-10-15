/**
 * SudoDola Studio - SQLite Account & Cookie Vault Engine
 * Engineered by SudoDotDev
 * Powered by native node:sqlite DatabaseSync (Zero JSON file dependencies)
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'vault.db');
const db = new DatabaseSync(DB_PATH);

// Enable Foreign Keys and Write-Ahead Logging for concurrency & durability
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

// Initialize SQLite Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT,
    status TEXT DEFAULT 'live',
    saved_count INTEGER DEFAULT 0,
    saved_today INTEGER DEFAULT 0,
    last_used INTEGER DEFAULT 0,
    cooldown_until INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cookies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    domain TEXT DEFAULT '.dola.com',
    path TEXT DEFAULT '/',
    secure INTEGER DEFAULT 1,
    http_only INTEGER DEFAULT 0,
    same_site TEXT DEFAULT 'lax',
    expiration_date REAL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_cookies_account ON cookies(account_id);
`);

/**
 * Parse raw cookie content (JSON or Netscape format)
 */
function parseCookieContent(rawText, filename = 'Cookie') {
  let cookies = [];
  const cleanText = String(rawText || '').trim();

  // 1. Try JSON parsing
  if (cleanText.startsWith('[') || cleanText.startsWith('{')) {
    try {
      const parsed = JSON.parse(cleanText);
      if (Array.isArray(parsed)) {
        cookies = parsed;
      } else if (parsed && Array.isArray(parsed.cookies)) {
        cookies = parsed.cookies;
      } else if (typeof parsed === 'object') {
        cookies = Object.entries(parsed).map(([k, v]) => ({
          name: k,
          value: String(v),
          domain: '.dola.com',
          path: '/'
        }));
      }
    } catch (_) {}
  }

  // 2. Try Netscape / Curl format
  if (!cookies.length) {
    const lines = cleanText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(/\t+/);
      if (parts.length >= 7) {
        cookies.push({
          domain: parts[0],
          includeSubdomains: parts[1] === 'TRUE',
          path: parts[2],
          secure: parts[3] === 'TRUE',
          expirationDate: parseInt(parts[4], 10) || undefined,
          name: parts[5],
          value: parts[6]
        });
      }
    }
  }

  return cookies.map(c => ({
    name: c.name || c.Name,
    value: c.value || c.Value || '',
    domain: (c.domain || c.Domain || '.dola.com').trim(),
    path: c.path || c.Path || '/',
    secure: c.secure !== false,
    httpOnly: c.httpOnly === true,
    sameSite: c.sameSite || 'lax',
    expirationDate: c.expirationDate || c.expiry || undefined
  })).filter(c => Boolean(c.name && c.value && String(c.value).trim().length > 0));
}

/**
 * Upsert single account and replace its cookies in SQLite
 */
function upsertAccount(acc) {
  if (!acc || !acc.name) return;

  // Look up if account already exists with this name or ID
  const existing = db.prepare('SELECT id FROM accounts WHERE name = ? OR id = ?').get(String(acc.name), String(acc.id || ''));
  const finalId = existing ? existing.id : String(acc.id || `acc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`);

  const validCookies = (acc.cookies || []).filter(c => c && c.name && c.value && String(c.value).trim().length > 0);

  const stmtAcc = db.prepare(`
    INSERT INTO accounts (id, name, filename, status, saved_count, saved_today, last_used, cooldown_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      filename = excluded.filename,
      status = excluded.status,
      saved_count = excluded.saved_count,
      saved_today = excluded.saved_today,
      last_used = excluded.last_used,
      cooldown_until = excluded.cooldown_until
  `);

  stmtAcc.run(
    finalId,
    String(acc.name),
    String(acc.filename || `${acc.name}.json`),
    String(acc.status || 'live'),
    Number(acc.savedCount || 0),
    Number(acc.savedToday || 0),
    Number(acc.lastUsed || 0),
    Number(acc.cooldownUntil || 0),
    Number(acc.createdAt || Date.now())
  );

  // Replace cookies for account
  db.prepare('DELETE FROM cookies WHERE account_id = ?').run(finalId);

  const stmtCookie = db.prepare(`
    INSERT INTO cookies (account_id, name, value, domain, path, secure, http_only, same_site, expiration_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of validCookies) {
    stmtCookie.run(
      String(acc.id),
      String(c.name),
      String(c.value),
      String(c.domain || '.dola.com'),
      String(c.path || '/'),
      c.secure !== false ? 1 : 0,
      c.httpOnly === true ? 1 : 0,
      String(c.sameSite || 'lax'),
      c.expirationDate ? Number(c.expirationDate) : null
    );
  }
}

// One-time automatic migration from legacy data/accounts.json
try {
  const legacyAccountsJson = path.join(DATA_DIR, 'accounts.json');
  const legacyBakJson = path.join(DATA_DIR, 'accounts.json.migrated.bak');
  const countRow = db.prepare('SELECT COUNT(*) as count FROM accounts').get();
  const sourceJson = fs.existsSync(legacyAccountsJson) ? legacyAccountsJson : (fs.existsSync(legacyBakJson) ? legacyBakJson : null);
  if (countRow.count === 0 && sourceJson) {
    const raw = fs.readFileSync(sourceJson, 'utf8');
    const legacy = JSON.parse(raw);
    if (Array.isArray(legacy) && legacy.length > 0) {
      for (const acc of legacy) {
        if (acc && (acc.id || acc.name)) {
          upsertAccount(acc);
        }
      }
      if (sourceJson === legacyAccountsJson) {
        try { fs.renameSync(legacyAccountsJson, legacyAccountsJson + '.migrated.bak'); } catch (_) {}
      }
    }
  }
} catch (e) {
  console.warn('[SQLite Vault] Legacy migration notice:', e.message);
}

/**
 * Load all accounts with their cookies directly from SQLite
 */
function loadAllAccounts() {
  const now = Date.now();

  // Reset daily limits & cooldowns
  db.exec(`
    UPDATE accounts 
    SET status = 'live', cooldown_until = 0, saved_today = 0
    WHERE status = 'limit_reached' AND cooldown_until > 0 AND cooldown_until <= ${now}
  `);
  db.exec(`
    UPDATE accounts 
    SET saved_today = 0
    WHERE last_used > 0 AND (${now} - last_used) > 86400000 AND saved_today > 0
  `);

  const accRows = db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
  const selectCookies = db.prepare('SELECT name, value, domain, path, secure, http_only, same_site, expiration_date FROM cookies WHERE account_id = ?');

  return accRows.map(acc => {
    const cRows = selectCookies.all(acc.id);
    const cookies = cRows.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.http_only),
      sameSite: c.same_site || 'lax',
      expirationDate: c.expiration_date || undefined
    }));

    return {
      id: acc.id,
      name: acc.name,
      filename: acc.filename || `${acc.name}.json`,
      cookies,
      status: acc.status || 'live',
      hasSkill: true,
      savedCount: acc.saved_count || 0,
      savedToday: acc.saved_today || 0,
      lastUsed: acc.last_used || 0,
      cooldownUntil: acc.cooldown_until || 0,
      createdAt: acc.created_at || Date.now()
    };
  });
}

/**
 * Save array of accounts directly to SQLite
 */
function saveAllAccounts(accounts) {
  if (Array.isArray(accounts)) {
    for (const acc of accounts) {
      upsertAccount(acc);
    }
  }
  return loadAllAccounts();
}

/**
 * Add uploaded/pasted cookie payloads directly into SQLite
 */
function addCookieFiles(filesData = []) {
  let addedCount = 0;
  for (const file of filesData) {
    const parsedCookies = parseCookieContent(file.content, file.name);
    if (!parsedCookies.length) continue;

    const baseName = file.name ? file.name.replace(/\.(json|txt)$/i, '') : `Cookie_${Date.now().toString().slice(-4)}`;
    const sessionId = parsedCookies.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss')?.value;

    let existingAccId = null;
    if (sessionId) {
      const match = db.prepare(`
        SELECT a.id FROM accounts a 
        JOIN cookies c ON a.id = c.account_id 
        WHERE (c.name = 'sessionid' OR c.name = 'sessionid_ss') AND c.value = ?
        LIMIT 1
      `).get(sessionId);
      if (match) existingAccId = match.id;
    }

    const accId = existingAccId || `acc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    upsertAccount({
      id: accId,
      name: baseName,
      filename: `${baseName}.json`,
      cookies: parsedCookies,
      status: 'live',
      hasSkill: true,
      savedCount: 0,
      savedToday: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      createdAt: Date.now()
    });
    addedCount++;
  }
  return { total: loadAllAccounts().length, added: addedCount };
}

/**
 * Delete accounts by ID from SQLite (Cascade deletes cookies)
 */
function deleteAccounts(accountIds = []) {
  if (!accountIds.length) return { deleted: 0, remaining: loadAllAccounts().length };
  const stmt = db.prepare('DELETE FROM accounts WHERE id = ?');
  let deleted = 0;
  for (const id of accountIds) {
    const res = stmt.run(String(id));
    if (res.changes) deleted += res.changes;
  }
  return { deleted, remaining: loadAllAccounts().length };
}

/**
 * Delete dead accounts from SQLite
 */
function deleteDeadAccounts() {
  const res = db.prepare("DELETE FROM accounts WHERE status = 'dead'").run();
  return { deleted: res.changes, remaining: loadAllAccounts().length };
}

/**
 * Reset account status and cooldown timer in SQLite
 */
function resetAccountStatus(accountIds = []) {
  if (!accountIds.length) {
    const res = db.prepare("UPDATE accounts SET status = 'live', cooldown_until = 0, saved_today = 0").run();
    return { success: true, count: res.changes, total: loadAllAccounts().length };
  }
  const stmt = db.prepare("UPDATE accounts SET status = 'live', cooldown_until = 0, saved_today = 0 WHERE id = ?");
  let count = 0;
  for (const id of accountIds) {
    const res = stmt.run(String(id));
    if (res.changes) count += res.changes;
  }
  return { success: true, count, total: loadAllAccounts().length };
}

/**
 * Update account status and cooldown in SQLite
 */
function updateAccountStatus(id, status, cooldownUntil = 0) {
  db.prepare('UPDATE accounts SET status = ?, cooldown_until = ?, last_used = ? WHERE id = ?')
    .run(String(status), Number(cooldownUntil), Date.now(), String(id));
}

/**
 * Increment video counter in SQLite
 */
function incrementSavedCount(id) {
  db.prepare('UPDATE accounts SET saved_count = saved_count + 1, saved_today = saved_today + 1, last_used = ? WHERE id = ?')
    .run(Date.now(), String(id));
}

module.exports = {
  db,
  parseCookieContent,
  upsertAccount,
  loadAllAccounts,
  saveAllAccounts,
  addCookieFiles,
  deleteAccounts,
  deleteDeadAccounts,
  resetAccountStatus,
  updateAccountStatus,
  incrementSavedCount
};
