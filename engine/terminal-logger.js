/**
 * SudoDola Studio Pro - Enhanced Terminal Logger for IDE
 * Provides rich ANSI colorized, categorized console logging to stdout.
 */

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightCyan: '\x1b[96m',
  brightMagenta: '\x1b[95m',
  bgRed: '\x1b[41m\x1b[37m'
};

function getTimestamp() {
  const d = new Date();
  return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * Log a message to the IDE terminal with channel and level tags.
 * @param {string} channel - e.g. 'MAIN', 'ORCH', 'WORKER', 'DOLA', 'UI', 'VAULT'
 * @param {string} message - The log text
 * @param {string} level   - 'info' | 'success' | 'warn' | 'error' | 'progress' | 'chat'
 */
function termLog(channel, message, level = 'info') {
  const time = `${colors.gray}[${getTimestamp()}]${colors.reset}`;

  let levelTag = `[${level.toUpperCase()}]`;
  let levelColor = colors.blue;

  const lvl = String(level || 'info').toLowerCase();
  if (lvl === 'success' || lvl === 'ok') {
    levelColor = colors.brightGreen;
  } else if (lvl === 'warn' || lvl === 'warning') {
    levelColor = colors.brightYellow;
  } else if (lvl === 'error' || lvl === 'fatal') {
    levelColor = colors.brightRed;
  } else if (lvl === 'chat') {
    levelColor = colors.brightCyan;
  } else if (lvl === 'progress') {
    levelColor = colors.brightMagenta;
  } else {
    levelColor = colors.blue;
  }

  let chColor = colors.white;
  const ch = String(channel || 'APP').toUpperCase();
  if (ch.includes('MAIN')) chColor = colors.cyan;
  else if (ch.includes('WORKER')) chColor = colors.brightMagenta;
  else if (ch.includes('ORCH')) chColor = colors.yellow;
  else if (ch.includes('DOLA')) chColor = colors.brightCyan;
  else if (ch.includes('UI') || ch.includes('RENDERER')) chColor = colors.green;
  else if (ch.includes('VAULT') || ch.includes('COOKIE')) chColor = colors.magenta;

  const chTag = `${chColor}${colors.bold}[${ch}]${colors.reset}`;
  const lvlTag = `${levelColor}${levelTag}${colors.reset}`;

  console.log(`${time} ${chTag} ${lvlTag} ${message}`);
}

module.exports = {
  termLog,
  colors
};
