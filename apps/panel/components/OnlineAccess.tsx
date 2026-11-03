"use client";
/**
 * Administration → Online access: how people reach this install from the internet — a Cloudflare
 * tunnel the panel runs itself, or the install's own domain behind the HTTPS proxy a VM install
 * runs — the public stats site's own address and name, and whether the public demo is shown. All
 * of it set here, none of it in infra/.env.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/resource";
import { APP_NAME } from "../lib/brand";
import { ActionResult, Explanation, SkeletonLines, Toggle } from "./ui";
import { PanelGroup, Panel } from "./Panel";

interface StatsSite { host: string | null; origin: string | null; name: string | null; shareable: string | null }
type TunnelState = "off" | "connecting" | "connected" | "missing" | "failing";
interface OnlineView {
  route?: "home" | "vm";
  tunnel?: { set: boolean; state: TunnelState; connections: number; tunnelId: string | null; detail: string | null };
  domain?: { host: string | null; proxy: boolean };
  statsSite: StatsSite;
  demo?: { on: boolean };
}

export default function OnlineAccess({ canManage }: { canManage: boolean }) {
  const load = useCallback(() => api<OnlineView>("/online"), []);
  // While the tunnel is still finding its feet, look again every few seconds.
  const [refreshMs, setRefreshMs] = useState<number | undefined>(undefined);
  const online = useResource(load, { refreshMs });
  const view = online.data;
  const tunnelState = view?.tunnel?.state;
  useEffect(() => { setRefreshMs(tunnelState === "connecting" || tunnelState === "failing" ? 4_000 : undefined); }, [tunnelState]);

  if (!view) {
    return <PanelGroup viewId="online"><Panel id="online" caps="open" title="Put the panel online">{online.error ? <ActionResult error={online.error} /> : <SkeletonLines lines={4} />}</Panel></PanelGroup>;
  }
  // A save reads the whole tab again rather than painting its own answer: a poll still on its way
  // would otherwise land after it and put back what the save replaced.
  return (
    <PanelGroup viewId="online">
      <OnlinePanel view={view} onSaved={online.reload} canManage={canManage} />
      {/* Only with its settings in the answer: drawn without them, the screen crashed, and empty
          boxes in their place would invite saving blanks over the real address. */}
      {view.statsSite && <StatsSitePanel site={view.statsSite} onSaved={online.reload} canManage={canManage} />}
      {view.demo && <DemoPanel on={view.demo.on} domain={view.domain} onSaved={online.reload} canManage={canManage} />}
    </PanelGroup>
  );
}

const TUNNEL_SAYS: Record<TunnelState, string> = {
  off: "Off",
  connecting: "Connecting to Cloudflare…",
  connected: "Connected",
  missing: "Cannot start: cloudflared is not installed where the panel runs",
  failing: "Not connecting",
};

