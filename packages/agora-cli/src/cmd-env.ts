import { Command } from 'commander';
import type { CliContext } from './index.js';

// Type aliases for secret references, inlined to avoid agora-core import
type SecretRef = { ref: string };
type InlineSecret = { inline: string };

const REF_PREFIXES = ['arn:', 'local-secret://'];

/**
 * Parse a single KEY=VALUE secret argument string into a record entry.
 * Values prefixed with a known ref scheme (arn:, local-secret://) become
 * opaque { ref } entries; values prefixed with inline: have that prefix
 * stripped and become { inline } entries; bare values without a recognized
 * prefix also become { inline } entries.
 */
export function parseSecretArg(kv: string): Record<string, SecretRef | InlineSecret> {
  const [k, ...rest] = kv.split('=');
  const v = rest.join('=');
  if (REF_PREFIXES.some((p) => v.startsWith(p))) {
    return { [k]: { ref: v } };
  } else if (v.startsWith('inline:')) {
    return { [k]: { inline: v.slice('inline:'.length) } };
  }
  return { [k]: { inline: v } };
}

export function attachEnvCmd(program: Command, ctx: CliContext): void {
  const env = program.command('env').description('Manage env bundles');

  env.command('register')
    .requiredOption('--name <name>', 'env bundle name')
    .option('--value <kv...>', 'KEY=VALUE pairs (repeatable)')
    .option('--secret <kv...>', 'KEY=arn:... | KEY=local-secret://... | KEY=inline:<value> (repeatable)')
    .action(async (opts) => {
      const client = await ctx.getClient();
      const values: Record<string, string> = {};
      const secrets: Record<string, SecretRef | InlineSecret> = {};
      for (const kv of opts.value ?? []) {
        const [k, ...rest] = kv.split('=');
        values[k] = rest.join('=');
      }
      for (const kv of opts.secret ?? []) {
        const [k, ...rest] = kv.split('=');
        const v = rest.join('=');
        if (REF_PREFIXES.some((p) => v.startsWith(p))) {
          secrets[k] = { ref: v };
        } else if (v.startsWith('inline:')) {
          secrets[k] = { inline: v.slice('inline:'.length) };
        } else {
          console.error(`secret ${k} must start with 'arn:', 'local-secret://', or 'inline:'`);
          process.exit(1);
        }
      }
      const ref = await client.env.register({ name: opts.name, values, secrets });
      console.log(JSON.stringify(ref));
    });

  env.command('list').action(async () => {
    const client = await ctx.getClient();
    for (const r of await client.env.list()) console.log(`${r.name}\t${r.contentHash}\t${r.registeredAt}`);
  });
  env.command('get <name>').action(async (name: string) => {
    const client = await ctx.getClient();
    const ref = await client.env.get(name);
    console.log(ref ? JSON.stringify(ref) : '(not found)');
  });
}
