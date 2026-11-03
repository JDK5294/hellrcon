// Lists read back in (lib/upload.ts) and planned before anything changes (lib/uploadPlans.ts). The
// files are the download's own, round-tripped, plus a workbook the way Excel saves one — compressed,
// with its text in a shared table — and a semicolon CSV from a spreadsheet in another language.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { toCsv, toJson, toXlsx } from "../lib/download.ts";
import { cellTime, findColumn, parseCsv, readTable } from "../lib/upload.ts";
import { planBans, planMembers, planVips } from "../lib/uploadPlans.ts";

const NY = "America/New_York";
const clock = { zone: NY, wall: (iso) => new Date(Date.parse(iso) - 4 * 3_600_000).toISOString().slice(0, 16) };
const enc = (s) => new TextEncoder().encode(s);
const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

const vipSheet = (rows) => ({
  name: "VIPs",
  columns: [
    { key: "player", label: "Player" }, { key: "playerId", label: "Player ID" }, { key: "status", label: "Status" },
    { key: "expires", label: "Expires", time: true }, { key: "groupPerk", label: "Group perk" },
    { key: "pausedUntil", label: "Paused until", time: true }, { key: "comment", label: "Comment" },
  ],
  rows,
});

test("every download format reads back to the same table, a time in the zone its heading names", async () => {
  const sheet = vipSheet([["-=KLM=- Gunplay", "76561198012345678", "4d 1h left", "2026-10-30T15:45:00.000Z", null, null, "paid, monthly"]]);
  for (const bytes of [toXlsx(sheet, clock), enc(`\uFEFF${toCsv(sheet, clock)}`), enc(toJson(sheet))]) {
    const t = await readTable(bytes);
    const id = findColumn(t, "playerId", "Player ID");
    const exp = findColumn(t, "expires", "Expires");
    assert.equal(t.rows.length, 1);
    assert.equal(String(t.rows[0][id.index]), "76561198012345678", "the id exact, whatever the format");
    assert.equal(t.rows[0][findColumn(t, "player", "Player").index], "-=KLM=- Gunplay", "the CSV's formula guard comes off");
    assert.equal(cellTime(t.rows[0][exp.index], exp.zone), "2026-10-30T15:45:00.000Z");
  }
});

