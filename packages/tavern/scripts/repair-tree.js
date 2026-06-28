// @ts-check
/* eslint-disable no-console, no-await-in-loop, @endo/restrict-comparison-operands */
/* global process */

/**
 * Repair a tavern tree.jsonl file by removing oversized lines and/or
 * truncating the tail at a given line number.
 *
 * Two modes:
 *
 * 1. Scan mode (--scan): streams the file and reports all lines above a
 *    size threshold (--scan-threshold, default 100KB). Shows line number,
 *    size, and a content preview. Does not modify anything.
 *
 * 2. Repair mode (default): streams the file and writes a cleaned copy.
 *    - Lines exceeding --max-line-size (default 1MB) are removed. Their
 *      children's parentId is bridged to the removed node's parent so
 *      the conversation chain stays connected.
 *    - If --truncate-at <N> is set, stops writing after line N.
 *    - Writes to <input>.clean, then renames to the original path.
 *    - Use --dry-run to preview without writing.
 *
 * Usage:
 *   node scripts/repair-tree.js <tree.jsonl> --scan
 *   node scripts/repair-tree.js <tree.jsonl> --scan --scan-threshold 50000
 *   node scripts/repair-tree.js <tree.jsonl> --truncate-at 500
 *   node scripts/repair-tree.js <tree.jsonl> --max-line-size 1000000 --truncate-at 500
 *   node scripts/repair-tree.js <tree.jsonl> --dry-run
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const formatBytes = bytes => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const previewContent = (line, maxLen = 200) => {
  let preview;
  try {
    const node = JSON.parse(line);
    const msgs = Array.isArray(node.messages) ? node.messages : [];
    const parts = msgs.map(
      m => `[${m.role || '?'}] ${(m.content || '').slice(0, 80)}`,
    );
    preview = parts.join(' | ');
  } catch {
    preview = line.slice(0, maxLen).replace(/\n/g, ' ');
  }
  return preview.length > maxLen ? `${preview.slice(0, maxLen)}...` : preview;
};

/**
 * Parse argv without external deps (this script shouldn't import from the
 * package — it needs to run on a potentially broken tree without module
 * resolution issues).
 */
const parseArgs = argv => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[name] = true;
        } else {
          flags[name] = next;
          i += 1;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, _: positional };
};

// ── Scan mode ───────────────────────────────────────────────────────────

const scanMode = async (filePath, scanThreshold) => {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  let totalLines = 0;
  let totalBytes = 0;
  const oversized = [];

  console.log(`Scanning ${filePath}`);
  console.log(`Threshold: ${formatBytes(scanThreshold)}`);
  console.log('');

  for await (const line of rl) {
    lineNumber += 1;
    totalLines += 1;
    totalBytes += line.length + 1;

    if (line.length > scanThreshold) {
      oversized.push({
        lineNumber,
        size: line.length,
        preview: previewContent(line),
      });
    }

    if (lineNumber % 50_000 === 0) {
      process.stderr.write(`  scanned ${lineNumber} lines...\r`);
    }
  }

  console.log(`Total lines: ${totalLines}`);
  console.log(`Total size: ${formatBytes(totalBytes)}`);
  console.log(`Oversized lines: ${oversized.length}`);
  console.log('');

  if (oversized.length === 0) {
    console.log('No oversized lines found.');
    return;
  }

  console.log('Oversized lines:');
  for (const { lineNumber: ln, size, preview } of oversized) {
    console.log(`  Line ${ln}: ${formatBytes(size)}`);
    console.log(`    ${preview}`);
    console.log('');
  }

  console.log('To repair, re-run with --truncate-at <N> to cut at a line,');
  console.log('and/or --max-line-size <bytes> to bridge out oversized lines:');
  console.log(`  node scripts/repair-tree.js ${filePath} --truncate-at <N>`);
};

// ── Repair mode ─────────────────────────────────────────────────────────

