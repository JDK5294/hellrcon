import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Every service in the shipped stack that runs one of OUR node apps gets the composed
 * DATABASE_URL.
 *
 * The bot's own code documents "without DATABASE_URL the repo is in-memory (empty)" as a dev
 * fallback — and the shipped compose file walked straight into it: the discord service carried
 * only REDIS_URL, so the relay bot ran against an empty store. Every panel-configured relay
 * route and every alert (admin pings, watchlist joins, automation reports) lives in that
 * database; the panel showed them saved, the bot loaded none of them, and nothing logged an
 * error because an empty config list is a legal state. The failure was invisible everywhere.
 *
 * Keyed off the shared Dockerfile: a compose service built from apps/api/Dockerfile is one of
 * our apps, whatever `command` it runs, so a fourth app added tomorrow is covered on arrival.
 */
test("every app service in docker-compose gets the composed DATABASE_URL", () => {
  const compose = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infra", "docker-compose.yml"), "utf8");
  // Split into top-level service blocks: a line of exactly two spaces + name + colon starts one.
  const lines = compose.split("\n");
  const blocks = new Map<string, string>();
  let name: string | null = null, buf: string[] = [];
  for (const line of lines) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) {
      if (name) blocks.set(name, buf.join("\n"));
      name = m[1]!; buf = [];
    } else if (name) buf.push(line);
  }
  if (name) blocks.set(name, buf.join("\n"));

  const appServices = [...blocks.entries()].filter(([, body]) => body.includes("apps/api/Dockerfile"));
  assert.ok(appServices.length >= 3, `expected the api, worker and discord services to build from the shared Dockerfile — found ${appServices.map(([n]) => n).join(", ") || "none"} (the compose layout moved; retarget this scan)`);
  for (const [service, body] of appServices) {
    assert.ok(
      /\bDATABASE_URL:/.test(body),
      `the "${service}" service has no DATABASE_URL — it will silently run on the empty in-memory store, and everything it is supposed to read from the database (relay routes, alerts, configs) will quietly not exist`,
    );
  }
});

test("postgres gets more than Docker's 64MB of shared memory — long analytics windows need it", () => {
  const compose = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infra", "docker-compose.yml"), "utf8");
  const pg = compose.slice(compose.indexOf("\n  postgres:"), compose.indexOf("\n  redis:"));
  assert.match(pg, /\n {4}shm_size: 1gb\n/, "without it a 90-day or 1-year window's parallel query runs out of /dev/shm");
});

/** The compose file's top-level service blocks, by name. */
function services(): Map<string, string> {
  const compose = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infra", "docker-compose.yml"), "utf8");
  const blocks = new Map<string, string>();
  let name: string | null = null, buf: string[] = [];
  for (const line of compose.split("\n")) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) {
      if (name) blocks.set(name, buf.join("\n"));
      name = m[1]!; buf = [];
    } else if (name) buf.push(line);
  }
  if (name) blocks.set(name, buf.join("\n"));
  return blocks;
}

/*
 * The database and Redis were published on every interface. Behind a home router that is the local
 * network; on a VM with a public address it is the internet — Docker writes its own firewall rules,
 * so ufw never sees the port — with Postgres on the template's password and Redis on none. The app
 * reaches both over the compose network; the host port is for local tools, on this machine only.
 */
test("postgres and redis are published on this machine only, never on every interface", () => {
  const blocks = services();
  for (const [svc, port] of [["postgres", "POSTGRES_PORT"], ["redis", "REDIS_PORT"]] as const) {
    const body = blocks.get(svc) ?? "";
    const published = [...body.matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]!);
    assert.ok(published.length > 0, `${svc} has no published port — the scan is reading the wrong block`);
    for (const mapping of published) {
      assert.ok(mapping.startsWith(`127.0.0.1:\${${port}:-`), `${svc} publishes "${mapping}" — on every interface, reachable from the network`);
    }
  }
});

test("the api is never handed a public placeholder as its login key", () => {
  const api = services().get("api") ?? "";
  const line = /^ {6}SESSION_SECRET: (.*)$/m.exec(api)?.[1];
  assert.equal(line, "${SESSION_SECRET:-}", "unset must stay unset, so the app makes and keeps a key of its own");
});

/*
 * Your own domain with HTTPS. The proxy binds ports 80 and 443, which a home PC must not have
 * taken by a stack that has no use for them, so it runs only on the `domain` profile a VM install
 * turns on. It fetches a certificate only for an address the panel says is its own, and drops the
 * Cloudflare header a visitor reaching the server directly could otherwise send to pass for
 * someone else.
 */
test("the HTTPS proxy runs only on the domain profile, asks the panel before any certificate, and drops the borrowed visitor header", () => {
  const caddy = services().get("caddy") ?? "";
  assert.match(caddy, /^ {4}profiles: \["domain"\]$/m, "never on a stack that did not ask for it");
  const caddyfile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infra", "Caddyfile"), "utf8");
  assert.match(caddyfile, /^\s*ask http:\/\/api:8080\/api\/online\/tls-ask$/m, "the panel says which addresses are its own");
  assert.match(caddyfile, /^\s*on_demand$/m);
  assert.match(caddyfile, /^\s*header_up -Cf-Connecting-Ip$/m);
});

/*
 * The tunnel runs inside the API now. The separate container older installs ran is no longer
 * started with the stack: each start script asks the panel where its own tunnel stands, removes
 * the old container once it is connected (or switched off), and starts it only as a fallback.
 */
test("the start scripts no longer start the old tunnel container with the stack, and retire it by the panel's word", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const name of ["start.sh", "start.bat"]) {
    const script = readFileSync(join(root, name), "utf8");
    const up = script.split("\n").filter((l) => /docker compose .* up -d --build/.test(l));
    assert.equal(up.length, 1, `${name} starts the stack in one place`);
    assert.doesNotMatch(up[0]!, /tunnel/, `${name} starts the stack without the old tunnel container`);
    assert.match(script, /api\/setup\/status/);
    assert.match(script, /--profile tunnel rm -sf cloudflared/, `${name} removes the old container`);
    assert.match(script, /--profile tunnel up -d cloudflared/, `${name} starts it only as the fallback`);
  }
});

