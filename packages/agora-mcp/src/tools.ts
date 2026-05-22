// @quarry-systems/agora-mcp — runtime tool surface.
//
// Registers the six MCP tools allowed on the run-time surface per §4.6 of
// the agora-mvp spec. Three catalog reads (metadata only — never file
// contents, secret values, or system prompt bodies) and three dispatch
// operations:
//
//   agora_dispatch           → client.dispatch(...)
//   agora_dispatch_describe  → client.dispatch.describe(id)
//   agora_dispatch_cancel    → client.dispatch.cancel(id)
//   agora_capabilities_list  → client.capabilities.list()
//   agora_subagents_list     → client.subagent.list()
//   agora_envs_list          → client.env.list()
//
// Deliberately ABSENT from this surface (deploy-time privileged operations
// excluded by §7.7):
//   - any `agora_*_register`
//   - any `agora_*_assign`
// The CI check in `task-ci-mcp-tool-allowlist` enforces this architecturally;
// the names in `AGORA_TOOL_NAMES` are load-bearing for that check.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AgoraClient } from '@quarry-systems/agora-client';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The exact six tool names this server exposes, in declaration order.
 * Frozen `as const` so downstream code (and the CI allowlist check) can
 * rely on the literal tuple shape.
 */
export const AGORA_TOOL_NAMES = [
  'agora_dispatch',
  'agora_dispatch_describe',
  'agora_dispatch_cancel',
  'agora_capabilities_list',
  'agora_subagents_list',
  'agora_envs_list',
] as const;

export type AgoraToolName = (typeof AGORA_TOOL_NAMES)[number];

/**
 * Tool descriptor list returned from `tools/list`. Each entry carries a
 * description and a JSON-schema `inputSchema`. The dispatch tool's schema
 * intentionally permits `additionalProperties` so callers can pass through
 * the full `DispatchWork & ClientDispatchOpts` shape without us reflecting
 * the whole agora-core type tree into JSON-schema here.
 */
const TOOL_DESCRIPTORS = [
  {
    name: 'agora_dispatch',
    description:
      'Dispatch a unit of work to a registered subagent on a configured target. ' +
      'Returns a DispatchResult (dispatchId, exitCode, stdout/stderr, resolved refs).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Logical target name (must be configured on the AgoraClient).',
        },
        subagent: {
          description: 'Subagent short name or a pre-built SubagentRef.',
        },
        workerImage: {
          type: 'string',
          description: 'Worker container image (digest-pinned) the provider should run.',
        },
        env: {
          description: 'Env-bundle short name, EnvRef, or an array of either.',
        },
        capabilities: {
          description:
            'If set, REPLACES the subagent\'s assigned capability set. ' +
            'Cannot be combined with addCapabilities.',
        },
        addCapabilities: {
          description:
            'If set, APPENDS to the subagent\'s assigned capability set (override on name conflict).',
        },
        secrets: {
          description:
            'Per-dispatch secrets, keyed by env-var name. Each value is either a SecretRef or an InlineSecret.',
        },
        input: {
          description: 'Free-form JSON payload forwarded to the worker as AGORA_INPUT_JSON.',
        },
        callback: {
          description: 'Optional callback configuration ({ url }) for streaming results back.',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Per-dispatch timeout. Falls back to defaultDispatchTimeoutSeconds.',
        },
        defaultDispatchTimeoutSeconds: {
          type: 'number',
          description: 'Fallback when work.timeoutSeconds is omitted.',
        },
        retentionDays: {
          type: 'number',
          description: 'Dispatch-record retention override (else client.retention.defaultDays).',
        },
        resources: {
          description: 'Optional resource overrides ({ cpu, memory }).',
        },
        dispatchId: {
          type: 'string',
          description: 'Caller-supplied dispatch id. If omitted, a uuid v4 is minted.',
        },
      },
      required: ['target', 'subagent', 'workerImage'],
      additionalProperties: true,
    },
  },
  {
    name: 'agora_dispatch_describe',
    description:
      'Look up a previously-sealed dispatch record by id. Returns the full DispatchResult. ' +
      'Throws when the record has been purged by retention (cannot be distinguished from never-existed).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dispatchId: {
          type: 'string',
          description: 'The dispatch id to describe.',
        },
      },
      required: ['dispatchId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agora_dispatch_cancel',
    description:
      'Request cancellation of an in-flight dispatch by id. Returns void on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dispatchId: {
          type: 'string',
          description: 'The dispatch id to cancel.',
        },
      },
      required: ['dispatchId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agora_capabilities_list',
    description:
      'List registered capabilities (metadata only: name, registeredAt, contentHash). ' +
      'Does NOT return capability file contents, system prompt bodies, or secret values.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'agora_subagents_list',
    description:
      'List registered subagents (metadata only: name, registeredAt, contentHash). ' +
      'Does NOT return subagent system-prompt bodies.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'agora_envs_list',
    description:
      'List registered env bundles (metadata only: name, registeredAt, contentHash). ' +
      'Does NOT return env-bundle contents or secret ARNs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * Register the six run-time agora tools on `server`, wiring each to the
 * matching `AgoraClient` method. Errors thrown by client methods are caught
 * and returned as `{ content, isError: true }` responses per the MCP SDK
 * contract — we surface `err.message` only, never `err.stack`, so internal
 * paths and trace frames do not leak to the orchestrator.
 */
export function registerAgoraTools(server: Server, client: AgoraClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const argsObj = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case 'agora_dispatch': {
          // `client.dispatch` is callable; the merged DispatchWork &
          // ClientDispatchOpts shape is what the prototype-installed
          // dispatch fn expects. We cast here because JSON-schema can't
          // capture the full agora-core type tree.
          const result = await client.dispatch(
            argsObj as unknown as Parameters<AgoraClient['dispatch']>[0],
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'agora_dispatch_describe': {
          const dispatchId = requireString(argsObj, 'dispatchId');
          const result = await client.dispatch.describe(dispatchId);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'agora_dispatch_cancel': {
          const dispatchId = requireString(argsObj, 'dispatchId');
          await client.dispatch.cancel(dispatchId);
          return {
            content: [{ type: 'text', text: `cancelled: ${dispatchId}` }],
          };
        }
        case 'agora_capabilities_list': {
          const result = await client.capabilities.list();
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'agora_subagents_list': {
          const result = await client.subagent.list();
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'agora_envs_list': {
          const result = await client.env.list();
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        default:
          // Unknown tool: per MCP SDK error contract, return isError rather
          // than throwing raw. The orchestrator gets a structured response
          // it can pattern-match on.
          return {
            content: [{ type: 'text', text: `unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err: unknown) {
      // Wrap any thrown error from the client (or arg validation) as an
      // isError response. We surface `err.message` only — never `err.stack`
      // — so internal file paths and trace frames do not leak across the
      // tool boundary to the orchestrator.
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `error invoking ${name}: ${message}` }],
        isError: true,
      };
    }
  });
}

/**
 * Pull a required string field out of a tool-call arguments object. Throws
 * a plain `Error` (caught by the dispatch handler's try/catch and reflected
 * back to the caller as an `isError` response).
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string argument: ${key}`);
  }
  return v;
}
