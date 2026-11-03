"use client";
/**
 * "Download": a list as a file, in the format picked in a small popup — Excel, CSV or JSON — which
 * remembers the last choice on this device. What goes in is the list as the screen has it (its
 * search, filters and order), or, for a list the screen holds only part of, every row `sheet`
 * fetches — over a time range picked in the same popup, for a log that runs back months.
 * lib/download.ts writes the file.
 */
import { useState } from "react";
import { ActionResult, Modal } from "./ui";
import { useToast } from "../lib/feedback";
import { buildFile, FORMATS, isFormat, type DownloadFormat, type Sheet } from "../lib/download";
import { effectiveZone, isoToWall, wallToIso } from "../lib/time";

/** The time a ranged download covers: ISO instants, either end open. */
export interface DownloadRange { from?: string; to?: string }

const RANGES = [
  { id: "1h", label: "The last hour", ms: 3_600_000 },
  { id: "24h", label: "The last 24 hours", ms: 86_400_000 },
  { id: "7d", label: "The last 7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "The last 30 days", ms: 30 * 86_400_000 },
  { id: "all", label: "Everything" },
  { id: "custom", label: "Pick the dates…" },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

/** The picked range as instants, or why it cannot be read. Typed dates are in the display zone. */
function readRange(id: RangeId, fromWall: string, toWall: string): DownloadRange | string {
  const preset = RANGES.find((r) => r.id === id);
  if (preset && "ms" in preset) return { from: new Date(Date.now() - preset.ms).toISOString() };
  if (id === "all") return {};
  const from = fromWall ? wallToIso(fromWall) : null;
  const to = toWall ? wallToIso(toWall) : null;
  if (!from && !to) return "Pick a start, an end, or both.";
  if (from && to && from >= to) return "The start has to come before the end.";
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

const FORMAT_KEY = "panel.download.format";

function rememberedFormat(): DownloadFormat {
  try {
    const kept = window.localStorage.getItem(FORMAT_KEY);
    if (isFormat(kept)) return kept;
  } catch { /* storage blocked: the default */ }
  return "xlsx";
}

/** Hands the browser a file to save. The address is kept a minute rather than revoked at once:
 *  Safari reads it after the click returns, and a revoked one saves nothing. */
function saveFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function DownloadButton({ file, title, count, noun, scope, ranged, noIds, sheet }: {
  /** The file's name without its extension (fileStem). Today's date is added to it. */
  file: string;
  /** The popup's heading: "Download the VIP list". */
  title: string;
  /** How many rows the file will hold, when the screen knows (a ranged list's are counted as read). */
  count?: number;
  /** One row, in words: "VIP", "member". */
  noun: string;
  /** What the rows are, after the count ("as the list stands — its search and order"), or after
   *  "Every line" for a list counted as it is read ("matching the log's filters, in the time…"). */
  scope: string;
  /** Offer a time range: the list runs back further than anyone wants in one file. */
  ranged?: boolean;
  /** The rows hold no game ids (names only), so the formats are not described by how they keep them. */
  noIds?: boolean;
  /** The rows, read when the download is asked for — fetched, for a list held only in part. */
  sheet: (range: DownloadRange) => Sheet | Promise<Sheet>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<DownloadFormat>("xlsx");
  const [rangeId, setRangeId] = useState<RangeId>("24h");
  const [fromWall, setFromWall] = useState("");
  const [toWall, setToWall] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function download() {
    const range = ranged ? readRange(rangeId, fromWall, toWall) : {};
    if (typeof range === "string") return setError(range);
    setBusy(true);
    setError("");
    try {
      const rows = await sheet(range);
      const today = isoToWall(new Date().toISOString()).slice(0, 10);
      saveFile(`${file}-${today}.${format}`, buildFile(rows, format, { zone: effectiveZone(), wall: isoToWall }));
      try { window.localStorage.setItem(FORMAT_KEY, format); } catch { /* remembered for this visit only */ }
      if (rows.notice) toast.info(rows.notice);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="mini ghost" disabled={count === 0} title={count === 0 ? "Nothing to download" : undefined}
        onClick={() => { setFormat(rememberedFormat()); setError(""); setOpen(true); }}>Download</button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)} busy={busy} className="confirm-modal">
          <div className="pa-fields">
            <label>Format
              <select value={format} onChange={(e) => setFormat(e.target.value as DownloadFormat)}>
                {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            <p className="muted fs-sm" style={{ margin: 0 }}>{(() => { const f = FORMATS.find((x) => x.id === format); return noIds ? f?.plain : f?.blurb; })()}</p>
            {ranged && (
              <label>Time range
                <select value={rangeId} onChange={(e) => setRangeId(e.target.value as RangeId)}>
                  {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </label>
            )}
            {ranged && rangeId === "custom" && (
              <>
                <label>From<input type="datetime-local" value={fromWall} onChange={(e) => setFromWall(e.target.value)} /></label>
                <label>To<input type="datetime-local" value={toWall} onChange={(e) => setToWall(e.target.value)} /></label>
              </>
            )}
            <p className="muted fs-sm" style={{ margin: 0 }}>{count === undefined ? `Every ${noun} ${scope}.` : `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}, ${scope}.`}</p>
          </div>
          <ActionResult error={error} />
          <div className="pa-actions">
            <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button type="button" onClick={() => void download()} disabled={busy}>{busy ? "Preparing…" : "Download"}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