/*
 * The installers. The VM's sets the two lines that make it a VM install: the panel reports the
 * route, and the HTTPS proxy for an own domain runs with the stack. It is one function called on
 * its last line, so `curl … | bash` cutting off mid-download runs nothing. The Windows one offers
 * both programs it needs by winget and by their download pages, and both hand over to the start
 * script.
 */
test("the installers: the VM's sets the VM's settings and is safe to pipe; the Windows one offers what it needs; both hand over to the start script", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const sh = readFileSync(join(root, "install.sh"), "utf8");
  // The lines that write them, not the messages that mention them.
  assert.match(sh, /\|\| printf '\\nDEPLOY_ROUTE=vm\\n' >> infra\/\.env$/m);
  assert.match(sh, /\|\| printf 'COMPOSE_PROFILES=domain\\n' >> infra\/\.env$/m);
  assert.match(sh, /^\s*\.\/start\.sh$/m, "it starts the panel the same way an update does");
  assert.equal(sh.trimEnd().split("\n").pop(), 'main "$@"', "nothing runs until the whole script has arrived");
  const bat = readFileSync(join(root, "install.bat"), "utf8");
  for (const [id, page] of [["Git.Git", "https://git-scm.com/download/win"], ["Docker.DockerDesktop", "https://www.docker.com/products/docker-desktop/"]]) {
    assert.ok(bat.includes(`set "WINGET_ID=${id}"`), `offers ${id} by winget`);
    assert.ok(bat.includes(`set "PAGE=${page}"`), `and its download page, ${page}`);
  }
  assert.match(bat, /recommended for Windows/, "and says these are the recommended ones");
  assert.match(bat, /Rancher Desktop/, "not the only ones");
  assert.match(bat, /^call start\.bat$/m);
  // A fresh Docker Desktop is not on the window's PATH yet, and start.bat looks for docker there.
  assert.match(bat, /^if errorlevel 1 if exist "%ProgramFiles%\\Docker\\Docker\\resources\\bin\\docker\.exe" set "PATH=%PATH%;%ProgramFiles%\\Docker\\Docker\\resources\\bin"$/m,
    "a Docker just installed is found by start.bat");
});

/*
 * Both shell scripts run under `set -euo pipefail`, where an assignment from a pipeline takes the
 * status of the first command in it that fails and the script stops there, saying nothing: a grep
 * that finds no API_PORT line, a curl that times out while the tunnel is checked. And the VM
 * installer must not stop because a VM refuses swap.
 */
test("the shell scripts never stop half-way, silently, on a check that comes back empty", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const name of ["start.sh", "install.sh"]) {
    const risky = readFileSync(join(root, name), "utf8").split("\n").flatMap((line, i) => {
      const m = /[A-Za-z_][A-Za-z0-9_]*="\$\((.*)\)"\s*$/.exec(line);
      return m && /[^|]\|[^|]/.test(m[1]!) && !m[1]!.includes("||") ? [`${name}:${i + 1} ${line.trim()}`] : [];
    });
    assert.deepEqual(risky, [], "end these with || true and judge the empty value");
  }
  const sh = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(sh, /&& swapon \/swapfile 2>\/dev\/null; then$/m, "swap is tried inside a condition");
  assert.doesNotMatch(sh, /^\s*swapon /m, "never a bare swapon, which would stop the install");
});

// On a VM the setup page is opened from another computer: the link start.sh prints names the server.
test("on a VM, start.sh's setup link names the server's address, not localhost", () => {
  const sh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.sh"), "utf8");
  assert.match(sh, /if grep -Eq '\^DEPLOY_ROUTE=vm' infra\/\.env/);
  assert.match(sh, /OPEN_URL="http:\/\/\$\{PANEL_HOST\}:\$\{API_PORT\}\/#\/setup\?code=\$\{SETUP_CODE\}"/);
});

test("batch files are checked out with CRLF line endings everywhere", () => {
  const attrs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".gitattributes"), "utf8");
  assert.match(attrs, /^\*\.bat text eol=crlf$/m);
});

/*
 * install.bat is the file people download on its own, from its page on GitHub, and that download is
 * the file exactly as stored: the eol=crlf rule converts checkouts and ZIP downloads, not that. So
 * install.bat is left out of the conversion and stored with CRLF on every line.
 */
test("install.bat is stored with CRLF line endings, so a download of that one file has them too", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // git goes by the last line that sets an attribute.
  const rule = readFileSync(join(root, ".gitattributes"), "utf8").split("\n").map((l) => l.trim())
    .filter((l) => /^(\*\.bat|install\.bat)\s/.test(l) && /\s-?text\b/.test(l)).pop();
  assert.equal(rule, "install.bat -text", "git stores install.bat as it is in the folder");
  const lines = readFileSync(join(root, "install.bat"), "utf8").split("\n");
  assert.equal(lines.pop(), "", "the last line ends too");
  assert.deepEqual(lines.flatMap((l, i) => l.endsWith("\r") ? [] : [`install.bat:${i + 1}`]), [], "every line ends in CRLF");
});

/*
 * Which code an install gets. main holds nothing yet, so both installers clone the branch the panel
 * is built on, and the links to them in the README, the install guide and install.sh's own header
 * name that branch: a link to main would fetch an installer that is not there. Moving to main is a
 * change of all of them or none.
 */
