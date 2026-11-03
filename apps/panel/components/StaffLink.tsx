"use client";
/**
 * A clickable staff (user) name that jumps to that user's staff profile — the mirror of PlayerLink,
 * for actors in the audit trail. Drop it anywhere a staff name appears (Activity trail, staff cards,
 * a target that happens to be a user). With no id it renders plain text.
 */
import { useAppNav } from "../lib/nav";

export function StaffLink({ userId, name, className }: { userId?: string | null; name?: React.ReactNode; className?: string }) {
  const { go } = useAppNav();
  const label = name ?? (userId || "");
  if (!userId) return <>{label}</>;
  return (
    <button
      type="button"
      className={`player-link${className ? ` ${className}` : ""}`}
      onClick={(e) => { e.stopPropagation(); go("staff", { userId }); }}
      title="Open staff profile"
    >
      {label}
    </button>
  );
}
