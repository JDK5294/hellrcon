"use client";
/**
 * Searchable map picker — shows friendly names, stores raw ids. Staff never type a raw map id: they
 * search by name and click. Single mode (one map, e.g. override) or multi mode (a list, e.g. a
 * blacklist). Backed by the server's live catalogue; unknown stored ids still render (as the id).
 * Styling lives in `.picker*` classes (globals.css), not inline.
 */
import { useMemo, useState } from "react";

export interface CatalogueMap { id: string; prettyName: string }

export function MapPicker({ catalogue, value, onChange, multiple = true, disabled, placeholder = "Search maps…" }: {
  catalogue: CatalogueMap[];
  value: string[];
  onChange: (v: string[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const nameOf = useMemo(() => {
    const m = new Map(catalogue.map((c) => [c.id, c.prettyName]));
    return (id: string) => m.get(id) ?? id;
  }, [catalogue]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return catalogue
      .filter((c) => !value.includes(c.id) && (c.prettyName.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)))
      .slice(0, 40);
  }, [catalogue, q, value]);

  const add = (id: string) => { onChange(multiple ? [...value, id] : [id]); setQ(""); };
  const remove = (id: string) => onChange(value.filter((x) => x !== id));

  return (
    <div className="picker">
      <div className="picker-chips">
        {value.map((id) => (
          <span key={id} className="picker-chip">
            {nameOf(id)}
            {!disabled && <button type="button" onClick={() => remove(id)} aria-label="remove">✕</button>}
          </span>
        ))}
      </div>
      {!disabled && (multiple || value.length === 0) && (
        <div className="picker-input-wrap">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} />
          {matches.length > 0 && (
            <div className="picker-menu">
              {matches.map((m) => (
                <button key={m.id} type="button" className="picker-opt" onClick={() => add(m.id)}>
                  <strong>{m.prettyName}</strong> <span className="muted">{m.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {catalogue.length === 0 && <span className="hint">Map list unavailable (server offline?) — reconnect to pick by name.</span>}
    </div>
  );
}