test("both installers clone the same branch, and every link to an installer names it", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const read = (name: string) => readFileSync(join(root, name), "utf8");
  const bat = read("install.bat"), sh = read("install.sh");
  const repo = /^set "REPO_URL=https:\/\/github\.com\/([^"]+)\.git"\r?$/m.exec(bat)?.[1];
  const branch = /^set "REPO_BRANCH=([^"]+)"\r?$/m.exec(bat)?.[1];
  assert.ok(repo && branch, "install.bat names the repository and the branch");
  assert.ok(sh.includes(`REPO_URL="\${HELLRCON_REPO:-https://github.com/${repo}.git}"`), "install.sh the same repository");
  assert.ok(sh.includes(`REPO_BRANCH="\${HELLRCON_BRANCH:-${branch}}"`), "and the same branch");
  const clones = (script: string) => script.split("\n").filter((l) => /^\s*git clone /.test(l)).map((l) => l.trim());
  assert.deepEqual(clones(bat), ['git clone -b "%REPO_BRANCH%" "%REPO_URL%" "%DIR%"'], "install.bat clones that branch");
  assert.deepEqual(clones(sh), ['git clone -b "$REPO_BRANCH" "$REPO_URL" "$DIR"'], "and so does install.sh");
  const download = `https://github.com/${repo}/blob/${branch}/install.bat`;
  const pipe = `https://raw.githubusercontent.com/${repo}/${branch}/install.sh`;
  for (const [name, wanted] of [["README.md", [download, pipe]], ["docs/install.md", [download, pipe]], ["install.sh", [pipe]]] as const) {
    const text = read(name);
    for (const link of wanted) assert.ok(text.includes(link), `${name} links ${link}`);
    const links = [...text.matchAll(/https:\/\/(?:raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+|github\.com\/[^/\s]+\/[^/\s]+\/(?:blob|raw))\/[^\s)`]+?\/install\.(?:sh|bat)/g)];
    assert.deepEqual(links.map((m) => m[0]).filter((l) => l !== download && l !== pipe), [], `${name}: every link to an installer is one of those two`);
  }
});

/*
 * stop.bat stops the stack from its own folder, as start.bat starts it: run as administrator,
 * Windows starts a .bat in C:\Windows\System32, where there is no infra\.env, so the stop failed -
 * and it said "Done." either way, so the panel looked stopped when it was still running.
 */
test("stop.bat works from its own folder and says Done only when the stack stopped", () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "stop.bat"), "utf8");
  const cd = bat.search(/^cd \/d "%~dp0"\r?$/m);
  const down = bat.search(/^docker compose .* down\r?$/m);
  assert.ok(cd > 0 && down > cd, "it changes to its own folder before stopping the stack");
  assert.match(bat, / down\r?\nif errorlevel 1 \(\r?\n {2}echo \[X\] /, "a failed stop says so");
  assert.doesNotMatch(bat, /^echo Done\.\r?$/m, "Done. is said only when the stop worked, not after it whatever happened");
});

/*
 * A port already taken. Docker refuses to start the panel on a port something else holds, with an
 * error about the port; both start scripts ask first, offering the next free port or one typed in,
 * and save it as API_PORT in infra/.env. The panel's own container holding the port is not a clash:
 * an update restarts the panel on the same port.
 */
test("both start scripts check the port before starting the stack, and offer the next free one or one typed in", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const bat = readFileSync(join(root, "start.bat"), "utf8");
  const sh = readFileSync(join(root, "start.sh"), "utf8");
  for (const [name, script] of [["start.bat", bat], ["start.sh", sh]] as const) {
    const own = script.indexOf("port api 8080");
    const up = script.search(/docker compose .* up -d --build/);
    assert.ok(own > 0 && own < up, `${name} asks whether the panel itself holds the port, before starting the stack`);
  }
  assert.match(bat, /^powershell -NoProfile -Command "\$own = docker compose [^"]* port api 8080;[^"]*" >nul 2>nul\r?\nif not errorlevel 1 goto port_free/m, "the panel's own container holding the port is not a clash");
  // findstr's `$` matches only before a carriage return, and Docker ends its lines with a bare line
  // feed: a findstr test ending in `$` never matches what Docker prints.
  for (const line of bat.split(/\r?\n/).filter((l) => /^\s*docker .*\|\s*findstr/i.test(l))) {
    assert.doesNotMatch(line, /findstr[^|]*\$"/, `a findstr $ over Docker's output never matches: ${line}`);
  }
  assert.match(bat, /\[1\] Find the next free port for me/);
  assert.match(bat, /\[2\] Let me type a port/);
  assert.match(bat, /^choice \/c 123 /m);
  assert.match(sh, /if ! grep -qE ":\$\{API_PORT\}\\\$" <<< "\$own_port" && port_busy "\$API_PORT"; then/);
  assert.match(sh, /1\) Find the next free port for me/);
  assert.match(sh, /2\) Let me type a port/);
  assert.match(sh, /exec 4<>\/dev\/tty/, "start.sh asks on the terminal, even when its input is a pipe");
  assert.match(sh, /No terminal to ask on, so the next free port is used/);
});

/** Two ports in use side by side, and one free after them, high enough to be nobody's. */
async function twoPortsInUse(): Promise<{ base: number; close: () => void }> {
  const listenAt = (port: number) => new Promise<Server>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "0.0.0.0", () => resolve(s));
  });
  for (let tries = 0; tries < 50; tries++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    const held: Server[] = [];
    try {
      held.push(await listenAt(base), await listenAt(base + 1));
      const free = await listenAt(base + 2);
      await new Promise((r) => free.close(r));
      return { base, close: () => held.forEach((s) => s.close()) };
    } catch {
      held.forEach((s) => s.close());
    }
  }
  throw new Error("no three adjacent free ports found");
}

