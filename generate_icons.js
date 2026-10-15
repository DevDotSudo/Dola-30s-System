const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(12 + len);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, 'ascii');
  data.copy(buf, 8);
  const typeAndData = buf.subarray(4, 8 + len);
  const crc = crc32(typeAndData);
  buf.writeUInt32BE(crc, 8 + len);
  return buf;
}

function createPng(width, height, drawFn) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = writeChunk('IHDR', ihdr);

  // Raw image data with 1 filter byte per line
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawFn(x, y, width, height);
      const pixelOffset = rowOffset + 1 + x * 4;
      raw[pixelOffset] = r;
      raw[pixelOffset + 1] = g;
      raw[pixelOffset + 2] = b;
      raw[pixelOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(raw);
  const idatChunk = writeChunk('IDAT', compressed);
  const iendChunk = writeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function renderIcon(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxR = w * 0.46;

  // Background rounded shape (squircle)
  const normX = Math.abs(dx) / (w * 0.44);
  const normY = Math.abs(dy) / (h * 0.44);
  const squircle = Math.pow(normX, 4) + Math.pow(normY, 4);

  if (squircle > 1.0) {
    return [0, 0, 0, 0]; // Transparent
  }

  // Gradient background: Electric Indigo / Cyan / Violet
  const t = (x + y) / (w + h);
  let bgR = Math.floor(99 * (1 - t) + 14 * t);
  let bgG = Math.floor(102 * (1 - t) + 165 * t);
  let bgB = Math.floor(241 * (1 - t) + 233 * t);

  // Inner glow / highlight near border
  if (squircle > 0.85) {
    bgR = Math.min(255, bgR + 60);
    bgG = Math.min(255, bgG + 60);
    bgB = Math.min(255, bgB + 60);
  }

  // Draw a sleek "D" & lightning bolt symbol in the center
  // Center stylized "D"
  const nx = (x - w * 0.28) / (w * 0.44);
  const ny = (y - h * 0.24) / (h * 0.52);

  let isSymbol = false;
  if (nx >= 0 && nx <= 0.9 && ny >= 0 && ny <= 1.0) {
    // Outer D curve
    const inOuter = (nx <= 0.3) || (Math.pow(Math.max(0, nx - 0.25) / 0.65, 2) + Math.pow((ny - 0.5) / 0.5, 2) <= 1.0);
    // Inner hole
    const inInner = (nx > 0.28 && nx < 0.65 && Math.pow((nx - 0.25) / 0.4, 2) + Math.pow((ny - 0.5) / 0.3, 2) <= 0.8);
    if (inOuter && !inInner) {
      isSymbol = true;
    }
  }

  // Lightning spark on the right
  const lx = (x - w * 0.55) / (w * 0.3);
  const ly = (y - h * 0.35) / (h * 0.35);
  if (lx >= 0 && lx <= 1 && ly >= 0 && ly <= 1) {
    if (Math.abs(lx - ly) < 0.22 && ly > 0.2 && ly < 0.8) {
      isSymbol = true;
    }
  }

  if (isSymbol) {
    return [255, 255, 255, 255]; // Crisp white logo
  }

  return [bgR, bgG, bgB, 255];
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 32, 48, 128].forEach(size => {
  const png = createPng(size, size, renderIcon);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`Generated icon${size}.png (${size}x${size})`);
});
