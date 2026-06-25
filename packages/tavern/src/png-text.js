// @ts-check
/* eslint-disable no-await-in-loop, no-continue */
/* global Buffer */

import fs from 'node:fs/promises';
import path from 'node:path';

import harden from '@endo/harden';

/**
 * Read the embedded `chara` tEXt chunk from a SillyTavern character PNG
 * and return the base64-decoded byte string (callers `JSON.parse` it).
 *
 * SillyTavern embeds the V2 character card as base64-encoded JSON in a
 * PNG `tEXt` chunk whose keyword is `chara`. We only need that chunk;
 * every other chunk type is ignored.
 *
 * Safety:
 *  - verify the 8-byte PNG signature
 *  - walk chunks without buffering the whole file
 *  - validate each chunk's declared length against the remaining file
 *    size before allocating a buffer for it (rejects zip-bomb attempts)
 *  - cap the `chara` payload at `MAX_CHARA_BYTES` (cards are KB-sized)
 *  - verify each chunk's trailing CRC32 against (type ‖ payload)
 *  - stop at `IEND`
 *
 * @param {string} file path to a PNG file
 * @param {{ maxCharaBytes?: number }} [opts]
 * @returns {Promise<string>} base64-decoded payload (a JSON string)
 */
export const readPngCharaText = async (file, opts = {}) => {
  const maxCharaBytes = opts.maxCharaBytes ?? 10 * 1024 * 1024;
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;

    // 1. PNG signature.
    const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sigBuf = Buffer.alloc(8);
    await handle.read(sigBuf, 0, 8, 0);
    if (!sigBuf.equals(SIG)) {
      throw new Error(`Not a PNG file: bad signature (${path.basename(file)})`);
    }

    let cursor = 8;
    const lenBuf = Buffer.alloc(4);
    const typeBuf = Buffer.alloc(4);
    const crcBuf = Buffer.alloc(4);

    while (cursor < size) {
      // 2. chunk header: 4-byte big-endian length + 4-byte type.
      await handle.read(lenBuf, 0, 4, cursor);
      const length = lenBuf.readUInt32BE(0);
      await handle.read(typeBuf, 0, 4, cursor + 4);
      const type = typeBuf.toString('latin1');

      // 3. bounds check the declared length vs remaining file.
      //    header(8) + payload(length) + crc(4) must fit.
      const remaining = size - (cursor + 8);
      if (length > remaining - 4) {
        throw new Error(
          `PNG chunk "${type}" declares length ${length} exceeding remaining ${remaining} bytes`,
        );
      }

      const payload = Buffer.alloc(length);
      if (length > 0) {
        await handle.read(payload, 0, length, cursor + 8);
      }
      await handle.read(crcBuf, 0, 4, cursor + 8 + length);
      const declaredCrc = crcBuf.readUInt32BE(0);

      // 4. verify CRC32 over (type ‖ payload).
      const crcInput = Buffer.concat([typeBuf, payload], 4 + length);
      const computed = crc32(crcInput);
      if (computed !== declaredCrc) {
        throw new Error(
          `PNG chunk "${type}" CRC mismatch (declared ${declaredCrc}, computed ${computed})`,
        );
      }

      cursor += 12 + length;

      if (type === 'IEND') {
        break;
      }

      // 5. the only chunk we care about is tEXt keyword "chara".
      if (type === 'tEXt') {
        const nul = payload.indexOf(0);
        if (nul < 0) {
          // not the chara chunk; keep walking
          continue;
        }
        const keyword = payload.subarray(0, nul).toString('latin1');
        if (keyword !== 'chara') {
          continue;
        }
        if (length > maxCharaBytes) {
          throw new Error(
            `PNG chara payload is ${length} bytes, exceeds cap ${maxCharaBytes}`,
          );
        }
        const base64 = payload.subarray(nul + 1).toString('latin1');
        return Buffer.from(base64, 'base64').toString('utf8');
      }
    }

    throw new Error(`No tEXt "chara" chunk found in ${path.basename(file)}`);
  } finally {
    await handle.close();
  }
};
harden(readPngCharaText);

/* eslint-disable no-bitwise, unicorn/numeric-separators-style */

/** Lazily-built CRC32 lookup table. */
let crcTable = null;

/**
 * @returns {Uint32Array}
 */
const makeCrcTable = () => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
};

/**
 * Standard PNG CRC32 (reflected, init 0xffffffff, xorout 0xffffffff).
 *
 * @param {Buffer} buf
 * @returns {number} unsigned 32-bit CRC
 */
const crc32 = buf => {
  crcTable = crcTable ?? makeCrcTable();
  let crc = 0xffff_ffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
};
/* eslint-enable no-bitwise, unicorn/numeric-separators-style */