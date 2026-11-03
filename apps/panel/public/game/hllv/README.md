# Hell Let Loose: Vietnam artwork

Faction emblems and role icons for HLL: Vietnam, bundled here for this community admin tool the
same way the open-source CRCON project (github.com/MarechJ/hll_rcon_tool) bundles them — these
files are copied from its `assets/hllv/images/icons/` at tag **v12.1.1**. They are game assets
(© Team17 / Black Matter), not covered by this repository's license, exactly as the WW2 set next
door is not.

Layout: `teams/<faction>[_colored|_dark].webp` · `roles/<role>.png` (+`_black` variants)

Deliberately NOT here yet: map images and tactical maps. `gameAssets.ts` keys its lookups by game
id and never falls back between games, so the map resolvers answer "no art" for Vietnam and the
callers render their plain-text look — which is why adding only part of the set is safe.
