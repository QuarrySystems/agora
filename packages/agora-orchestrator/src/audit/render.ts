import type { AuditBundle, CheckResult, AuditEntryRow } from '../contracts/index.js';

export interface RenderOpts {
  /** Pass false to suppress ANSI color codes (plain text). Default: plain (no color added). */
  color?: boolean;
  /** Pass true to show every ledger row without head+tail truncation. */
  full?: boolean;
}

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

function mark(c: CheckResult): string {
  if (c.ok === true) return '✓';
  if (c.ok === 'n/a') return '─';
  return '✗';
}

function truncHash(h: string, len = 6): string {
  return h.slice(0, len);
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const HEAD = 3;
const TAIL = 3;

function ledgerRow(e: AuditEntryRow, failing: number | undefined): string {
  const isFailing = failing !== undefined && e.seq === failing;
  const flag = isFailing ? ' ✗' : '';
  return `  ${String(e.seq).padStart(4)}  ${truncHash(e.entryHash)}  ${e.kind}${flag}`;
}

function buildLedger(
  entries: AuditEntryRow[],
  failingSeq: number | undefined,
  full: boolean,
): string[] {
  if (entries.length === 0) return ['  (no entries)'];

  if (full || entries.length <= HEAD + TAIL) {
    return entries.map((e) => ledgerRow(e, failingSeq));
  }

  const head = entries.slice(0, HEAD).map((e) => ledgerRow(e, failingSeq));
  const tail = entries.slice(-TAIL).map((e) => ledgerRow(e, failingSeq));
  const omitted = entries.length - HEAD - TAIL;
  return [...head, `  …(${omitted} more)`, ...tail];
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

export function renderVerification(bundle: AuditBundle, opts: RenderOpts = {}): string {
  const r = bundle.report;
  const color = opts.color === true; // only add ANSI when explicitly requested; false/undefined → plain
  const full = opts.full === true;

  // Verdict line
  const verdictLabel = r.intact ? `✓ ${r.claim.toUpperCase()}` : '✗ TAMPERED';
  const sep = '─'.repeat(58);

  const failingSeq: number | undefined =
    r.checks.chain.ok === false && r.checks.chain.detail
      ? (() => {
          const m = r.checks.chain.detail.match(/entry (\d+)/);
          return m ? Number(m[1]) : undefined;
        })()
      : undefined;

  const lines: string[] = [];

  // Header
  lines.push(`  agora verify  ·  ${bundle.runId}                  ${verdictLabel}`);
  lines.push('  ' + sep);

  // Check rows
  const chainDetail =
    r.checks.chain.detail ??
    `${bundle.auditLog.entries.length} entries, hash-linked, no gaps`;
  lines.push(`  ${mark(r.checks.chain)} chain        ${chainDetail}`);

  const rootDetail = r.checks.root.detail ?? (
    r.checks.root.ok === 'n/a' ? 'n/a' : 'merkle = anchored root'
  );
  lines.push(`  ${mark(r.checks.root)} root         ${rootDetail}`);

  const sigDetail = r.checks.signature.detail ?? (
    r.checks.signature.ok === 'n/a' ? 'n/a' : String(r.checks.signature.ok)
  );
  lines.push(`  ${mark(r.checks.signature)} signature    ${sigDetail}`);

  lines.push(`  ${mark(r.checks.anchor)} anchor       ${r.anchorId}  (${r.guarantee})`);

  lines.push('  ' + sep);

  // Ledger
  lines.push('  seq   hash    kind');
  lines.push(...buildLedger(bundle.auditLog.entries, failingSeq, full));

  lines.push('  ' + sep);

  // Footer
  const entries = bundle.auditLog.entries;
  const firstAt = entries[0]?.at ?? '—';
  const lastAt = entries[entries.length - 1]?.at ?? '—';
  const reconciled = bundle.items.length;
  const total = bundle.auditLog.entries.length;
  lines.push(
    `  ${reconciled}/${total} items reconciled  ·  anchor: ${r.anchorId}  ·  ran ${firstAt}→${lastAt} (unattended)`,
  );

  const output = lines.join('\n');

  // Color mode: only strip ANSI if the output had some and color is false.
  // Since we never ADD ANSI codes here unconditionally, the plain path is already clean.
  // If color === true we could add codes in future; for now plain text is fine either way.
  if (color) {
    // Future: wrap verdict and markers with color codes here.
    return output;
  }
  return output;
}
