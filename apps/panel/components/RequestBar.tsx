"use client";
/**
 * The pinned cart bar + the "does everything look right" review.
 *
 * The bar stays on screen across every view while request mode is on — the visible promise that
 * the app is capturing, not firing. Review lists each captured line with its FATE at this user's
 * grants: ✓ lines they hold at write apply immediately on submit, ✋ the rest are filed as one
 * bundle for the queue. Rows can be dropped before filing; Submit is the single moment anything
 * actually happens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useRequestMode } from "../lib/requestMode";
import { useServers } from "../lib/servers";
import { useConfirm, useToast } from "../lib/feedback";
import { KIND_LABEL } from "../lib/approvals";
import { routeDetails } from "../lib/requestLines";
import { Modal } from "./ui";

interface DraftLine {
  id: string; kind: string; serverId: string | null;
  playerId: string | null; playerName: string | null;
  payload: Record<string, unknown>;
  fate: "immediate" | "ask";
}

function details(l: DraftLine): string {
  const p = l.payload;
  // A filed call shows what it would do (the message, the map, the command) — see routeDetails.
  if (l.kind === "route") return routeDetails(p);
  const parts: string[] = [];
  if (typeof p.hours === "number" && p.hours > 0) parts.push(`${p.hours}h`);
  if (typeof p.days === "number" && p.days > 0) parts.push(`${p.days}d`);
  if (typeof p.mode === "string" && p.mode) parts.push(String(p.mode));
  if (typeof p.reason === "string" && p.reason) parts.push(`“${p.reason}”`);
  if (typeof p.message === "string" && p.message) parts.push(`“${p.message}”`);
  return parts.join(" · ");
}

export function RequestBar() {
  const mode = useRequestMode();
  const { servers } = useServers();
  const toast = useToast();
  const confirm = useConfirm();
  const [review, setReview] = useState<DraftLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const serverName = useMemo(() => new Map(servers.map((s) => [s.id, s.name])), [servers]);
  const barRef = useRef<HTMLDivElement>(null);

  /*
   * The bar RESERVES its own height instead of floating over the page.
   *
   * It used to hover above the bottom edge as a centred pill, which on a phone wrapped onto three
   * rows and sat on top of the page: the rows underneath it could not be read and could not be
   * tapped, and no amount of scrolling moved them clear, because nothing else knew the bar was
   * there. Publishing the measured height as `--request-bar-h` lets the shell end above it — the
   * page shrinks rather than being covered. Measured rather than hard-coded because the bar still
   * grows a line when the text wraps on a very narrow screen, and a stale constant would put the
   * gap in the wrong place.
   */
  useEffect(() => {
    const el = barRef.current;
    const root = document.documentElement;
    if (!mode.building || !el) { root.style.removeProperty("--request-bar-h"); return; }
    const set = () => root.style.setProperty("--request-bar-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--request-bar-h"); };
  }, [mode.building]);

  const openReview = useCallback(async () => {
    try {
      const r = await api<{ draft: { lines: DraftLine[] } | null }>("/requests/draft");
      setReview(r.draft?.lines ?? []);
    } catch (e) { toast.error((e as Error).message); }
  }, [toast]);

  if (!mode.building) return null;

  const immediate = (review ?? []).filter((l) => l.fate === "immediate").length;
  const ask = (review ?? []).length - immediate;

  async function removeLine(id: string) {
    try {
      await api(`/requests/draft/lines/${id}`, { method: "DELETE" });
      setReview((rows) => rows?.filter((l) => l.id !== id) ?? null);
      mode.captured(Math.max(0, mode.count - 1));
    } catch (e) { toast.error((e as Error).message); }
  }

  async function submit() {
    setBusy(true);
    try {
      const r = await api<{ applied: { error: string | null }[]; filed: string | null }>("/requests/draft/submit", { method: "POST" });
      const failed = r.applied.filter((a) => a.error).length;
      const parts: string[] = [];
      if (r.applied.length) parts.push(`${r.applied.length - failed} applied now${failed ? ` (${failed} failed — see Requests)` : ""}`);
      if (r.filed) parts.push("the rest sent for approval (Moderation → Requests)");
      toast.success(parts.length ? parts.join(" · ") : "Submitted");
      setReview(null);
      mode.captured(0);
      mode.exit();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  /** Exit = leave WITHOUT saving: the draft is dropped, and you land back where you entered.
   *  A filled cart gets one warning naming the alternative; an empty one just closes. */
  async function exitAndDrop() {
    if (mode.count > 0 && !(await confirm({
      title: "Exit without saving?",
      body: `${mode.count} captured action${mode.count === 1 ? "" : "s"} will be dropped — nothing was ever executed. Use “Save draft” instead to keep them for later.`,
      confirmLabel: "Exit and drop",
      danger: true,
    }))) return;
    await mode.discard();
    setReview(null);
  }

  return (
    <>
      {/* One line, and the words that can be dropped on a narrow screen are marked as droppable
          rather than allowed to wrap the whole bar onto three rows. */}
      <div className="request-bar" role="status" ref={barRef}>
        <span className="request-bar-dot" aria-hidden>●</span>
        <span className="rb-text">
          <strong>Building</strong>
          <span className="rb-wide"> a request</span>
          <span className="muted"> · {mode.count} captured</span>
          <span className="muted rb-wide"> · nothing executed</span>
        </span>
        <span className="grow" />
        <button className="mini" onClick={() => void openReview()} disabled={mode.count === 0}>Review<span className="rb-wide"> &amp; submit</span></button>
        <button className="mini ghost" onClick={() => void mode.save()} title="Keep the draft for later and go back to where you were — “Build a request” resumes it">Save<span className="rb-wide"> draft</span></button>
        <button className="mini ghost danger-ghost" onClick={() => void exitAndDrop()} title="Leave without saving — anything not saved or submitted is dropped">Exit</button>
      </div>

      {review && (
        <Modal title="Does everything look right?" onClose={() => setReview(null)} busy={busy}>
          {!review.length && <p className="muted">The request is empty — add actions from any player menu, then come back.</p>}
          {review.length > 0 && (
            <>
              <p className="muted mt-0">
                {immediate > 0 && <>✓ {immediate} appl{immediate === 1 ? "ies" : "y"} immediately (your own permissions). </>}
                {ask > 0 && <>✋ {ask} go{ask === 1 ? "es" : ""} for approval.</>}
              </p>
              <div className="scroll-x">
                <table>
                  <thead><tr><th>Action</th><th>Player</th><th>Server</th><th>Details</th><th>On submit</th><th></th></tr></thead>
                  <tbody>
                    {review.map((l) => (
                      <tr key={l.id}>
                        {/* A filed call carries its own words (see ask.ts) — never a URL. */}
                        <td style={{ whiteSpace: "nowrap" }}>{KIND_LABEL[l.kind] ?? (typeof l.payload.label === "string" ? l.payload.label : l.kind)}</td>
                        {/* Both, for the same reason the queue shows both: the name is who you
                            are about to act on, the id is the thing that is unambiguous. */}
                        <td>
                          {l.playerName || l.playerId
                            ? <>
                                <div>{l.playerName || <span className="muted">unknown player</span>}</div>
                                {l.playerId && <div className="muted fs-xs mono-id">{l.playerId}</div>}
                              </>
                            : <span className="muted">—</span>}
                        </td>
                        <td>{l.serverId ? serverName.get(l.serverId) ?? <span className="muted">gone</span> : <span className="muted">—</span>}</td>
                        <td className="wrap">{details(l) || <span className="muted">—</span>}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {l.fate === "immediate"
                            ? <span className="badge active">applies immediately</span>
                            : <span className="badge observe">needs approval</span>}
                        </td>
                        <td><button className="mini ghost" onClick={() => void removeLine(l.id)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="pa-actions">
            <button className="ghost" onClick={() => setReview(null)} disabled={busy}>Keep building</button>
            <button onClick={() => void submit()} disabled={busy || !review.length}>{busy ? "Submitting…" : "Submit"}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
