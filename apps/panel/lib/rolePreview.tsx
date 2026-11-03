"use client";
/**
 * "View as this role" — an ephemeral, read-only preview that renders the whole panel as a chosen
 * role would experience it, so an owner tuning permissions can SEE the result instead of guessing.
 *
 * It reuses the shape the request builder already proved comfortable: a docked bar that stays up
 * across every screen while the mode is on, with an Exit that puts everything back. Two promises
 * make it safe:
 *   - the view can only ever NARROW — the grants the shell renders with are the role's, clamped to
 *     what the previewer themselves holds (previewGrantsForRole), so nobody sees a screen they
 *     could not already open;
 *   - nothing can be changed from inside it — lib/api refuses every non-GET while the flag is on,
 *     because a write from a simulation would be a real write.
 *
 * Purely client-side and unsaved: a preview is a glance, not a state. It does not touch the draft,
 * the server, or localStorage — closing the tab ends it, which is the right lifetime for "let me
 * check what they'd see."
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setRolePreview } from "./api";

export interface PreviewRole {
  id: string;
  name: string;
  grants: { capability: string; level: "none" | "read" | "write" }[];
}

interface RolePreview {
  /** The role being previewed, or null when not previewing. */
  role: PreviewRole | null;
  previewing: boolean;
  start: (role: PreviewRole) => void;
  exit: () => void;
}

const Ctx = createContext<RolePreview>({ role: null, previewing: false, start: () => {}, exit: () => {} });
export const useRolePreview = () => useContext(Ctx);

export function RolePreviewProvider({ children, onChange }: { children: ReactNode; onChange?: (role: PreviewRole | null) => void }) {
  const [role, setRole] = useState<PreviewRole | null>(null);
  // If this provider ever unmounts mid-preview (a sign-out remounting the shell), the module
  // flag must not outlive it — a stale flag refuses writes for a session that never previewed.
  useEffect(() => () => setRolePreview(null), []);
  const start = useCallback((r: PreviewRole) => {
    setRolePreview(r.id);
    setRole(r);
    onChange?.(r);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, [onChange]);
  const exit = useCallback(() => {
    setRolePreview(null);
    setRole(null);
    onChange?.(null);
  }, [onChange]);
  const value = useMemo(() => ({ role, previewing: role !== null, start, exit }), [role, start, exit]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
