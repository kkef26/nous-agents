/**
 * NOUS.CONDUCTOR.MERGE_GATES.3 — atomic dist swap.
 *
 * swapDist replaces the served dist/ directory with a freshly built
 * one. The swap is deliberately structured so the previous dist/ is
 * only removed AFTER the new dist/ has been moved into place — a
 * failure mid-way leaves the served path intact (either the old dist,
 * or a partial new one; the caller decides how to recover).
 *
 * Kept as an independently importable named export (constraint #4).
 * Its consumer (runSmokeGate) invokes it only when smoke_passed; the
 * conductor orchestrator body NEVER references swapDist directly.
 */

export interface SwapDistArgs {
  /** Absolute path to the freshly built dist/ directory. */
  source: string;
  /** Absolute path to the served location the CDN / hosting picks up. */
  dest: string;
}

export interface SwapDistDeps {
  fsImpl?: {
    rename(oldPath: string, newPath: string): Promise<void>;
    rm(
      path: string,
      opts?: { recursive?: boolean; force?: boolean },
    ): Promise<void>;
    access(path: string): Promise<void>;
  };
}

/**
 * Move `source` into `dest`, first evicting any prior `dest`.
 *
 * Steps:
 *   1. If dest exists, rename it aside to `${dest}.previous-<ts>` so
 *      the previous dist is not lost mid-swap.
 *   2. Rename source → dest.
 *   3. Remove the aside directory.
 *
 * Failures propagate; callers treat any thrown error as
 * verification_pending (the served path is left in whatever state the
 * failing OS call produced — the caller must not advance the clause).
 */
export async function swapDist(
  args: SwapDistArgs,
  deps: SwapDistDeps = {},
): Promise<void> {
  const fs = deps.fsImpl ?? (await defaultFs());
  const { source, dest } = args;

  let hadPrevious = false;
  try {
    await fs.access(dest);
    hadPrevious = true;
  } catch {
    hadPrevious = false;
  }

  const aside = `${dest}.previous-${swapAsideStamp()}`;

  if (hadPrevious) {
    await fs.rename(dest, aside);
  }

  try {
    await fs.rename(source, dest);
  } catch (err) {
    if (hadPrevious) {
      await fs.rename(aside, dest).catch(() => {
        // Best-effort restore. Swallow secondary errors so the primary
        // rename failure is what the caller sees.
      });
    }
    throw err;
  }

  if (hadPrevious) {
    await fs.rm(aside, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// helpers

async function defaultFs(): Promise<NonNullable<SwapDistDeps['fsImpl']>> {
  const mod = await import('node:fs/promises');
  return {
    rename: mod.rename,
    rm: mod.rm,
    access: mod.access,
  };
}

let asideCounter = 0;
function swapAsideStamp(): string {
  asideCounter += 1;
  return `${process.pid}-${asideCounter}`;
}
