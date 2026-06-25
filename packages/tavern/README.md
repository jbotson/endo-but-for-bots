# @endo/tavern

An Endo agent framework that runs **SillyTavern character cards** as
autonomous agents. Tavern imports a character card (PNG-with-embedded-JSON
or `.json`, V1 or V2) and an optional SillyTavern chat export, then runs
that character as an Endo agent with disk-backed conversation history that
survives restarts.

Tavern is structurally similar to `@endo/fae` but differs in one key way:
**the system prompt lives on disk in `agent.json`, not in the conversation
tree.** Re-importing a card updates the live prompt for the *existing* agent
while preserving all history — no fresh-agent-on-prompt-change.

## How it differs from fae

| | fae | tavern |
|---|---|---|
| System prompt | baked into an immutable root node; prompt change ⇒ fresh tree | lives in `agent.json`, injected at LLM-call time; prompt change ⇒ same tree |
| History | daemon petstore | plain-disk `tree.jsonl` |
| Agent identity | created from a system-prompt argument | bound to an on-disk state dir produced by the importer |
| Tool calls | fae's built-in tools | re-uses fae's built-in tools verbatim |

## Architecture

Tavern is a single package that slots into the Endo monorepo, re-using the
unpublished `@endo/lal` (LLM provider) and `@endo/conversation-tree` deps
that resolve in-workspace.

1. **Importer** (`scripts/import-*.js` over `src/import.js`) — parses a
   SillyTavern card + chat export and writes the per-agent state directory
   (`agent.json`, `card.json`, `tree.jsonl`, `state.json`, `imports.log`).
   Runs as plain Node scripts (only `fs`, no daemon).

2. **Factory** (`agent.js` — `make()`) — bound to a named LLM provider.
   `createAgent(name, { stateDir, providerName?, pin? })` binds a driver
   caplet to an **already-imported** state dir. No `systemPrompt` argument.

3. **Driver** (`driver.js`) — a standalone caplet per agent that runs the
   inbox/LLM loop. Each turn it re-reads `agent.json` (live prompt edits),
   assembles the LLM context from `agent.json` + the disk tree, appends the
   assistant/tool nodes to `tree.jsonl`, and replies. When pinned to
   `@pins`, `revivePins()` re-launches it on daemon restart.

### Disk layout (per agent)

All under `<endo-state>/tavern/<agent-name>/` (override with `--state-dir`):

```
tavern/<agent-name>/
├── tree.jsonl      # append-only conversation tree (one node per line)
├── agent.json      # resolved config incl. systemPrompt — RE-READ EACH TURN
├── card.json       # raw imported ST card, verbatim (audit)
├── state.json      # bookkeeping (lastProcessedMessageNumber, schemaVersion)
└── imports.log     # append-only audit of import runs
```

Nothing outside this package reads or writes these files (except you, for
inspection).

## Prerequisites

Build the workspace from the repo root:

```bash
cd ../..
npx corepack yarn install
```

Start the daemon:

```bash
yarn endo purge -f
yarn endo start
```

Tavern re-uses the LLM provider flow from fae/lal, so provision one first
(one time):

```bash
cd packages/fae
yarn setup                              # provision the LLM provider factory
yarn create-provider                    # submit host/model/auth-token via .env
```

## Setup

### Step 1: Provision the tavern factory guest

```bash
cd packages/tavern
yarn setup
```

### Step 2: Bind the factory to a provider

Creates the `tavern-factory` caplet bound to the `default` provider:

```bash
yarn tavern-factory-setup
# or: PROVIDER_NAME=default FACTORY_NAME=tavern-factory yarn tavern-factory-setup
```

## Importing a character

Import runs **before** creating the live agent — it writes the on-disk state
the driver will bind to.

### Card + chat together

```bash
node scripts/import-all.js \
  --card ~/Downloads/Seraphina.png \
  --chat  ~/Downloads/Seraphina.chat.jsonl \
  --agent seraphina \
  --user-name Alex \
  --persona "A curious traveler"
```

### Card only

Writes `agent.json` + `card.json`; **never touches `tree.jsonl`**:

```bash
node scripts/import-card.js --card ~/Downloads/Seraphina.png --agent seraphina
```

### Chat only

Builds a linear `tree.jsonl` from a SillyTavern `.jsonl` export. By default
seeds a portability root node from the current `agent.json` system prompt
(the driver never trusts it — `agent.json` is authoritative):

```bash
node scripts/import-chat.js --chat ~/Downloads/Seraphina.chat.jsonl --agent seraphina [--replace] [--keep-system]
```

### Importer options

| Flag | Effect |
|------|--------|
| `--state-dir DIR` | override the resolved state directory |
| `--user-name NAME` | override the card/chat `user_name` |
| `--persona "..."` | persona injected as `{{persona}}` |
| `--no-card-system-prompt` | assemble prompt from fields instead of the card's `system_prompt` |
| `--include first_mes,scenario=false` | toggle which card fields feed the prompt |
| `--greeting-index N` | pick alternate greeting `N` (0 = `first_mes`) |
| `--provider default` | which stored provider (default `default`) |
| `--model NAME` | optional provider model override (`--model null` to clear) |
| `--replace` | (chat) overwrite an existing `tree.jsonl` |
| `--keep-system` | (chat) include `is_system` lines as `role:"system"` |
| `--fsync` | per-append `fsync` for crash durability |

