# Installing the panel

Two ways to run it. Pick the one that matches the machine you have:

| | A Windows PC (home) | A Linux VM (cloud) |
|---|---|---|
| Install | double-click `install.bat` | one command: `install.sh` |
| Runs when | the PC is on | always |
| Online from anywhere | Cloudflare Tunnel | Cloudflare Tunnel, or your own domain |
| Costs | nothing extra | the VM's monthly price |

Both end the same way: the panel opens its **setup page**, which asks only for what it needs to
run. Everything else, including Discord, the public stats site and putting the panel online, is set
later inside the panel.

## On a Windows PC

1. Download [`install.bat`](https://github.com/JDK5294/hellrcon/blob/main/install.bat) (the page's download
   button, "Download raw file") and double-click it.
2. It checks for the two programs the panel needs and offers to install any that are missing:
   - **Git** fetches the code and, later, its updates.
   - **Docker Desktop** runs the panel.

   For each missing one you choose **[1]** install it now (with winget, Windows' own installer),
   **[2]** open its download page, or **[3]** stop. These are the programs recommended for Windows;
   others work too (GitHub Desktop instead of Git, Rancher Desktop instead of Docker Desktop) if
   you already use them.
3. After installing Docker Desktop, Windows may ask you to restart. Restart, open Docker Desktop
   once to accept its terms, then run `install.bat` again.
4. It puts the code in `%USERPROFILE%\hellrcon` and runs `start.bat`, which starts everything (the
   first time takes several minutes) and opens the panel's setup page in your browser.

From then on, `start.bat` in that folder starts the panel and updates it. `stop.bat` stops it.

### Keep it online after a restart

After Windows restarts, for updates or after a power cut, the panel comes back by itself as soon as
Docker Desktop is running again. Two settings make that happen with nobody at the PC, and both are
recommended:

1. **Docker Desktop starts when you sign in.** In Docker Desktop: Settings → General → "Start
   Docker Desktop when you sign in to your computer". It is off when Docker Desktop is installed.
2. **Windows signs in by itself.** Microsoft's free
   [Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon) tool sets it up: run
   it, enter your Windows password and choose Enable. Only do this on a PC kept somewhere safe:
   whoever switches it on is signed in.

`start.bat` reminds you of either one it finds off. To have the PC switch itself back
on after a power cut too, look in its BIOS for a setting such as "Restore on AC power loss".

## On a Linux VM

An Ubuntu or Debian VM. For its size, see Hardware requirements in the README: one busy server is
comfortable on 2 vCPU and 4 GB of memory, and 2 GB is the least. Connect to it with SSH and run:

```sh
curl -fsSL https://raw.githubusercontent.com/JDK5294/hellrcon/main/install.sh | sudo bash
```

It installs Docker and git when they are missing, adds a swap file on a VM with under 3 GB of
memory and none (an update's build can run out of memory without one), puts the code in
`/opt/hellrcon`, turns on the HTTPS proxy for your own domain, opens the server's own firewall
(ufw) for the panel, starts everything and prints the address of the setup page, such as
`http://203.0.113.7:8080/#/setup?code=ABCD-EFGH`.

Your VM provider has a firewall of its own (a "security group" or "network rules"). Allow:

- **8080**, for the first setup,
- **80 and 443**, if you will use your own domain.

To update later: `cd /opt/hellrcon && sudo ./start.sh`. Running the installer again does the same.

The first setup is over plain HTTP, since the panel has no address of its own yet. To keep even
that off the open internet, connect with an SSH tunnel (`ssh -L 8080:localhost:8080 you@your-vm`)
and open the printed link with `localhost` in place of the server's address. Port 8080 then need
not be open in your provider's firewall at all.

## The setup page

The first time, the panel opens on its setup page with a one-time **setup code** filled in. The
code proves you are the person who installed it: until the owner account exists, nobody who finds
the page can take the panel over. If you open the page some other way, the code is in the window
that started the panel.

**Lost the code?** It stays the same until the owner account exists, through restarts and
updates, so nothing is lost for good:

- Run the start script again (`start.bat`, or `sudo ./start.sh` on a VM). It shows the code again
  and opens the setup page with it filled in; on a VM it prints that page's link instead.
- Or read it from the panel's log, the line starting "Setup code": on Windows in Docker Desktop
  under Containers → app → api-1, on a VM with
  `sudo docker compose -f infra/docker-compose.yml logs api | grep "Setup code"` in the panel's
  folder.

Five wrong codes within 15 minutes, whoever types them, lock the page for up to 15 minutes; the
refusal says how long is left. Restarting the panel ends that sooner: `stop.bat` then `start.bat`
on Windows, or `sudo docker compose -f infra/docker-compose.yml restart api` in the panel's folder
on a VM.

Then:

1. **The owner account.** It can do everything; add the rest of your staff later.
2. **Your community's time zone.** Schedules, the nightly backup and the daily claims run on it.
3. **Your game server.** Its address, RCON port and RCON password, from your host's control panel.
   Test connection tries them first. The server starts read-only (observe mode), so this is safe
   next to another tool such as CRCON.

Each step after the first can be skipped. The last page lists what you might do next, all
optional: put the panel online, turn on nightly backups, connect Discord, add more servers.

## Putting the panel online

Administration → **Online access**. There are two ways, side by side, each with its steps:

**Cloudflare Tunnel** — the way for a home PC, and fine on a VM.

- No ports to open, and your address stays hidden. Free, with HTTPS done for you, and it works
  behind any router.
- You need a free Cloudflare account with your domain on it, and visits pass through Cloudflare.
- Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), paste its install
  command into the panel, and add a public hostname pointing at `http://localhost:8080`. The panel
  runs the tunnel itself; there is nothing to install for it.

**Your own domain** — for a VM.

- Nobody stands between your visitors and your server. Any domain works, with free certificates
  from Let's Encrypt.
- The server's address is public, and ports 80 and 443 must be open to it.
- Point an A record for the panel's address at the VM's IP address, enter the domain in the panel,
  and open `https://` and your domain. The first visit takes a few seconds while the certificate
  is issued.

Once the panel is online, you can close port 8080 in your VM provider's firewall: it was only
needed for the first setup.

## When something goes wrong

- **"Docker is not running".** Start Docker Desktop (Windows) or `sudo systemctl start docker`
  (Linux), then run the start script again.
- **The setup page asks for a code you do not have.** Run the start script again; see "Lost the
  code?" above.
- **The panel did not come up.** The start script says what it saw; for more,
  `docker compose -f infra/docker-compose.yml logs --tail=200`.
- **Something else uses port 8080.** The start script notices before it starts anything and asks:
  find the next free port, type one yourself, or stop. It saves the choice as `API_PORT` in
  `infra/.env`, so every later start uses it too, and opens the panel there, such as
  `http://localhost:8081`. A Cloudflare tunnel's public hostname stays `localhost:8080`: that is
  the panel's port inside Docker, whatever the port outside.

  To change the port yourself later, open `infra/.env` in the panel's folder (on Windows
  `%USERPROFILE%\hellrcon\infra\.env` with Notepad, on a VM `sudo nano /opt/hellrcon/infra/.env`),
  change `API_PORT`, save it and run the start script again. On Windows a port can be held back with
  nothing using it, since Windows reserves ranges of ports for its own networking; the start script
  skips those, and `netsh interface ipv4 show excludedportrange protocol=tcp` lists them.

## Plugins

A plugin adds to the panel: a screen, a Discord button, a tile. Plugins live in the
`installed-plugins` folder of the panel's folder, one folder each, and the panel loads them when it
starts. To add one that comes from a git repository, run this in the panel's folder (on a VM with
`sudo` in front), then run the start script:

```sh
git clone <the plugin's address> installed-plugins/<a name for it>
```

The start script updates every plugin there that is a git clone along with the panel, and restarts
the panel when one changes. To remove one, delete its folder and run the start script again. A
plugin runs inside the panel with full access to it, so only add plugins you trust. To make one of
your own, see [plugins.md](plugins.md).

## An install from before this setup

Nothing to do: run the start script as usual. Settings an older `infra/.env` held (Discord, the
stats site, the Cloudflare tunnel's token) are carried into the panel on the first start, and the
separate tunnel container is retired once the panel's own tunnel is connected.
