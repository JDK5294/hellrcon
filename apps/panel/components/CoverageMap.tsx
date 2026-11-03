"use client";
/**
 * Which profile is in charge, over time AND player count — the shared picture behind the map vote's
 * "which set runs when" and auto settings' "which profile applies when". Both features resolve
 * first-match-wins on the same schedule engine, so the same question deserves the same exact
 * answer, drawn the same way.
 *
 * Both axes matter and they interact: a profile gated "under 40 players" and one gated
 * "18:00–23:00" mean the same hour has different answers at different counts. Every display that
 * fixed the count to draw the clock — a heat grid at 60 players, a sentence per day — stated
 * something false at other counts, which is exactly the mistake this exists to catch.
 *
 * So the player count is an AXIS, not a setting: one labelled row per band, each row divided by
 * time, and a row can only exist where the answer genuinely differs from the row below it. The
 * regions come from the API computed off the config's own bounds, so they are exact rather than
 * sampled, and a striped stretch means no profile matches there at all.
 */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { localClock } from "../lib/time";
import { ActionResult, Callout, Divider } from "./ui";

interface CoverageSpan { startMinute: number; endMinute: number; profile: string | null }
interface CoverageBand { minPlayers: number; maxPlayers: number | null; spans: CoverageSpan[] }
interface CoverageResp {
  timezone: string;
  groups: { days: string[]; bands: CoverageBand[] }[];
  calendarOnly: { name: string; when: string }[];
  hasGaps: boolean;
}

