/**
 * PWA 아이콘 PNG 생성기 (개발용 스크립트).
 *
 * 외부 라이브러리 금지 규칙에 따라 Node 내장 zlib 만으로 PNG 를 직접 인코딩한다.
 * 결과물은 public/ 에 커밋되므로 빌드 파이프라인에서는 실행되지 않는다.
 *
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x0b, 0x0e, 0x14];
const P1 = [0x2f, 0x6f, 0xed];
const P2 = [0xf0, 0x55, 0x9b];

function draw(size, { padding = 0.14, radius = 0.19 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = size * padding;
  const r = size * radius;
  const cardTop = pad;
  const cardBottom = size - pad;
  const cardHeight = cardBottom - cardTop;
  const bandHalf = cardHeight * 0.08;
  const mid = size / 2;

  const put = (x, y, [red, green, blue]) => {
    const i = (y * size + x) * 4;
    rgba[i] = red;
    rgba[i + 1] = green;
    rgba[i + 2] = blue;
    rgba[i + 3] = 255;
  };

  const inRoundedRect = (x, y, left, top, right, bottom, rad) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    const cx = Math.min(Math.max(x, left + rad), right - rad);
    const cy = Math.min(Math.max(y, top + rad), bottom - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  };

  const mix = (base, amount) => base.map((c) => Math.round(c + (255 - c) * amount));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 배경 (모서리 둥근 사각형)
      if (!inRoundedRect(x, y, 0, 0, size - 1, size - 1, r)) continue;
      put(x, y, BG);

      const insideCard = inRoundedRect(x, y, pad, cardTop, size - pad, cardBottom, size * 0.07);
      if (!insideCard) continue;
      if (Math.abs(y - mid) <= bandHalf) continue; // 중립 띠

      if (y < mid) {
        // 위쪽 = P2, 점 패턴
        const period = Math.max(6, Math.round(size / 18));
        const dot = (x % period) < period * 0.34 && (y % period) < period * 0.34;
        put(x, y, dot ? mix(P2, 0.55) : P2);
      } else {
        // 아래쪽 = P1, 사선 패턴
        const period = Math.max(6, Math.round(size / 16));
        const stripe = ((x + y) % period) < period * 0.36;
        put(x, y, stripe ? mix(P1, 0.34) : P1);
      }
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, { padding: 0.12, radius: 0.19 }],
  ['icon-512.png', 512, { padding: 0.12, radius: 0.19 }],
  // maskable 은 안전 영역(중앙 80%) 안에 내용이 들어가야 한다
  ['icon-maskable-512.png', 512, { padding: 0.24, radius: 0.5 }],
];

for (const [name, size, opts] of targets) {
  const png = encodePng(size, size, draw(size, opts));
  writeFileSync(resolve(OUT_DIR, name), png);
  console.log(`${name} — ${size}x${size}, ${png.length} bytes`);
}
