// @ts-check

/**
 * @typedef {object} ChatMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string} content
 * @property {object[]} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 */

/**
 * A single node in the conversation tree. Each node records the messages
 * appended at one step (typically one user turn, or one assistant response
 * plus its tool-call results).
 *
 * @typedef {object} ConversationNode
 * @property {string} id - Unique identifier (endo messageId or generated uuid)
 * @property {string | null} parentId - Parent node id (endo replyTo), null for roots
 * @property {ChatMessage[]} messages - Messages recorded at this step
 * @property {Record<string, unknown>} metadata - Arbitrary metadata (scene, summary, label)
 * @property {number} timestamp
 */

/**
 * @typedef {object} TreeBackend
 * @property {(node: ConversationNode) => Promise<void>} putNode
 * @property {(id: string) => Promise<ConversationNode | null>} getNode
 * @property {(parentId: string | null) => Promise<ConversationNode[]>} getChildren
 * @property {() => Promise<ConversationNode[]>} getRoots
 */

export {};