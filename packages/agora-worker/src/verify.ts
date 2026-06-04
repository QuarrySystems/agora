// agora-worker: self-verify runner (Gap A)
//
// After the runtime adapter produces its edit, the worker optionally runs a
// configured verify command in the workspace and REPORTS the result alongside
// the patch. The command is an arbitrary, LANGUAGE-AGNOSTIC shell string
// supplied by the subagent definition — e.g. `dotnet test`, `cargo test`,
// `pytest`, `go test ./...`, or `pnpm exec tsc --noEmit && pnpm vitest run`.
// The worker neither knows nor cares which toolchain it is; the toolchain
// comes from the worker image / workspace the operator supplies.
//
// Unlike the setup-script runner (which gates the dispatch by throwing on a
// non-zero exit), verify is report-only: a non-zero exit, a timeout, or a
// failure to start all resolve to `{ passed: false }`. It NEVER throws and
// never changes the dispatch outcome — it only adds a signal to the sealed
// output sentinel so the operator can read pass/fail without re-running by
// hand. Gating on verify is a deliberate future pull, not part of v1.

import { spawn } from "node:child_process";

export interface VerifyResult {
  passed: boolean;
  /** Combined stdout+stderr, truncated to the report limit. Omitted if empty. */
  report?: string;
  durationMs: number;
}

export interface RunVerifyOpts {
  workspaceDir: string;
  /** Shell command string; run via `shell:true` (→ /bin/sh -c in the container). */
  command: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  /** Max characters of captured output retained in `report`. */
  reportLimit?: number;
}

const DEFAULT_REPORT_LIMIT = 8_000;

function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(0, limit) + "\n…[truncated]";
}

/**
 * Run the verify command in the workspace, time-bounded, and report pass/fail.
 * Resolves (never rejects) with a {@link VerifyResult}.
 */
export async function runVerify(opts: RunVerifyOpts): Promise<VerifyResult> {
  const limit = opts.reportLimit ?? DEFAULT_REPORT_LIMIT;
  const start = Date.now();

  return new Promise<VerifyResult>((resolve) => {
    const child = spawn(opts.command, {
      cwd: opts.workspaceDir,
      env: opts.env,
      shell: true,
    });

    let out = "";
    const append = (d: Buffer): void => {
      if (out.length < limit) out += d.toString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let settled = false;
    const finish = (r: VerifyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        passed: false,
        report: truncate(out + "\n[verify timed out]", limit),
        durationMs: Date.now() - start,
      });
    }, opts.timeoutSeconds * 1000);

    child.on("error", (err) => {
      finish({
        passed: false,
        report: truncate(`[verify failed to start] ${err.message}`, limit),
        durationMs: Date.now() - start,
      });
    });

    child.on("exit", (code) => {
      const report = truncate(out, limit);
      finish({
        passed: code === 0,
        report: report.length > 0 ? report : undefined,
        durationMs: Date.now() - start,
      });
    });
  });
}
