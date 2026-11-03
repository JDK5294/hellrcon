"use client";
/**
 * Signatures — the two optional lines appended to whatever a player is shown.
 *
 * A template is WHAT you say. A signature is who said it and where to go next, which is why the
 * two live on the same page: they are the same job, split by how often they change. A reason gets
 * retyped every time; a signature is set once and then quietly rides along.
 *
 * Two lines, switched on independently per action, because they answer different questions and a
 * community may want either, both or neither on any given action. A permanent ban is worth signing
 * and pointing at an appeal; a routine "move up to the objective" nudge is neither.
 *
 * The staff line carries the acting staff member's PANEL name — their Discord nick, normally —
 * never their in-game alias. Half the staff play under something nobody recognises, and being
 * recognised is the entire point of signing.
 *
 * The live preview is not decoration. Two configurable lines glued onto a reason is exactly the
 * kind of thing that reads fine in the editor and arrives mangled in game, and staff should not
 * have to kick somebody to find out.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../lib/feedback";
import { Panel } from "./Panel";
import { ActionResult, AskNotice, SkeletonLines, Toggle, Explanation } from "./ui";

interface Use { staff: boolean; custom: boolean }
interface Config {
  staffLine: string;
  customLine: string;
  actions: Record<string, Use>;
  signable?: { id: string; label: string }[];
}

/** The example body the preview is built from — a reason of the shape staff actually type. */
const SAMPLE = "Team killing after a warning";

export default function Signatures({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr("");
    // An answer missing its fields reads as lines left blank and nothing signed, not as a crash on
    // the first switch pressed.
    api<Partial<Config>>("/signatures").then((r) => {
      const cfg: Config = { staffLine: r.staffLine ?? "", customLine: r.customLine ?? "", actions: r.actions ?? {}, signable: r.signable ?? [] };
      setData(cfg); setDraft(cfg);
    }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = Boolean(draft && data && JSON.stringify(draft) !== JSON.stringify(data));
  const signable = draft?.signable ?? [];
  const wanted = (id: string): Use => draft?.actions?.[id] ?? { staff: false, custom: false };
  const setUse = (id: string, patch: Partial<Use>) => setDraft((d) => (d
    ? { ...d, actions: { ...d.actions, [id]: { ...wanted(id), ...patch } } }
    : d));

  async function save() {
    if (!draft) return;
    setBusy(true); setErr("");
    try {
      await api("/signatures", { method: "PUT", body: { staffLine: draft.staffLine, customLine: draft.customLine, actions: draft.actions } });
      toast.success("Signatures saved");
      load();
    } catch (e) { setErr((e as Error).message); toast.error((e as Error).message); } finally { setBusy(false); }
  }

  /** Exactly what the server will build, so the preview cannot drift from the real thing. */
  const preview = (u: Use): string => {
    const parts = [SAMPLE];
    if (u.staff && draft) { const l = draft.staffLine.replaceAll("{staff}", "Your name").trim(); if (l) parts.push(l); }
    if (u.custom && draft) { const l = draft.customLine.trim(); if (l) parts.push(l); }
    return parts.join("\n");
  };

  return (
    <Panel id="signatures" caps="open" title="Signatures" subtitle="what gets added to the end of what a player reads"
      actions={dirty ? <button className="primary" onClick={save} disabled={busy || !canManage}>{busy ? "Saving…" : "Save"}</button> : undefined}>
      <Explanation>
        A kick reason arrives with no author and nowhere to take it up. These two lines fix that,
        and they are separate switches because they answer separate questions — one says <strong>who
        acted</strong>, the other says <strong>where to go next</strong>.
      </Explanation>
      <ActionResult error={err} />
      {canManage ? <AskNotice capability="templates.manage" /> : <p className="hint">You need the Templates permission to edit signatures.</p>}
      {!draft && !err && <SkeletonLines lines={4} />}

      {draft && (
        <>
          <div className="grid">
            <label>Staff signature
              <input value={draft.staffLine} disabled={!canManage}
                onChange={(e) => setDraft({ ...draft, staffLine: e.target.value })} placeholder="- {staff}" />
              <span className="hint">
                <code>{"{staff}"}</code> becomes the name on the acting staff member&rsquo;s account —
                their Discord nickname, <strong>not</strong> their in-game name. (The
                <code>{"{player}"}</code> token on the admin-camera message is the opposite: that one
                comes off the game log and is the in-game name.)
              </span>
            </label>
            <label>Second signature
              <input value={draft.customLine} disabled={!canManage}
                onChange={(e) => setDraft({ ...draft, customLine: e.target.value })} placeholder="Appeal at discord.gg/your-invite" />
              <span className="hint">
                Free text, appended as-is. Usually a Discord invite, but a rules link or an appeals
                note works the same way.
              </span>
            </label>
          </div>

          <div className="scroll-x">
            <table className="table">
              <thead><tr>
                <th>Action</th>
                <th>Sign with staff name</th>
                <th>Add the second line</th>
                <th>What the player reads</th>
              </tr></thead>
              <tbody>
                {signable.map((a) => {
                  const u = wanted(a.id);
                  return (
                    <tr key={a.id}>
                      <td>{a.label}</td>
                      <td>
                        <Toggle checked={u.staff} disabled={!canManage}
                          onChange={(v) => setUse(a.id, { staff: v })} />
                      </td>
                      <td>
                        <Toggle checked={u.custom} disabled={!canManage}
                          onChange={(v) => setUse(a.id, { custom: v })} />
                      </td>
                      <td className="wrap"><pre className="hint" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{preview(u)}</pre></td>
                    </tr>
                  );
                })}
                {/* The one signable thing that is not an action: the standing join-screen text.
                    Nobody SENDS it, so there is no staff toggle — a name there would credit
                    whoever last saved a config field. Second line only, appended whichever door
                    sets the message (Live settings, or an Auto settings profile). */}
                <tr>
                  <td>
                    Welcome / notice message
                    <br /><span className="hint">&ldquo;Welcome message&rdquo; on WW2 · &ldquo;Notice message&rdquo; on Vietnam</span>
                  </td>
                  <td><span className="muted" title="Nobody sends the join screen — a staff name here would credit whoever last saved a setting.">—</span></td>
                  <td>
                    <Toggle checked={wanted("welcome").custom} disabled={!canManage}
                      onChange={(v) => setUse("welcome", { staff: false, custom: v })} />
                  </td>
                  <td className="wrap"><pre className="hint" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{
                    ["Welcome to the server!", ...(wanted("welcome").custom && draft.customLine.trim() ? [draft.customLine.trim()] : [])].join("\n")
                  }</pre></td>
                </tr>
              </tbody>
            </table>
          </div>
          <Explanation>
            Only actions a player actually reads are listed — a team switch and an unban show them
            nothing, so a signature on those would be a switch that does nothing. Automated actions
            never carry the staff line (the app has no name), but they do carry the second one.
            The welcome/notice message is a standing setting rather than something a staff member
            sends, so it takes only the second line — added whenever the message is set, from Live
            settings or an Auto settings profile alike.
          </Explanation>
        </>
      )}
    </Panel>
  );
}