function OnlinePanel({ view, onSaved, canManage }: { view: OnlineView; onSaved: () => void; canManage: boolean }) {
  const tunnel = view.tunnel ?? { set: false, state: "off" as TunnelState, connections: 0, tunnelId: null, detail: null };
  const domain = view.domain ?? { host: null, proxy: false };
  const vm = view.route === "vm";
  const [token, setToken] = useState("");
  const [host, setHost] = useState(domain.host ?? "");
  const [busy, setBusy] = useState("");
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");

  async function put(what: "tunnel" | "domain", body: Record<string, string>, done: (v: OnlineView) => string) {
    setBusy(what);
    setOk("");
    setError("");
    try {
      const v = await api<OnlineView>(`/online/${what}`, { method: "PUT", body });
      onSaved();
      setOk(done(v));
      if (what === "tunnel") setToken("");
      else setHost(v.domain?.host ?? "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  const reachedAt = tunnel.state === "connected" ? "Online through your Cloudflare tunnel"
    : domain.host && domain.proxy ? `Online at https://${domain.host}`
    : "This network only, for now";

  return (
    <Panel id="online" caps="open" title="Put the panel online" subtitle={reachedAt}>
      <p className="muted mt-0">Two ways to reach the panel from anywhere, over HTTPS. One is enough.</p>
      <ActionResult ok={ok} error={error} />

      <section className="online-way">
        <h3 className="online-way-title">Cloudflare Tunnel <span className="badge ok">{vm ? "Works on a VM too" : "Recommended for a home PC"}</span></h3>
        <div className="online-proscons">
          <ul className="online-pros">
            <li>No ports to open, and your address stays hidden.</li>
            <li>Free, with HTTPS done for you.</li>
            <li>Works behind any router, even one you cannot change.</li>
          </ul>
          <ul className="online-cons">
            <li>Needs a free Cloudflare account, with your domain on it.</li>
            <li>Visits pass through Cloudflare on the way.</li>
          </ul>
        </div>
        {tunnel.set && (
          <p className="online-status">
            <strong>{TUNNEL_SAYS[tunnel.state]}</strong>
            {tunnel.state === "connected" && <> — {tunnel.connections} connection{tunnel.connections === 1 ? "" : "s"} to Cloudflare</>}
            {tunnel.tunnelId && <span className="muted"> · tunnel {tunnel.tunnelId.slice(0, 8)}</span>}
            {tunnel.detail && tunnel.state !== "connected" && <span className="muted"> · {tunnel.detail}</span>}
          </p>
        )}
        <label>
          Tunnel token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} disabled={!canManage} autoComplete="off" spellCheck={false}
            placeholder={tunnel.set ? "saved — paste a new one to replace it" : "paste the token, or the whole install command"} />
        </label>
        {canManage && (
          <div className="actions">
            <button className="primary" disabled={busy !== "" || !token.trim()} onClick={() => void put("tunnel", { token }, () => "Saved. The panel is starting its tunnel.")}>{busy === "tunnel" ? "Saving…" : "Save"}</button>
            {tunnel.set && <button className="ghost" disabled={busy !== ""} onClick={() => void put("tunnel", { token: "" }, () => "Removed. The tunnel is off.")}>Remove</button>}
          </div>
        )}
        <Explanation>
          <ol className="online-steps">
            <li>Put your domain on Cloudflare (the free plan is enough): in the Cloudflare dashboard choose Add a domain, then give your domain&apos;s registrar the two nameservers Cloudflare shows.</li>
            <li>Go to Zero Trust → Networks → Tunnels → Create a tunnel, choose Cloudflared, and name it.</li>
            <li>On the connector page, copy any of the install commands it shows and paste it above. The panel picks the token out of it. Skip installing the connector: the panel runs it.</li>
            <li>Under Public hostname, add the address for the panel, such as panel.example.com, with Service type HTTP and URL localhost:8080. A tunnel set up earlier with api:8080 keeps working.</li>
            <li>Save here. Within a few seconds it says Connected; then open your address.</li>
          </ol>
          <p>For the stats site&apos;s own address, add a second public hostname the same way, then set it under Public stats site below.</p>
        </Explanation>
      </section>

      <section className="online-way">
        <h3 className="online-way-title">Your own domain <span className="badge">{vm ? "For this VM" : "For a VM with its own address"}</span></h3>
        <div className="online-proscons">
          <ul className="online-pros">
            <li>Nobody stands between your visitors and your server.</li>
            <li>Any domain works, with free certificates from Let&apos;s Encrypt.</li>
          </ul>
          <ul className="online-cons">
            <li>The server&apos;s address is public, and ports 80 and 443 must be open to it.</li>
            <li>Not for a home PC: most home connections cannot take it.</li>
          </ul>
        </div>
        <p className="online-status">
          {domain.proxy ? <strong>The HTTPS proxy is running.</strong> : <>The HTTPS proxy is not running on this install. It comes with the VM install.</>}
          {domain.host && domain.proxy && <> Open <a href={`https://${domain.host}`} target="_blank" rel="noreferrer">https://{domain.host}</a> — the first visit takes a few seconds while its certificate is issued.</>}
        </p>
        <label>
          The panel&apos;s domain
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="panel.example.com" disabled={!canManage} autoComplete="off" spellCheck={false} />
        </label>
        {canManage && (
          <div className="actions">
            <button className="primary" disabled={busy !== "" || host.trim() === (domain.host ?? "")} onClick={() => void put("domain", { host }, (v) => (v.domain?.host ? `Saved. The panel answers on https://${v.domain.host} once its DNS points here.` : "Removed."))}>{busy === "domain" ? "Saving…" : "Save"}</button>
            {domain.host && <button className="ghost" disabled={busy !== ""} onClick={() => void put("domain", { host: "" }, () => "Removed. The panel no longer has its own domain.")}>Remove</button>}
          </div>
        )}
        <Explanation>
          <ol className="online-steps">
            <li>At the company that runs your domain&apos;s DNS, add an A record for the panel&apos;s address (such as panel) pointing at this server&apos;s public IP address. Add an AAAA record too if the server has IPv6.</li>
            <li>Open ports 80 and 443 in your VM provider&apos;s firewall (its security group or network rules). The VM installer already opened them on the server itself.</li>
            <li>Enter the domain here and save.</li>
            <li>Open https:// and your domain. The first visit takes a few seconds while Let&apos;s Encrypt issues the certificate; after that it renews on its own.</li>
          </ol>
          <p>For the stats site&apos;s own address, add a second A record pointing at the same IP, then set it under Public stats site below.</p>
        </Explanation>
      </section>
    </Panel>
  );
}

function StatsSitePanel({ site, onSaved, canManage }: { site: StatsSite; onSaved: () => void; canManage: boolean }) {
  const [host, setHost] = useState(site.host ?? "");
  const [origin, setOrigin] = useState(site.origin ?? "");
  const [name, setName] = useState(site.name ?? "");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");

  const dirty = host.trim() !== (site.host ?? "") || origin.trim() !== (site.origin ?? "") || name.trim() !== (site.name ?? "");

  async function save() {
    setBusy(true);
    setOk("");
    setError("");
    try {
      const r = await api<OnlineView>("/online/stats-site", { method: "PUT", body: { host: host.trim(), origin: origin.trim(), name: name.trim() } });
      onSaved();
      setHost(r.statsSite.host ?? ""); setOrigin(r.statsSite.origin ?? ""); setName(r.statsSite.name ?? "");
      setOk(r.statsSite.shareable ? `Saved. Stats links now start ${r.statsSite.shareable}.` : "Saved. The stats site is on the panel's own address, at /stats.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel id="stats-site" caps="open" title="Public stats site" subtitle={site.shareable ? `Links start ${site.shareable}` : "On the panel's own address, at /stats"}>
      <label>
        Its own address
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="stats.example.com" autoComplete="off" spellCheck={false} disabled={!canManage} />
      </label>
      <p className="muted fs-xs mt-0">Links shared with players then never show the panel&apos;s address.</p>
      <label>
        Community name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={APP_NAME} maxLength={60} disabled={!canManage} />
      </label>
      <p className="muted fs-xs mt-0">What the stats site calls itself. Players know your community, not this software.</p>
      <label>
        Shareable address
        <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder={host.trim() ? `https://${host.trim()}` : "https://stats.example.com"} autoComplete="off" spellCheck={false} disabled={!canManage} />
      </label>
      <p className="muted fs-xs mt-0">Only when links should start with something other than https:// and the address above.</p>
      <ActionResult ok={ok} error={error} />
      {canManage && <div className="actions"><button className="primary" onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</button></div>}
      <Explanation>
        <p className="mt-0">Point the address at the same place as the panel. On a Cloudflare tunnel, add a second public hostname to the tunnel with the same service as the panel&apos;s. With your own domain, add a DNS record for it pointing at the same server.</p>
        <p>A visit on that address gets only the stats pages and their public data; everything else there answers &quot;not found&quot;. Short links work on it: stats.example.com/nam is the page of the server whose URL name is nam.</p>
      </Explanation>
    </Panel>
  );
}

/**
 * The public demo: a copy of the panel that runs on made-up data in the visitor's own browser, at
 * /demo on the panel's address. Its own bar takes a visitor to Help's walkthroughs, so the one link
 * serves both. The switch saves as it is turned.
 */
function DemoPanel({ on, domain, onSaved, canManage }: { on: boolean; domain: OnlineView["domain"]; onSaved: () => void; canManage: boolean }) {
  // The switch shows where it was turned while the save is on its way, and goes back if it fails.
  const [shown, setShown] = useState(on);
  useEffect(() => setShown(on), [on]);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");
  // Any address of the panel serves it, the same server answering: its own domain once the HTTPS
  // proxy serves it, or else the address it is open on now.
  const [here, setHere] = useState("");
  useEffect(() => setHere(window.location.origin), []);
  const origin = domain?.host && domain.proxy ? `https://${domain.host}` : here;

  async function turn(next: boolean) {
    setShown(next);
    setBusy(true);
    setOk("");
    setError("");
    try {
      await api<OnlineView>("/online/demo", { method: "PUT", body: { on: next } });
      onSaved();
      setOk(next ? "On. Anyone with the link can try the panel." : "Off. The link now answers \"not found\".");
    } catch (err) {
      setShown(on);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel id="demo" caps="open" title="Public demo" subtitle={on ? "On" : "Off"}>
      <Toggle checked={shown} onChange={(v) => void turn(v)} disabled={!canManage || busy} label="Show the demo" />
      <p className="muted fs-xs mt-0">A copy of the panel on made-up data, for anyone to click around in. Nothing done there reaches your servers.</p>
      {shown && origin && (
        <p className="demo-link">Link to share: <a href={`${origin}/demo/`} target="_blank" rel="noreferrer">{origin}/demo/</a></p>
      )}
      <ActionResult ok={ok} error={error} />
      <Explanation>
        <p className="mt-0">The demo runs in the visitor&apos;s own browser, on a made-up community with a round being played on Live. They can open every screen, and anything they change lasts only until they reload the page. It never reads or changes anything of yours, and plugins you have loaded are not in it.</p>
        <p>Its bar at the top opens Help&apos;s walkthroughs, which show each job step by step on the demo&apos;s own screens.</p>
        <p>It is on the panel&apos;s own address, so share it the way you reach the panel. Off, the link answers &quot;not found&quot;.</p>
      </Explanation>
    </Panel>
  );
}
