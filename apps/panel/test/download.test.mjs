// Lists as files (lib/download.ts): what Excel, CSV and JSON each carry — game ids exact, times in
// the display zone or as instants, a player's name never run as a formula — and the workbook's own
// bytes, a zip of XML parts written without a library, read back here part by part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOWNLOAD_MAX, buildFile, fileStem, readAll, toCsv, toJson, toXlsx } from "../lib/download.ts";
import { unzipStored } from "./unzip.mjs";

// Four hours behind UTC, as New York is in October.
const clock = { zone: "America/New_York", wall: (iso) => new Date(Date.parse(iso) - 4 * 3_600_000).toISOString().slice(0, 16) };
const sheet = {
  name: "VIPs: Test [1]",
  columns: [
    { key: "player", label: "Player" },
    { key: "playerId", label: "Player ID" },
    { key: "kills", label: "Kills" },
    { key: "added", label: "Added", time: true },
    { key: "vip", label: "VIP" },
  ],
  rows: [
    ["-=KLM=- Gunplay", "76561198012345678", 12, "2026-10-23T15:45:30.000Z", true],
    ['=HYPERLINK("http://x","y")', "deadbeef00112233", -3, null, false],
    ["Zoë \u0001<&> \"q\", 2", "123", 0.5, "2026-01-02T08:04:00.000Z", undefined],
  ],
};

test("Excel: game ids are text, times real dates in the display zone, the heading bold and frozen", () => {
  const parts = unzipStored(toXlsx(sheet, clock));
  assert.deepEqual([...parts.keys()], ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
  const ws = parts.get("xl/worksheets/sheet1.xml");
  // Text, never a number Excel would round to 7.65612E+16.
  assert.match(ws, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">76561198012345678<\/t><\/is><\/c>/);
  assert.match(ws, /<c r="C2"><v>12<\/v><\/c>/, "a count is a number");
  assert.match(ws, /<c r="C3"><v>-3<\/v><\/c>/);
  // 11:45 New York time, as days since 1899-12-30, in the date style.
  const serial = Date.parse("2026-10-23T11:45:00Z") / 86_400_000 + 25_569;
  assert.match(ws, new RegExp(`<c r="D2" s="2"><v>${serial}</v></c>`));
  assert.doesNotMatch(ws, /r="D3"/, "no time, no cell — not 2000-01-01");
  assert.match(ws, /<c r="E2" t="inlineStr"><is><t xml:space="preserve">yes<\/t>/);
  assert.match(ws, /<c r="D1" t="inlineStr" s="1"><is><t xml:space="preserve">Added \(America\/New_York\)<\/t>/);
  assert.match(ws, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  // A formula-looking name is text in a workbook, so it is written as it is.
  assert.match(ws, /<t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/x&quot;,&quot;y&quot;\)<\/t>/);
  // What XML cannot carry is dropped, the rest escaped: one bad character must not cost the file.
  assert.match(ws, /<t xml:space="preserve">Zoë &lt;&amp;&gt; &quot;q&quot;, 2<\/t>/);
  assert.ok(parts.get("xl/workbook.xml").includes('<sheet name="VIPs  Test  1" sheetId="1" r:id="rId1"/>'), "no []: in a sheet's name");
  assert.match(parts.get("xl/styles.xml"), /<numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"\/>/);
});

test("Excel: columns past Z are AA, AB", () => {
  const columns = Array.from({ length: 28 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
  const ws = unzipStored(toXlsx({ name: "Wide", columns, rows: [columns.map((_, i) => i)] }, clock)).get("xl/worksheets/sheet1.xml");
  assert.match(ws, /<c r="Z2"><v>25<\/v><\/c><c r="AA2"><v>26<\/v><\/c><c r="AB2"><v>27<\/v><\/c>/);
});

test("CSV: wall-clock times, quoted where it must be, and a formula-looking name never run as one", async () => {
  const lines = toCsv(sheet, clock).split("\r\n");
  assert.equal(lines[0], "Player,Player ID,Kills,Added (America/New_York),VIP");
  assert.equal(lines[1], "'-=KLM=- Gunplay,76561198012345678,12,2026-10-23 11:45,yes");
  assert.equal(lines[2], `"'=HYPERLINK(""http://x"",""y"")",deadbeef00112233,-3,,no`, "a number keeps its minus sign");
  assert.equal(lines[3], `"Zoë \u0001<&> ""q"", 2",123,0.5,2026-01-02 04:04,`);
  assert.equal(lines[4], "", "every line ends in CRLF");
  // Excel reads the file as UTF-8 only with the byte-order mark in front.
  const bytes = new Uint8Array(await buildFile(sheet, "csv", clock).arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("JSON: one object per row under code-style keys, times as the instants they are", async () => {
  const rows = JSON.parse(toJson(sheet));
  assert.deepEqual(rows[0], { player: "-=KLM=- Gunplay", playerId: "76561198012345678", kills: 12, added: "2026-10-23T15:45:30.000Z", vip: true });
  assert.equal(rows[1].added, null);
  assert.equal(rows[2].vip, null, "an empty cell is null, not a missing key");
  const blob = buildFile(sheet, "json", clock);
  assert.equal(blob.type, "application/json");
  assert.deepEqual(JSON.parse(await blob.text()), rows);
});

test("a file's name is safe anywhere", () => {
  assert.equal(fileStem("vips", "Test Server #1"), "vips-test-server-1");
  assert.equal(fileStem("bans", undefined), "bans");
  assert.equal(fileStem("group", "  [KLM] Seeders!! "), "group-klm-seeders");
});

test("a long list is read whole for a download, every page on the first page's snapshot", async () => {
  const rows = Array.from({ length: 1234 }, (_, i) => i);
  const asked = [];
  const { items, capped } = await readAll(async (offset, limit, anchor) => {
    asked.push([offset, anchor]);
    return { items: rows.slice(offset, offset + limit), total: rows.length, anchor: offset === 0 ? "2026-10-23T00:00:00.000Z" : "a later one" };
  });
  assert.equal(items.length, 1234);
  assert.equal(capped, false);
  assert.deepEqual(asked, [[0, undefined], [500, "2026-10-23T00:00:00.000Z"], [1000, "2026-10-23T00:00:00.000Z"]], "the first anchor, every time");
});

test("a download stops at its ceiling and says rows were left out", async () => {
  let reads = 0;
  const { items, capped } = await readAll(async (offset, limit) => {
    reads += 1;
    return { items: Array.from({ length: limit }, (_, i) => offset + i), total: DOWNLOAD_MAX + 1 };
  });
  assert.equal(items.length, DOWNLOAD_MAX);
  assert.equal(capped, true);
  assert.equal(reads, DOWNLOAD_MAX / 500, "no read past it");
  // A list that does not count itself ends on its first short page.
  const short = await readAll(async (offset) => ({ items: offset === 0 ? [1, 2, 3] : [] }));
  assert.deepEqual(short, { items: [1, 2, 3], capped: false });
});
