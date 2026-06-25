# Tavern — an Endo agent framework that imports SillyTavern characters

Status: **Draft for review** (no code written yet)
Date: 2026-06-24
Working name: **`tavern`** (adjustable): the "tavern" inside Endo, where
SillyTavern characters come to live as autonomous agents.

---

## 1. Goal

Build an **Endo agent framework**, structurally similar to `@endo/fae`, that can:

1. **Import a SillyTavern character card** (PNG-with-embedded-JSON or `.json`,
   V1 or V2) and run that character as an Endo agent with **roughly the same
   prompts** SillyTavern would have produced.
2. **Import a SillyTavern chat export** (`.jsonl`) so the agent starts with
   **roughly the same conversation history** the user already had.
3. **Persist conversation history to disk** so it is **never lost on restart**.
4. **Update prompts without recreating the agent** — re-importing or editing the
   card changes the live system prompt for the *existing* agent, preserving all
   history. No fresh-agent-on-prompt-change (explicitly unlike fae, which starts
   a fresh tree when the system prompt changes).

**Out of scope (v1), planned for later:**
- SillyTavern UI / ST-side extension / server plugin (the earlier "bridge into
  SillyTavern" idea is abandoned). The agent is interacted with through Endo's
  mail/chat (`@endo/chat`, `endo inbox`, other agents).
- **Branching / swipes**: v1 history is **linear**, but the implementation uses a
  **conversation tree** (linear = a degenerate tree) specifically so swipes/branches
  can be added later without restructuring. See §3.3.
- Exact ST prompt parity (world-info/lorebook activation, regex scripts, instruct
  formatting, token-budget trimming, depth-anchor injection): we aim for *rough*
  parity from the card's own fields.

---

## 2. One package in the Endo monorepo

Per review, we drop the two-part split. Everything lives in a single new package:

```
endo-but-for-bots/packages/tavern/
```

This is the key simplification: because we're inside the monorepo, the unpublished
`@endo/lal` (LLM provider) and `@endo/conversation-tree` deps resolve normally —
exactly like `packages/fae` does. No standalone importer repo, no inter-component
disk contract, no `file:`-dependency hacks.

The importer (which parses ST PNG/JSON/JSONL) lives in the **same package** as a
set of scripts. It needs only Node built-ins for parsing, but co-location means
it can also reuse the package's own disk-tree abstractions to write history.

### 2.1 Why this is simpler than the previous design
- No "importer repo" + "caplet repo" + a disk contract between them — it's one
  package, internal files only.
- The earlier constraints (unpublished deps forcing a split) vanish in-workspace.
- The importer reuses the same `makeDiskBackend` + `makeConversationTree` the
  driver uses, so import and runtime share one history format.

---

## 3. Core idea: disk-backed conversation tree

The central technical choice, and the main place this diverges from fae:

- **fae** persists its conversation tree in the **Endo daemon's petstore** via
  `makeEndoPetstoreBackend(powers)` (see `packages/fae/agent.js`). That works and
  survives daemon restarts (the petstore is persisted by the daemon), but the user
  wants history on **plain disk**: inspectable, portable, re-importable, and not
  coupled to daemon-internal storage.
- **tavern** introduces a new **disk backend** for `@endo/conversation-tree`:
  `makeDiskBackend(stateDir)`. The tree is persisted as an append-only JSONL file
  on the host filesystem. The caplet is `--UNCONFINED` (imports `fs`, like fae's
  filesystem tools), so it can read/write this directly.

### 3.1 The `TreeBackend` we implement

`@endo/conversation-tree`'s `TreeBackend` interface is just four methods
(`packages/conversation-tree/types.js`):

```ts
putNode(node): Promise<void>
getNode(id): Promise<ConversationNode | null>
getChildren(parentId): Promise<ConversationNode[]>
getRoots(): Promise<ConversationNode[]>
```

`makeDiskBackend(treePath)` implements these against `tree.jsonl`:

- **File format**: one `ConversationNode` JSON per line: `{id, parentId,
  messages, metadata, timestamp}`. Append-only (siblings are just later lines
  sharing a `parentId`).
- **`putNode`**: `fs.appendFile(treePath, JSON.stringify(node) + '\n')`.
- **`getNode/getChildren/getRoots`**: load is "read all lines → `Map<id,node>` once,
  cache in memory"; subsequent appends update the cache. (Histories are small
  enough that a full load is fine; a streaming/indexed read is a v2 optimization.)
