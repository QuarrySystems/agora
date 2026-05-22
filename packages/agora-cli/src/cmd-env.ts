import { Command } from 'commander';
import type { CliContext } from './index.js';

// Type aliases for secret references, inlined to avoid agora-core import
type SecretRef = { arn: string };
type InlineSecret = { inline: string };

export function attachEnvCmd(program: Command, ctx: CliContext): void {
  const env = program.command('env').description('Manage env bundles');

  env.command('register')
    .requiredOption('--name <name>', 'env bundle name')
    .option('--value <kv...>', 'KEY=VALUE pairs (repeatable)')
    .option('--secret <kv...>', 'KEY=arn:... | KEY=inline:<value> (repeatable)')
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
        if (v.startsWith('arn:')) secrets[k] = { arn: v };
        else if (v.startsWith('inline:')) secrets[k] = { inline: v.slice('inline:'.length) };
        else { console.error(`secret ${k} must start with 'arn:' or 'inline:'`); process.exit(1); }
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
