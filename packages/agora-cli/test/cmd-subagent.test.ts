import { attachSubagentCmd } from '../src/cmd-subagent.js';
import { Command } from 'commander';
import { it, expect } from 'vitest';

it('attachSubagentCmd registers register/assign/list/get subcommands', () => {
  const program = new Command();
  attachSubagentCmd(program, { getClient: async () => ({} as any) });
  const sub = program.commands.find((c) => c.name() === 'subagent');
  expect(sub).toBeDefined();
  const subNames = sub!.commands.map((c) => c.name()).sort();
  expect(subNames).toEqual(['assign', 'get', 'list', 'register']);
});
