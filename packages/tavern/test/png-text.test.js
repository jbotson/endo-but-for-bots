// @ts-check
/* eslint-disable no-bitwise, unicorn/numeric-separators-style, no-continue, @endo/restrict-comparison-operands */
/* global Buffer */

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { readPngCharaText } from '../src/png-text.js';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

const crc32 = buf => {
  let crc = 0xffff_ffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
};

/** Build a minimal PNG (sig + IHDR + chara tEXt + IEND). */
/**
 * @param {object} payloadObject
 */
const buildPng = payloadObject => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, payload) => {
    const typeBuf = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    const crcInput = Buffer.concat([typeBuf, payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeBuf, payload, crc]);
  };
  const ihdrPayload = Buffer.alloc(13);
  // width=1 height=1 bitdepth=8 colortype=2 (RGB) compression/filter=interlace=0
  ihdrPayload.writeUInt32BE(1, 0);
  ihdrPayload.writeUInt32BE(1, 4);
  ihdrPayload[8] = 8;
  ihdrPayload[9] = 2;
  const base64 = Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64');
  const charaPayload = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(base64, 'latin1'),
  ]);
  const iend = Buffer.alloc(0);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdrPayload),
    chunk('tEXt', charaPayload),
    chunk('IEND', iend),
  ]);
};

const writeFile = async (name, contents) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-png-'));
  const p = path.join(dir, name);
  await fs.writeFile(p, contents);
  return p;
};

test('reads + decodes the chara tEXt chunk from a PNG', async t => {
  const payload = {
    spec: '2.0',
    data: { name: 'Seraphina', description: 'guide', system_prompt: 'You are {{char}}.' },
  };
  const p = await writeFile('seraphina.png', buildPng(payload));
  const json = await readPngCharaText(p);
  t.deepEqual(JSON.parse(json), payload);
});

test('throws on a bad PNG signature', async t => {
  const p = await writeFile('bad.bin', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]));
  await t.throwsAsync(() => readPngCharaText(p), { message: /Not a PNG/ });
});

test('throws on a CRC mismatch (corrupt chara chunk)', async t => {
  const payload = { data: { name: 'X' } };
  const good = buildPng(payload);
  // Flip a byte inside the chara payload (well before its trailing CRC).
  const typeIdx = good.indexOf(Buffer.from('tEXt', 'latin1'));
  const corrupted = Buffer.from(good);
  corrupted[typeIdx + 12] ^= 0xff; // 12 inside the chara base64 portion
  const p = await writeFile('corrupt.png', corrupted);
  await t.throwsAsync(() => readPngCharaText(p), { message: /CRC mismatch/ });
});

test('throws when no chara tEXt chunk is present', async t => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, payload) => {
    const typeBuf = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    const crcInput = Buffer.concat([typeBuf, payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeBuf, payload, crc]);
  };
  const ihdrPayload = Buffer.alloc(13);
  ihdrPayload.writeUInt32BE(1, 0);
  ihdrPayload.writeUInt32BE(1, 4);
  ihdrPayload[8] = 8;
  ihdrPayload[9] = 2;
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdrPayload),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const p = await writeFile('nochara.png', png);
  await t.throwsAsync(() => readPngCharaText(p), { message: /No tEXt "chara"/ });
});

test('respects the maxCharaBytes cap', async t => {
  const payload = { data: { name: 'Y', description: 'a'.repeat(50) } };
  const p = await writeFile('y.png', buildPng(payload));
  await t.throwsAsync(() => readPngCharaText(p, { maxCharaBytes: 10 }), {
    message: /exceeds cap/,
  });
});