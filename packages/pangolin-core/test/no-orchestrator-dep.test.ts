import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

it('pangolin-core never imports from pangolin-orchestrator', () => {
  const dir = join(__dirname, '..', 'src');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(src, `${f} must not import orchestrator`).not.toMatch(/pangolin-orchestrator/);
  }
});