test("start.sh's port helpers: a port in use is busy, the next free one skips the taken ones, and API_PORT is saved in place", async () => {
  const sh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.sh"), "utf8");
  const helpers = sh.slice(sh.indexOf("port_busy() {"), sh.indexOf("own_port="));
  assert.ok(helpers.includes("save_api_port() {"), "the port helpers moved: retarget this test");
  const dir = mkdtempSync(join(tmpdir(), "start-sh-port-"));
  writeFileSync(join(dir, "helpers.sh"), helpers);
  const bash = (cmd: string) => spawnSync("bash", ["-c", `set -euo pipefail; . ./helpers.sh; ${cmd}`], { cwd: dir, encoding: "utf8" });
  const { base, close } = await twoPortsInUse();
  try {
    assert.equal(bash(`if port_busy ${base}; then echo busy; else echo free; fi`).stdout.trim(), "busy");
    assert.equal(bash(`if port_busy ${base + 2}; then echo busy; else echo free; fi`).stdout.trim(), "free");
    assert.equal(bash(`next_free_port ${base}`).stdout.trim(), String(base + 2), "the next free port, past the other one in use");
  } finally {
    close();
  }
  // A Windows-edited file: CRLF, a name with an accent, the line to change in the middle.
  const env = join(dir, "infra", ".env");
  spawnSync("mkdir", ["-p", join(dir, "infra")]);
  writeFileSync(env, "# Settings\r\nAPI_PORT=8080\r\nPUBLIC_STATS_NAME=Lynx División\r\n");
  chmodSync(env, 0o644);
  assert.equal(bash("save_api_port 8095").status, 0);
  assert.equal(readFileSync(env, "utf8"), "# Settings\r\nAPI_PORT=8095\nPUBLIC_STATS_NAME=Lynx División\r\n", "only the port line changes");
  assert.equal(statSync(env).mode & 0o777, 0o644, "the file keeps its own mode");
  writeFileSync(env, "POSTGRES_PASSWORD=app\nX=1");
  bash("save_api_port 8095");
  assert.equal(readFileSync(env, "utf8"), "POSTGRES_PASSWORD=app\nX=1\nAPI_PORT=8095\n", "a missing line is added on a line of its own");
});

// start.bat's port checks are PowerShell; where pwsh is installed they are run here as written.
const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
test("start.bat's PowerShell: a port in use is busy, the next free one skips the taken ones, and API_PORT is saved in place", { skip: hasPwsh ? false : "no pwsh here" }, async () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const free = /^set "PS_FREE=(.*)"\r?$/m.exec(bat)?.[1];
  const busy = /^powershell -NoProfile -Command "(%PS_FREE%; if \(Free %1\)[^"]*)"/m.exec(bat)?.[1];
  const next = /'powershell -NoProfile -Command "(%PS_FREE%; \$p = %API_PORT% \+ 1;[^"]*)"/.exec(bat)?.[1];
  const save = /^powershell -NoProfile -Command "(\$f = 'infra\\\.env';[^"]*)"\r?$/m.exec(bat)?.[1];
  assert.ok(free && busy && next && save, "start.bat's PowerShell moved: retarget this test");
  const dir = mkdtempSync(join(tmpdir(), "start-bat-port-"));
  const pwsh = (cmd: string) => spawnSync("pwsh", ["-NoProfile", "-Command", cmd.replaceAll("%PS_FREE%", free!)], { cwd: dir, encoding: "utf8" });
  const { base, close } = await twoPortsInUse();
  try {
    assert.equal(pwsh(busy!.replaceAll("%1", String(base))).status, 0, "in use");
    assert.equal(pwsh(busy!.replaceAll("%1", String(base + 2))).status, 1, "free");
    assert.equal(pwsh(next!.replaceAll("%API_PORT%", String(base))).stdout.trim(), String(base + 2));
  } finally {
    close();
  }
  // Windows reads infra\.env with backslashes; this runs where the separator is a slash.
  const saveHere = save!.replaceAll("%NEW_PORT%", "8095").replaceAll("infra\\.env", "infra/.env");
  const env = join(dir, "infra", ".env");
  spawnSync("mkdir", ["-p", join(dir, "infra")]);
  writeFileSync(env, "﻿# Settings\r\nAPI_PORT=8080\r\nPUBLIC_STATS_NAME=Lynx División\r\nAPI_PORT=9000\r\n");
  assert.equal(pwsh(saveHere).status, 0);
  const saved = readFileSync(env);
  assert.notDeepEqual([...saved.subarray(0, 3)], [0xef, 0xbb, 0xbf], "no byte-order mark: Docker would read it as part of the first line");
  assert.deepEqual(saved.toString("utf8").split(/\r?\n/), ["# Settings", "API_PORT=8095", "PUBLIC_STATS_NAME=Lynx División", "API_PORT=8095", ""], "every port line changes and nothing else");
  writeFileSync(env, "POSTGRES_PASSWORD=app\nX=1");
  pwsh(saveHere);
  assert.deepEqual(readFileSync(env, "utf8").split(/\r?\n/), ["POSTGRES_PASSWORD=app", "X=1", "API_PORT=8095", ""], "a missing line is added");
});

/*
 * After a Windows restart the panel comes back by itself only when Docker Desktop starts at sign-in
 * (off by default) and Windows signs in by itself. start.bat recommends whichever is missing, and
 * only those: Docker's choice counts as off when its settings file says so, or when start.bat just
 * had to start Docker itself; Windows' is AutoAdminLogon.
 */
test("start.bat recommends what a restart needs, and only what is missing", () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  assert.match(bat, /set "STARTED_DOCKER=1"\r?\nstart "" "%DOCKER_DESKTOP%"/, "it remembers starting Docker Desktop itself");
  assert.match(bat, /^if "%DOCKER_AUTOSTART%"=="off" set "RESTART_DOCKER=1"\r?$/m);
  assert.match(bat, /^if "%DOCKER_AUTOSTART%"=="unknown" if defined STARTED_DOCKER set "RESTART_DOCKER=1"\r?$/m);
  assert.match(bat, /reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" \/v AutoAdminLogon/);
  assert.match(bat, /^if not "%AUTOLOGON%"=="1" set "RESTART_LOGON=1"\r?$/m);
  assert.match(bat, /^if not defined RESTART_DOCKER if not defined RESTART_LOGON goto restart_done\r?$/m);
  // The advice block: its heading, then each piece of advice under the check it belongs to.
  const block = bat.slice(bat.indexOf("goto restart_done"), bat.indexOf(":restart_done")).split(/\r?\n/).slice(1).filter((l) => l.trim());
  const heading = block.filter((l) => /^echo(\.| {3}Restarts:| {3}once Docker Desktop is running again)/.test(l));
  const advice = block.filter((l) => !heading.includes(l));
  assert.equal(heading.length, 3, "the advice block's heading moved: retarget this test");
  assert.ok(advice.length >= 5 && advice.every((l) => /^if defined RESTART_(DOCKER|LOGON) echo /.test(l)), "each piece of advice only when it is missing");
  assert.ok(advice.filter((l) => /Docker Desktop/.test(l)).every((l) => l.startsWith("if defined RESTART_DOCKER echo")), "Docker's advice when Docker's start is missing");
  assert.ok(advice.filter((l) => /Autologon|signs in by itself|somewhere safe/i.test(l)).every((l) => l.startsWith("if defined RESTART_LOGON echo")), "the sign-in advice when the sign-in is missing");
});