Cards may be `.png` (V2, `chara` tEXt chunk) or `.json` (V1 flat or V2
data-veiled). V1 cards are promoted to the V2 shape; unknown fields are
preserved verbatim in `card.json`.

## Creating the live agent

Binds a driver to the imported state dir and (with `--pin`) survives
restarts:

```bash
yarn create-agent seraphina --pin
# or: node scripts/create-agent.js seraphina --pin --state-dir /abs/path
```

The agent is now listening on its inbox. Talk to it through Endo mail/chat:

```bash
endo send --as @host seraphina "Hi! Remember our last conversation?"
endo inbox --as @host --follow
```

Or start the `@endo/chat` UI:

```bash
cd packages/chat
yarn dev
# http://localhost:5173 — send with @seraphina Hello!
```

## Updating a character without losing history

This is the headline feature. Edit/download a new card and re-import it:

```bash
node scripts/import-card.js --card ~/Downloads/Seraphina-v2.png --agent seraphina
```

`agent.json` is rewritten with the new `systemPrompt`; `tree.jsonl` is
untouched. The next incoming message uses the new prompt over the **entire
existing history** — no agent recreation, no history loss.

## Prompt resolution

For each LLM call the driver assembles, from `agent.json`:

1. `{ role: 'system', content: systemPrompt }` — the authoritative prompt
   (a leading `system` message from the import-time portability root is
   **stripped** — `agent.json` wins).
2. `...tree.getPath(leafId)` — the recorded user/assistant/tool turns.
3. `depth_prompt` injected `depth` messages before the end (best-effort).
4. `post_history_instructions` appended as an ephemeral `system` tail.

Macros (`{{char}}`, `{{user}}`, `{{original}}`, `{{persona}}`) are expanded
during import, not at runtime.

## Crash & restart behavior

| Event | Behavior |
|---|---|
| Daemon restart (clean) | `@pins` → `revivePins()` re-launches the driver → re-reads `tree.jsonl` → continues. History intact. |
| Driver crash mid-reply | `lastProcessedMessageNumber` was advanced before the LLM loop; on restart the existing user-leaf (no assistant child yet) is detected and the loop re-runs for it. The regenerated reply may differ — documented v1 limitation. |
| Disk full / append fails | Loop errors → replies to sender → does **not** dismiss (leaves the message for retry). |
| `tree.jsonl` partial line | `load()` skips the trailing incomplete line (logged). |

## Tools

Tavern re-uses fae's built-in tool makers verbatim
(`src/tool-makers.js` re-exports them from `@endo/fae/src/tool-makers.js`),
giving an imported character the same petstore / mail / `exec` / channel
/ `adoptTool` agency a fae agent has. Tool results are appended to
`tree.jsonl` exactly like ordinary turns.

No filesystem-caplets ship in v1 — the agent's own state dir is managed by
the driver and intentionally not exposed as a tool, to keep `tree.jsonl`
safe from corruption.

## Limitations (v1)

- Rough (not exact) ST prompt parity: no world-info/lorebook activation, no
  regex scripts, no instruct formatting, no token-budget trimming.
- Linear history only — the tree supports branching/swipes but the driver
  doesn't create siblings yet (see DESIGN.md §14).
- Character book is stored in `card.json` for v2 but not scanned.
- Macro support is a subset (`{{char}}`, `{{Char}}`, `{{user}}`, `{{User}}`,
  `{{persona}}`, `{{original}}`).
- Interacted with via Endo mail/chat, not SillyTavern.
- Closest provider script (`scripts/create-agent.js`) looks up the factory
  over the daemon socket.

See `DESIGN.md` for the full design, rationale, and the v2 roadmap
(swipes/branching, lorebook activation, exposing the importer as an Endo
tool).

## File structure

```
packages/tavern/
├── agent.js                  # Factory entry point + spawnTavernLoop
├── driver.js                 # Driver caplet (inbox loop, pinnable)
├── setup.js                  # Provision the tavern-factory guest
├── tavern-factory-setup.js   # Bind factory to a provider + launch caplet
├── package.json
├── tsconfig.json
├── src/
│   ├── disk-backend.js       # TreeBackend over JSONL
│   ├── agent-state.js        # load/save agent.json + state.json
│   ├── card.js               # parse ST card PNG/JSON → normalized (V1/V2)
│   ├── png-text.js           # read tEXt "chara" chunk (CRC32-verified)
│   ├── chat.js               # parse ST .jsonl → messages
│   ├── prompt.js             # card + persona + macros → systemPrompt/PHI/depth
│   ├── macros.js             # {{char}}/{{user}}/{{original}} ... subset
│   ├── names.js              # pet-name validation, slug rules, state-dir
│   ├── import.js             # importCard + importChat functions
│   ├── tool-makers.js        # thin re-export of fae's tool makers
│   └── types.js              # JSDoc typedefs
├── scripts/
│   ├── import-card.js        # CLI: card → agent.json + card.json
│   ├── import-chat.js        # CLI: chat.jsonl → tree.jsonl
│   ├── import-all.js         # CLI: both
│   ├── create-agent.js      # CLI: TavernFactory.createAgent over the daemon
│   └── args.js               # tiny argv parser
└── test/                     # ava tests
```
