"use client";
/**
 * Map vote SETUP — the settings, and only the settings.
 *
 * This was once nine numbered steps that also carried the live controls, a poll preview, a one-off
 * "force the next map", and a link to another page. Numbering implied a sequence you complete, but
 * this is a screen you come back to; the numbering even skipped 4 when that step didn't apply, so
 * the list had a hole in it. Worse, the actions you use during a match were buried in the middle of
 * a form you fill in once.
 *
 * So the controls moved to MapVoteControl (the Vote tab) and what is left is a plain settings panel
 * in the house shape: Save in the header, Divider-separated sections, no numbers. The sections are
 * the real decisions — where the poll goes, what can be voted on, when a set applies, the timings,
 * and what players are told in game.
 *
 * Deliberately NOT changed: the map sets stay explicit lists. Staff curate those on purpose — the
 * job here is to make the list legible (how many are excluded, how many can still appear), not to
 * replace it with clever rules.
 *
 * What DID change: the sets themselves no longer live here. A set and a schedule are shared library
 * records now (see MapVoteLibrary), and this page holds only the ordered PAIRINGS — this set, on
 * that schedule — that make up one server's vote. Two dropdowns per line, and the library behind a
 * disclosure, because on a phone the previous layout put every map of every set on the page before
 * you reached the setting you came for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtExact } from "../lib/time";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { useAppNav } from "../lib/nav";
import { useToast } from "../lib/feedback";
import { CoverageMap } from "./CoverageMap";
import { readUserPrefs } from "../lib/userPrefs";
import { useCommunityZone, zoneOptions } from "../lib/zones";
import { Panel } from "./Panel";
import { PresetBar } from "./PresetBar";
import { ActionResult, AskNotice, Callout, Divider, GoTo, ObserveBanner, SettingCard, Toggle, Explanation } from "./ui";
import MapVoteLibrary, { describeWhen, type MapSet, type VoteSchedule } from "./MapVoteLibrary";
// One Pool shape, owned by the editor that renders it — a second copy here drifted the moment
// per-bucket modes were added and this one silently lacked them.
import type { GridMap } from "./MapGrid";
import type { Pool } from "./MapSetEditor";
import { PlaceholderHint } from "./Placeholders";

/** One line of the setup: which library set, on which library schedule (null = all the time). */
interface Link { mapSet: string; schedule: string | null }
type Layout = "none" | "map_list" | "vote_counts";
type StartupState = "remember" | "paused" | "active";
interface Reminder { minutesAfterMatchStart: number; message: string; layout?: Layout }
interface PollOptionLive { id: string; name: string; votes: number }
interface VoteState {
  paused: boolean; pauseReason: string | null; overrideMapId: string | null;
  skipNext: boolean; reroll: boolean; startNow: boolean; resyncNow: boolean;
  sendMessageLayout: string | null; savedOptions: { id: string; name: string }[];
  liveAppliedMapId: string | null; reopenAt: string | null;
  activePoll: { options: PollOptionLive[]; profile: string | null; openedAt: string | null; totalVotes: number; talliedAt: string | null } | null;
}
interface HistoryRow {
  id: string; decidedAt: string; profile: string | null;
  options: PollOptionLive[]; winnerId: string | null; winnerName: string | null;
  totalVotes: number; outcome: "vote" | "override" | "skipped" | "no_votes" | "restarted" | "held" | "error"; applied: boolean;
}

