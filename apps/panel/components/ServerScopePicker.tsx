"use client";
/**
 * "Which servers?" for an action that can hit more than one.
 *
 * Bans are the reason this exists. A ban lives in one game server's own ban list, so a player
 * barred from the community had to be banned once per server, and lifting it meant remembering to
 * do the same in reverse — miss one and they are quietly still banned somewhere nobody looks.
 *
 * It asks for a RULE rather than a set of ticks, because those are different decisions:
 *
 *   • Everywhere      — the community. A server we stand up next month is covered too.
 *   • Everywhere but… — the same, with exceptions. Also covers a new server.
 *   • Only these      — exactly this set, and nothing that appears later.
 *
 * The first two used to be impossible to say: ticking every box produced the same array of ids as
 * choosing them one by one, so the intent was lost the moment the request left the browser and no
 * later server could inherit anything. The three-way choice is what makes the difference storable.
 * The shape came from the map-vote editor, which already says "any map except these".
 *
 * Servers are listed by their NUMBER, not their name: these names are eighty characters long and
 * differ from each other by one digit in the middle, so a column of them is unreadable and a row
 * of them does not fit. The number is the same one the header badge shows.
 *
 * Only servers the staff member can actually act on appear — the API re-checks and would refuse
 * the rest, and offering a choice that can only fail is worse than not offering it.
 */
import { useServers } from "../lib/servers";
import { useGrants } from "../lib/grants";
import { canOnServer } from "../lib/access";
import { describeBanScope, resolveBanScope, type BanScope } from "../lib/banScope";

const MODES = [
  { id: "all", label: "Everywhere" },
  { id: "except", label: "Everywhere but…" },
  { id: "servers", label: "Only these" },
] as const;

export function ServerScopePicker({ capability, game, value, onChange, label = "Apply on" }: {
  /** The capability the action needs — a server the user lacks it on is not offered. */
  capability: string;
  /** The game the player id belongs to. Ids do not cross games (HLL: Vietnam keys players by its
   *  own per-game EOS id), so a server running a different game is never offered — the API would
   *  refuse it anyway, and offering a choice that can only fail is worse than not offering it. */
  game?: string;
  /** The scope rule. */
  value: BanScope;
  onChange: (scope: BanScope) => void;
  label?: string;
}) {
  const { servers, numberOf } = useServers();
  const grants = useGrants();
  const allowed = servers.filter((s) => (!game || s.game === game) && canOnServer(grants, capability, s.id));
  // One server in the community: there is no combination to choose, so the control is noise.
  if (allowed.length < 2) return null;

  const listed = value.mode === "all" ? [] : value.serverIds;
  const covered = resolveBanScope(value, allowed).length;

  /** In `except` a ticked chip is EXCLUDED; in `servers` it is included. One list, two readings. */
  const toggle = (id: string) => {
    if (value.mode === "all") return;
    const next = listed.includes(id) ? listed.filter((x) => x !== id) : [...listed, id];
    onChange({ mode: value.mode, serverIds: next });
  };

  const setMode = (mode: BanScope["mode"]) => {
    if (mode === "all") return onChange({ mode: "all" });
    // The ticks are deliberately NOT carried across. A chip means "include" in one mode and
    // "exclude" in the other, so keeping the list would silently invert what the user had said —
    // "only #1" would become "everywhere but #1", which is very nearly its opposite. Every mode
    // starts from its own widest reading and narrows from there.
    onChange({ mode, serverIds: [] });
  };

  return (
    <div className="scope-pick">
      <div className="scope-pick-head">
        <span>{label}</span>
        <div className="seg" role="group" aria-label="Which servers">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`seg-btn ${value.mode === m.id ? "active" : ""}`}
              aria-pressed={value.mode === m.id}
              onClick={() => setMode(m.id)}
            >{m.label}</button>
          ))}
        </div>
      </div>
      {value.mode !== "all" && (
        <div className="scope-pick-row">
          {allowed.map((s) => {
            const ticked = listed.includes(s.id);
            const excluding = value.mode === "except";
            return (
              <button
                key={s.id}
                type="button"
                className={`scope-chip${ticked ? (excluding ? " off" : " on") : ""}`}
                aria-pressed={ticked}
                // The full name lives here — unreadable in a chip, but the only way to be certain
                // which server a number means when it matters.
                title={`${s.name}${excluding && ticked ? " — excluded" : ""}${s.engagementMode === "observe" ? " — observe mode, writes are refused" : ""}`}
                onClick={() => toggle(s.id)}
              >
                <span className="scope-no">{numberOf(s.id)}</span>
                {s.engagementMode === "observe" && <span className="scope-obs" aria-label="observe mode">obs</span>}
              </button>
            );
          })}
        </div>
      )}
      {/* Say it out loud. Beside a Ban button this is the last chance to notice that the action is
          about to reach further than intended — and with a standing rule that now includes servers
          nobody has built yet, the count alone no longer tells the whole story. */}
      <p className="hint scope-pick-note">{describeBanScope(value, covered, allowed.length)}</p>
    </div>
  );
}
