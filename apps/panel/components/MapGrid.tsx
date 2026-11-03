"use client";
/**
 * Pick maps by looking at them.
 *
 * The search box this replaces asked staff to know what a map is called before they could choose
 * it, and to recognise "stmariedumont_off_ger" when it came back. That is fine for whoever set the
 * server up and useless for everyone else on the team. Here every map is a thumbnail of the actual
 * place with its mode and time of day on it, so choosing is recognition rather than recall.
 *
 * Variants are grouped under their family — Carentan's Warfare, Offensive and night versions sit
 * together — because "I want Carentan" is the thought people actually have, and the variants are
 * the fiddly part they get wrong. Selecting the family header takes all of them.
 *
 * Maps with no bundled artwork still appear, as a plain tile. A missing image must never hide a map
 * that the vote can legitimately offer.
 */
import { useMemo, useState } from "react";
import { mapIconUrl } from "../lib/gameAssets";
import { useGame } from "../lib/game";
import { Nothing, SearchInput } from "./ui";

export interface GridMap {
  id: string; prettyName: string; mode?: string; environment?: string; family?: string;
  /** The coarse day/night the vote engine buckets by, computed server-side. Never re-derive it. */
  envGroup?: "day" | "night";
}

/** Short badge text for a variant, e.g. "Warfare · Night". Nothing when we know nothing. */
function variantLabel(m: GridMap): string {
  const bits = [m.mode, m.environment && m.environment.toLowerCase() !== "day" ? m.environment : null].filter(Boolean);
  return bits.map((b) => String(b)[0]!.toUpperCase() + String(b).slice(1)).join(" · ");
}

export function MapGrid({ catalogue, value, onChange, disabled, emptyMeans = "every map" }: {
  catalogue: GridMap[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  /** What an empty selection means here, said in the header so it is never ambiguous. */
  emptyMeans?: string;
}) {
  // The catalogue always belongs to the pinned server's game, so the artwork asks about that
  // one — a Vietnam set must not be illustrated with Normandy tiles.
  const game = useGame();
  const [q, setQ] = useState("");
  const selected = useMemo(() => new Set(value), [value]);

  // Group by family, keeping catalogue order within each so variants read day → night as listed.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const byFamily = new Map<string, GridMap[]>();
    for (const m of catalogue) {
      if (needle && !m.prettyName.toLowerCase().includes(needle) && !m.id.toLowerCase().includes(needle)) continue;
      const fam = m.family || m.id;
      const list = byFamily.get(fam) ?? [];
      list.push(m);
      byFamily.set(fam, list);
    }
    return [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalogue, q]);

  const toggle = (id: string) => {
    if (disabled) return;
    onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  };
  const toggleFamily = (maps: GridMap[]) => {
    if (disabled) return;
    const ids = maps.map((m) => m.id);
    const allOn = ids.every((id) => selected.has(id));
    onChange(allOn ? value.filter((x) => !ids.includes(x)) : [...new Set([...value, ...ids])]);
  };

  // The family name as a heading: the raw family key is a squashed id, so prefer the shortest
  // pretty name in the group, which is nearly always the plain Warfare variant.
  const familyLabel = (maps: GridMap[]) =>
    [...maps].sort((a, b) => a.prettyName.length - b.prettyName.length)[0]?.prettyName ?? maps[0]?.id ?? "";

  return (
    <div className="mapgrid">
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <SearchInput value={q} onChange={setQ} placeholder="Filter maps…" />
        <span className="hint">
          {value.length > 0
            ? <><strong>{value.length}</strong> selected</>
            : <>Nothing selected — that means <strong>{emptyMeans}</strong>.</>}
        </span>
        {value.length > 0 && !disabled && (
          <button className="ghost mini" onClick={() => onChange([])}>Clear</button>
        )}
      </div>

      {groups.length === 0 && <Nothing>No maps match “{q}”.</Nothing>}

      <div className="mapgrid-groups" role="group" aria-label="Maps">
        {groups.map(([fam, maps]) => {
          const allOn = maps.every((m) => selected.has(m.id));
          const someOn = !allOn && maps.some((m) => selected.has(m.id));
          return (
            <div key={fam} className="mapgrid-group">
              {/* A family with one variant needs no "select all" — the tile IS the family, and the
                  header would just say the same name twice. */}
              {maps.length > 1 && (
                <button
                  type="button"
                  className={`mapgrid-family ${allOn ? "all" : someOn ? "some" : ""}`}
                  onClick={() => toggleFamily(maps)}
                  disabled={disabled}
                  aria-pressed={allOn}
                  title={allOn ? "Deselect every version of this map" : "Select every version of this map"}
                >
                  {familyLabel(maps)} <span className="hint">{maps.length}</span>
                </button>
              )}
              <div className="mapgrid-variants">
                {maps.map((m) => {
                  const on = selected.has(m.id);
                  const art = mapIconUrl(m.id, game.descriptor?.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`mapgrid-tile ${on ? "on" : ""}`}
                      onClick={() => toggle(m.id)}
                      disabled={disabled}
                      aria-pressed={on}
                      title={m.prettyName}
                    >
                      {art
                        ? <img className="mapgrid-art" src={art} alt="" loading="lazy" />
                        : <span className="mapgrid-art mapgrid-art-none" aria-hidden />}
                      <span className="mapgrid-text">
                        <span className="mapgrid-name">{m.prettyName}</span>
                        {variantLabel(m) && <span className="mapgrid-tag">{variantLabel(m)}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MapGrid;