/** Plain-words explanation of each recorded outcome — no codes for staff to decode. */
const OUTCOME_LABEL: Record<HistoryRow["outcome"], string> = {
  vote: "players decided",
  override: "staff forced the map",
  skipped: "staff skipped the vote",
  no_votes: "nobody voted — default pick",
  restarted: "staff started a new vote",
  held: "staff changed the map by hand — result not applied",
  error: "something went wrong",
};
interface Delivery {
  enabled: boolean; surface: string; channelId: string | null; pollHours: number; registeredOnlyIngame: boolean; registeredOnlyDiscord: boolean; reminders: Reminder[];
  liveApply: boolean; postMatchApplyDelaySeconds: number; pollResetDelaySeconds: number; tidyChannel: boolean; pauseBelowPlayers: number;
  startupState: StartupState;
}
interface ConfigResp extends Delivery {
  timezone: string; profileLinks: Link[];
  /** Which set the schedule picks right now — resolved by the API, never re-derived here. */
  activeProfile: string | null;
  state: VoteState; defaultPool?: Pool; sets?: MapSet[]; schedules?: VoteSchedule[];
}
interface Preview {
  options: { id: string; name: string }[]; profile?: string | null;
  /** The set's always-offered maps that made the sample, and the ones that did not (with why). */
  alwaysOffered?: string[];
  alwaysSkipped?: { id: string; why: "in-play" | "not-on-server" | "no-room" }[];
}
/** Why an always-offered map sat out a ballot, in the words the preview shows. */
const ALWAYS_SKIP: Record<string, string> = {
  "in-play": "it is the map being played",
  "not-on-server": "this server does not have it",
  "no-room": "the poll has no room for it",
};

