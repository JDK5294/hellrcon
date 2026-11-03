"use client";
/**
 * Users & roles — a real permission system:
 *  - CUSTOM ROLES: named, reusable permission bundles (grants + limits). Users can hold several;
 *    effective access is the union of their roles plus individual grants — and editing a role
 *    updates every member at once. Presets (Viewer → Owner) are starting templates for roles
 *    and for one-off individual setups.
 *  - The permission matrix groups capabilities by area, shows what each one does, and edits
 *    levels IN PLACE (None / Read / Write). Numeric action limits (e.g. max temp-ban hours)
 *    appear as sub-rows under their capability.
 *  - Scope tabs (users only): Global is the baseline; per-server tabs add extra access on one
 *    server. Roles are global by design.
 *  - Edits are local until "Save changes".
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { createUserWithAccess, type StartingAccess } from "../lib/createUser";
import { useToast, useConfirm, usePrompt } from "../lib/feedback";
import { ActionResult, AskNotice, Callout, EmptyState, SettingCard, SkeletonLines, Explanation } from "./ui";
import { applyDisplayZone, deviceZone, zoneOptions } from "../lib/zones";
import { PanelGroup, Panel } from "./Panel";
import { useRolePreview } from "../lib/rolePreview";
import { useRequestMode } from "../lib/requestMode";
import { ServerScopeChips } from "./ServerScopeChips";

interface Grant { id?: string; capability: string; scopeType: string; scopeId: string | null; level: string }
/** A role the user holds, and where. scopeId null = everywhere. */
interface RoleRef { id: string; name: string; scopeId?: string | null }
interface User { id: string; username: string; displayName?: string; email: string | null; createdAt: string; grants: Grant[]; limits?: Record<string, number>; roles?: RoleRef[]; discordId?: string | null; discordUsername?: string | null; discordNick?: string | null; discordManaged?: boolean; hasPassword?: boolean }
interface Capability { key: string; label: string; description: string; scoped: boolean; group: string; levels?: ("read" | "write")[] }
interface Preset { key: string; label: string; description: string; grants: { capability: string; level: "none" | "read" | "write" }[]; limits?: Record<string, number> }
interface LimitDef { key: string; label: string; description: string; capability: string; unit: string }
interface Server { id: string; name: string }
interface Role {
  id: string; name: string; description: string | null;
  grants: { capability: string; level: "none" | "read" | "write" }[];
  limits: Record<string, number>;
  members: number;
}

/** Editor states per capability: `inherit` = no grant of your own (roles/other scopes decide);
 *  `none` = an explicit BLOCK grant that vetoes the capability even if a role confers it;
 *  `read`/`write` = your own grant at that level. */
const LEVELS = ["inherit", "none", "read", "write"] as const;
type Level = (typeof LEVELS)[number];
const LEVEL_LABEL: Record<Level, string> = { inherit: "–", none: "Block", read: "Read", write: "Write" };
const LEVEL_TITLE: Record<Level, string> = {
  inherit: "No grant of your own — roles and other scopes decide",
  none: "Explicitly blocked — denies this even if a role grants it",
  read: "Read access",
  write: "Write access",
};

/**
 * The states this row may actually be set to.
 *
 * Inherit and Block are always there — "no grant of my own" and "explicitly denied" mean something
 * for anything grantable. Read and Write are offered only where the API has an answer to them, and
 * the catalogue says which (`levels`, checked against the route source by a test so it cannot
 * drift). There is no read form of "kick a player" and no write form of "view the ban list": a
 * button for either would turn the row green and grant nothing, which is a worse outcome than the
 * button not being there, because the admin walks away believing they did something.
 *
 * An older server that does not send `levels` gets all four, which is what the screen did before.
 */
function levelsFor(c: Capability): readonly Level[] {
  const allowed = c.levels ?? ["read", "write"];
  return LEVELS.filter((l) => l === "inherit" || l === "none" || allowed.includes(l));
}

/** Local editable copy of a grant set, keyed by capability|scope. */
type GrantMap = Map<string, { capability: string; scopeType: "global" | "server"; scopeId: string | null; level: "none" | "read" | "write" }>;
const keyOf = (capability: string, scopeId: string | null) => `${capability}|${scopeId ?? ""}`;

function toMap(grants: Grant[]): GrantMap {
  const m: GrantMap = new Map();
  for (const g of grants) {
    if (g.scopeType !== "global" && g.scopeType !== "server") continue;
    m.set(keyOf(g.capability, g.scopeId), {
      capability: g.capability, scopeType: g.scopeType, scopeId: g.scopeId ?? null,
      level: g.level === "write" ? "write" : g.level === "none" ? "none" : "read",
    });
  }
  return m;
}
const mapEq = (a: GrantMap, b: GrantMap) =>
  a.size === b.size && [...a].every(([k, v]) => { const o = b.get(k); return o && o.level === v.level; });
const limitsEq = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

