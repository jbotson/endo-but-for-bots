// @ts-check
/* eslint-disable no-await-in-loop */

import fs from 'node:fs/promises';

import harden from '@endo/harden';

/** @import { ConversationNode, TreeBackend } from '../types.js' */

/**
 * Disk-backed `TreeBackend` for `@endo/conversation-tree`.
 *
 * The conversation tree is persisted as an **append-only JSONL** file: one
 * `ConversationNode` per line, `{id, parentId, messages, metadata,
 * timestamp}`. Siblings are simply later lines sharing a `parentId`.
 *
 * Reads are served from an in-memory `Map<id, ConversationNode>` loaded once
 * at construction by scanning the file (histories are small; a streaming
 * indexed reader is a later optimization). Every `putNode` appends to the
 * file *and* updates the in-memory map, so subsequent reads see the new
 * node without re-reading the file.
 *
 * A trailing partial / un-terminated last line (e.g. from a crash mid-append)
 * is skipped on load and logged to stderr.
 *
 * @param {string} treePath - absolute path to the `tree.jsonl` file
 * @param {{ fsync?: boolean }} [opts] - per-append `fsync` for crash durability
 * @returns {Promise<TreeBackend>}
 */
export const makeDiskBackend = async (treePath, opts = {}) => {
  const fsync = opts.fsync ?? false;

  /** @type {Map<string, ConversationNode>} */
  const nodes = new Map();

  // Whether the loaded file lacks a trailing newline. If so, the next append
  // prepends a newline so the new node starts on its own line (otherwise it
  // would merge onto the last existing line and corrupt both on reload).
  let needsLeadingNewline = false;

  const load = async () => {
    let text;
    try {
      text = await fs.readFile(treePath, 'utf8');
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ENOENT') {
        return; // fresh agent — no tree yet
      }
      throw error;
    }
    if (text.length === 0) return;
    if (!text.endsWith('\n')) {
      needsLeadingNewline = true;
    }

    const lines = text.split('\n');
    // A trailing newline yields a final empty element; drop it.
    if (lines[lines.length - 1] === '') lines.pop();
    let skipped = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length === 0) {
        skipped += 1;
      } else {
        try {
          const node = JSON.parse(line);
          if (node && typeof node.id === 'string') {
            nodes.set(node.id, node);
          } else {
            skipped += 1;
          }
        } catch (error) {
          // Skip the trailing partial line silently unless it's mid-file.
          if (i !== lines.length - 1) {
            console.error(
              `[tavern/disk-backend] skipping unparseable line ${
                i + 1
              } of ${treePath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          skipped += 1;
        }
      }
    }
    if (skipped > 0) {
      console.error(
        `[tavern/disk-backend] ${treePath}: skipped ${skipped} partial/corrupt line(s) on load`,
      );
    }
  };

  await load();

  /**
   * Append one node line to disk + memory. Returns once the OS has accepted
   * the bytes (and optionally `fsync`ed them).
   *
   * @param {ConversationNode} node
   */
  const append = async node => {
    const line = `${JSON.stringify(node)}\n`;
    // 'a' opens (and creates) the file for appending.
    const fh = await fs.open(treePath, 'a');
    try {
      // Ensure this node starts on its own line. A prior writer (import,
      // hand-edit, or a crash) may have left the file without a trailing
      // newline; naively appending would merge the new node onto the last
      // line and corrupt both on reload.
      if (needsLeadingNewline) {
        await fh.write('\n');
        needsLeadingNewline = false;
      }
      await fh.writeFile(line);
      if (fsync) {
        await fh.sync();
      }
    } finally {
      await fh.close();
    }
    nodes.set(node.id, node);
  };

  const ensureDir = async () => {
    const dir = treePath.slice(0, Math.max(0, treePath.lastIndexOf('/')));
    if (dir) {
      await fs.mkdir(dir, { recursive: true });
    }
  };

  // Ensure the parent directory exists so the first append doesn't fail.
  await ensureDir();

  /** @type {TreeBackend} */
  const backend = {
    async putNode(node) {
      await append(node);
    },

    async getNode(id) {
      return nodes.get(id) ?? null;
    },

    async getChildren(parentId) {
      /** @type {ConversationNode[]} */
      const children = [];
      for (const node of nodes.values()) {
        if (node.parentId === parentId) {
          children.push(node);
        }
      }
      return children;
    },

    async getRoots() {
      return /** @type {any} */ (backend).getChildren(null);
    },
  };

  return harden(backend);
};
harden(makeDiskBackend);