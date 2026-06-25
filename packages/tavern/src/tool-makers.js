// @ts-check

/**
 * tavern re-uses fae's built-in tool makers verbatim. Importing them here
 * (rather than duplicating) gives an imported SillyTavern character the same
 * petname / mail / exec / channel agency a fae agent has. Tool results are
 * appended to the disk conversation tree exactly like ordinary turns (see
 * `driver.js`).
 *
 * No filesystem-caplets are re-exported — the agent's own state dir is
 * managed by the driver and intentionally not exposed as a tool, to keep
 * `tree.jsonl` safe from corruption. A "read my own history" tool is a v2.
 */

export {
  makeListPetnamesTool,
  makeLookupTool,
  makeStoreTool,
  makeRemoveTool,
  makeAdoptTool,
  makeAdoptToolTool,
  makeSendTool,
  makeReplyTool,
  makeListMessagesTool,
  makeDismissTool,
  makeExecTool,
  makeReadChannelTool,
} from '@endo/fae/src/tool-makers.js';