test("start.bat's PowerShell reads Docker's start-at-sign-in as off only when its settings say so", { skip: hasPwsh ? false : "no pwsh here" }, () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const cmd = /for \/f %%s in \('powershell -NoProfile -Command "([^"]*)" 2\^>nul'\) do set "DOCKER_AUTOSTART=%%s"/.exec(bat)?.[1];
  assert.ok(cmd, "start.bat's Docker check moved: retarget this test");
  // Windows joins the path with a backslash; this runs where the separator is a slash.
  const here = cmd!.replaceAll("Docker\\settings", "Docker/settings");
  const read = (files: Record<string, string>) => {
    const appdata = mkdtempSync(join(tmpdir(), "start-bat-appdata-"));
    if (Object.keys(files).length) spawnSync("mkdir", ["-p", join(appdata, "Docker")]);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(appdata, "Docker", name), body);
    return spawnSync("pwsh", ["-NoProfile", "-Command", here], { encoding: "utf8", env: { ...process.env, APPDATA: appdata } }).stdout.trim();
  };
  assert.equal(read({}), "unknown", "no settings file");
  assert.equal(read({ "settings-store.json": '{"AutoStart": true}' }), "on");
  assert.equal(read({ "settings-store.json": '{"AutoStart": false}' }), "off");
  assert.equal(read({ "settings.json": '{"autoStart": false, "analyticsEnabled": true}' }), "off", "an older Docker Desktop's file");
  assert.equal(read({ "settings-store.json": '{"DisplayedOnboarding": true}' }), "unknown", "a file without the key says nothing");
  assert.equal(read({ "settings-store.json": "{not json" }), "unknown");
  assert.equal(read({ "settings-store.json": '{"AutoStart": true}', "settings.json": '{"autoStart": false}' }), "on", "the current file before the old one");
});

/*
 * Where the code came from, for the panel's "update available" check (apps/api/src/updates.ts): the
 * start scripts pass the branch the clone follows and the GitHub repository as owner/name only. A
 * clone's address can carry a sign-in, and the image must never hold one.
 */
const ORIGINS: [string, string][] = [
  ["https://github.com/JDK5294/hellrcon.git", "JDK5294/hellrcon"],
  ["https://someone:ghp_secret@github.com/JDK5294/hellrcon.git", "JDK5294/hellrcon"],
  ["git@github.com:JDK5294/hellrcon.git", "JDK5294/hellrcon"],
  ["https://github.com/JDK5294/hellrcon/", "JDK5294/hellrcon"],
  ["https://github.com/someone/panel1.1.git", "someone/panel1.1"],
  ["https://gitlab.com/someone/panel.git", ""],
  ["", ""],
];

test("the image is told its branch and GitHub repository, after the build, and never the clone's address", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const compose = readFileSync(join(root, "infra", "docker-compose.yml"), "utf8");
  assert.equal(compose.match(/^ {8}GIT_BRANCH: \$\{GIT_BRANCH:-\}$/gm)?.length, 3, "every app image is built with the same arguments");
  assert.equal(compose.match(/^ {8}GIT_REPO: \$\{GIT_REPO:-\}$/gm)?.length, 3);
  const dockerfile = readFileSync(join(root, "apps", "api", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^ENV APP_BRANCH=\$GIT_BRANCH APP_REPO=\$GIT_REPO$/m);
  assert.ok(dockerfile.indexOf("ARG GIT_BRANCH=") > dockerfile.indexOf("RUN pnpm build"), "after the build: following another branch costs no rebuild");

  const sh = readFileSync(join(root, "start.sh"), "utf8");
  assert.match(sh, /GIT_BRANCH="\$\(git rev-parse --abbrev-ref HEAD 2>\/dev\/null \|\| true\)"/);
  const parse = sh.slice(sh.indexOf('    GIT_REPO=""\n'), sh.indexOf("    export GIT_BRANCH GIT_REPO"));
  assert.ok(parse.includes('case "$origin" in'), "start.sh's parsing moved: retarget this test");
  for (const [origin, repo] of ORIGINS) {
    const out = spawnSync("bash", ["-c", `set -euo pipefail; origin='${origin}'\n${parse}printf '%s' "$GIT_REPO"`], { encoding: "utf8" });
    assert.equal(out.stdout, repo, origin || "(no origin)");
  }
  const bat = readFileSync(join(root, "start.bat"), "utf8");
  assert.match(bat, /^for \/f %%b in \('git rev-parse --abbrev-ref HEAD 2\^>nul'\) do set "GIT_BRANCH=%%b"\r?$/m);
  assert.match(bat, /^if "%GIT_BRANCH%"=="HEAD" set "GIT_BRANCH="\r?$/m, "a detached checkout follows no branch");
});

test("start.bat's PowerShell keeps owner/name from the clone's address and nothing else", { skip: hasPwsh ? false : "no pwsh here" }, () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const cmd = /for \/f %%r in \('powershell -NoProfile -Command "([^"]*)" 2\^>nul'\) do set "GIT_REPO=%%r"/.exec(bat)?.[1];
  assert.ok(cmd?.includes("$env:GIT_ORIGIN"), "start.bat's parsing moved: retarget this test");
  assert.match(bat, /set "GIT_REPO=%%r"\r?\nset "GIT_ORIGIN="\r?\n/, "the address is cleared once read, so nothing after start.bat's parse sees it");
  for (const [origin, repo] of ORIGINS) {
    const out = spawnSync("pwsh", ["-NoProfile", "-Command", cmd!], { encoding: "utf8", env: { ...process.env, GIT_ORIGIN: origin } });
    assert.equal(out.stdout.trim(), repo, origin || "(no origin)");
  }
});