- Crash-safety: appends are newline-terminated; a trailing partial line is
  skipped on load (logged). Optional `fsync` toggle for stricter durability.

This is essentially fae's `makeEndoPetstoreBackend` (`packages/conversation-tree/
src/endopetstore-backend.js`) with `E(powers).storeValue/lookup/list` swapped for
`fs.appendFile` + an in-memory map. ~50 lines.

### 3.2 Why a tree (not a linear log), even though v1 is linear

- **Future swipes/branching for free.** Swipes = sibling nodes under the same
  parent; `getChildren(parentId)` already enumerates them. A linear log would
  force a structural rewrite when we add branching. The tree avoids that.
  v1 simply always appends a single child to the current leaf — a degenerate
  tree. No special-case code; swipes later just create alternate siblings and
  track the "active leaf."
- **Reuse fae's loop logic.** fae's `runAgenticLoop` already drives a tree
  (`tree.getPath(leafId)`, `tree.addNode(leafId, [...])`). tavern's driver is a
  lightly modified fae loop pointed at the disk-backed tree.
- **`@endo/conversation-tree` is in-workspace**, so we reuse it directly instead
  of hand-rolling a transcript manager.

### 3.3 Disk layout (internal to the package — no contract)

Per agent, one directory. Default root = Endo state dir + `tavern/<agent>/`
(resolved like `whereEndoState`), configurable via `stateDir` passed to
`createAgent`.

```
<state>/tavern/<agent-name>/
├── tree.jsonl      # disk-backed conversation tree (append-only, one node/line)
├── agent.json      # resolved config incl. systemPrompt — RE-READ EACH TURN (§5)
├── card.json       # raw imported ST card, verbatim (reference/audit)
├── state.json      # bookkeeping (lastProcessedMessageNumber, schemaVersion)
└── imports.log     # append-only audit of import runs
```

All of this is internal to `packages/tavern`; nothing outside the package reads
or writes these files (except the user, for inspection).

---

## 4. Prompt-update-without-recreate (the key requirement)

fae bakes the system prompt into an **immutable root node** and, on prompt change,
starts a **fresh conversation tree** (`getOrCreateRoot` in `agent.js`:
"System prompt changed, creating fresh conversation tree"). The user explicitly
does **not** want this.

tavern's solution: **the system prompt lives outside the tree**, in `agent.json`,
and is injected at LLM-call time. The tree stores only conversation turns
(user/assistant/tool). Therefore:

- Editing the card + re-importing **rewrites `agent.json`** (new `systemPrompt`),
  leaves `tree.jsonl` untouched → the next turn uses the new prompt over the
  **entire existing history**. No agent recreation, no history loss.
- The driver **reloads `agent.json` at the start of each turn** (it's a tiny file
  read once per inbox message, not per LLM round), so prompt edits take effect on
  the next message even with no restart.
- LLM input each turn is assembled as
  `[ { role:'system', content: agentJson.systemPrompt }, ...tree.getPath(leafId) ]`
  (plus the ephemeral `post_history_instructions` tail and a `depth_prompt`
  insertion — §6.2), **never** read from a stored root node.

This is a small, clean, deliberate deviation from fae's loop — the only structural
change needed to satisfy "don't recreate on prompt change."

### 4.1 Why we store a root node in the tree at all
Optionally we still record a root node at import time (containing the initial
system prompt) purely so `tree.jsonl` is a **stand-alone, re-importable**
transcript. The driver **never trusts** it as the live prompt (`agent.json` is
authoritative). It's metadata-for-portability only.

---

## 5. `agent.json` (the resolved, editable config)

```jsonc
{
  "schemaVersion": 1,
  "agentName": "seraphina",
  "characterName": "Seraphina",
  "userName": "User",
  "personaDescription": "",
  "systemPrompt": "<full resolved system prompt>",        // used each turn
  "postHistoryInstructions": "<resolved string>",          // ephemeral tail
  "depthPrompt": { "depth": 4, "role": "system", "prompt": "<resolved>" },
  "promptInputs": {                                       // audit/repro
    "include": { "description": true, "personality": true, "scenario": true,
                 "mes_example": true, "first_mes": false,
                 "post_history_instructions": true, "depth_prompt": true },
    "useCardSystemPrompt": true,
    "alternateGreetingIndex": 0
  },
  "promptHash": "sha1:...",   // informational only — NEVER used to recreate
  "provider": { "name": "default" },
  "model": null,              // optional override of provider's model
  "importedAt": "2026-06-24T12:00:00Z",
  "cardPath": "/path/to/Seraphina.png",
  "chatPath":  "/path/to/chat.jsonl",
  "fsync": false              // optional per-append fsync for crash durability
}
```

`agent.json` is written by the importer and re-read by the driver each turn. It
holds no secrets (the LAL auth token stays in the daemon petstore via the fae/lal
provider flow — §7).

---

## 6. SillyTavern import (card + chat)

Implemented as scripts in the package (e.g. `scripts/import-card.js`,
`scripts/import-chat.js`, `scripts/import-all.js`), runnable via
`endo run --UNCONFINED ... --powers @agent` or plain `node` (they only need `fs`).

### 6.1 Card → `agent.json` + `card.json`

- **PNG**: read the `chara` tEXt chunk, base64-decode, `JSON.parse`. (V2 spec
  embeds the card there.) Hand-rolled PNG tEXt reader (~30 lines, no dep) or
  `pngjs` if we accept one dep.
- **JSON**: parse directly.
- **V1** (flat `{name, description, ...}`) → promote to V2 shape under `data`.
- `card.json` = the **raw** card bytes verbatim (spec: never destroy unknown
  `extensions`).
- Resolve usable fields from `data` (V2) with V1 fallback.

**Prompt resolution** (`src/prompt.js`):

1. **Base system prompt**
   - If `data.system_prompt` non-empty and `useCardSystemPrompt` true: use it,
     substituting `{{original}}` → a sane fallback ("You are {{char}}. Respond in
     character.").
   - Else assemble from fields enabled by `include`: `description`,
     `personality`, `scenario`, `mes_example` (as example dialogue), `first_mes`
     (only as "greeting context" if `--include first_mes` and not seeded as history).
2. **Macros** (subset, `src/macros.js`): `{{char}}`→`data.name`, `{{user}}`→userName,
   `{{original}}`→fallback, `{{persona}}`→personaDescription, plus whitespace
   collapse. (No STscript/regex — documented limitation.)
3. **post_history_instructions**: if non-empty, resolved + stored; the driver
   injects it as an ephemeral tail system message each turn (not persisted into
   the tree).
4. **depth_prompt**: `data.extensions.depth_prompt` → `{depth, role, prompt}`;
   driver injects it N messages before the end (best-effort in v1).
5. **character_book (lorebook)**: v1 = **not scanned** (documented). Stored in
   `card.json` for future v2 keyword activation.

### 6.2 Chat export → `tree.jsonl`

- Line 1 = header `{ user_name, character_name, chat_metadata }`. `user_name` →
  `agent.json.userName` if not overridden by CLI.
- Each subsequent line = `{ name, is_user, is_system, mes, send_date, extra,
  swipe_id, swipes?, ... }`.
  - `is_user` → `role:"user"`, `name`=userName.
  - `is_system` → skipped by default (ST UI affordances); `--keep-system` includes
    them as `role:"system"`.
  - else → `role:"assistant"`, `name`=characterName (or message `name`).
  - `mes` → content; if `swipes` present, use `swipe_id` to pick the active one.
- **Import builds a linear chain of tree nodes** via `makeConversationTree(
  makeDiskBackend(...))`: a root node (system prompt from the card at import
  time, for portability — §4.1) then one child node per imported message,
  parented to the previous. (`addNode` accepts a `metadata.nodeId`, so we can use
  stable ids like the ST `send_date` for traceability.)
- A real ST chat export already contains the first message (the greeting), so we
  don't special-case `first_mes`/`alternate_greetings` during chat import — we
  import what's in the file. If a chat export is *not* provided but the card has
  `first_mes`, the importer can optionally seed the tree with the chosen greeting
  (governed by `--include first_mes`).
- `--replace` overwrites `tree.jsonl`; default behavior for `import-all` is to
  create fresh (warns if `tree.jsonl` exists without `--replace`).

### 6.3 Write semantics (no-recreate guarantee)

`import-card` **always overwrites `agent.json`** but **never touches
`tree.jsonl`** (unless paired with `import-chat --replace`). This is the single
most important property: edit card → re-import card → next turn uses the new
prompt over the full existing history.

---

## 7. Provider & configuration

- Reuse the **existing LAL provider** flow unchanged. Provider provisioning stays
  the fae/lal way (`setup` + `create-provider` or the factory form). tavern's
  driver consumes the named `llm-provider` value from the Endo petstore, exactly
  like fae's driver (`await E(powers).lookup('llm-provider')` → `createProvider`).
- `agent.json.provider.name` selects which stored provider (default `default`).
- `agent.json.model` optionally overrides the provider's model.
- **Secrets never touch the importer or `agent.json`.** The LAL auth token lives
  only in the daemon petstore via the lal/fae flow.

---

## 8. The caplet package (`packages/tavern`)

Mirrors `packages/fae` so it slots into the existing toolchain (yarn workspace,
`endo run --UNCONFINED`, `@pins`/`revivePins()`).

```
packages/tavern/
├── package.json            # workspace:^ deps: @endo/lal, @endo/conversation-tree,
│                           #   @endo/errors, @endo/eventual-send, @endo/exo,
│                           #   @endo/patterns, @endo/far, @endo/harden,
│                           #   @endo/promise-kit, @endo/fae (tool-makers), @endo/where
├── agent.js                # Factory: make(guestPowers, _ctx) → TavernFactory exo
├── driver.js               # Per-agent driver caplet (disk tree + loop)
├── setup.js                # Provision the tavern factory guest (like fae/setup.js)
├── tavern-factory-setup.js # Bind factory to a provider (like fae-factory-setup.js)
├── scripts/
│   ├── import-card.js      # CLI: card → agent.json + card.json
│   ├── import-chat.js      # CLI: chat.jsonl → tree.jsonl
│   ├── import-all.js       # CLI: both
│   └── create-agent.js     # CLI: call TavernFactory.createAgent over the daemon
├── src/
│   ├── disk-backend.js     # makeDiskBackend(treePath) — TreeBackend over JSONL
│   ├── agent-state.js      # load/save agent.json + state.json
│   ├── provider.js         # resolve stored llm-provider → @endo/lal createProvider
│   ├── card.js             # parse ST card PNG/JSON → normalized (V1/V2)
│   ├── png-text.js         # read tEXt "chara" chunk
│   ├── chat.js             # parse ST .jsonl → messages + meta
│   ├── prompt.js           # card + persona + macros → systemPrompt/PHI/depthPrompt
│   ├── macros.js           # {{char}}/{{user}}/{{original}} ... subset
│   ├── tool-makers.js      # thin re-export of @endo/fae/src/tool-makers.js (or trimmed copy)
│   └── names.js            # petname validation, slug rules, state-dir resolution
├── tools/                  # optional example tool caplets (drop fae's greet/math)
└── test/                   # ava tests (parsers, disk-backend, loop)
```

### 8.1 Factory (`agent.js`)

`make(guestPowers, _ctx)` returns an exo `TavernFactory`:

```
createAgent(name, { stateDir, providerName?, pin? }) → profileName
```

- Like fae's `createAgent`, but **no `systemPrompt` argument** — the prompt lives
  on disk in `agent.json`, which is exactly what lets prompts change without
  recreation (§4).
- Creates the agent guest (inbox, petstore) + a driver guest; writes the two
  capability refs (`llm-provider`, `agent`) into the driver's namespace — same
  pattern as fae's factory.
- Launches the driver caplet via `makeUnconfined`, passing env:
  `TAVERN_STATE_DIR=<state>`, `TAVERN_AGENT_NAME=<name>`,
  `TAVERN_PROVIDER_NAME=<name>`.
- `pin:true` → copy the driver result into `@pins` for restart survival (§10).

### 8.2 Driver (`driver.js`) — the inbox/LLM loop with disk history

Adapted from fae's `spawnWorkerLoop` (`packages/fae/agent.js`):

1. **Read disk state**:
   - `agent-state.js` loads `agent.json` (→ current systemPrompt, PHI, depthPrompt,
     providerName, model) and `state.json` (→ lastProcessedMessageNumber).
   - `makeDiskBackend(stateDir+'/tree.jsonl')` + `makeConversationTree` → load
     the existing tree; cache root + current leaf id.
2. Resolve the LLM provider: `lookup(providerName)` → `{host,model,authToken}` →
   `createProvider(...)` (`@endo/lal`). Cache; re-resolve on provider change.
3. Build `localTools` (petstore ops + mail + `exec` + `adoptTool`; reuse fae's
   makers — §9).
4. Message-following loop (`makeRefIterator(followMessages())`), per fae:
   - For each inbox message with `number > lastProcessedMessageNumber`:
     a. Serialize per-agent (one message at a time).
     b. **Reload `agent.json`** → fresh systemPrompt/PHI/depthPrompt (live edit).
     c. Append the incoming user text as a tree node (child of current leaf):
        `{role:'user', content, meta:{messageNumber}}`. Update `currentLeafId`.
     d. Run the **agentic loop**: `chat([systemFromAgentJson, ...tree.getPath(leaf)],
        toolSchemas)`. On tool calls → execute → `tree.addNode(leaf, [assistant,
        ...toolResults])`. Loop until no tool calls. (Tool calls/results land on
        disk as tree nodes, exactly as fae lands them in its tree.)
     e. Final assistant content → `reply()` to sender; `tree.addNode(leaf,
        [assistant])`.
     f. `dismiss()`; advance `lastProcessedMessageNumber` in `state.json`.
   - Race `next()` against a cancelled promise; clean return of the iterator.

The only structural differences from fae's loop:
- backend = disk (not petstore);
- system prompt pulled from `agent.json` per turn (not a stored root);
- history persists to `tree.jsonl` (not the daemon petstore).

### 8.3 `disk-backend.js` — the crucial bit

```js
makeDiskBackend(treePath) → TreeBackend
```
- `putNode`: `fs.appendFile(path, JSON.stringify(node)+'\n')` + update in-memory
  `Map<id,node>`.
- `getNode/getChildren/getRoots`: served from the in-memory map, loaded once on
  construction by reading all lines (`JSON.parse` each; skip partial trailing
  line).
- ~50 lines; directly analogous to `endopetstore-backend.js`.

---

## 9. Tools

v1 reuses fae's built-in tools by **importing** its makers (fae's `package.json`
already exports `./src/tool-makers.js`):

```js
import {
  makeListPetnamesTool, makeLookupTool, makeStoreTool, makeRemoveTool,
  makeAdoptToolTool, makeSendTool, makeReplyTool, makeListMessagesTool,
  makeDismissTool, makeExecTool, makeReadChannelTool,
} from '@endo/fae/src/tool-makers.js';
```

This gives the imported ST character fae-level agency (petstore, mail, other
agents, `exec` in SES, channel read). Tool results are appended as tree nodes
(`role:"tool"` / `role:"assistant"` with `tool_calls`), so the agentic transcript
persist exactly like ordinary turns.

No filesystem-caplets shipped in v1 (the agent's own state dir is managed by the
driver, not exposed as a tool, to prevent corrupting `tree.jsonl`). A dedicated
"read my own history" tool is a nice v2.

---

## 10. Crash & restart correctness (the point of disk persistence)

| Event | Behavior |
|---|---|
| Daemon restart (clean) | `@pins` → `revivePins()` re-launches `driver.js` → re-reads `tree.jsonl` from disk → continues. History intact (the whole reason we chose disk). |
| Driver crash mid-agentic-loop | Partial tree on disk (assistant + tool nodes so far). `lastProcessedMessageNumber` **not** advanced → on restart the same inbox message re-runs. **Idempotency rule:** before appending the user node, the driver checks the most recent leaf's `meta.messageNumber`; if it equals the incoming number, it **skips the append** and resumes the loop from the existing partial leaf (v1 simplification: re-runs the LLM for that user turn — see note). |
| Disk full / append fails | Loop errors → `reply` with error → do **not** `dismiss` (leave message for retry). Surface in `state.json`. |
| `tree.jsonl` corrupted (partial line) | `load()` skips the trailing incomplete line (logged). |
| `agent.json` missing/unreadable | Driver sends an error reply asking the user to run the importer. |
| Duplicate import | `imports.log` + `promptHash` make it visible; importer warns if `tree.jsonl` exists without `--replace`. |

**v1 idempotency simplification:** the driver appends the user node and
*immediately* writes the advanced `lastProcessedMessageNumber`, then runs the
loop. On crash+restart, the last user turn may have no assistant reply yet; the
driver detects (latest leaf is a `user` node with `meta.messageNumber === N`) and
re-runs the LLM for it (appending fresh assistant output). This can produce a
*different* reply than the lost one — acceptable, documented. (A v2
deterministic "reply in progress" marker would avoid this.)

---

## 11. Security

- The driver is `--UNCONFINED` (imports `fs`, like fae's FS tools) but FS access
  is **scoped to that agent's state dir** by validated path joins; no
  user-controlled path escapes it (same `resolveSafe` pattern as fae's tools).
- `exec` tool exposure is fae's existing behavior (JS with guest powers in SES);
  inherited, documented.
- Secrets (LAL auth token) live only in the Endo petstore via the lal/fae flow;
  neither the importer nor `agent.json` ever contains them.
- `agent.json` is editable plain text on the user's own machine; the host is
  trusted (consistent with Endo's threat model).

---

## 12. Dependencies (all workspace-resolvable)

```
@endo/lal, @endo/conversation-tree, @endo/fae (tool-makers),
@endo/errors, @endo/eventual-send, @endo/exo, @endo/patterns,
@endo/far, @endo/harden, @endo/promise-kit, @endo/where, @endo/daemon (makeRefIterator)
```

All resolve in-workspace. `@endo/lal`, `@endo/conversation-tree`, `@endo/fae`,
`@endo/ses` are **unpublished** to npm (verified 2026-06-24) — this is exactly why
the package lives in the monorepo. The importer's PNG/JSON/JSONL parsing uses only
Node built-ins (optionally `pngjs`), so it adds no cross-package dependency.

---

## 13. Setup & usage walkthrough (end to end)

```sh
# 0. Endo daemon running, fae-style provider already provisioned (one time):
#    cd ~/Projects/Internet/endo-but-for-bots/packages/fae && yarn setup && yarn create-provider

