// `agora subagent` subcommand group — register / assign / list / get.
//
// Each subcommand resolves an `AgoraClient` via `ctx.getClient()` and calls
// the namespaced `client.subagent.*` API. The `register` subcommand reads a
// YAML file with the subagent definition (systemPrompt / promptTemplate /
// model / capabilities) and forwards it under the given `--name`.
//
// `assign` is currently restricted: the namespaced storage layer does not
// expose the underlying {systemPrompt, promptTemplate, model} bundle from a
// `SubagentRef`, so we cannot reconstruct a `RegisterSubagentOpts` purely
// from a name. Rather than silently dropping prompt fields, we emit a clear
// error directing the user to re-register with the new capability list.
// The full assign-only flow lands in v1.5 once subagent.get exposes enough
// of the stored bundle to round-trip it back through register().

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { CliContext } from './index.js';

export function attachSubagentCmd(program: Command, ctx: CliContext): void {
  const sub = program.command('subagent').description('Manage subagents');

  sub
    .command('register')
    .description('Register a subagent from a YAML definition file')
    .requiredOption('--name <name>', 'subagent name')
    .requiredOption(
      '--from <file>',
      'YAML file with systemPrompt / promptTemplate / model / capabilities',
    )
    .action(async (opts: { name: string; from: string }) => {
      const client = await ctx.getClient();
      const raw = await readFile(opts.from, 'utf8');
      const def = (parseYaml(raw) ?? {}) as Record<string, unknown>;
      const handle = await client.subagent.register({ name: opts.name, ...def });
      console.log(
        JSON.stringify({
          name: handle.name,
          contentHash: handle.contentHash,
          registeredAt: handle.registeredAt,
        }),
      );
    });

  sub
    .command('assign <name>')
    .description('Assign a new capability set to a named subagent')
    .requiredOption('--capabilities <list>', 'comma-separated capability names')
    .action(async (name: string, opts: { capabilities: string }) => {
      // Touch the client so misconfiguration surfaces here, even though we
      // immediately throw — keeps the failure mode consistent with the other
      // subcommands (config errors first, semantic limitation second).
      await ctx.getClient();
      const caps = opts.capabilities
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      throw new Error(
        `assign currently requires re-registering the subagent with the new capability list via 'subagent register --from <yaml> --name ${name}' where the YAML's 'capabilities' includes ${caps.join(', ')}. Full assign-only flow will land in v1.5 once SubagentHandle is retrievable from storage.`,
      );
    });

  sub
    .command('list')
    .description('List all registered subagents')
    .action(async () => {
      const client = await ctx.getClient();
      const refs = await client.subagent.list();
      for (const r of refs) {
        console.log(`${r.name}\t${r.contentHash}\t${r.registeredAt}`);
      }
    });

  sub
    .command('get <name>')
    .description('Get a single subagent ref by name')
    .action(async (name: string) => {
      const client = await ctx.getClient();
      const ref = await client.subagent.get(name);
      console.log(ref ? JSON.stringify(ref) : '(not found)');
    });
}