/*
 * cmd and PowerShell both give | > < & ^ a meaning, and cmd's own rules for them inside a quoted
 * `for /f` command are a trap: the key and the database password were made with `$b^|%%{…}`, and
 * a caret that reaches PowerShell is a parse error, so a new install got neither, silently. No
 * PowerShell in start.bat uses those characters, so it runs the same whichever way cmd reads them.
 */
test("start.bat's PowerShell commands hold none of the characters cmd treats specially", () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const commands = [...bat.matchAll(/powershell -NoProfile -Command "([^"]*)"/g)].map((m) => m[1]!);
  commands.push(/^set "PS_FREE=(.*)"\r?$/m.exec(bat)?.[1] ?? "");
  assert.ok(commands.length >= 7, "start.bat's PowerShell moved: retarget this test");
  for (const c of commands) assert.doesNotMatch(c, /[|<>&^]/, c.slice(0, 80));
});

test("start.bat makes a 64-character encryption key and a 48-character database password", { skip: hasPwsh ? false : "no pwsh here" }, () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  for (const [name, length] of [["ENCRYPTION_KEY", 64], ["POSTGRES_PASSWORD", 48]] as const) {
    const cmd = new RegExp(`for /f %%k in \\('powershell -NoProfile -Command "([^"]*)"'\\) do >> "infra\\\\\\.env" echo ${name}=%%k`).exec(bat)?.[1];
    assert.ok(cmd, `start.bat's ${name} line moved: retarget this test`);
    const made = spawnSync("pwsh", ["-NoProfile", "-Command", cmd!.replaceAll("%%", "%")], { encoding: "utf8" }).stdout.trim();
    assert.match(made, new RegExp(`^[0-9a-f]{${length}}$`), name);
  }
});

/*
 * Finding out whether a port is free must not listen on it: on Windows the first program to listen
 * makes Windows Defender Firewall ask about it, in the middle of the start. start.bat reads the
 * listeners and the ranges Windows reserves for itself instead. And what someone types is checked
 * where cmd never reads it: a stray & | < > on a command line is a syntax error, and cmd ends the
 * whole script on one.
 */
test("start.bat finds a port's use without listening on it, and checks a typed port where cmd cannot trip on it", () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const free = /^set "PS_FREE=(.*)"\r?$/m.exec(bat)?.[1] ?? "";
  assert.doesNotMatch(free, /Sockets\.TcpListener\]|Sockets\.Socket\]::new|\.Start\(\)/, "nothing is listened on");
  assert.match(free, /GetActiveTcpListeners\(\)/);
  assert.match(free, /netsh interface \$fam show excludedportrange protocol=tcp/, "the ranges Windows keeps for itself count as taken");
  assert.doesNotMatch(bat, /echo %NEW_PORT%/, "what was typed never goes on a command line unchecked");
  assert.match(bat, /^powershell -NoProfile -Command "if \(\$env:NEW_PORT -match /m);
});

test("start.bat's typed-port check takes a port from 1024 to 65535 and nothing else", { skip: hasPwsh ? false : "no pwsh here" }, () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const check = /^powershell -NoProfile -Command "(if \(\$env:NEW_PORT -match [^"]*)" >nul 2>nul\r?$/m.exec(bat)?.[1];
  assert.ok(check, "start.bat's typed-port check moved: retarget this test");
  const ok = (typed: string) => spawnSync("pwsh", ["-NoProfile", "-Command", check!], { env: { ...process.env, NEW_PORT: typed } }).status === 0;
  for (const good of ["1024", "8081", "65535"]) assert.ok(ok(good), good);
  for (const bad of ["", "80", "1023", "65536", "99999", "08081", "8081&calc", "8081 ", "8,081", "abc"]) assert.ok(!ok(bad), JSON.stringify(bad));
});

/*
 * start.sh on a Mac: bash 3.2, where "${a[@]}" of an empty array is an unbound variable under set -u
 * and stopped the start; and lsof in place of ss, which is read for the port (some lsofs answer 0 to
 * anything) with a connection tried as well (without root, lsof lists only this user's sockets).
 */
test("start.sh runs on a Mac's bash and lsof: no bare array expansion, and lsof read for the port", async () => {
  const sh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.sh"), "utf8");
  const code = sh.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const m of code.matchAll(/"\$\{(\w+)\[@\]\}"/g)) {
    assert.equal(code.slice(m.index! - `\${${m[1]}[@]+`.length, m.index!), `\${${m[1]}[@]+`, `"\${${m[1]}[@]}" must sit inside \${${m[1]}[@]+…}: bash 3.2 calls an empty array unbound`);
  }
  const helpers = sh.slice(sh.indexOf("port_busy() {"), sh.indexOf("own_port="));
  const dir = mkdtempSync(join(tmpdir(), "start-sh-mac-"));
  writeFileSync(join(dir, "helpers.sh"), helpers);
  spawnSync("mkdir", ["-p", join(dir, "bin")]);
  for (const tool of ["bash", "cat"]) spawnSync("ln", ["-s", spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), join(dir, "bin", tool)]);
  const lsof = (body: string) => { writeFileSync(join(dir, "bin", "lsof"), `#!${join(dir, "bin", "bash")}\n${body}\n`); chmodSync(join(dir, "bin", "lsof"), 0o755); };
  const busy = (port: number) => spawnSync(join(dir, "bin", "bash"), ["-c", `set -euo pipefail; . ./helpers.sh; if port_busy ${port}; then echo busy; else echo free; fi`], { cwd: dir, encoding: "utf8", env: { PATH: join(dir, "bin") } }).stdout.trim();
  const { base, close } = await twoPortsInUse();
  try {
    lsof("echo '1 /bin/sh /dev/null'; exit 0");
    assert.equal(busy(base + 2), "free", "an lsof that answers 0 to anything does not make a free port busy");
    lsof(`echo "com.docke 1 me 50u IPv6 0x1 0t0 TCP *:${base + 2} (LISTEN)"`);
    assert.equal(busy(base + 2), "busy", "a port lsof lists as listening");
    lsof("exit 1");
    assert.equal(busy(base), "busy", "a listener lsof cannot see (another user's) is found by connecting");
  } finally {
    close();
  }
});

