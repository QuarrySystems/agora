---
title: The privilege boundary
description: Why register and assign — the verbs that define what a worker is and can do — are never reachable from the AI loop, and how that boundary is enforced architecturally.
sidebar:
  order: 4
---

agora splits its operations into two classes:

- **Deploy-time operations** create or modify executable artifacts —
  `capabilities.register()`, `subagent.register()` / `assign()`, `env.register()`.
  These define *what a worker is, what it can do, and what it can access.*
- **Run-time operations** compose existing artifacts into dispatches —
  `dispatch`, the read-only catalog lookups, and the orchestration-safe
  `submit`/`status`/`watch` verbs.

The boundary rule (§10.6) is one sentence: **anything that defines what a worker
*is* is set by humans (or human-reviewed CI); anything that *composes* existing
artifacts at run-time can be driven by an orchestrator — human or AI.** The
deploy-time verbs never reach the AI loop.

## Why `register` / `assign` stay out of the AI loop

If an AI orchestrator could register capabilities or subagents, prompt injection
becomes privilege escalation. Three distinct risks, each sufficient on its own
([ADR-0005](/agora/explanation/decisions/0005-privileged-ops-never-ai-reachable/)):

1. **Capability content.** A capability defines the worker's authority surface —
   its bash patterns, MCP config, setup script. An AI tricked via repo content
   or document text could register a capability that runs attacker-controlled
   code.
2. **Subagent prompts.** A registered subagent's system prompt is the instruction
   set every future dispatch runs. An injected payload would propagate to every
   dispatch using that subagent.
3. **Secret exfiltration.** Even with redacted output, the LLM *saw* the secret
   at register time, and tool-call payloads land in transcripts and model logs.

This is the AWS IAM pattern: a lambda doesn't create its own execution role; an
admin provisions roles and the lambda references them. agora is the same —
artifacts are provisioned by humans, and dispatches reference them by name.

## The boundary is architectural, not policy

Enforcement does not depend on the orchestrator behaving well. The
[`agora-mcp`](/agora/reference/mcp-tools/) server exposes a frozen tuple of
exactly **nine** run-time tools (`AGORA_TOOL_NAMES` in
`packages/agora-mcp/src/tools.ts`):

| # | Tool | Class |
|---|---|---|
| 1 | `agora_dispatch` | dispatch |
| 2 | `agora_dispatch_describe` | dispatch |
| 3 | `agora_dispatch_cancel` | dispatch |
| 4 | `agora_capabilities_list` | catalog read (metadata only) |
| 5 | `agora_subagents_list` | catalog read (metadata only) |
| 6 | `agora_envs_list` | catalog read (metadata only) |
| 7 | `agora_orchestrator_submit` | client orchestration |
| 8 | `agora_orchestrator_status` | client orchestration |
| 9 | `agora_orchestrator_watch` | client orchestration |

No tool named `agora_*_register` or `agora_*_assign` exists on this surface — the
source file's own header comment lists them as *"Deliberately ABSENT … excluded
by §7.7,"* alongside the privileged `orchestrator_cancel`, the service-only
`orchestrator_audit`, and the CLI-only `orchestrator_serve`. The catalog reads
that *do* ship return metadata only (name, `registeredAt`, `contentHash`) —
never file contents, system-prompt bodies, or secret values.

A CI allowlist check (`task-ci-mcp-tool-allowlist`) dumps the server's exposed
tool names and asserts the set equals exactly those nine. Any addition fails the
build; any name matching `agora_*_register` or `agora_*_assign` fails regardless
of intent. Without that check the boundary would be policy — and policy decays
as code evolves.

The escape hatch for self-modifying orchestration is to write a TypeScript
orchestrator against `agora-client` directly, which means *a human wrote the
orchestration code* — exactly the trust model agora wants.

## See also

- [ADR-0005 — Privileged operations are never reachable through an AI tool surface](/agora/explanation/decisions/0005-privileged-ops-never-ai-reachable/)
- [MCP tools reference](/agora/reference/mcp-tools/) — the full nine-tool surface.
- [Sandboxing AI agents](/agora/explanation/sandboxing-ai-agents/) — the broader "why."
</content>