test("a workbook the way Excel saves it: compressed, its text in the shared table", async () => {
  const parts = {
    "xl/workbook.xml": '<workbook xmlns="x" xmlns:r="r"><sheets><sheet name="List" sheetId="1" r:id="rId7"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/sheet3.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<sst><si><t>Player ID</t></si><si><t>Player</t></si><si><r><t>Zo</t></r><r><t xml:space="preserve">ë &amp; co</t></r></si></sst>',
    "xl/worksheets/sheet3.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="3"><c r="A3" t="str"><v>76561198000000001</v></c><c r="B3" t="s"><v>2</v></c></row></sheetData></worksheet>',
  };
  const files = [];
  const dir = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = enc(text);
    const data = deflateRawSync(raw);
    const n = enc(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(n.length, 28); entry.writeUInt32LE(offset, 42);
    files.push(local, n, data); dir.push(entry, n);
    offset += 30 + n.length + data.length;
  }
  const size = dir.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(dir.length / 2, 8); end.writeUInt16LE(dir.length / 2, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  const t = await readTable(new Uint8Array(Buffer.concat([...files, ...dir, end])));
  assert.deepEqual(t.headers, ["Player ID", "Player"]);
  assert.deepEqual(t.rows, [["76561198000000001", "Zoë & co"]], "the sheet the workbook names, a gap row skipped, a formatted name joined");
});

test("CSV from a spreadsheet in another language: semicolons, quotes, a date alone", () => {
  assert.deepEqual(parseCsv('Player ID;Player;Expires\r\n7656;"Smith; John";2026-11-01\n'), [["Player ID", "Player", "Expires"], ["7656", "Smith; John", "2026-11-01"]]);
  assert.equal(cellTime("2026-11-01", NY), "2026-11-01T04:00:00.000Z", "a date alone is its midnight, there");
  assert.equal(cellTime("not a date", NY), undefined);
  assert.equal(cellTime("", NY), null);
});

test("a VIP list only ever adds or lengthens VIP, and leaves alone what it should not touch", async () => {
  const t = await readTable(enc(toJson(vipSheet([
    ["Fresh", "1", "", null, null, null, "paid"],
    ["Topped", "2", "", at(10), null, null, null],
    ["Longer", "3", "", at(10), null, null, null],
    ["Paid", "4", "", at(10), null, null, null],
    ["Perk", "5", "Group perk", null, "Seeders", null, null],
    ["Done", "6", "Expired", at(-2), null, null, null],
    ["Timeout", "7", "", null, null, at(1), null],
    ["Held", "8", "", null, null, null, null],
    ["Fresh again", "1", "", null, null, null, null],
    ["", "", "", null, null, null, null],
  ]))));
  const current = [
    { playerId: "2", expiration: at(2) }, { playerId: "3", expiration: at(30) }, { playerId: "4", expiration: null },
    { playerId: "8", expiration: null, groupHold: { groups: [] } },
  ];
  const plan = planVips(t, current);
  const by = Object.fromEntries(plan.rows.map((r) => [r.line, [r.action, r.detail]]));
  assert.deepEqual(by[2], ["add", "permanent"]);
  assert.equal(by[3][0], "extend", "two days, made ten");
  assert.match(by[4][1], /^already VIP until/, "thirty days stay thirty");
  assert.deepEqual(by[5], ["keep", "already permanent"]);
  assert.match(by[6][1], /group perk/);
  assert.match(by[7][1], /^ended/);
  assert.match(by[8][1], /paused in the list/);
  assert.match(by[9][1], /group perk — left as it is/);
  assert.deepEqual(by[10], ["skip", "listed twice — the first line counts"]);
  assert.deepEqual(by[11], ["skip", "no player ID on this line"]);
  assert.deepEqual(plan.rows[0].payload, { playerId: "1", playerName: "Fresh", until: null, comment: "paid" });
  assert.equal(planVips({ headers: ["Name"], rows: [["x"]] }, []).missing, "Player ID", "a file without the id column is said to be one");
});

test("bans place only what is still in force, on this server's game", async () => {
  const sheet = {
    name: "Bans",
    columns: ["playerId", "player", "type", "until", "game", "reason", "status"].map((key) => ({ key, label: key, time: key === "until" })),
    rows: [
      ["1", "Perma", "perma", null, "WW2", "cheating", "active"],
      ["2", "Temp", "temp", at(3), "WW2", "", "active"],
      ["3", "Lifted", "perma", null, "WW2", "x", "lifted"],
      ["4", "Over", "temp", at(-1), "WW2", "x", "active"],
      ["5", "Viet", "perma", null, "Vietnam", "x", "active"],
      ["6", "Again", "perma", null, "WW2", "x", "active"],
      ["7", "Odd", "forever", null, "WW2", "x", "active"],
    ],
  };
  const plan = planBans(await readTable(enc(toJson(sheet))), [{ playerId: "6", active: true }], "hll");
  assert.deepEqual(plan.rows.map((r) => r.action), ["add", "add", "skip", "skip", "skip", "keep", "skip"]);
  assert.deepEqual(plan.rows[0].payload, { playerId: "1", playerName: "Perma", type: "perma", until: null, reason: "cheating" });
  assert.equal(plan.rows[1].payload.type, "temp");
  assert.match(plan.rows[4].detail, /a Vietnam ban — upload it on a Vietnam server/);
  assert.match(plan.rows[6].detail, /not a ban type/);
});

test("group members are added once", () => {
  const plan = planMembers({ headers: ["Player", "Player ID"], rows: [["A", "1"], ["B", "2"]] }, [{ playerId: "2" }]);
  assert.deepEqual(plan.rows.map((r) => [r.action, r.detail]), [["add", "added"], ["keep", "already in the group"]]);
});
