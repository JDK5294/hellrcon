# Installed plugins

Plugins this install runs live here, one folder each. The panel loads them when it starts: the api
container sees this folder as `/data/plugins`, read-only.

To add one that comes from a git repository, run this in the panel's folder (on a Windows PC,
`%USERPROFILE%\hellrcon`; on a VM, `/opt/hellrcon`, with `sudo` in front):

```sh
git clone <the plugin's address> installed-plugins/<a name for it>
```

Then run the start script (`start.bat`, or `sudo ./start.sh` on a VM). From then on it updates each
plugin here that is a git clone along with the panel, and restarts the panel when one changes.

A plugin is code that runs inside the panel with full access to it, so only add plugins you trust.
To remove one, delete its folder and run the start script again. To make one of your own, see
[docs/plugins.md](../docs/plugins.md).

Everything in this folder except this file stays out of the panel's own repository.
