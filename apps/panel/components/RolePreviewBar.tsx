"use client";
/**
 * The docked bar shown while previewing a role — the always-visible reminder that the panel is a
 * simulation right now, with the one control that ends it. It borrows the request bar's dock so
 * the two elevation-modes feel like one idea, and reserves its own height the same way (the shell
 * ends above `--request-bar-h`) so it never covers the page it sits under.
 */
import { useEffect, useRef } from "react";
import { useRolePreview } from "../lib/rolePreview";

export function RolePreviewBar() {
  const preview = useRolePreview();
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = barRef.current;
    const root = document.documentElement;
    if (!preview.previewing || !el) { return; }
    const set = () => root.style.setProperty("--request-bar-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--request-bar-h"); };
  }, [preview.previewing]);

  if (!preview.previewing) return null;

  return (
    <div className="request-bar" role="status" ref={barRef}>
      <span className="request-bar-dot" aria-hidden>👁</span>
      <span className="rb-text">
        <strong>Viewing as {preview.role?.name}</strong>
        <span className="muted rb-wide"> · a read-only preview — nothing you press changes anything</span>
      </span>
      <span className="grow" />
      <button className="mini" onClick={() => preview.exit()}>Exit preview</button>
    </div>
  );
}
