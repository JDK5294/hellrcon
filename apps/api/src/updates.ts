/**
 * Is there a newer version? Asked for the account made at setup, and nobody else (routes/admin.ts).
 *
 * The start scripts bake in where this build came from: the commit (APP_COMMIT), the branch the
 * clone follows (APP_BRANCH) and the GitHub repository as owner/name (APP_REPO, never the clone's
 * address, which can carry a sign-in). The check reads the branch's newest commits from GitHub's
 * public API and finds this build among them: the ones above it are the update. One request, no
 * file lists, and at most one an hour — GitHub allows sixty an hour without an account.
 *
 * GitHub answers 404 for a private repository, so until the code is public there is nothing to
 * compare against, and the answer says so instead of guessing.
 */
export interface UpdateChange {
  sha: string;
  /** The commit message's first line. */
  title: string;
  date: string | null;
}

export interface UpdateStatus {
  state: "current" | "available" | "unknown";
  commit: string | null;
  branch: string | null;
  /** How many commits the branch has past this build ("available" only). */
  behindBy?: number;
  /** Newest first. */
  changes?: UpdateChange[];
  /** Why there is no answer ("unknown" only). */
  reason?: string;
  checkedAt: string | null;
}

export interface UpdateCheck {
  /** The last answer, asking GitHub again when it is older than an hour (or never asked). */
  status(): Promise<UpdateStatus>;
}

/** How far back the branch is read: an install further behind than this is told it cannot tell. */
export const LOOK_BACK = 100;
const MAX_AGE_MS = 60 * 60_000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createUpdateCheck(opts: { commit?: string | null; branch?: string | null; repo?: string | null; fetch?: Fetch; now?: () => number } = {}): UpdateCheck {
  const commit = opts.commit?.trim() || null;
  const branch = opts.branch?.trim() || null;
  const repo = opts.repo?.trim() || null;
  const fetchImpl: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  let last: UpdateStatus | null = null;
  let lastAt = 0;
  let inFlight: Promise<UpdateStatus> | null = null;

  const unknown = (reason: string): UpdateStatus => ({ state: "unknown", commit, branch, reason, checkedAt: new Date(now()).toISOString() });

  async function ask(): Promise<UpdateStatus> {
    if (!commit) return unknown("This install was not started by start.bat or start.sh, so the version it runs is not known.");
    if (!branch) return unknown("This copy of the code follows no branch, so there is no newer version to look for.");
    if (!repo) return unknown("This copy of the code did not come from GitHub, so there is nothing to compare it with.");
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${LOOK_BACK}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "hellrcon-update-check" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return last ?? unknown("GitHub did not answer, so newer versions cannot be checked right now.");
    }
    if (res.status === 404) {
      return unknown("GitHub does not show this code's repository to the public (it is private), so newer versions cannot be checked.");
    }
    if (!res.ok) return last ?? unknown(`GitHub answered ${res.status}, so newer versions cannot be checked right now.`);
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list)) return last ?? unknown("GitHub's answer could not be read.");
    const commits = list.map((c) => ({
      sha: String((c as { sha?: unknown }).sha ?? ""),
      title: String((c as { commit?: { message?: unknown } }).commit?.message ?? "").split("\n")[0]!.trim(),
      date: ((c as { commit?: { committer?: { date?: string }; author?: { date?: string } } }).commit?.committer?.date
        ?? (c as { commit?: { author?: { date?: string } } }).commit?.author?.date) ?? null,
    }));
    const at = commits.findIndex((c) => c.sha.startsWith(commit));
    const checkedAt = new Date(now()).toISOString();
    if (at === 0) return { state: "current", commit, branch, checkedAt };
    if (at > 0) return { state: "available", commit, branch, behindBy: at, changes: commits.slice(0, at).map((c) => ({ ...c, sha: c.sha.slice(0, 8) })), checkedAt };
    return unknown(`This version is not among the newest ${LOOK_BACK} on ${branch}: it is further behind, or not on that branch.`);
  }

  return {
    async status() {
      if (last && now() - lastAt < MAX_AGE_MS) return last;
      inFlight ??= ask().then((s) => { last = s; lastAt = now(); return s; }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