test("start.bat's port check counts a range Windows reserved for itself as taken", { skip: hasPwsh ? false : "no pwsh here" }, () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const free = /^set "PS_FREE=(.*)"\r?$/m.exec(bat)?.[1];
  assert.ok(free, "start.bat's port check moved: retarget this test");
  // netsh as Windows prints it, standing in for the real one.
  const dir = mkdtempSync(join(tmpdir(), "start-bat-netsh-"));
  writeFileSync(join(dir, "netsh"), "#!/bin/sh\nprintf 'Protocol tcp Port Exclusion Ranges\\n\\nStart Port    End Port\\n----------    --------\\n      8000        8099\\n     50000       50059     *\\n'\n");
  chmodSync(join(dir, "netsh"), 0o755);
  const ask = (port: number) => spawnSync("pwsh", ["-NoProfile", "-Command", `${free}; if (Free ${port}) { 'free' } else { 'taken' }`], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).stdout.trim();
  assert.equal(ask(8080), "taken", "inside a reserved range");
  assert.equal(ask(50059), "taken", "the range's last port");
  assert.equal(ask(8100), "free", "just past it");
});

/*
 * Whether the panel itself holds the port is Docker's answer to `compose port`, which ends its line
 * with a bare line feed. start.bat tested that answer with findstr ":8080$", and findstr's `$`
 * matches only before a carriage return: it never matched, so every update with the panel running
 * said another program had port 8080 and stopped to ask for a new one. The check as written, against
 * a docker that answers the way Docker does.
 */
test("start.bat knows the panel's own container on its port from Docker's answer", { skip: hasPwsh ? false : "no pwsh here" }, () => {
  const bat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "start.bat"), "utf8");
  const own = /^powershell -NoProfile -Command "(\$own = docker compose [^"]*)" >nul 2>nul\r?\nif not errorlevel 1 goto port_free/m.exec(bat)?.[1];
  assert.ok(own, "start.bat's own-container check moved: retarget this test");
  const dir = mkdtempSync(join(tmpdir(), "start-bat-docker-"));
  const answers = (printed: string, status = 0) => {
    writeFileSync(join(dir, "docker"), `#!/bin/sh\nprintf '${printed}'\nexit ${status}\n`);
    chmodSync(join(dir, "docker"), 0o755);
  };
  const ownsIt = (port: string) => spawnSync("pwsh", ["-NoProfile", "-Command", own!], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, API_PORT: port } }).status === 0;
  answers("0.0.0.0:8080\\n");
  assert.equal(ownsIt("8080"), true, "the panel is on 8080: the port is its own");
  assert.equal(ownsIt("8081"), false, "the panel is on 8080, so 8081 is not its port");
  assert.equal(ownsIt("808"), false, "808 is not 8080");
  answers("0.0.0.0:8080\\n[::]:8080\\n");
  assert.equal(ownsIt("8080"), true, "answered for both address families");
  answers("", 1);
  assert.equal(ownsIt("8080"), false, "no panel running: Docker answers nothing, and the port is not its own");
});

/*
 * Installed plugins. The folder is the operator's: mounted read-only into the api (the one service
 * that loads plugins), kept out of the panel's own repository and out of every image, and never a
 * setting to type — a plugin goes in the folder. What is in it, at which commit, rides into the api
 * as PLUGINS_STATE, so a change recreates the container that reads plugins only when it starts.
 */
test("installed plugins: mounted read-only into the api alone, outside git and the image, and a change recreates the api", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const api = services().get("api")!;
  assert.match(api, /^ {6}- \.\.\/installed-plugins:\/data\/plugins:ro$/m);
  assert.match(api, /^ {6}PLUGINS_DIR: \/data\/plugins$/m);
  assert.match(api, /^ {6}PLUGINS_STATE: \$\{PLUGINS_STATE:-\}$/m);
  for (const [name, body] of services()) if (name !== "api") assert.ok(!body.includes("installed-plugins"), `${name} does not load plugins`);
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^installed-plugins\/\*$/m, "a plugin's clone is not part of the panel's repository");
  assert.match(gitignore, /^!installed-plugins\/README\.md$/m, "…but the folder, and what it is for, comes with the panel");
  assert.match(readFileSync(join(root, "installed-plugins", "README.md"), "utf8"), /git clone <the plugin's address> installed-plugins\/<a name for it>/);
  assert.match(readFileSync(join(root, ".dockerignore"), "utf8"), /^installed-plugins$/m, "never built into an image");
  assert.doesNotMatch(readFileSync(join(root, "infra", ".env.example"), "utf8"), /^#?\s*PLUGINS_DIR=/m, "not a setting anyone has to make");
});