export default function MapVote({ canManage, catalogue }: { canManage: boolean; catalogue: GridMap[] }) {
  const { serverId, server } = useServers();
  const { go } = useAppNav();
  const toast = useToast();
  const [tz, setTz] = useState("UTC");
  const [delivery, setDelivery] = useState<Delivery>({
    enabled: false, surface: "native", channelId: null, pollHours: 24, registeredOnlyIngame: false, registeredOnlyDiscord: false, reminders: [],
    liveApply: true, postMatchApplyDelaySeconds: 300, pollResetDelaySeconds: 180, tidyChannel: true, pauseBelowPlayers: 0,
    startupState: "remember",
  });
  /** What this server stores: the ordered pairings. This is what Save writes. */
  const [links, setLinks] = useState<Link[]>([]);
  const [sets, setSets] = useState<MapSet[]>([]);
  const [schedules, setSchedules] = useState<VoteSchedule[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // The engine's own defaults, sent by the API. A set stores only its overrides, so the editor
  // needs these to show what a field will actually DO when the set leaves it unset — otherwise
  // "no game mode picked" appears where the engine would in fact use Offensive.
  const [defaultPool, setDefaultPool] = useState<Pool>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewOf, setPreviewOf] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  // Bumped when a load lands, so the coverage map refetches exactly when the saved config could
  // have changed — not on every keystroke into an unsaved pairing.
  const [savedGen, setSavedGen] = useState(0);

  // Which load is allowed to paint. Switching server while the previous config is still in flight
  // used to let the OLD server's settings land in this editor under the NEW server's name — and
  // the next Save would then write those settings to the server you had switched to.
  const gen = useRef(0);
  const load = useCallback(() => {
    if (!serverId) return;
    const mine = ++gen.current;
    setErr(""); setDirty(false);
    api<ConfigResp>(`/servers/${serverId}/mapvote/config`)
      .then((r) => {
        if (mine !== gen.current) return;
        setTz(r.timezone);
        setDelivery({
          enabled: r.enabled, surface: r.surface, channelId: r.channelId, pollHours: r.pollHours, registeredOnlyIngame: r.registeredOnlyIngame === true, registeredOnlyDiscord: r.registeredOnlyDiscord === true, reminders: r.reminders ?? [],
          liveApply: r.liveApply ?? true, postMatchApplyDelaySeconds: r.postMatchApplyDelaySeconds ?? 300,
          pollResetDelaySeconds: r.pollResetDelaySeconds ?? 180, tidyChannel: r.tidyChannel !== false, pauseBelowPlayers: r.pauseBelowPlayers ?? 0,
          startupState: r.startupState ?? "remember",
        });
        setLinks(r.profileLinks ?? []);
        setSets(r.sets ?? []); setSchedules(r.schedules ?? []);
        setActive(r.activeProfile); setDefaultPool(r.defaultPool ?? {});
        setSavedGen((n) => n + 1);
      })
      .catch((e) => { if (mine === gen.current) setErr(e.message); });
    // Just enough history for the "last vote was…" line; the full record has its own page.
    api<{ history: HistoryRow[] }>(`/servers/${serverId}/mapvote/history?limit=5`)
      .then((r) => { if (mine === gen.current) setHistory(r.history ?? []); })
      .catch(() => { /* history is additive — never block the editor on it */ });
  }, [serverId]);
  useEffect(() => { load(); }, [load]);

  // No polling here any more. A settings form has nothing that changes on its own, and re-fetching
  // every 15s would blow away half-typed edits. The Vote tab polls, because that is where the
  // numbers actually move.

  const mutate = (fn: (l: Link[]) => Link[]) => { setLinks((prev) => fn(prev)); setDirty(true); };
  const setLink = (i: number, patch: Partial<Link>) => mutate((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setDeliv = (patch: Partial<Delivery>) => { setDelivery((d) => ({ ...d, ...patch })); setDirty(true); };
  const move = (i: number, d: number) => mutate((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });

  async function save() {
    setBusy(true); setErr("");
    try {
      await api(`/servers/${serverId}/mapvote/config`, { method: "PUT", body: { ...delivery, timezone: tz, profiles: links } });
      toast.success("Map vote settings saved");
      load();
    } catch (e) { setErr((e as Error).message); toast.error((e as Error).message); } finally { setBusy(false); }
  }
  /** Build a sample from a line's SET. Reads the library copy, not the resolved profile, so it
   *  still works for a line you have just added and not yet saved. */
  async function runPreview(i: number) {
    const pool = sets.find((s) => s.name.toLowerCase() === (links[i]?.mapSet ?? "").toLowerCase())?.pool ?? {};
    setPreviewBusy(true); setPreviewOf(i); setErr("");
    try { setPreview(await api<Preview>(`/servers/${serverId}/maps/poll/preview`, { method: "POST", body: { config: pool } })); }
    catch (e) { setErr((e as Error).message); } finally { setPreviewBusy(false); }
  }

  const nameOf = useMemo(() => new Map(catalogue.map((m) => [m.id, m.prettyName])), [catalogue]);
  const specOf = useMemo(() => new Map(schedules.map((s) => [s.name.toLowerCase(), s.spec])), [schedules]);

  // Read once per mount: it's a display preference, and Settings is another page away.
  const showLocal = useMemo(() => readUserPrefs().localTimes, []);
  const communityTz = useCommunityZone();

  if (!serverId) return null;

  return (
    <Panel
      id="mapvote-setup"
      caps="open"
      title="Vote setup"
      subtitle={delivery.enabled ? "on" : "off"}
      actions={<>
        {dirty && <button className="ghost" onClick={load}>Discard</button>}
        <button className="primary" onClick={save} disabled={!dirty || busy || !canManage}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      <p className="muted mt-0">Which maps players can vote on, where the poll is posted, and the timing behind it.</p>
      {canManage && <AskNotice capability="mapvote.config" serverId={serverId} />}
      <ActionResult error={err} />

      <PresetBar feature="mapvote" featureLabel="Map vote" serverId={serverId} canManage={canManage} dirty={dirty} onApplied={load} />

      <SettingCard
        title="Run a vote at the end of every match"
        description="With this off nothing is posted and no map is changed, but everything below is still saved."
      >
        <Toggle checked={delivery.enabled} onChange={(v) => setDeliv({ enabled: v })} disabled={!canManage}
          label={delivery.enabled ? "On" : "Off"} />
      </SettingCard>
      <Explanation>
        To pause or restart the vote without turning it off — or to force a map, or push the standings
        to players in game — use <GoTo view="maps" tab="vote">Vote</GoTo>.
      </Explanation>
      <ObserveBanner server={server}>Vote settings are still saved — they just aren&apos;t applied to the game until then.</ObserveBanner>

      <Divider label="Where players vote" />
      <div className="grid">
        <label>Voting surface
          <select value={delivery.surface} onChange={(e) => setDeliv({ surface: e.target.value })} disabled={!canManage}>
            <option value="native">Discord poll</option>
            <option value="ingame">In game — type a number in chat</option>
            <option value="both">Both — Discord poll + in-game chat, combined</option>
          </select>
          <span className="hint">
            In-game voting needs no Discord: the options are announced in game with a number each,
            and players vote by typing that number in team or unit chat (&ldquo;!vm 4&rdquo; and
            &ldquo;!votemap 4&rdquo; count too) — which is how console players who never open Discord
            get a say. Reminders below carry the numbered list too.
            {delivery.surface === "both" && (
              <> With BOTH, the two ballots are combined for the final score; the Discord poll card
              only shows its own half, so the full combined result is posted to the channel when the
              vote closes.</>
            )}
          </span>
        </label>
        <div>
          <span className="field-label">Duplicate protection</span>
          {/* One switch per RUNNING surface. A gate whose surface is switched off does nothing, and
              a switch that does nothing is worse than no switch — staff turn it on and believe the
              vote is protected. The saved value is left alone, so a surface put back finds its
              setting where it was. */}
          {delivery.surface !== "native" && (
            <Toggle checked={delivery.registeredOnlyIngame} disabled={!canManage}
              onChange={(v) => setDeliv({ registeredOnlyIngame: v })}
              label="In-game votes: only registered players count" />
          )}
          {delivery.surface !== "ingame" && (
            <Toggle checked={delivery.registeredOnlyDiscord} disabled={!canManage}
              onChange={(v) => setDeliv({ registeredOnlyDiscord: v })}
              label="Discord votes: only registered accounts count" />
          )}
          <Explanation>
            Registered = a Discord account linked to a game account (the VIP panel&apos;s registration).
            Registered voters are always counted once, wherever they vote — their in-game ballot
            carries their Discord identity, and the Discord ballot wins a conflict. These switches
            decide what happens to votes that CANNOT be tied to a registered person: with the
            in-game switch on, chat votes from unlinked players don&apos;t count; with the Discord
            switch on, unregistered clicks are discounted when the vote closes (the poll card still
            shows them — the posted result is the counted tally). The usual posture is in-game ON,
            Discord OFF: anyone may click the poll, but a vote from inside the match must come from
            a registered player.
          </Explanation>
        </div>
        {delivery.surface !== "ingame" && (
          <label>Discord channel ID
            <input value={delivery.channelId ?? ""} onChange={(e) => setDeliv({ channelId: e.target.value || null })} disabled={!canManage} placeholder="e.g. 123456789012345678" inputMode="numeric" />
            <span className="hint">In Discord: right-click the channel → Copy Channel ID. (Needs Developer Mode on, under Settings → Advanced.)</span>
          </label>
        )}
        {delivery.surface !== "ingame" && (
          <label>Discord poll card lifetime (hours)
            <input type="number" min={1} max={768} value={delivery.pollHours} onChange={(e) => setDeliv({ pollHours: Number(e.target.value) })} disabled={!canManage} />
            <span className="hint">A safety net only — the vote closes the card itself when the match ends. Keep it longer than any match
              could run (24h is safe): a card that times out first reads &ldquo;Poll closed&rdquo; in Discord while the vote is still going.</span>
          </label>
        )}
      </div>

      <Divider label="What players can vote on" />
      <Explanation>
        Each line pairs a <strong>map set</strong> (which maps can appear) with a <strong>schedule</strong>
        (when that set is used). Both come from the shared library, so a set you build here is available on
        every server. The first line whose schedule matches wins, so put the most specific at the top and
        leave one with no schedule at the bottom to catch the rest.
      </Explanation>

      {links.length === 0 && (
        <Callout variant="info">
          Nothing is paired up yet, so the vote has nothing to offer. Add a line below and pick a set —
          the library already has a few to start from, and you can edit or delete any of them.
        </Callout>
      )}

      {links.map((link, i) => {
        const spec = link.schedule ? specOf.get(link.schedule.toLowerCase()) : undefined;
        const isActive = active != null && active.toLowerCase() === link.mapSet.toLowerCase();
        return (
          <div className="setting-card" key={i}>
            <div className="control-row">
              <label style={{ margin: 0, flex: "1 1 180px" }}>Map set
                <select value={link.mapSet} disabled={!canManage} onChange={(e) => { setLink(i, { mapSet: e.target.value }); setPreview(null); }}>
                  {/* A set deleted out from under this line would otherwise vanish from the dropdown
                      and silently re-point the line at whatever sorts first. */}
                  {!sets.some((s) => s.name.toLowerCase() === link.mapSet.toLowerCase()) && (
                    <option value={link.mapSet}>{link.mapSet} (missing)</option>
                  )}
                  {sets.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </label>
              <label style={{ margin: 0, flex: "1 1 180px" }}>When
                <select value={link.schedule ?? ""} disabled={!canManage} onChange={(e) => setLink(i, { schedule: e.target.value || null })}>
                  <option value="">All the time</option>
                  {link.schedule && !schedules.some((s) => s.name.toLowerCase() === link.schedule!.toLowerCase()) && (
                    <option value={link.schedule}>{link.schedule} (missing)</option>
                  )}
                  {schedules.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </label>
              {canManage && (
                <div className="actions" style={{ marginTop: 0, gap: 4 }}>
                  <button className="ghost mini" onClick={() => move(i, -1)} disabled={i === 0} title="Higher priority">↑</button>
                  <button className="ghost mini" onClick={() => move(i, 1)} disabled={i === links.length - 1} title="Lower priority">↓</button>
                  <button className="ghost mini" onClick={() => { mutate((l) => l.filter((_, j) => j !== i)); setPreview(null); }} title="Remove this line">✕</button>
                </div>
              )}
            </div>
            <p className="hint mt-0">
              {describeWhen(spec)}{isActive ? " This is the set in use right now." : ""}
            </p>
            <div className="actions">
              <button className="ghost mini" onClick={() => runPreview(i)} disabled={previewBusy}>
                {previewBusy && previewOf === i ? "Building…" : "Show me a sample vote"}
              </button>
            </div>
            {preview && previewOf === i && (
              <>
                {preview.options.length === 0
                  ? <Callout variant="warn">That produced <strong>no options</strong> — the exclusions probably rule out everything. Remove some exclusions, or lower &ldquo;don&apos;t re-offer the last N&rdquo;.</Callout>
                  : <ol className="hint" style={{ margin: "8px 0 0 18px" }}>{preview.options.map((o) => (
                      <li key={o.id}>
                        {nameOf.get(o.id) ?? o.name ?? o.id}
                        {preview.alwaysOffered?.includes(o.id) && <span className="muted"> · always offered</span>}
                      </li>
                    ))}</ol>}
                {(preview.alwaysSkipped ?? []).map((skip) => (
                  <p key={skip.id} className="hint" style={{ margin: "4px 0 0" }}>
                    Always offer: <strong>{nameOf.get(skip.id) ?? skip.id}</strong> sat this one out — {ALWAYS_SKIP[skip.why] ?? skip.why}.
                  </p>
                ))}
              </>
            )}
          </div>
        );
      })}

      {canManage && sets.length > 0 && (
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="ghost" onClick={() => mutate((l) => [...l, { mapSet: sets[0]!.name, schedule: null }])}>Add a map set to this server</button>
        </div>
      )}

      <div className="grid" style={{ marginTop: 12 }}>
        <label>Times are in
          <select value={tz || communityTz || "UTC"} onChange={(e) => { setTz(e.target.value); setDirty(true); }} disabled={!canManage}>
            {zoneOptions(communityTz).map((z) => <option key={z} value={z}>{z}{z === communityTz ? " (community)" : ""}</option>)}
          </select>
          <span className="hint">This server&apos;s zone — a shared schedule reads its window in whichever server is using it. Defaults to the community time zone.</span></label>
      </div>

      <MapVoteLibrary
        sets={sets} schedules={schedules} catalogue={catalogue} defaultPool={defaultPool}
        game={server?.game ?? ""}
        timezone={tz} showLocal={showLocal} canManage={canManage} onChanged={load}
      />

      <CoverageMap
        endpoint={links.length > 0 ? `/servers/${serverId}/mapvote/coverage` : null}
        noun="map set" fallbackName="defaults"
        gapAdvice={<>The vote falls back to the engine&apos;s built-in defaults there (3 day + 1 night + 3 wildcard from the whole
        catalogue). Widen a set&apos;s times or player range, or add a set with no conditions at the bottom to catch the rest.</>}
        dirty={dirty} reloadKey={savedGen} showLocal={showLocal}
      />

      <Divider label="Timing" />
      <p className="hint mt-0">Sensible defaults are already set — you only need these to change the timing.</p>
        <Toggle checked={delivery.liveApply} onChange={(v) => setDeliv({ liveApply: v })} disabled={!canManage}
          label={delivery.liveApply
            ? "Keep the next map set to whichever map is winning, as votes come in"
            : "Only decide the next map once the match ends"} />
        <Explanation>
          {delivery.liveApply
            ? "Recommended. The map in the lead is queued straight away and re-queued whenever the lead changes, so even a match that ends early or crashes still goes to the map players picked. Until anyone votes, a map from the ballot is queued instead, so the map just played can't come round again."
            : "The next map is only set at the moment the match ends. If the match ends unexpectedly, the rotation carries on as normal instead."}
        </Explanation>

        <div className="row" style={{ gap: 6, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: "0.85rem", margin: 0 }}>
            After a match ends, wait
            <input type="number" min={0} max={3600} value={delivery.pollResetDelaySeconds} disabled={!canManage} style={{ width: 74, margin: "0 6px" }}
              onChange={(e) => setDeliv({ pollResetDelaySeconds: Number(e.target.value) })} />
            seconds before posting the next vote.
          </label>
        </div>
        <p className="hint" style={{ marginTop: 2 }}>Gives players time to load into the new match before they&apos;re asked to vote again. 180 seconds is a good default.</p>

        {delivery.surface !== "ingame" && (
          <>
            <div style={{ marginTop: 10 }}>
              <Toggle checked={delivery.tidyChannel} disabled={!canManage}
                onChange={(v) => setDeliv({ tidyChannel: v })}
                label="Clear the channel when a new vote starts" />
            </div>
            <Explanation>
              Leaves one live ballot and nothing else: the spent polls go, and so do Discord&apos;s own
              &quot;poll has closed&quot; lines, which otherwise pile up after every round. Messages posted by
              people are never touched, and every tally — including who voted for what — is kept under
              History either way.
            </Explanation>
          </>
        )}

        {delivery.liveApply && (
          <>
            <div className="row" style={{ gap: 6, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              <label style={{ fontSize: "0.85rem", margin: 0 }}>
                And leave the next map alone for
                <input type="number" min={0} max={3600} value={delivery.postMatchApplyDelaySeconds} disabled={!canManage} style={{ width: 74, margin: "0 6px" }}
                  onChange={(e) => setDeliv({ postMatchApplyDelaySeconds: Number(e.target.value) })} />
                seconds after a match ends.
              </label>
            </div>
            <p className="hint" style={{ marginTop: 2 }}>The first couple of votes on a fresh poll aren&apos;t worth acting on. 300 seconds is a good default.</p>
          </>
        )}

        <div className="row" style={{ gap: 6, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: "0.85rem", margin: 0 }}>
            Pause voting while fewer than
            <input type="number" min={0} max={100} value={delivery.pauseBelowPlayers} disabled={!canManage} style={{ width: 66, margin: "0 6px" }}
              onChange={(e) => setDeliv({ pauseBelowPlayers: Number(e.target.value) })} />
            players are on the server.
          </label>
        </div>
        <div className="grid" style={{ marginTop: 12 }}>
          <label>If the bot restarts
            <select value={delivery.startupState} disabled={!canManage}
              onChange={(e) => setDeliv({ startupState: e.target.value as StartupState })}>
              <option value="remember">Carry on as it was</option>
              <option value="paused">Always come back paused</option>
              <option value="active">Always come back voting</option>
            </select>
            <span className="hint">
              {delivery.startupState === "remember"
                ? "Whether the vote was running or paused survives a restart, because that is stored. This is the right choice for a normal server."
                : delivery.startupState === "paused"
                  ? "This server starts paused every time the bot comes back, so resuming it is understood to last until the next restart. Use it for an events or CvC server that is usually quiet."
                  : "A restart always resumes voting, so a pause can never outlive the crash that caused it. Any poll left open by the old process is discarded and a fresh one is drawn."}
            </span>
          </label>
        </div>

        <Explanation>
          {delivery.pauseBelowPlayers > 0
            ? `A notice goes up in the vote channel instead, and voting starts itself again — with the same maps — once ${delivery.pauseBelowPlayers} or more players are on. Set it to 0 to always vote.`
            : "Set to 0: voting runs even on an empty server. Try 1 if you don't want polls posted overnight."}
        </Explanation>

      <Divider label="Tell players in game" />
      <p className="hint mt-0">Most players aren&apos;t in Discord. These are broadcast in game after a match starts, to point them at the vote.</p>
        {delivery.reminders.length === 0 && <p className="hint mt-0">No reminders — players only find the vote if they're in Discord.</p>}
        {delivery.reminders.length > 0 && <PlaceholderHint>— filled for each player the reminder reaches.</PlaceholderHint>}
        {delivery.reminders.map((rm, i) => (
          <div key={i} className="row" style={{ gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
            <label style={{ fontSize: "0.8rem", margin: 0 }}>
              <input type="number" min={0} value={rm.minutesAfterMatchStart} disabled={!canManage} style={{ width: 64, margin: "0 4px" }}
                onChange={(e) => setDeliv({ reminders: delivery.reminders.map((x, j) => (j === i ? { ...x, minutesAfterMatchStart: Number(e.target.value) } : x)) })} />
              min into the match, say:
            </label>
            <input aria-label="Reminder" value={rm.message} disabled={!canManage} placeholder="Vote for the next map on Discord!" style={{ flex: 1, minWidth: 200 }}
              onChange={(e) => setDeliv({ reminders: delivery.reminders.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)) })} />
            <select aria-label="Then" value={rm.layout ?? "none"} disabled={!canManage} style={{ minWidth: 168 }}
              onChange={(e) => setDeliv({ reminders: delivery.reminders.map((x, j) => (j === i ? { ...x, layout: e.target.value as Layout } : x)) })}>
              <option value="none">…and nothing else</option>
              <option value="map_list">…then list the maps</option>
              <option value="vote_counts">…then list the maps with votes</option>
            </select>
            {canManage && <button className="danger" onClick={() => setDeliv({ reminders: delivery.reminders.filter((_, j) => j !== i) })}>Remove</button>}
          </div>
        ))}
        <Explanation>
          Listing the maps with votes lets players see how the vote is going without leaving the game — it&apos;s the one that gets people to vote.
          You can also write <code>{"{options}"}</code> inside the message to put the map names on the same line instead.
        </Explanation>
        {canManage && <button className="ghost" onClick={() => setDeliv({ reminders: [...delivery.reminders, { minutesAfterMatchStart: 10, message: "Vote for the next map on Discord!", layout: "vote_counts" }] })}>Add a reminder</button>}

      {/* Forcing a map used to be a step of this form, which was wrong twice over: it is a one-off
          action rather than a setting, and it only makes sense while a vote is actually running. It
          lives on the control surface now, beside the poll it overrules. */}
      <p className="muted fs-xs notice" style={{ marginTop: 16 }}>
        {history.length > 0
          ? <>Last vote: <strong>{history[0]!.winnerName ?? history[0]!.winnerId ?? "—"}</strong> on {fmtExact(history[0]!.decidedAt)} · {OUTCOME_LABEL[history[0]!.outcome]}. </>
          : <>No votes recorded yet — the first appears once a match ends with the vote on. </>}
        Every finished vote and who turned up is under <button className="linklike" data-goto="history.mapvotes" onClick={() => go("mapvotes")}>Map vote history</button>.
      </p>
    </Panel>
  );
}
