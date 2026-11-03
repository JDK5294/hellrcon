"use client";
/**
 * Staff announcements — an internal notice board for the admin team (repurposed from the old
 * public community page; the public site lives on its own domain now, so nothing here is served
 * without a session). Every logged-in staff member sees posted notices; users with the
 * community.edit capability also see drafts and can compose, edit, publish/unpublish, and delete.
 *
 * Read analytics: rendering the board stamps a first-read receipt per posted notice (never
 * overwritten, so time-to-see stays honest), and every notice carries an explicit "✓ Acknowledge"
 * for the things that really must be read. Editors see who has seen/acknowledged each notice,
 * how long after posting, who still hasn't — plus a board-wide analytics panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "../lib/api";
import { useToast, useConfirm } from "../lib/feedback";
import { usePagedList } from "../lib/paged";
import { ActionResult, AskNotice, EmptyState, GoTo, PageHeader, Pager, SkeletonLines, Toggle } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { Time } from "./Time";
import { StaffLink } from "./StaffLink";
import { fmtRelative, fmtExact } from "../lib/time";
// The same "time to see" figure the analytics page shows, formatted by the same function so the
// two screens can never disagree about what 90 minutes looks like.
import { minutes } from "./analytics/shared";

interface MyRead { readAt: string; acknowledgedAt: string | null }
interface Announcement {
  id: string; title: string; body: string; published: boolean;
  publishedAt: string | null; createdAt: string;
  myRead: MyRead | null;
}
interface ReadDetail {
  staffCount: number;
  reads: { userId: string; name: string; readAt: string; acknowledgedAt: string | null; minutesToSee: number | null }[];
  unread: { userId: string; name: string }[];
}
interface AnalyticsRow {
  id: string; title: string; published: boolean; publishedAt: string | null;
  readCount: number; ackCount: number; staffCount: number;
  avgMinutesToSee: number | null; medianMinutesToSee: number | null;
}
interface Analytics { staffCount: number; postedCount: number; overallReadRate: number | null; overallAvgMinutesToSee: number | null; notices: AnalyticsRow[] }


export default function Community({ canEdit = false, canDiscord = false, canReadAnalytics = false }: {
  canEdit?: boolean;
  /** may open the Discord hub tab that holds the unread-notice nudge */
  canDiscord?: boolean;
  /** may open the analytics page that reports on this board */
  canReadAnalytics?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  // The notices a page at a time, newest first: every notice for an editor, drafts included, and
  // the posted ones for everyone else. The board read the newest hundred and stopped there.
  const fetchPage = useCallback((offset: number, limit: number) =>
    api<{ announcements?: Announcement[]; total?: number }>(`${canEdit ? "/community/announcements/all" : "/community/announcements"}?offset=${offset}&limit=${limit}`)
      // An install with no board yet answers thin, and `r.announcements.filter` on undefined is
      // not an empty board — it unmounts the page.
      .then((r) => ({ items: r.announcements ?? [], total: r.total ?? null })), [canEdit]);
  const list = usePagedList<Announcement>(fetchPage, "community.notices");
  const error = list.error;
  // The reader's own receipts as this visit changed them, laid over the rows as read — a tick just
  // given shows at once, without reading the page again.
  const [myReads, setMyReads] = useState<Record<string, MyRead>>({});
  const items = useMemo(() => list.items?.map((a) => (myReads[a.id] ? { ...a, myRead: myReads[a.id]! } : a)) ?? null, [list.items, myReads]);
  // Where the page on screen starts and how long it is, for the reach read that goes with it —
  // kept before the effect below reads it, so a page that lands finds its own place here.
  const where = useRef({ offset: 0, limit: list.limit });
  useEffect(() => { where.current = { offset: list.page * list.limit, limit: list.limit }; }, [list.page, list.limit]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [published, setPublished] = useState(true);
  const [formError, setFormError] = useState("");
  // In flight: a second press (or Enter twice) would post the notice twice.
  const [posting, setPosting] = useState(false);
  // NEW badges: the notices that were unread when they first came up on this visit. Kept for the
  // whole visit — the receipt is stamped immediately, but the badge should stay visible while you
  // read. A notice is new once, the first time it is shown; one you posted was never waiting for you.
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());
  const shown = useRef(new Set<string>());
  // per-notice read detail (editors), loaded on expand
  const [openReads, setOpenReads] = useState<string | null>(null);
  const [readDetail, setReadDetail] = useState<ReadDetail | null>(null);
  // edit-in-place
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  // Per-notice reach, shown inline against each notice in the list below. The BOARD-WIDE report
  // moved to Analytics → Announcements; this is the same read, kept here because "how many have
  // seen this one" belongs next to the notice you are looking at.
  // Read for the page on screen — the notices in the order an editor's board lists them — and
  // only the latest read is kept, so a page left before its figures came cannot leave them here.
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const reachRead = useRef(0);
  const loadAnalytics = useCallback(() => {
    if (!canEdit) return;
    const mine = ++reachRead.current;
    api<Analytics>(`/community/announcements/analytics?offset=${where.current.offset}&limit=${where.current.limit}`)
      .then((r) => { if (mine === reachRead.current) setAnalytics(r); })
      .catch(() => { if (mine === reachRead.current) setAnalytics(null); });
  }, [canEdit]);

  // Each page as it comes in: its unread notices are NEW the first time they show, and are seen.
  useEffect(() => {
    const page = list.items;
    if (!page) return;
    const unread = page.filter((a) => a.published && !a.myRead).map((a) => a.id);
    const fresh = unread.filter((id) => !shown.current.has(id));
    for (const a of page) shown.current.add(a.id);
    if (fresh.length) setNewIds((prev) => new Set([...prev, ...fresh]));
    if (!unread.length) { loadAnalytics(); return; }
    // Rendering IS seeing: stamp first-read receipts for the posted notices now on screen.
    void api("/community/announcements/read", { method: "POST", body: { ids: unread } })
      .then(() => {
        const now = new Date().toISOString();
        setMyReads((prev) => {
          const next = { ...prev };
          for (const id of unread) next[id] ??= { readAt: now, acknowledgedAt: null };
          return next;
        });
      }, () => {})
      .finally(loadAnalytics);
  }, [list.items, loadAnalytics]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setPosting(true);
    try {
      const r = await api<{ announcement?: { id?: string } }>("/community/announcements", { method: "POST", body: { title, body, published } });
      if (r.announcement?.id) shown.current.add(r.announcement.id); // yours: not new to you
      setTitle(""); setBody(""); setPublished(true);
      list.reload(); // the newest notice is at the top of page one
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setPosting(false);
    }
  }

  async function togglePublish(a: Announcement) {
    try {
      await api(`/community/announcements/${a.id}`, { method: "PATCH", body: { published: !a.published } });
      list.refresh();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function remove(a: Announcement) {
    if (!(await confirm({ title: "Delete this notice?", body: "Its read receipts go with it.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api(`/community/announcements/${a.id}`, { method: "DELETE" });
      list.refresh();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function acknowledge(a: Announcement) {
    try {
      const r = await api<{ read: MyRead & { announcementId: string } }>(`/community/announcements/${a.id}/ack`, { method: "POST" });
      setMyReads((prev) => ({ ...prev, [a.id]: { readAt: r.read.readAt, acknowledgedAt: r.read.acknowledgedAt } }));
      toast.success(`Acknowledged “${a.title}”`);
      loadAnalytics();
    } catch (e) { toast.error((e as Error).message); }
  }

  function startEdit(a: Announcement) {
    setEditing(a.id); setEditTitle(a.title); setEditBody(a.body);
  }
  async function saveEdit(a: Announcement) {
    try {
      await api(`/community/announcements/${a.id}`, { method: "PATCH", body: { title: editTitle, body: editBody } });
      setEditing(null);
      toast.success("Notice updated");
      list.refresh();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function toggleReads(a: Announcement) {
    if (openReads === a.id) { setOpenReads(null); setReadDetail(null); return; }
    setOpenReads(a.id); setReadDetail(null);
    try {
      setReadDetail(await api<ReadDetail>(`/community/announcements/${a.id}/reads`));
    } catch (e) { toast.error((e as Error).message); setOpenReads(null); }
  }

  const statFor = (id: string): AnalyticsRow | undefined => analytics?.notices?.find((n) => n.id === id);

  return (
    <div>
      <div className="card page-head">
        <PageHeader routeId="community" title="Staff announcements" />
        {canEdit && <AskNotice capability="community.edit" />}
      </div>
      {error && <div className="card"><ActionResult error={error} /></div>}

      <PanelGroup viewId="community">
        {canEdit && (
          <Panel id="compose" caps="community.edit" title="Post a notice">
            <form onSubmit={create}>
              <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
              <label>Body<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} style={{ width: "100%", padding: "0.5rem", background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6 }} required /></label>
              <Toggle checked={published} onChange={setPublished} label="Post immediately (off saves a draft)" />
              <div className="actions"><button type="submit" disabled={posting}>Add notice</button></div>
              <ActionResult error={formError} />
            </form>
          </Panel>
        )}

        {/* The nudge settings and the read analytics used to sit here. Both were about something
            OTHER than writing a notice — one is a Discord channel, one is a measurement — so they
            moved to where the rest of that lives, and the board links across. Each link is shown
            only to someone who can actually open the destination: a button that leads to a 403 is
            worse than no button. */}
        {(canDiscord || canReadAnalytics) && (
          <Panel id="elsewhere" caps={["community.edit", "analytics.announcements"]} title="Settings and reporting" subtitle="the parts of this board that live elsewhere">
            <div className="jump-row">
              {canDiscord && (
                <span className="jump-item">
                  <GoTo view="discord" tab="relay">Discord settings</GoTo>
                  <span className="muted fs-xs">Remind staff on Discord who haven&apos;t read a notice.</span>
                </span>
              )}
              {canReadAnalytics && (
                <span className="jump-item">
                  <GoTo view="analytics" tab="announcements">Read analytics</GoTo>
                  <span className="muted fs-xs">Read rates, time-to-see and acknowledgements across every notice.</span>
                </span>
              )}
            </div>
          </Panel>
        )}

        <Panel id="notices" caps="open" title="Notices" subtitle={list.total !== null ? `${list.total}` : undefined}>
          {!items && !error && <SkeletonLines lines={3} />}
          {items && !items.length && list.page === 0 && (
            <EmptyState icon="📣" title="No notices posted yet">
              This is the board your admin team reads — schedule changes, policy updates, anything every
              staff member should see. {canEdit ? "Post the first one using the form above; you'll be able to see who has read it." : "Someone with permission to post will start it off."}
            </EmptyState>
          )}
          {/* newest first, so these are a list inside one panel rather than panels of their own */}
          <div className="recent-list">
            {items?.map((a) => {
              const stat = statFor(a.id);
              return (
                <div className="subcard" key={a.id}>
                  <div className="row">
                    <div>
                      <strong>{a.title}</strong>
                      {newIds.has(a.id) && <span className="badge active" style={{ marginLeft: 8 }}>NEW</span>}
                      <br /><span className="muted">{a.publishedAt ? fmt(a.publishedAt) : fmt(a.createdAt)}</span>
                    </div>
                    {canEdit && <span className={`badge ${a.published ? "active" : "observe"}`}>{a.published ? "posted" : "draft"}</span>}
                  </div>
                  {editing === a.id ? (
                    <div style={{ marginTop: 8 }}>
                      <label>Title<input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></label>
                      <label>Body<textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={4} style={{ width: "100%" }} /></label>
                      <div className="actions">
                        <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="primary" onClick={() => saveEdit(a)} disabled={!editTitle.trim() || !editBody.trim()}>Save</button>
                      </div>
                    </div>
                  ) : (
                    <p style={{ whiteSpace: "pre-wrap" }}>{a.body}</p>
                  )}

                  {a.published && (
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {a.myRead?.acknowledgedAt
                        ? <span className="badge active" title={fmtExact(a.myRead.acknowledgedAt)}>✓ Acknowledged</span>
                        : <button className="mini" onClick={() => acknowledge(a)}>✓ Acknowledge</button>}
                      {canEdit && stat && (
                        <button className="mini ghost" onClick={() => toggleReads(a)}>
                          Seen {stat.readCount}/{stat.staffCount} · Ack {stat.ackCount}/{stat.staffCount}{stat.avgMinutesToSee !== null ? ` · ~${minutes(stat.avgMinutesToSee)} to see` : ""} {openReads === a.id ? "▴" : "▾"}
                        </button>
                      )}
                    </div>
                  )}

                  {openReads === a.id && (
                    <div className="subcard" style={{ marginTop: 8 }}>
                      {!readDetail && <p className="muted">Loading read receipts…</p>}
                      {readDetail && (
                        <>
                          {readDetail.reads.length > 0 && (
                            <div className="scroll-x">
                              <table className="table">
                                <thead><tr><th>Staff</th><th>Seen</th><th>After posting</th><th>Acknowledged</th></tr></thead>
                                <tbody>
                                  {readDetail.reads.map((r) => (
                                    <tr key={r.userId}>
                                      <td><StaffLink userId={r.userId} name={r.name} /></td>
                                      <td><Time iso={r.readAt} /></td>
                                      <td>{minutes(r.minutesToSee)}</td>
                                      <td>{r.acknowledgedAt ? `✓ ${fmtRelative(r.acknowledgedAt)}` : "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          <p className="hint" style={{ marginTop: 6 }}>
                            {readDetail.unread.length
                              ? <>Not seen yet: {readDetail.unread.map((u) => u.name).join(", ")}</>
                              : "Everyone has seen this."}
                          </p>
                        </>
                      )}
                    </div>
                  )}

                  {canEdit && editing !== a.id && (
                    <div className="actions">
                      <button className="ghost" onClick={() => startEdit(a)}>Edit</button>
                      <button className="ghost" onClick={() => togglePublish(a)}>{a.published ? "Unpost" : "Post"}</button>
                      <button className="danger" onClick={() => remove(a)}>Delete</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {items && items.length > 0 && <Pager list={list} noun="notice" />}
        </Panel>
      </PanelGroup>
    </div>
  );
}
