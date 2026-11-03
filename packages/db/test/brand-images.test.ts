/**
 * The community's own images: nothing is there until somebody uploads one, and what an upload
 * stores is what a read gives back, byte for byte, in both stores. The memory store always runs;
 * Postgres joins when DATABASE_URL is set, in a schema of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository, createIsolatedRepository } from "../dist/index.js";
import type { Repository } from "../src/types.ts";

const stores: [string, () => Promise<{ repo: Repository; cleanup: () => Promise<void> }>][] = [
  ["memory", async () => ({ repo: new InMemoryRepository() as unknown as Repository, cleanup: async () => {} })],
];
if (process.env.DATABASE_URL) stores.push(["postgres", async () => (await createIsolatedRepository()) as { repo: Repository; cleanup: () => Promise<void> }]);

for (const [name, open] of stores) {
  test(`${name}: a match board badge is stored, read back whole, replaced and removed`, async () => {
    const { repo, cleanup } = await open();
    try {
      assert.equal(await repo.brandImages.get("board-badge"), null, "nothing is built in");

      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
      const saved = await repo.brandImages.set("board-badge", { mime: "image/png", bytes: png, by: "ana" });
      assert.equal(saved.mime, "image/png");
      assert.equal(saved.updatedBy, "ana");
      const back = (await repo.brandImages.get("board-badge"))!;
      assert.deepEqual([...back.bytes], [...png], "byte for byte, a zero and a 255 included");
      // A reader's copy is its own: scribbling on it changes nothing stored.
      back.bytes[0] = 0;
      assert.equal((await repo.brandImages.get("board-badge"))!.bytes[0], 0x89);

      const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 7]);
      await repo.brandImages.set("board-badge", { mime: "image/jpeg", bytes: jpg, by: "bob" });
      const replaced = (await repo.brandImages.get("board-badge"))!;
      assert.equal(replaced.mime, "image/jpeg");
      assert.deepEqual([...replaced.bytes], [...jpg], "the new image replaces the old one whole");
      assert.equal(replaced.updatedBy, "bob");

      assert.equal(await repo.brandImages.remove("board-badge"), true);
      assert.equal(await repo.brandImages.get("board-badge"), null);
      assert.equal(await repo.brandImages.remove("board-badge"), false, "nothing left to remove");
    } finally {
      await cleanup();
    }
  });
}