const hasGit = spawnSync("git", ["--version"]).status === 0;
test("start.sh pulls each plugin that is a git clone, carries on past one that cannot be, and says what it found", { skip: hasGit ? false : "no git here" }, () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const src = readFileSync(join(root, "start.sh"), "utf8");
  const from = src.indexOf("# Plugins (installed-plugins/README.md)");
  const to = src.indexOf("export PLUGINS_STATE", from);
  assert.ok(from > 0 && to > from, "start.sh has its plugins step");
  assert.ok(to < src.search(/docker compose .* up -d --build/), "…before it starts the stack");
  const step = src.slice(from, to) + "export PLUGINS_STATE\n";

  const dir = mkdtempSync(join(tmpdir(), "plugins-"));
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  // Two upstream plugins, each one commit ahead of the copy installed from it.
  for (const name of ["alpha", "gamma"]) {
    git(dir, "init", "-q", "--bare", `${name}.git`);
    git(dir, "clone", "-q", `${name}.git`, `${name}-dev`);
    writeFileSync(join(dir, `${name}-dev`, "index.js"), "export default 1;\n");
    git(join(dir, `${name}-dev`), "add", "-A");
    git(join(dir, `${name}-dev`), "commit", "-q", "-m", "first");
    git(join(dir, `${name}-dev`), "push", "-q", "origin", "HEAD:main");
    git(dir, "clone", "-q", `${name}.git`, join("installed-plugins", name));
    writeFileSync(join(dir, `${name}-dev`, "index.js"), "export default 2;\n");
    git(join(dir, `${name}-dev`), "commit", "-q", "-am", "second");
    git(join(dir, `${name}-dev`), "push", "-q", "origin", "HEAD:main");
  }
  // gamma has a commit of its own here, so it cannot fast-forward.
  writeFileSync(join(dir, "installed-plugins", "gamma", "index.js"), "export default 3;\n");
  git(join(dir, "installed-plugins", "gamma"), "commit", "-q", "-am", "local");
  const gammaHere = git(join(dir, "installed-plugins", "gamma"), "rev-parse", "--short", "HEAD");
  // beta was dropped in by hand; the README is a file, not a plugin.
  spawnSync("mkdir", ["-p", join(dir, "installed-plugins", "beta")]);
  writeFileSync(join(dir, "installed-plugins", "beta", "index.js"), "export default 4;\n");
  writeFileSync(join(dir, "installed-plugins", "README.md"), "# Installed plugins\n");

  const run = spawnSync("bash", ["-c", `set -euo pipefail\n${step}printf 'STATE=%s\\n' "$PLUGINS_STATE"`], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const alphaUp = git(join(dir, "alpha-dev"), "rev-parse", "--short", "HEAD");
  assert.equal(git(join(dir, "installed-plugins", "alpha"), "rev-parse", "--short", "HEAD"), alphaUp, "alpha took the new commit");
  assert.match(run.stdout, /\[OK\] Plugin alpha is up to date\./);
  assert.match(run.stdout, /\[!\] Plugin gamma could not be updated - it starts as it was\./);
  assert.match(run.stdout, new RegExp(`^STATE=alpha@${alphaUp};beta;gamma@${gammaHere};$`, "m"), "every plugin, a clone by its commit");

  // No folder at all: nothing found, and nothing stops.
  const bare = mkdtempSync(join(tmpdir(), "no-plugins-"));
  const none = spawnSync("bash", ["-c", `set -euo pipefail\n${step}printf 'STATE=%s\\n' "$PLUGINS_STATE"`], { cwd: bare, encoding: "utf8" });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /^STATE=$/m);
});

test("start.bat pulls each plugin that is a git clone and says what it found, before it starts the stack", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const bat = readFileSync(join(root, "start.bat"), "utf8").replace(/\r\n/g, "\n");
  const step = bat.indexOf("REM 4c) Plugins");
  assert.ok(step > 0 && step < bat.search(/docker compose .* up -d --build/), "the plugins step comes before the stack starts");
  assert.match(bat, /^set "PLUGINS_STATE="\nfor \/d %%d in \("installed-plugins\\\*"\) do call :plugin_update "%%~fd" "%%~nxd"$/m);
  // The subroutine sits past the script's own end, so it only ever runs when called.
  const end = bat.search(/^endlocal\nexit \/b$/m);
  const sub = bat.indexOf(":plugin_update\n");
  assert.ok(end > 0 && sub > end, "the subroutine is after the script's exit");
  const body = bat.slice(sub, bat.indexOf("exit /b 0", sub));
  assert.match(body, /^if not exist "%~1\\\.git" goto plugin_state$/m, "a folder that is not a clone is only counted");
  assert.match(body, /^git -C "%~1" pull --ff-only\nif errorlevel 1 goto plugin_stuck$/m);
  assert.match(body, /^echo \[!\] Plugin %~2 could not be updated - it starts as it was\.$/m);
  assert.match(body, /^for \/f %%h in \('git -C "%~1" rev-parse --short HEAD 2\^>nul'\) do set "PLUGIN_AT=@%%h"$/m);
  assert.match(body, /^set "PLUGINS_STATE=%PLUGINS_STATE%%~2%PLUGIN_AT%;"$/m, "the same name@commit; record start.sh keeps");
  assert.doesNotMatch(body, /\($|\) else \(/m, "no parenthesised block that a folder name in an echo could close");
});

/*
 * Every test command runs Node with --experimental-strip-types, which came in Node 22.6. CI, the
 * version file, the engines field and the image all have to be on it, or a fresh clone's CI fails
 * on its first run while every run here passes.
 */
test("CI, .nvmrc, the engines field and the image all run a Node the tests can run on", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8");
  const major = (v: string) => Number(/^(\d+)/.exec(v)?.[1]);
  const ci = [...read(".github", "workflows", "ci.yml").matchAll(/^ +node-version: (\S+)$/gm)].map((m) => m[1]!);
  assert.ok(ci.length >= 3, `every CI job sets up Node (${ci.length})`);
  for (const v of ci) assert.ok(major(v) >= 22, `a CI job on Node ${v}`);
  assert.ok(major(read(".nvmrc").trim()) >= 22, ".nvmrc");
  const [, maj, min] = /^>=(\d+)\.(\d+)/.exec(JSON.parse(read("package.json")).engines.node) ?? [];
  assert.ok(Number(maj) > 22 || (Number(maj) === 22 && Number(min) >= 6), "the engines field asks for 22.6 or later");
  assert.ok(major(/^FROM node:(\S+)/m.exec(read("apps", "api", "Dockerfile"))?.[1] ?? "") >= 22, "the image");
  assert.match(JSON.parse(read("apps", "api", "package.json")).scripts.test, /--experimental-strip-types/, "the reason, still true");
});
