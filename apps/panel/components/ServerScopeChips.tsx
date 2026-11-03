"use client";
/**
 * "Where does this apply?" — as many servers as you like.
 *
 * The first cut of this was a single `<select>`: every server, or one. That reads fine with two
 * servers and falls apart at three, which is the normal case — "the @Mods role covers Warfare and
 * Offensive but not the training server" could not be said at all. The data model always allowed
 * it (an assignment is one row per scope, so a role held on two servers is simply two rows); only
 * the control was narrower than the thing it was editing.
 *
 * Toggle chips rather than a multi-select box: `<select multiple>` needs ctrl-click to deselect and
 * is close to unusable on a phone, which is where this panel actually gets used.
 *
 * `null` means every server — including ones added later, which is the difference between it and
 * "all of them ticked". That distinction is the reason this is not just a list of ids: a mapping
 * meant to cover the whole community should not silently stop covering a server added next week.
 */
export function ServerScopeChips({ servers, value, onChange, disabled, label = "on" }: {
  servers: { id: string; name: string }[];
  /** null = everywhere (now and in future); otherwise exactly these servers. */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const picked = new Set(value ?? []);
  const everywhere = value === null;

  const toggle = (id: string) => {
    // Coming from "everywhere", the first specific pick means only that server — not "all of them
    // except". Anyone wanting most-but-not-all adds the rest, which is two clicks, versus silently
    // granting a server they did not choose.
    const next = new Set(everywhere ? [] : picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    // Deselecting the last one is a request to cover nothing, and an assignment that covers nothing
    // is just an absent assignment — so it falls back to everywhere rather than saving a no-op.
    onChange(next.size ? [...next] : null);
  };

  return (
    <span className="scope-chips">
      <span className="muted fs-xs">{label}</span>
      <button
        type="button" className={`scope-chip${everywhere ? " on" : ""}`} disabled={disabled}
        aria-pressed={everywhere} onClick={() => onChange(null)}
        title="Applies on every server, including any added later"
      >Every server</button>
      {servers.map((s) => (
        <button
          key={s.id} type="button" className={`scope-chip${picked.has(s.id) ? " on" : ""}`} disabled={disabled}
          aria-pressed={picked.has(s.id)} onClick={() => toggle(s.id)} title={s.name}
        >{s.name}</button>
      ))}
    </span>
  );
}

/** How a set of scopes reads in a sentence: "everywhere", "on Warfare", "on Warfare and 2 more". */
export function describeScopes(value: string[] | null, servers: { id: string; name: string }[]): string {
  if (value === null || !value.length) return "everywhere";
  const names = value.map((id) => servers.find((s) => s.id === id)?.name ?? id);
  if (names.length === 1) return `on ${names[0]}`;
  if (names.length === 2) return `on ${names[0]} and ${names[1]}`;
  return `on ${names[0]} and ${names.length - 1} more`;
}
