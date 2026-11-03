"use client";
/**
 * The unread-notice nudge: the Discord side of the staff noticeboard.
 *
 * It sits beside the relay and the alert pings rather than on a tab of its own, because it is the
 * same kind of thing they are — pick a channel, decide what makes the bot post in it. A whole tab
 * for one toggle and a channel id was a page you had to know existed.
 *
 * It is built to the same schema as the relay panel directly above it, deliberately: Save lives in
 * the panel header and lights up only once something changed, the switch is a Toggle inside a
 * SettingCard, text fields are a `.grid` of labelled inputs, and the result of a save is reported
 * by ActionResult rather than a toast. Two panels on one tab making the same kind of decision
 * should not ask for it in two different visual languages.
 *
 * It IS a separate panel, not another card inside the relay's, for a reason the UI has to be honest
 * about: the relay is configured per server and this is one setting for the whole instance. That
 * lives in the subtitle, which on both panels answers the same question — what does this apply to.
 *
 * The capability is deliberately `community.edit`, not `discord.config`: this is the announcements
 * feature choosing how it reaches people, and whoever runs the noticeboard is who should decide
 * whether it nags.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { ActionResult, AskNotice, GoTo, SettingCard, SkeletonLines, Toggle, Explanation } from "./ui";
import { Panel } from "./Panel";

interface NudgeConfig { enabled: boolean; channelId: string; afterHours: number; excusedUserIds?: string[] }
interface StaffOption { id: string; name: string }

export function AnnouncementNudgePanel({ canManage }: { canManage: boolean }) {
  const [nudge, setNudge] = useState<NudgeConfig | null>(null);
  // Everyone the nudge could name — the options for who it should not. Ships with the config GET,
  // so noticeboard editors need no extra permission to see their own team's names.
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");
  // The last server-confirmed config, so Discard can put the form back without a round trip. The
  // longer panels on this tab reload to discard; this one is small enough to just remember.
  const saved = useRef<NudgeConfig | null>(null);

  useEffect(() => {
    if (!canManage) return;
    api<{ config?: NudgeConfig; staff?: StaffOption[] }>("/community/announcements/nudge-config")
      // Defaults rather than a null: a response without a stored config is "not set up yet", which
      // is an empty form, not a permanent skeleton.
      .then((r) => {
        const cfg = { excusedUserIds: [], ...(r.config ?? { enabled: false, channelId: "", afterHours: 48 }) };
        saved.current = cfg;
        setNudge(cfg);
        setStaff(r.staff ?? []);
      })
      .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [canManage]);

  const discard = () => { setNudge(saved.current); setDirty(false); setErr(""); setOk(""); };

  const set = <K extends keyof NudgeConfig>(k: K, v: NudgeConfig[K]) => {
    setNudge((c) => (c ? { ...c, [k]: v } : c));
    setDirty(true);
    setOk("");
  };

  async function save() {
    if (!nudge) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await api<{ config: NudgeConfig }>("/community/announcements/nudge-config", { method: "PUT", body: nudge });
      saved.current = r.config;
      setNudge(r.config);
      setDirty(false);
      setOk(r.config.enabled ? `Saved — reminders go out after ${r.config.afterHours}h.` : "Saved — nudge is off.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // Turning it on with no channel saves a setting that silently cannot fire, so Save stays out of
  // reach until the channel is there — the same reason the relay won't post a category without one.
  const incomplete = Boolean(nudge?.enabled && !nudge.channelId.trim());

  return (
    <Panel
      id="nudge"
      caps="community.edit"
      title="Unread-notice nudge"
      subtitle="Every server"
      actions={<>
        {dirty && <button className="ghost" onClick={discard}>Discard</button>}
        <button className="primary" onClick={save} disabled={!dirty || busy || incomplete || !canManage}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      <p className="muted mt-0">Remind staff who still haven&apos;t opened the noticeboard.</p>
      <AskNotice capability="community.edit" />

      <ActionResult ok={ok} error={err || loadErr} />
      {canManage && !nudge && !loadErr && <SkeletonLines lines={3} />}

      {nudge && (
        <>
          <Explanation>
            Staff with linked Discord accounts get a real @mention. Unlike the relay above this is
            one setting for the whole panel rather than per server — there is only one noticeboard.
            It needs the bot token, under <GoTo view="discord" tab="setup">Setup &amp; status</GoTo>.
          </Explanation>

          {/* Toggle and fields in one card, the way each alert rule above states its own switch and
              the channel it posts to. Splitting them made the channel look like a panel-level
              setting rather than part of this one. */}
          <SettingCard
            title="Enable nudge"
            description="Once a notice has been posted for the set hours, the bot posts one reminder naming everyone who still hasn't opened the board. Re-posting a notice starts a fresh cycle."
            helper={incomplete ? "Paste the staff channel's id before turning this on (right-click the channel in Discord → Copy Channel ID)." : undefined}
          >
            <Toggle checked={nudge.enabled} onChange={(v) => set("enabled", v)} label={nudge.enabled ? "On" : "Off"} disabled={!canManage} />
            <div className="grid" style={{ marginTop: 8 }}>
              <label>
                Channel id
                <input
                  value={nudge.channelId}
                  onChange={(e) => set("channelId", e.target.value)}
                  disabled={!canManage}
                  placeholder="Channel id"
                  inputMode="numeric"
                />
              </label>
              <label>
                Remind after (hours)
                <input
                  type="number"
                  min="1"
                  max="720"
                  value={nudge.afterHours}
                  onChange={(e) => set("afterHours", Number(e.target.value))}
                  disabled={!canManage}
                />
              </label>
            </div>
          </SettingCard>

          <SettingCard
            title="Excused staff"
            description="Away or on leave? Excuse them and no reminder names them — on any notice — until they're removed here. Their read receipts still record, and each reminder's audit entry lists who it left out."
          >
            <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {(nudge.excusedUserIds ?? []).map((id) => (
                <span key={id} className="badge observe">
                  {staff.find((s) => s.id === id)?.name ?? "(removed account)"}
                  {canManage && (
                    <button className="linklike" style={{ marginLeft: 6 }} aria-label="Stop excusing"
                      onClick={() => set("excusedUserIds", (nudge.excusedUserIds ?? []).filter((x) => x !== id))}>✕</button>
                  )}
                </span>
              ))}
              {!(nudge.excusedUserIds ?? []).length && <span className="muted fs-sm">Nobody is excused — every unread name is pinged.</span>}
            </div>
            {/* value stays "" so the select is a pure "add" control — the chips above are the state. */}
            <select value="" disabled={!canManage}
              onChange={(e) => { const v = e.target.value; if (v) set("excusedUserIds", [...(nudge.excusedUserIds ?? []), v]); }}>
              <option value="">Excuse a staff member…</option>
              {staff.filter((s) => !(nudge.excusedUserIds ?? []).includes(s.id)).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </SettingCard>

          <p className="muted fs-xs" style={{ marginTop: 10 }}>
            The board itself — posting notices and reading them — is under{" "}
            <GoTo view="community">Announcements</GoTo>
          </p>
        </>
      )}
    </Panel>
  );
}
