#!/usr/bin/env node
// validate-adrs.mjs — validate the ADR collection at docs/decisions/.
//
// Checks performed:
//   1. Every NNNN-*.md ADR file has YAML frontmatter with `status`, `date`,
//      `deciders` keys.
//   2. Every ADR file has H2 headings `## Context`, `## Decision`,
//      `## Consequences` (in that order is not required, but all three must
//      appear).
//   3. docs/decisions/README.md references every ADR file present in the
//      directory (by NNNN-slug.md filename).
//
// Exit codes:
//   0  all checks pass
//   1  one or more checks fail; specific errors printed to stderr
//
// Run as a Node ESM script: `node scripts/validate-adrs.mjs`.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const DECISIONS_DIR = join(REPO_ROOT, 'docs', 'decisions');
const README_PATH = join(DECISIONS_DIR, 'README.md');

const ADR_FILENAME_RE = /^\d{4}-[a-z0-9][a-z0-9-]*\.md$/;
const REQUIRED_FRONTMATTER_KEYS = ['status', 'date', 'deciders'];
const REQUIRED_HEADINGS = ['## Context', '## Decision', '## Consequences'];

const errors = [];

function recordError(file, message) {
  errors.push(`${file}: ${message}`);
}

function parseFrontmatter(content, file) {
  // Frontmatter is delimited by `---` on its own line at the very top of the
  // file and the next `---` line. We don't need a full YAML parser; we only
  // check for `<key>:` at the start of a frontmatter line.
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    recordError(file, 'missing opening `---` frontmatter delimiter on line 1');
    return null;
  }
  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) {
    recordError(file, 'missing closing `---` frontmatter delimiter');
    return null;
  }
  const keys = new Set();
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function checkHeadings(content, file) {
  for (const heading of REQUIRED_HEADINGS) {
    // Match heading exactly at the start of a line.
    const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    if (!re.test(content)) {
      recordError(file, `missing required H2 heading \`${heading}\``);
    }
  }
}

async function validateAdr(file) {
  const path = join(DECISIONS_DIR, file);
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    recordError(file, `unreadable: ${err.message}`);
    return;
  }
  const keys = parseFrontmatter(content, file);
  if (keys) {
    for (const required of REQUIRED_FRONTMATTER_KEYS) {
      if (!keys.has(required)) {
        recordError(file, `missing required frontmatter key \`${required}\``);
      }
    }
  }
  checkHeadings(content, file);
}

async function validateReadmeReferencesAll(adrFiles) {
  let readme;
  try {
    readme = await readFile(README_PATH, 'utf8');
  } catch (err) {
    recordError('README.md', `unreadable: ${err.message}`);
    return;
  }
  for (const file of adrFiles) {
    if (!readme.includes(file)) {
      recordError('README.md', `does not reference ADR file \`${file}\``);
    }
  }
}

async function main() {
  let entries;
  try {
    entries = await readdir(DECISIONS_DIR);
  } catch (err) {
    console.error(`fatal: cannot read ${DECISIONS_DIR}: ${err.message}`);
    process.exit(1);
  }
  const adrFiles = entries.filter((e) => ADR_FILENAME_RE.test(e)).sort();
  if (adrFiles.length === 0) {
    console.error(`fatal: no ADR files matching NNNN-*.md found in ${DECISIONS_DIR}`);
    process.exit(1);
  }

  for (const file of adrFiles) {
    await validateAdr(file);
  }
  await validateReadmeReferencesAll(adrFiles);

  if (errors.length > 0) {
    console.error(`validate-adrs: ${errors.length} error(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `validate-adrs: OK (${adrFiles.length} ADR(s) validated, README references all)`,
  );
  process.exit(0);
}

await main();
