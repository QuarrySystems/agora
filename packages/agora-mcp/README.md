# @quarry-systems/agora-mcp

MCP server package for the Agora dispatch system.

> **Scaffold notice:** Implementation lands in DAG 2 of the Agora MVP plan. This package's existence is the contract that DAG 2 implements against.

## Exposed tool surface (§4.6 allowlist)

The MCP server exposes ONLY the following six run-time tool names:

- `agora_dispatch`
- `agora_dispatch_describe`
- `agora_dispatch_cancel`
- `agora_capabilities_list`
- `agora_subagents_list`
- `agora_envs_list`

The CI allowlist (task-ci-dep-allowlist) verifies this surface at MVP completion (DAG 3).

## Dependencies

- `@quarry-systems/agora-client` — workspace dependency providing the caller-side SDK
