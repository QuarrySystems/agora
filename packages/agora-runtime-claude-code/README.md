# @quarry-systems/agora-runtime-claude-code

MVP `RuntimeAdapter` implementation for Claude Code environments.

Implementation lands in DAG 2 of the agora MVP plan.

## Reserved Paths

This adapter owns merge rules for the following `reservedPaths`:

- `.claude/settings.json` — Claude Code global settings managed by the adapter
- `.claude/skills/**` — skill files installed and updated by the adapter
- `agora-plugins.json` — plugin manifest consumed by the agora runtime

No other tool or workflow should write to these paths without going through this adapter's merge logic.