const repairMode = async (filePath, maxLineSize, truncateAt, dryRun) => {
  /**
   * Map: removedNodeId → its parentId (the ancestor to bridge to).
   * When we encounter a node whose parentId is in this map, we resolve
   * the chain (handles consecutive removals) and rewrite parentId.
   */
  const gapMap = new Map();
  let lineNumber = 0;
  let removedCount = 0;
  let patchedCount = 0;
  let writtenCount = 0;
  let truncated = false;

  // Resolve parentId through the gap chain.
  const resolveParent = parentId => {
    let cursor = parentId;
    const visited = new Set();
    while (gapMap.has(cursor)) {
      if (visited.has(cursor)) break; // safety: cycle
      visited.add(cursor);
      cursor = gapMap.get(cursor);
    }
    return cursor;
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const outPath = dryRun ? null : `${filePath}.clean`;
  let writeStream = null;
  if (outPath) {
    writeStream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  }

  for await (const line of rl) {
    lineNumber += 1;

    if (truncateAt !== null && lineNumber > truncateAt) {
      truncated = true;
      break;
    }

    if (line.length > 0) {
      let node;
      try {
        node = JSON.parse(line);
      } catch {
        // Skip unparseable lines (same as disk backend)
        removedCount += 1;
        node = null;
      }

      if (node) {
        const { id, parentId } = node;

        if (line.length > maxLineSize) {
          gapMap.set(id, resolveParent(parentId));
          removedCount += 1;
          if (dryRun) {
            console.log(`  [remove] line ${lineNumber}: ${formatBytes(line.length)} (id=${id})`);
          }
        } else {
          // Bridge parentId if parent was removed
          let patchedLine = line;
          const resolvedParent = resolveParent(parentId);
          if (resolvedParent !== parentId) {
            patchedCount += 1;
            node.parentId = resolvedParent;
            patchedLine = JSON.stringify(node);
            if (dryRun) {
              console.log(
                `  [patch]  line ${lineNumber}: parentId ${parentId} → ${resolvedParent}`,
              );
            }
          }

          if (!dryRun && writeStream) {
            writeStream.write(`${patchedLine}\n`);
          }
          writtenCount += 1;
        }
      }
    }
  }

  if (writeStream) {
    await new Promise((resolve, reject) => {
      writeStream.end(err => (err ? reject(err) : resolve()));
    });
  }

  console.log(`Lines scanned: ${lineNumber}`);
  console.log(`Lines removed (oversized): ${removedCount}`);
  console.log(`Lines patched (parentId bridged): ${patchedCount}`);
  console.log(`Lines written: ${writtenCount}`);
  if (truncated) {
    console.log(`Truncated at line ${truncateAt}`);
  }

  if (!dryRun && writtenCount > 0) {
    // Backup original
    const backupPath = `${filePath}.bak`;
    await fsp.rename(filePath, backupPath);
    await fsp.rename(outPath, filePath);
    console.log(`Original backed up to ${backupPath}`);
    console.log(`Repaired file written to ${filePath}`);
  } else if (dryRun) {
    console.log('(dry-run — no files modified)');
  }
};

// ── Main ────────────────────────────────────────────────────────────────

const main = async () => {
  const argv = process.argv.slice(2);
  const { flags, _ } = parseArgs(argv);

  const filePath = _[0];
  if (!filePath) {
    console.error('Usage: repair-tree <tree.jsonl> [--scan] [--truncate-at N]');
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);

  try {
    await fsp.access(resolvedPath);
  } catch {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  const stat = await fsp.stat(resolvedPath);
  console.log(`File: ${resolvedPath}`);
  console.log(`Size: ${formatBytes(stat.size)}`);
  console.log('');

  const scan = Boolean(flags.scan);
  const scanThreshold = Number(flags['scan-threshold'] ?? 100_000);
  const maxLineSize = Number(flags['max-line-size'] ?? 1_000_000);
  const truncateAt = flags['truncate-at'] ? Number(flags['truncate-at']) : null;
  const dryRun = Boolean(flags['dry-run']);

  if (scan) {
    await scanMode(resolvedPath, scanThreshold);
  } else {
    console.log(`Max line size: ${formatBytes(maxLineSize)}`);
    if (truncateAt !== null) {
      console.log(`Truncate at line: ${truncateAt}`);
    }
    if (dryRun) {
      console.log('Mode: dry-run');
    }
    console.log('');
    await repairMode(resolvedPath, maxLineSize, truncateAt, dryRun);
  }
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
