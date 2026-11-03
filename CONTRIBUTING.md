# Contributing

Thanks for helping build a free, open RCON platform. A few ground rules keep the project
clean, consistent, and **free forever**.

## The project is, and stays, free

This project is licensed **AGPL-3.0-only** and is intended to remain free and open **permanently**.
Paid *hosting* of the software is fine; a closed or proprietary version is not. The AGPL and the
sign-off below exist to guarantee that.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA.
There is **no** copyright assignment and **no** grant of relicensing rights to anyone — your
contribution stays under AGPL-3.0, same as everyone else's. You simply certify that you wrote the
change (or have the right to submit it) and are contributing it under the project's license.

**How:** add a `Signed-off-by` line to every commit (this is what `git commit -s` does):

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off you agree to the DCO (full text at <https://developercertificate.org/>).

## Source checks (please read)

Name things for what they do: no other product's brand names in code, UI, comments, commit
messages or docs. CI runs `pnpm check:naming`, which fails the build on a problem it finds: it
checks that code or data taken from another project is credited in `NOTICE.md`, and it rejects
**raw control characters in source**. Write the escape (a NUL separator in a composite key is the
six-character escape, not a literal byte): both compile to the same byte, but a literal one makes
the whole file read as binary to `grep`, `sed` and `diff`, so it quietly disappears from
repo-wide searches.

## Development

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test
pnpm check:naming
```

See [`docs/architecture.md`](docs/architecture.md) for how the pieces fit together.

## Pull requests

- Keep changes focused; describe the what and why.
- Match the surrounding code style.
- Make sure CI is green (build, tests, and the source checks).
- A new feature gets an entry in What's new (`apps/panel/lib/whatsNew.ts`): what people can do now
  and where, in words someone opening the panel for the first time understands. Bug and stability
  fixes don't get one. Each update with a feature adds a new release at the top, numbered one more
  than the build before it — the number is
  how the panel knows what a person has not seen yet, so a second update on the same day still
  shows. The panel shows it once after the update, and its test holds the wording to that.
- Help's walkthroughs (`apps/panel/lib/walkthroughs.ts`) show each step on a picture of the panel,
  one taken on a computer's screen and one on a phone's (a step that differs on a phone says how in
  its `phone` field). When a change moves or renames something a walkthrough points at, the
  browser tests say which step. Every permission has one, so a new permission needs its walkthrough
  too; so does every screen, for each permission that opens it, so a new screen needs a step in one.
  A new button needs a step that points at it, unless it is one of the kinds the browser test
  "every action on every screen" lists as explained once for every screen.
  After adding a walkthrough, build the panel and run
  `node --experimental-strip-types scripts/walkthrough-shots.mjs` in `apps/panel` for its pictures;
  after changing a screen a walkthrough shows, run it with `--all` to take them all again. Commit
  the pictures it writes.
- Every commit needs a `Signed-off-by` line (see DCO above).
