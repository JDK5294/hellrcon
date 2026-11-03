/**
 * Binds the Discord moderation panel to the approvals spine.
 *
 * This file exists for one reason: the spine (`approvals.ts`, `requests.ts`, `approval-cards.ts`)
 * must never sit in an import cycle (import-cycles.test.ts), and `discord-moderation.ts` is
 * reached through the `context → plugin-host → discord-modules` knot — importing the spine from
 * there would close a loop THROUGH it. So the module declares narrow deps and this file, imported
 * only from the server root (index.ts) which nothing imports back, hands it the real functions
 * with the app context bound.
 */
import type { AppContext } from "./context.js";
import { executeApprovedLine } from "./approvals.js";
import { fileRequest } from "./requests.js";
import { postApprovalCard } from "./approval-cards.js";
import { setModerationDeps } from "./discord-moderation.js";

export function wireModerationPanel(ctx: AppContext): void {
  setModerationDeps({
    executeLine: (approver, line, opts) => executeApprovedLine(ctx, approver, line, opts),
    fileVolley: async (requester, lines, note) => {
      const filed = await fileRequest(ctx, requester, lines, { note });
      // Fire-and-forget like every card post: a Discord outage must never fail a filing.
      void postApprovalCard(ctx, filed.id);
      return { requestId: filed.id };
    },
  });
}