export default function Users() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  // Until the roles are read, the list is not known to be empty: "No roles defined yet" over a
  // list on its way read as roles that were gone.
  const [rolesRead, setRolesRead] = useState(false);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [limitDefs, setLimitDefs] = useState<LimitDef[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState("");
  const [nu, setNu] = useState({ username: "", password: "", start: "" });
  const [createErr, setCreateErr] = useState("");
  const [me, setMe] = useState<string | null>(null);
  // Reads the editors lean on. They failed silently: an empty permission list drew an editor
  // with nothing in it, and without the server list a role could not be given servers.
  const [readErrs, setReadErrs] = useState<string[]>([]);
  const failed = (what: string) => (e: unknown) => setReadErrs((cur) => [...cur, `Couldn't read ${what}: ${(e as Error).message}`]);

  const load = () => Promise.all([
    api<{ users: User[] }>("/users").then((r) => setUsers(r.users)),
    api<{ roles: Role[] }>("/roles").then((r) => { setRoles(r.roles ?? []); setRolesRead(true); }),
  ]).catch((e) => setError((e as Error).message));

  useEffect(() => {
    void load();
    // Without the permission list there is nothing to edit, so it is the page's error.
    api<{ capabilities: Capability[]; presets: Preset[]; limits: LimitDef[] }>("/capabilities").then((r) => { setCaps(r.capabilities ?? []); setPresets(r.presets ?? []); setLimitDefs(r.limits ?? []); })
      .catch((e) => setError(`Couldn't read the permission list: ${(e as Error).message}`));
    api<{ servers: Server[] }>("/servers").then((r) => setServers(r.servers ?? [])).catch(failed("the server list"));
    api<{ user: { id: string } }>("/me").then((r) => setMe(r.user.id)).catch(failed("your own account"));
  }, []);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr("");
    try {
      const preset = nu.start.startsWith("preset:") ? presets.find((p) => p.key === nu.start.slice(7)) : undefined;
      const start: StartingAccess = nu.start.startsWith("role:") ? { roleId: nu.start.slice(5) }
        : preset ? { grants: preset.grants, limits: preset.limits ?? {} } : null;
      await createUserWithAccess(api, { username: nu.username, password: nu.password }, start);
      setNu({ username: "", password: "", start: "" });
      void load();
    } catch (err) {
      setCreateErr((err as Error).message);
      // A refused starting access may still have left the account behind (when undoing it failed too).
      void load();
    }
  }

  if (error) return <div className="card"><ActionResult error={error} /></div>;

  return (
    <>
    {readErrs.length > 0 && <div className="card">{readErrs.map((m) => <ActionResult key={m} error={m} />)}</div>}
    <PanelGroup viewId="users">
      <Panel id="create" caps="open" title="Add a user">
        <Explanation>
          <p>
            Define roles (reusable permission bundles — editing one updates every member), assign
            them to users, and fine-tune anything per user in the matrix. Each capability is
            – (inherit) / Block / Read / Write — Block is an explicit veto that denies the
            capability even when a role grants it. Limits like max temp-ban duration sit under
            their capability.
          </p>
          <p>
            Which admin is which? Accounts here are <strong>panel logins</strong> (who can use this
            panel). In-game admin powers — admin camera, console kicks — are the game server&apos;s own
            list, managed under <strong>Administration → Console admins</strong>.
          </p>
        </Explanation>
        <form onSubmit={createUser} className="row" style={{ alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 160px", margin: 0 }}>Username<input value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} required /></label>
          <label style={{ flex: "1 1 160px", margin: 0 }}>Password<input type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required /></label>
          <label style={{ flex: "1 1 180px", margin: 0 }}>Starting access
            <select value={nu.start} onChange={(e) => setNu({ ...nu, start: e.target.value })}>
              <option value="">None (set up below)</option>
              {roles.length > 0 && (
                <optgroup label="Assign role">
                  {roles.map((r) => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}
                </optgroup>
              )}
              <optgroup label="Copy preset (individual grants)">
                {presets.map((p) => <option key={p.key} value={`preset:${p.key}`}>{p.label}</option>)}
              </optgroup>
            </select>
          </label>
          <button type="submit">Create user</button>
        </form>
        <ActionResult error={createErr} />
      </Panel>

      <RolesManager roles={roles} read={rolesRead} caps={caps} presets={presets} limitDefs={limitDefs} onChange={load} />

      <RequestCeilingPanel roles={roles} />

      <Panel id="clock" caps="open" title="Community time zone"><CommunityClock /></Panel>

      <Panel id="accounts" caps="open" title="Accounts" subtitle={users ? String(users.length) : undefined}>
        {!users && <SkeletonLines lines={3} />}
        <div className="recent-list">
          {users?.map((u) => (
            <UserEditor key={u.id} user={u} roles={roles} caps={caps} presets={presets} limitDefs={limitDefs} servers={servers} isSelf={u.id === me} meId={me} others={(users ?? []).filter((x) => x.id !== u.id)} onChange={load} />
          ))}
        </div>
      </Panel>
    </PanelGroup>
    </>
  );
}

/* ---------------- shared permission matrix ---------------- */

function MatrixEditor({ caps, limitDefs, servers, draft, setDraft, draftLimits, setDraftLimits, allowScopes, inheritedLevel }: {
  caps: Capability[]; limitDefs: LimitDef[]; servers: Server[];
  draft: GrantMap; setDraft: (fn: (d: GrantMap) => GrantMap) => void;
  draftLimits: Record<string, number>; setDraftLimits: (fn: (s: Record<string, number>) => Record<string, number>) => void;
  allowScopes: boolean;
  /** level conferred by roles (users only) — shown as a hint so overrides make sense. */
  inheritedLevel?: (capability: string) => Level;
}) {
  const [scope, setScope] = useState<string>("global");
  const groups = useMemo(() => {
    const gs = new Map<string, Capability[]>();
    for (const c of caps) { const list = gs.get(c.group) ?? []; list.push(c); gs.set(c.group, list); }
    return [...gs.entries()];
  }, [caps]);

  const levelAt = (cap: string, scopeId: string | null): Level =>
    draft.get(keyOf(cap, scopeId))?.level ?? "inherit";

  const setLevel = (cap: string, scopeId: string | null, level: Level) =>
    setDraft((d) => {
      const next = new Map(d);
      if (level === "inherit") next.delete(keyOf(cap, scopeId));
      else next.set(keyOf(cap, scopeId), { capability: cap, scopeType: scopeId ? "server" : "global", scopeId, level });
      return next;
    });

  const scopeServer = servers.find((s) => s.id === scope);
  const visibleCaps = (list: Capability[]) => (scope === "global" ? list : list.filter((c) => c.scoped));

  return (
    <>
      {allowScopes && (
        <>
          <div className="perm-scopes">
            <button className={`seg-btn ${scope === "global" ? "active" : ""}`} onClick={() => setScope("global")}>Global</button>
            {servers.map((s) => (
              <button key={s.id} className={`seg-btn ${scope === s.id ? "active" : ""}`} onClick={() => setScope(s.id)}>{s.name}</button>
            ))}
          </div>
          {scope !== "global" && (
            <p className="muted" style={{ fontSize: "0.78rem", margin: "6px 0 0" }}>
              Extra access on <strong>{scopeServer?.name}</strong> only, on top of the global baseline.
              Only per-server capabilities are listed.
            </p>
          )}
        </>
      )}

      {groups.map(([group, list]) => {
        const rows = visibleCaps(list);
        if (!rows.length) return null;
        return (
          <div key={group} className="perm-group">
            <div className="perm-group-title">{group}</div>
            {rows.map((c) => {
              const scopeId = scope === "global" ? null : scope;
              const lv = levelAt(c.key, scopeId);
              const hints: string[] = [];
              if (scope !== "global") {
                const g = levelAt(c.key, null);
                if (g !== "inherit") hints.push(`global: ${g === "none" ? "blocked" : g}`);
              }
              const inh = scope === "global" && inheritedLevel ? inheritedLevel(c.key) : "none";
              if (inh !== "none") hints.push(`from roles: ${inh}`);
              const rowLimits = scope === "global" && (lv === "read" || lv === "write") ? limitDefs.filter((d) => d.capability === c.key) : [];
              return (
                <div key={c.key}>
                  <div className="perm-row">
                    <div className="perm-cap">
                      <div className="perm-cap-label">{c.label}</div>
                      <div className="perm-cap-desc">{c.description}{hints.length ? ` — ${hints.join(" · ")}` : ""}</div>
                    </div>
                    <div className="seg perm-seg">
                      {levelsFor(c).map((l) => (
                        <button key={l} className={`seg-btn ${lv === l ? "active" : ""} ${l === "none" && lv === l ? "seg-btn-danger" : ""}`} title={LEVEL_TITLE[l]} onClick={() => setLevel(c.key, scopeId, l)}>
                          {LEVEL_LABEL[l]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {rowLimits.map((d) => (
                    <div key={d.key} className="perm-limit">
                      <div className="perm-cap">
                        <div className="perm-cap-label">↳ {d.label}</div>
                        <div className="perm-cap-desc">{d.description}</div>
                      </div>
                      <input
                        type="number" min="1" placeholder="no limit" className="perm-limit-input"
                        value={draftLimits[d.key] ?? ""}
                        onChange={(e) => setDraftLimits((s) => {
                          const next = { ...s };
                          const n = Number(e.target.value);
                          if (!e.target.value || !Number.isFinite(n) || n <= 0) delete next[d.key];
                          else next[d.key] = n;
                          return next;
                        })}
                      />
                      <span className="muted fs-xs">{d.unit}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/* ---------------- request builder's view ceiling ---------------- */

/**
 * While anyone builds a request their READ view is elevated so they can browse the surfaces the
 * request touches. This picks the ceiling — a role whose visibility is the most a builder ever
 * sees ("what the approvers see"), or no ceiling (everything readable) — and how long a saved,
 * unsubmitted draft survives untouched before the sweep tidies it away. It lives beside the
 * roles because the ceiling IS a role, and the natural pick is the top approver role.
 */
function RequestCeilingPanel({ roles }: { roles: Role[] }) {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null); // null = not loaded yet
  const [ttl, setTtl] = useState<string | null>(null);
  // The hours as last read or saved: leaving the box as it was saves nothing.
  const [savedTtl, setSavedTtl] = useState<number | null>(null);
  const [readErr, setReadErr] = useState("");
  useEffect(() => {
    api<{ config?: { requestCeilingRoleId?: string; requestDraftTtlHours?: number } }>("/app-config")
      .then((r) => { const hours = r.config?.requestDraftTtlHours ?? 72; setValue(r.config?.requestCeilingRoleId ?? ""); setTtl(String(hours)); setSavedTtl(hours); })
      // Not shown as "no ceiling" and 72 hours: the hours box saves when it is left, so a failed
      // read put those over the real settings for anyone who only tabbed through it.
      .catch((e) => setReadErr((e as Error).message));
  }, []);

  async function save(next: string) {
    const prev = value;
    setValue(next);
    try {
      await api("/app-config", { method: "PUT", body: { requestCeilingRoleId: next } });
      const named = roles.find((r) => r.id === next)?.name;
      toast.success(next ? `Request builders now see at most what “${named ?? "that role"}” can see` : "Request builders see everything readable");
    } catch (e) {
      setValue(prev);
      toast.error((e as Error).message);
    }
  }

  async function saveTtl() {
    const n = Math.max(0, Math.floor(Number(ttl) || 0));
    setTtl(String(n));
    if (n === savedTtl) return;
    try {
      await api("/app-config", { method: "PUT", body: { requestDraftTtlHours: n } });
      setSavedTtl(n);
      toast.success(n ? `Untouched drafts are now discarded after ${n} hour${n === 1 ? "" : "s"}` : "Drafts are now kept forever");
    } catch (e) { toast.error((e as Error).message); }
  }

  if (readErr) return <Panel id="request-ceiling" caps="open" title="Request builder"><ActionResult error={`Couldn't read the request builder's settings: ${readErr}`} /></Panel>;
  return (
    <Panel id="request-ceiling" caps="open" title="Request builder">
      <Explanation>
        Anyone building an approval request browses the app with a wider <em>read-only</em> view, so
        they can see the surfaces their request touches. Cap that view at a role — usually your top
        approver role, so requesters see at most what the people signing for them see. It never
        grants any action, and a personal Block still hides everything.
      </Explanation>
      <label style={{ maxWidth: 360 }}>While building, staff can see at most
        <select value={value ?? ""} disabled={value === null} onChange={(e) => void save(e.target.value)}>
          <option value="">Everything readable (no ceiling)</option>
          {roles.map((r) => <option key={r.id} value={r.id}>What “{r.name}” can see</option>)}
        </select>
      </label>
      <label style={{ maxWidth: 360, marginTop: 10 }}>Discard unsubmitted drafts after (hours)
        <input type="number" min="0" max="8760" value={ttl ?? ""} disabled={ttl === null}
          onChange={(e) => setTtl(e.target.value)} onBlur={() => void saveTtl()} />
        <span className="hint">Counted from the last time the draft was touched — a capture, a save, a resume. 0 keeps drafts forever.</span>
      </label>
    </Panel>
  );
}

/**
 * THE COMMUNITY CLOCK — one setting, and the reason nothing else asks.
 *
 * Every scheduled feature used to carry its own zone, each defaulting to the string "UTC", so a
 * community on the American east coast set map-vote windows in UTC, auto-settings profiles in UTC,
 * and had the daily claim reset at 8pm. This is where that is answered once.
 *
 * Instance-wide, so it is not among anyone's own settings: changing it moves when the claim resets
 * for everybody. It answers to user & role admin, as the API does — read shows it, write changes it,
 * and a change made without write is sent for approval to someone who holds it. Everyone else reads
 * it where they choose their own clock (Settings → Times shown in, "Community default").
 */
function CommunityClock() {
  const toast = useToast();
  const [tz, setTz] = useState<string | null>(null);
  const [readErr, setReadErr] = useState("");
  const [saving, setSaving] = useState(false);
  const mine = deviceZone();
  useEffect(() => {
    // A failed read is said: shown as UTC, it named a clock the community may not run on.
    api<{ config: { timezone: string } }>("/app-config").then((r) => setTz(r.config.timezone)).catch((e) => setReadErr((e as Error).message));
  }, []);

  const save = async (next: string) => {
    setSaving(true);
    try {
      const r = await api<{ config: { timezone: string } }>("/app-config", { method: "PUT", body: { timezone: next } });
      setTz(r.config.timezone);
      // Anyone following the community default reads the new clock immediately, this admin included.
      applyDisplayZone(r.config.timezone);
      toast.success(`Community time zone set to ${r.config.timezone}`);
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };

  if (readErr) return <ActionResult error={`Couldn't read the community time zone: ${readErr}`} />;
  if (tz === null) return null;
  const options = zoneOptions(tz);
  const nowThere = (() => {
    try { return new Date().toLocaleString(undefined, { timeZone: tz, dateStyle: "medium", timeStyle: "short" }); } catch { return ""; }
  })();
  return (
    <SettingCard
      title="Community time zone"
      description="The clock this community runs on. Schedules read and save in it, and the daily and monthly claims reset on its midnight. Set it once — nothing else asks."
      helper={nowThere ? `It is ${nowThere} there right now.${tz !== mine ? ` Your device is on ${mine}.` : ""}` : undefined}
    >
      <select value={tz} disabled={saving} onChange={(e) => save(e.target.value)}>
        {options.map((z) => <option key={z} value={z}>{z}{z === mine ? " (your device)" : ""}</option>)}
      </select>
      <AskNotice capability="admin.users" />
    </SettingCard>
  );
}

/* ---------------- roles manager ---------------- */

function RolesManager({ roles, read, caps, presets, limitDefs, onChange }: {
  roles: Role[]; read: boolean; caps: Capability[]; presets: Preset[]; limitDefs: LimitDef[]; onChange: () => void;
}) {
  const [nr, setNr] = useState({ name: "", from: "" });
  const [err, setErr] = useState("");

  async function createRole(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    // "Start from" copies the community's OWN roles, not the factory templates. The factory
    // presets were seeded into the roles table on first start and have been tuned since — offering
    // them here meant every new role started from the untuned original and staff re-did the same
    // dozen changes each time. Owner stays as the one built-in: it is a single wildcard grant,
    // there is nothing to tune, and "a second all-access role under a different name" is a real
    // request the existing roles cannot always express.
    let seed: { description: string; grants: { capability: string; level: "none" | "read" | "write" }[]; limits: Record<string, number> } = { description: "", grants: [], limits: {} };
    if (nr.from.startsWith("role:")) {
      const src = roles.find((r) => r.id === nr.from.slice(5));
      if (src) seed = { description: src.description ?? "", grants: src.grants.map((g) => ({ capability: g.capability, level: g.level })), limits: { ...src.limits } };
    } else if (nr.from === "preset:owner") {
      const owner = presets.find((p) => p.key === "owner");
      if (owner) seed = { description: owner.description ?? "", grants: owner.grants.map((g) => ({ capability: g.capability, level: g.level })), limits: owner.limits ?? {} };
    }
    try {
      await api("/roles", {
        method: "POST",
        body: { name: nr.name.trim(), description: seed.description, grants: seed.grants, limits: seed.limits },
      });
      setNr({ name: "", from: "" });
      onChange();
    } catch (e2) { setErr((e2 as Error).message); }
  }

  return (
    <Panel id="roles" caps="open" title="Roles" subtitle={read ? String(roles.length) : undefined}>
      <Explanation>
        A role is a named permission bundle. Assign it to any number of users — editing the role
        updates all of them at once. Individual per-user grants stack on top.
      </Explanation>
      {roles.map((r) => <RoleEditor key={r.id} role={r} allRoles={roles} caps={caps} presets={presets} limitDefs={limitDefs} onChange={onChange} />)}
      {!read && <SkeletonLines lines={3} />}
      {read && !roles.length && (
        <EmptyState icon="🔑" title="No roles defined yet">
          A role is a named bundle of permissions you give staff — &ldquo;Moderator&rdquo;, &ldquo;Senior admin&rdquo;
          — so you grant capabilities once and assign people to it. Create one below, then tune it.
        </EmptyState>
      )}
      <form onSubmit={createRole} className="row" style={{ alignItems: "flex-end", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ flex: "1 1 160px", margin: 0 }}>New role name<input value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} placeholder="e.g. Trial mod" required /></label>
        <label style={{ flex: "1 1 180px", margin: 0 }}>Start from
          <select value={nr.from} onChange={(e) => setNr({ ...nr, from: e.target.value })}>
            <option value="">Blank</option>
            {roles.length > 0 && (
              <optgroup label="Copy an existing role">
                {roles.map((r) => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}
              </optgroup>
            )}
            {presets.some((p) => p.key === "owner") && <option value="preset:owner">Owner (all access)</option>}
          </select>
        </label>
        <button type="submit">Create role</button>
      </form>
      <ActionResult error={err} />
    </Panel>
  );
}

function RoleEditor({ role, allRoles, caps, presets, limitDefs, onChange }: {
  role: Role; allRoles: Role[]; caps: Capability[]; presets: Preset[]; limitDefs: LimitDef[]; onChange: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const savedMap = useMemo(
    () => toMap(role.grants.map((g) => ({ capability: g.capability, scopeType: "global", scopeId: null, level: g.level }))),
    [role.grants],
  );
  const [draft, setDraftState] = useState<GrantMap>(savedMap);
  const [draftLimits, setDraftLimitsState] = useState<Record<string, number>>({ ...role.limits });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const preview = useRolePreview();
  const reqMode = useRequestMode();

  useEffect(() => { setDraftState(savedMap); setDraftLimitsState({ ...role.limits }); setErr(""); }, [savedMap, role.limits]);
  const dirty = !mapEq(draft, savedMap) || !limitsEq(draftLimits, role.limits);
  const isOwnerRole = draft.has(keyOf("*", null));

  /** Load another role's permissions into this editor's DRAFT — nothing is saved until the
   *  usual Save changes, so a copy can be reviewed (and discarded) like any other edit. */
  const copyGrants = (grants: { capability: string; level: "none" | "read" | "write" }[], limits: Record<string, number>) => {
    const next: GrantMap = new Map();
    for (const g of grants) next.set(keyOf(g.capability, null), { capability: g.capability, scopeType: "global", scopeId: null, level: g.level });
    setDraftState(next);
    setDraftLimitsState({ ...limits });
  };

  async function save() {
    setBusy(true); setErr("");
    try {
      await api(`/roles/${role.id}`, {
        method: "PUT",
        body: {
          grants: [...draft.values()].map((g) => ({ capability: g.capability, level: g.level })),
          limits: draftLimits,
        },
      });
      onChange();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function rename() {
    const name = await prompt({ title: "Rename role", label: "Role name", initial: role.name, confirmLabel: "Rename" });
    if (!name || name === role.name) return;
    try { await api(`/roles/${role.id}`, { method: "PUT", body: { name } }); toast.success(`Role renamed to “${name}”`); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function remove() {
    if (!(await confirm({ title: `Delete role "${role.name}"? ${role.members ? `${role.members} member${role.members === 1 ? "" : "s"} will lose its permissions.` : ""}`, confirmLabel: "Delete", danger: true }))) return;
    try { await api(`/roles/${role.id}`, { method: "DELETE" }); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="role-card">
      <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong>{role.name}</strong>
        {isOwnerRole && <span className="badge active">all access</span>}
        <span className="muted fs-sm">
          {role.members} member{role.members === 1 ? "" : "s"} · {role.grants.length} grant{role.grants.length === 1 ? "" : "s"}
        </span>
        {dirty && <span className="badge warn-badge">unsaved changes</span>}
        <span className="grow" />
        <button className="mini ghost" onClick={() => setOpen((v) => !v)}>{open ? "Collapse" : "Edit"}</button>
        <button className="mini ghost" disabled={reqMode.building}
          onClick={() => preview.start({ id: role.id, name: role.name, grants: role.grants })}
          title={reqMode.building
            ? "Finish or exit the request you're building first — the two modes share the docked bar"
            : "See the panel exactly as someone with only this role would — read-only, bounded by your own access"}>View as</button>
        <button className="mini ghost" onClick={rename}>Rename</button>
        <button className="mini ghost danger-ghost" onClick={remove}>Delete</button>
      </div>
      {open && (
        <div className="perm-editor">
          {/* One dropdown, not a row of buttons. The buttons were the factory templates — the
              untuned first-start originals — so "replace with Moderator" threw away the tuning
              this community had done and handed back the shipped defaults. Copying a REAL role is
              the operation staff actually want, and a picker keeps a destructive action off the
              hair-trigger it was on. Owner stays offered: it is one wildcard grant, not a bundle
              that can drift. */}
          <div className="perm-presets">
            <span className="perm-presets-label">Copy permissions from:</span>
            <select
              aria-label="Copy permissions from"
              value=""
              onChange={(e) => {
                const v = e.target.value;
                e.currentTarget.value = ""; // an action, not a setting — never looks "selected"
                if (v.startsWith("role:")) {
                  const src = allRoles.find((r) => r.id === v.slice(5));
                  if (src) copyGrants(src.grants, src.limits);
                } else if (v === "preset:owner") {
                  const owner = presets.find((p) => p.key === "owner");
                  if (owner) copyGrants(owner.grants, owner.limits ?? {});
                }
              }}
            >
              <option value="">Choose a role…</option>
              {allRoles.filter((r) => r.id !== role.id).map((r) => (
                <option key={r.id} value={`role:${r.id}`}>{r.name}</option>
              ))}
              {presets.some((p) => p.key === "owner") && <option value="preset:owner">Owner (all access)</option>}
            </select>
            <button className="mini ghost" onClick={() => { setDraftState(new Map()); setDraftLimitsState({}); }}>Clear all</button>
          </div>
          {isOwnerRole ? (
            <Callout variant="info">This role carries the <strong>all-access</strong> grant — members get every capability. Copy another role&rsquo;s permissions above to make it tunable.</Callout>
          ) : (
            <MatrixEditor
              caps={caps} limitDefs={limitDefs} servers={[]}
              draft={draft} setDraft={(fn) => setDraftState((d) => fn(d))}
              draftLimits={draftLimits} setDraftLimits={(fn) => setDraftLimitsState((s) => fn(s))}
              allowScopes={false}
            />
          )}
          <ActionResult error={err} />
          <div className="perm-save">
            <span className="muted fs-sm">{draft.size} grant{draft.size === 1 ? "" : "s"}{dirty ? " · unsaved" : ""}</span>
            <span className="grow" />
            <button className="ghost" disabled={!dirty || busy} onClick={() => { setDraftState(savedMap); setDraftLimitsState({ ...role.limits }); }}>Discard</button>
            <button disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- per-user editor ---------------- */

function UserEditor({ user, roles, caps, presets, limitDefs, servers, isSelf, meId, others, onChange }: {
  user: User; roles: Role[]; caps: Capability[]; presets: Preset[]; limitDefs: LimitDef[]; servers: Server[]; isSelf: boolean; meId: string | null; others: User[]; onChange: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [draft, setDraftState] = useState<GrantMap>(() => toMap(user.grants));
  const [draftLimits, setDraftLimitsState] = useState<Record<string, number>>(() => ({ ...(user.limits ?? {}) }));
  const [open, setOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeFrom, setMergeFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const saved = useMemo(() => toMap(user.grants), [user.grants]);
  useEffect(() => { setDraftState(toMap(user.grants)); setDraftLimitsState({ ...(user.limits ?? {}) }); setErr(""); }, [user.grants, user.limits]);
  const dirty = !mapEq(draft, saved) || !limitsEq(draftLimits, user.limits ?? {});

  const myRoles = useMemo(() => user.roles ?? [], [user.roles]);
  // Only the GLOBAL assignments: the matrix hint and the owner badge describe community-wide
  // access, and a role held on a single server does not confer any of it.
  const myRoleDefs = useMemo(
    () => myRoles.filter((r) => (r.scopeId ?? null) === null).map((r) => roles.find((x) => x.id === r.id)).filter((r): r is Role => !!r),
    [myRoles, roles],
  );
  const hasStar = draft.has(keyOf("*", null)) || myRoleDefs.some((r) => r.grants.some((g) => g.capability === "*"));

  /** Highest level the user's ROLES confer for a capability (shown as a hint in the matrix). */
  const inheritedLevel = (capability: string): Level => {
    let best: Level = "none";
    for (const r of myRoleDefs) {
      for (const g of r.grants) {
        if (g.capability !== "*" && g.capability !== capability) continue;
        if (g.level === "write") return "write";
        best = "read";
      }
    }
    return best;
  };

  const serverName = useMemo(() => (id: string) => servers.find((s) => s.id === id)?.name ?? id, [servers]);

  /** Badge: role names > Owner > matched preset > Custom > No access. */
  const badge = useMemo(() => {
    if (myRoles.length) return myRoles.map((r) => (r.scopeId ? `${r.name}@${serverName(r.scopeId)}` : r.name)).join(" + ") + (draft.size ? " +" : "");
    if (hasStar) return "Owner";
    if (!draft.size) return "No access";
    const globals = [...draft.values()].filter((g) => g.scopeType === "global");
    for (const p of presets) {
      if (p.key === "owner") continue;
      if (globals.length === p.grants.length && p.grants.every((pg) => draft.get(keyOf(pg.capability, null))?.level === pg.level)) {
        return p.label + ([...draft.values()].some((g) => g.scopeType === "server") ? " +" : "");
      }
    }
    return "Custom";
  }, [draft, presets, hasStar, myRoles, serverName]);

  async function setUserRoles(next: { roleId: string; scopeId: string | null }[]) {
    try { await api(`/users/${user.id}/roles`, { method: "PUT", body: { roles: next } }); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }

  /**
   * One chip per ROLE, not per assignment. A role held on three servers is three rows in the store
   * and one thing a person holds; showing three identical chips that differ only by a dropdown made
   * the common case ("Moderator on these four") look like a mistake.
   */
  const heldRoles = useMemo(() => {
    const byRole = new Map<string, { id: string; name: string; scopes: string[] | null }>();
    for (const r of myRoles) {
      const cur = byRole.get(r.id) ?? { id: r.id, name: r.name, scopes: [] as string[] | null };
      // Any community-wide assignment wins: the role already applies everywhere, so the specific
      // ones add nothing and showing them would imply a narrower grant than the user actually has.
      if ((r.scopeId ?? null) === null) cur.scopes = null;
      else if (cur.scopes !== null) cur.scopes = [...cur.scopes, r.scopeId!];
      byRole.set(r.id, cur);
    }
    return [...byRole.values()];
  }, [myRoles]);

  /** Flatten the chips back to the rows the API stores: one per role per server. */
  const flatten = (list: { id: string; scopes: string[] | null }[]) =>
    list.flatMap((r): { roleId: string; scopeId: string | null }[] =>
      r.scopes === null ? [{ roleId: r.id, scopeId: null }] : r.scopes.map((scopeId) => ({ roleId: r.id, scopeId })));
  async function setDiscordManaged(managed: boolean) {
    if (managed && !(await confirm({
      title: "Let Discord manage this user's roles?",
      body: "Their current roles are replaced from the Discord role mapping on their next login or sync.",
      confirmLabel: "Hand over to Discord",
    }))) return;
    try { await api(`/users/${user.id}/discord-managed`, { method: "PUT", body: { managed } }); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }

  function applyPreset(p: Preset) {
    setDraftState(() => {
      const next: GrantMap = new Map();
      for (const g of p.grants) next.set(keyOf(g.capability, null), { capability: g.capability, scopeType: "global", scopeId: null, level: g.level });
      return next;
    });
    setDraftLimitsState({ ...(p.limits ?? {}) });
  }

  async function save() {
    setBusy(true); setErr("");
    try {
      await api(`/users/${user.id}/grants`, { method: "PUT", body: { grants: [...draft.values()], limits: draftLimits } });
      onChange();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function resetPassword() {
    const pw = await prompt({
      title: `Set a new password for ${user.username}`,
      label: "New password",
      password: true,
      hint: "They can sign in with this immediately. Existing sessions stay signed in.",
      confirmLabel: "Set password",
    });
    if (!pw) return;
    try { await api(`/users/${user.id}`, { method: "PATCH", body: { password: pw } }); toast.success(`Password updated for ${user.username}`); }
    catch (e) { toast.error((e as Error).message); }
  }
  /**
   * The lockout. Separate from "reset password" on purpose: that one helps somebody who forgot
   * theirs and deliberately leaves their sessions alone, which is the wrong answer when the
   * problem is that somebody ELSE is signed in as them.
   */
  async function revokeSessions() {
    const ok = await confirm({
      title: `Sign ${user.username} out everywhere?`,
      body: `Every browser session ends immediately and every API token this account has made is revoked. ${isSelf ? "That includes this one — you will be signed out and have to sign back in. " : ""}The account keeps its roles, permissions and history; ${isSelf ? "you" : "they"} can sign straight back in.`,
      confirmLabel: "Sign out everywhere", danger: true,
    });
    if (!ok) return;
    try {
      const r = await api<{ tokensRevoked: number }>(`/users/${user.id}/revoke-sessions`, { method: "POST" });
      const tokens = r.tokensRevoked > 0 ? ` and revoked ${r.tokensRevoked} API token${r.tokensRevoked === 1 ? "" : "s"}` : "";
      toast.success(`Signed ${user.username} out everywhere${tokens}.`);
      // Signing yourself out means the very next request 401s. Say it rather than let the panel
      // start failing with no explanation attached to the thing that caused it.
      if (!isSelf) onChange();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function removeUser() {
    if (!(await confirm({ title: `Delete user ${user.username}? This cannot be undone.`, confirmLabel: "Delete", danger: true }))) return;
    try { await api(`/users/${user.id}`, { method: "DELETE" }); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function mergeIn() {
    if (!mergeFrom) return;
    const dup = others.find((o) => o.id === mergeFrom);
    if (!dup) return;
    const ok = await confirm({
      title: `Merge "${dup.displayName || dup.username}" into "${user.displayName || user.username}"?`,
      body: `All of ${dup.username}'s action history, authorship, and notice reads move to ${user.username}, its Discord identity transfers if ${user.username} has none, and the account is deleted. ${user.username} keeps its own roles and permissions. This cannot be undone.`,
      confirmLabel: "Merge accounts", danger: true,
    });
    if (!ok) return;
    try {
      await api(`/users/${user.id}/merge`, { method: "POST", body: { duplicateId: mergeFrom } });
      toast.success(`Merged ${dup.username} into ${user.username}.`);
      setMergeOpen(false); setMergeFrom("");
      onChange();
    } catch (e) { toast.error((e as Error).message); }
  }

  // One chip per role, so a role is either held or not — widening and narrowing happen on the
  // chip's own server picker rather than by adding it a second time.
  const assignable = roles.filter((r) => !myRoles.some((m) => m.id === r.id));
  const isOwnGrantStar = draft.has(keyOf("*", null));

  return (
    <div className="subcard">
      <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong>{user.displayName || user.username}</strong>
        {/* The @handle identifies the person even after a nickname change; the account name is
            shown too when it differs from both, so nobody is left guessing who a row is. */}
        {user.discordUsername && <span className="muted fs-sm">@{user.discordUsername}</span>}
        {!user.discordId && user.displayName && user.displayName !== user.username && <span className="muted fs-sm">{user.username}</span>}
        <span className={`badge ${hasStar ? "active" : badge === "No access" ? "" : "observe"}`}>{badge}</span>
        {user.discordManaged && <span className="badge" title="Roles managed by the Discord mapping">Discord</span>}
        {isSelf && <span className="muted fs-xs">(you)</span>}
        {dirty && <span className="badge warn-badge">unsaved changes</span>}
        <span className="grow" />
        <button className="mini ghost" onClick={() => setOpen((v) => !v)}>{open ? "Collapse" : "Edit permissions"}</button>
        <button className="mini ghost" onClick={resetPassword}>Reset password</button>
        <button className="mini ghost danger-ghost" title="End every session and revoke every API token for this account — the lockout for a leaked password or a shared login" onClick={revokeSessions}>Sign out everywhere</button>
        <button className="mini ghost" title="Fold another account's history into this one (e.g. an accidental duplicate from a first Discord sign-in)" onClick={() => setMergeOpen((v) => !v)}>Merge…</button>
        {!isSelf && <button className="mini ghost danger-ghost" onClick={removeUser}>Delete</button>}
      </div>

      {mergeOpen && (
        <div className="control-row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
          <span className="muted fs-sm">Merge into <strong>{user.displayName || user.username}</strong> (this account survives):</span>
          <select value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} aria-label="Duplicate account">
            <option value="">Pick the duplicate account…</option>
            {others.filter((o) => o.id !== meId).map((o) => (
              <option key={o.id} value={o.id}>{o.displayName || o.username}{o.discordUsername ? ` (@${o.discordUsername})` : ""}</option>
            ))}
          </select>
          <button className="mini" disabled={!mergeFrom} onClick={() => void mergeIn()}>Merge</button>
          <button className="mini ghost" onClick={() => { setMergeOpen(false); setMergeFrom(""); }}>Cancel</button>
        </div>
      )}

      {open && (
        <div className="perm-editor">
          {/* Discord-linked users: choose whether roles come from the Discord mapping or are hand-set. */}
          {user.discordId && (
            <Callout variant={user.discordManaged ? "info" : "warn"}>
              {user.discordManaged ? (
                <>Roles for <strong>{user.displayName || user.username}</strong> are <strong>managed by Discord</strong>
                  {user.discordUsername ? ` (@${user.discordUsername})` : ""} — edits here are overwritten on their next
                  login or the periodic sync. <button className="mini ghost" style={{ marginLeft: 8 }} onClick={() => void setDiscordManaged(false)}>Take manual control</button></>
              ) : (
                <>Roles for <strong>{user.displayName || user.username}</strong> are <strong>hand-managed</strong> (Discord override on) — Discord
                  changes won&apos;t touch them. <button className="mini ghost" style={{ marginLeft: 8 }} onClick={() => void setDiscordManaged(true)}>Hand back to Discord</button></>
              )}
            </Callout>
          )}
          {/* role membership — applies immediately */}
          <div className="perm-presets" style={{ marginBottom: 4 }}>
            <span className="perm-presets-label">Roles:</span>
            {heldRoles.map((r) => (
              <span key={r.id} className="role-chip role-chip-scoped">
                <span className="role-chip-name">{r.name}</span>
                {/* Which servers this role applies on — as many as apply. A role names no server of
                    its own, so the servers are chosen here and the same "Moderator" covers them all. */}
                {servers.length > 0 && (
                  <ServerScopeChips
                    servers={servers} value={r.scopes}
                    onChange={(next) => void setUserRoles(flatten(heldRoles.map((m) => (m.id === r.id ? { ...m, scopes: next } : m))))}
                  />
                )}
                <button className="chip-x" title={`Remove role ${r.name}`} onClick={() => setUserRoles(flatten(heldRoles.filter((m) => m.id !== r.id)))}>×</button>
              </span>
            ))}
            {!heldRoles.length && <span className="muted fs-sm">none</span>}
            {assignable.length > 0 && (
              <select
                className="role-add" value="" aria-label="Add a role"
                onChange={(e) => { if (e.target.value) void setUserRoles([...flatten(heldRoles), { roleId: e.target.value, scopeId: null }]); }}
              >
                <option value="">+ Add role…</option>
                {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
          </div>

          {/* individual grants on top */}
          <div className="perm-presets" role="group" aria-label="Individual permissions">
            <span className="perm-presets-label">Individual permissions{myRoles.length ? " (added on top of roles)" : ""} — apply preset:</span>
            {presets.map((p) => (
              <button key={p.key} className="mini ghost" title={p.description} onClick={() => applyPreset(p)}>{p.label}</button>
            ))}
            <button className="mini ghost" title="Remove every individual grant" onClick={() => { setDraftState(new Map()); setDraftLimitsState({}); }}>Clear all</button>
          </div>

          {isOwnGrantStar ? (
            <Callout variant="info">
              This user has the <strong>all-access</strong> grant — every capability, everywhere.
              Apply a different preset above to switch them to tunable permissions.
            </Callout>
          ) : (
            <MatrixEditor
              caps={caps} limitDefs={limitDefs} servers={servers}
              draft={draft} setDraft={(fn) => setDraftState((d) => fn(d))}
              draftLimits={draftLimits} setDraftLimits={(fn) => setDraftLimitsState((s) => fn(s))}
              allowScopes={true}
              inheritedLevel={myRoleDefs.length ? inheritedLevel : undefined}
            />
          )}

          <ActionResult error={err} />
          <div className="perm-save">
            <span className="muted fs-sm">
              {draft.size} individual grant{draft.size === 1 ? "" : "s"}{myRoles.length ? ` + ${myRoles.length} role${myRoles.length === 1 ? "" : "s"}` : ""}{dirty ? " · unsaved" : ""}
            </span>
            <span className="grow" />
            <button className="ghost" disabled={!dirty || busy} onClick={() => { setDraftState(toMap(user.grants)); setDraftLimitsState({ ...(user.limits ?? {}) }); }}>Discard</button>
            <button disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