# 1. Provision the tavern factory (once):
cd ~/Projects/Internet/endo-but-for-bots/packages/tavern
yarn setup                       # provision tavern factory guest (like fae/setup.js)
yarn tavern-factory-setup        # bind factory to "default" provider (like fae-factory-setup.js)

# 2. Import a SillyTavern character + chat into disk state:
node scripts/import-all.js --card ~/Downloads/Seraphina.png \
                            --chat  ~/Downloads/Seraphina.chat.jsonl \
                            --agent seraphina \
                            --persona "A curious traveler"
# → writes <state>/tavern/seraphina/{tree,agent,card,state}.json*

# 3. Create the live agent in Endo (binds the driver to that disk state):
yarn create-agent seraphina --pin
#   → TavernFactory.createAgent('seraphina', { stateDir, pin:true })

# 4. Talk to the character through Endo (mail/chat UI / @endo/chat):
endo send --as @host seraphina "Hi! Remember our last conversation?"
endo inbox --as @host --follow

# 5. Later: update the character card without losing history:
node scripts/import-card.js --card ~/Downloads/Seraphina-v2.png --agent seraphina
# → agent.json rewritten; tree.jsonl untouched; next message uses the new prompt.
```

(`yarn create-agent` wraps `scripts/create-agent.js`, which calls
`TavernFactory.createAgent` over the daemon client like fae's
`fae-factory-setup.js` calls `createAgent`.)

---

## 14. Branching / swipes — how v1 leaves the door open

v1 is linear: each turn appends a single child to the current leaf, and we track
one `currentLeafId`. The tree already supports more:

- **Swipes** = `tree.addNode(currentLeaf.parentId, [altAssistant])` (a sibling),
  then set `currentLeafId` to the new sibling. `getChildren(parent)` enumerates
  alternatives.
- **Regenerate** = same as a swipe (a new sibling under the user node), choosing a
  different active leaf.
- **Edit** = a new sibling with edited content (preserving the original), or a
  metadata flag.
- ST chat import already preserves `swipes`/`swipe_id` in node `metadata.st`, so
  re-importing a branched chat keeps the active branch and records alternatives.

No v1 code path hard-codes "linear only"; the only v1 limitation is that the
driver doesn't yet *create* siblings or expose leaf selection. Adding it is a
driver change, not a storage/format change — the disk tree already models it.

---

## 15. Milestones (post-review)

1. **`disk-backend.js`** + ava tests (put/get/children/roots, append, partial-line
   tolerance).
2. **Import parsers**: `card.js` + `png-text.js` + `prompt.js` + `macros.js`
   with tests against a sample V2 PNG and a V1 JSON → `agent.json` + `card.json`.
3. **`chat.js`**: JSONL parse → disk tree import; tests.
4. **Importer CLI** (`scripts/import-*.js`) + state-dir resolution; end-to-end dry
   run on sample files.
5. **`driver.js`** minimal loop: load disk tree + `agent.json` → one chat call →
   append → reply.
6. **Factory + setup + create-agent script**: `createAgent` wires the driver,
   pinning.
7. **Agentic loop + tools**: wire fae tool-makers; tool calls appended to disk tree.
8. **Restart survival**: pin → kill daemon → verify history intact from disk.
9. **Prompt-update-no-recreate**: edit card → re-import → verify new prompt + same
   history.
10. **Docs + install walkthrough.**

---

## 16. Limitations & non-goals (recap)

- Rough (not exact) ST prompt parity: no world-info/lorebook activation, no regex
  scripts, no instruct formatting, no token-budget trimming in v1.
- Linear history in v1 (tree supports branching; driver doesn't create siblings
  yet — §14).
- Character book not scanned (stored for v2).
- Macro support is a subset.
- Interacted with via Endo mail/chat, not SillyTavern.
- Mid-turn crash may regenerate a *different* assistant reply on restart (§10).

---

## 17. Open questions — resolved

- **A. Importer-first ordering — APPROVED.** The importer runs first (writes disk
  state), and `createAgent` binds a driver to an existing dir. `agent.json` must
  exist for the driver to start, so no agent before import.
- **B. Expose importer as an Endo tool — future must, out of v1 scope.** The user
  wants agents to be able to spawn new agents later. v1 keeps import as a
  host-side action, but the importer is structured as **reusable functions**
  (not just CLI scripts) so a future Endo tool wrapper is a thin adapter. Concretely:
  - `src/import.js` exposes `importCard(opts) → result` and
    `importChat(opts) → result` as pure-ish functions (read files, write state
    dir, no `process.argv`/`process.exit`).
  - `scripts/import-card.js` / `scripts/import-chat.js` / `scripts/import-all.js`
    are **thin CLI adapters** over `import.js` (parse argv, call the funcs).
  - A future `tool-makers.js` `makeImportTool(powers)` can wrap `import.js` in a
    FaeTool exo (with the agent's own `powers` providing the state dir) to let a
    running agent import/refresh another character. No code written for that in
    v1, but the seam exists.
- **C. Crash idempotency — APPROVED (fallback for v1).** Accept that a crashed
    mid-reply turn may regenerate a *different* assistant reply on restart. More
    resiliency (deterministic "reply in progress" marker) is punted to later.
- **D. PNG parsing — APPROVED (hand-rolled, hardened, with CRC verification).**
  The parser walks chunks defensively; CRC32 verified (~20 lines, table built
  lazily). See §6.1.1 for the exact safe-parsing recipe.

### 6.1.1 Safe hand-rolled PNG tEXt reader (`src/png-text.js`)

We only need to read the embedded `chara` tEXt chunk. Implementation is safe by
construction:

1. Verify the 8-byte PNG signature (`89 50 4E 47 0D 0A 1A 0A`); else throw.
2. Walk chunks **without buffering the whole file**: for each, read 4-byte type +
   4-byte big-endian length, then `fs.read(fd, buf, 0, length, offset)` for just
   that payload, then 4-byte CRC.
3. **Validate `length <= fileStat.size - currentOffset`** before any allocation
   (rejects crafted huge lengths / zip-bomb attempts).
4. **Cap the `chara` payload** at 10 MiB (character cards are KB-sized); throw
   otherwise.
5. **Verify the 4-byte chunk CRC32** against (type ‖ payload) using a lazily-built
   lookup table; throw on mismatch (catches truncation/corruption of the embedded
   card).
6. Only decode the `tEXt` chunk whose keyword is `chara`: split on the first NUL
   → keyword, then base64-decode the remainder → `JSON.parse`.
7. Stop at `IEND`. Ignore everything else.

No external dependency; total ~80 lines incl. CRC32. Bounds-checked, streamed, no
unbounded allocation, and verified against accidental corruption via CRC.

---

_All open questions resolved. Design ready for implementation._