/** Fixed swatches by profile name, so a profile keeps its colour across every row it appears in. */
const COVERAGE_COLORS = ["#4e79a7", "#e1913c", "#59a14f", "#b07aa1", "#76b7b2", "#a05d56", "#6b7b8c", "#8d6e63"];
const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** minutes past midnight → "18:00"; 1440 is the end of the day, not 00:00 the next one. */
const hhmm = (m: number) => (m >= 1440 ? "24:00" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

/** "Mon–Fri" for a run of days, "Sat, Sun" otherwise, "Every day" for the whole week. */
function daysLabel(days: string[]): string {
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  if (days.length === 7) return "Every day";
  const idx = days.map((d) => order.indexOf(d)).sort((a, b) => a - b);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
  return contiguous && idx.length > 2
    ? `${DAY_LABEL[order[idx[0]!]!]}–${DAY_LABEL[order[idx[idx.length - 1]!]!]}`
    : idx.map((i) => DAY_LABEL[order[i]!]).join(", ");
}

/** "Any player count" · "Under 40 players" · "40–59 players" · "60+ players". */
function bandLabel(b: CoverageBand): string {
  if (b.minPlayers === 0 && b.maxPlayers === null) return "Any player count";
  if (b.minPlayers === 0) return `Under ${b.maxPlayers} players`;
  if (b.maxPlayers === null) return `${b.minPlayers}+ players`;
  return `${b.minPlayers}–${b.maxPlayers - 1} players`;
}

export function CoverageMap({ endpoint, noun, fallbackName, gapAdvice, dirty, reloadKey, showLocal }: {
  /** The coverage route to read, or null when there is nothing to draw yet (no profiles). */
  endpoint: string | null;
  /** What one entry is called on this page: "map set", "profile". */
  noun: string;
  /** What an uncovered stretch falls back to: "defaults", "the stored settings", … (span label). */
  fallbackName: string;
  /** The gap callout's closing advice — what falling into a gap means HERE, and how to close it. */
  gapAdvice: ReactNode;
  dirty: boolean;
  reloadKey: number;
  showLocal: boolean;
}) {
  const [cov, setCov] = useState<CoverageResp | null>(null);
  const [covErr, setCovErr] = useState("");

  useEffect(() => {
    if (!endpoint) { setCov(null); return; }
    let stale = false;
    api<Partial<CoverageResp>>(endpoint)
      .then((r) => {
        if (stale) return;
        // Shaped on arrival rather than trusted. An older API build (a panel deployed ahead of the
        // server) answers this route with a body that has no regions in it at all, and reaching
        // into that directly threw during render — which in React takes the WHOLE settings page
        // down, not just this section. A coverage read that comes back unusable must cost nothing
        // more than an empty coverage section.
        setCov({
          timezone: typeof r?.timezone === "string" ? r.timezone : "UTC",
          groups: Array.isArray(r?.groups) ? r.groups.filter((g) => Array.isArray(g?.bands)) : [],
          calendarOnly: Array.isArray(r?.calendarOnly) ? r.calendarOnly : [],
          hasGaps: Boolean(r?.hasGaps),
        });
        setCovErr("");
      })
      .catch((e) => { if (!stale) setCovErr((e as Error).message); });
    return () => { stale = true; };
  }, [endpoint, reloadKey]);

  if (!endpoint) return null;

  const names = [...new Set((cov?.groups ?? []).flatMap((g) => g.bands.flatMap((b) => b.spans.map((s) => s.profile))).filter((n): n is string => n !== null))];
  const colorOf = (name: string) => COVERAGE_COLORS[names.indexOf(name) % COVERAGE_COLORS.length];
  const localMidnight = showLocal && cov ? localClock(cov.timezone, "00:00") : null;
  // Every uncovered region, said exactly — both axes named, because either alone is a half-truth.
  // Grouped by (days, band) so a day with two holes reads as one sentence, not two near-identical
  // ones: "00:00–18:00 and 23:00–24:00 on every day with 40+ players".
  const gaps: { days: string; band: string; ranges: string[] }[] = [];
  for (const g of cov?.groups ?? []) {
    for (const b of g.bands) {
      const ranges = b.spans.filter((s) => s.profile === null).map((s) => `${hhmm(s.startMinute)}–${hhmm(s.endMinute)}`);
      if (ranges.length) gaps.push({ days: daysLabel(g.days), band: bandLabel(b), ranges });
    }
  }
  const listed = (parts: string[]) => parts.map((p, i) => (i === 0 ? p : i === parts.length - 1 ? ` and ${p}` : `, ${p}`)).join("");

  return (
    <>
      <Divider label={`Coverage — which ${noun} is in charge`} />
      <p className="hint mt-0">
        {noun[0]!.toUpperCase() + noun.slice(1)}s are matched on time <em>and</em> player count, so both are shown: each row is a player-count band, divided across the day.
        {dirty && <> Shows the <strong>last saved</strong> settings — save to see your edits here.</>}
      </p>
      <ActionResult error={covErr} />
      {cov && (
        <>
          {cov.groups.map((g, gi) => (
            <div key={gi} className="cov-group">
              <div className="cov-group-head">{daysLabel(g.days)}</div>
              {g.bands.map((b, bi) => (
                <div key={bi} className="cov-row">
                  <div className="cov-band-label">{bandLabel(b)}</div>
                  <div className="cov-bar">
                    {b.spans.map((s, si) => {
                      const share = (s.endMinute - s.startMinute) / 1440;
                      return (
                        <div
                          key={si}
                          className={`cov-seg ${s.profile === null ? "cov-seg-gap" : ""}`}
                          style={{ width: `${share * 100}%`, background: s.profile ? colorOf(s.profile) : undefined }}
                          title={`${hhmm(s.startMinute)}–${hhmm(s.endMinute)} · ${bandLabel(b)} · ${s.profile ?? `no ${noun} matches — ${fallbackName}`}`}
                        >
                          {/* A short stretch cannot hold its name, and half a word reads as a
                              different profile — so it stays blank and answers on hover instead. */}
                          {share >= 0.1 && <span className="cov-seg-text">{s.profile ?? fallbackName}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="cov-row">
                <div className="cov-band-label" />
                <div className="cov-ruler">
                  {[0, 6, 12, 18].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, "0")}:00</span>)}
                  <span style={{ right: 0 }}>24:00</span>
                </div>
              </div>
            </div>
          ))}

          <p className="hint" style={{ marginTop: 8 }}>
            Times are in {cov.timezone}{localMidnight ? <> · 00:00 there is {localMidnight} for you</> : null}.
            {cov.calendarOnly.length > 0 && (
              <> Not shown above because {cov.calendarOnly.length === 1 ? "it only applies" : "they only apply"} under conditions the clock can&apos;t draw:{" "}
                {cov.calendarOnly.map((c, i) => <span key={c.name}>{i > 0 && ", "}<strong>{c.name}</strong> ({c.when})</span>)}.
              </>
            )}
          </p>

          {cov.hasGaps
            ? <Callout variant="warn">
                <strong>No {noun} covers:</strong>
                <ul style={{ margin: "4px 0 6px 18px" }}>
                  {gaps.map((g, i) => (
                    <li key={i}>{listed(g.ranges)} on {g.days.toLowerCase()}, with <strong>{g.band.toLowerCase()}</strong></li>
                  ))}
                </ul>
                {gapAdvice}
              </Callout>
            : <p className="hint">Every time of day at every player count is covered by one of your {noun}s.</p>}
        </>
      )}
    </>
  );
}
