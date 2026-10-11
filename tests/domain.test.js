import test from "node:test";
import assert from "node:assert/strict";
import {
  changedFields,
  previewChange,
  validateBackup,
  checksum,
  checkLinks,
} from "../js/domain.js";
const catalog = {
  menuItems: [
    { id: "americano", name: "Americano", price: 39000, status: "ACTIVE" },
  ],
  ingredients: [
    { id: "coffee", name: "Coffee", baseUnit: "g", stock: 0, status: "ACTIVE" },
  ],
  recipes: [
    {
      id: "recipe-a",
      menuItemId: "americano",
      version: 1,
      status: "ACTIVE",
      items: [{ ingredientId: "coffee", quantity: 10, unit: "g" }],
    },
  ],
  sales: [],
  purchaseReceipts: [],
  stockCounts: [],
  reorderSettings: [],
  stockLedger: [],
  activityEvents: [],
  entityVersions: [],
  restoreJobs: [],
};
test("changedFields reports before/after changes", () =>
  assert.deepEqual(
    changedFields(
      { price: 30, name: "A" },
      { price: 35, name: "A", archived: false },
    ),
    ["archived", "price"],
  ));
test("sale preview snapshots recipe and computes stock impact", () => {
  const p = previewChange(
    {
      collection: "sales",
      id: "sale-1",
      data: {
        date: "2026-10-09",
        invoiceNo: "HD1",
        items: [{ menuItemId: "americano", quantity: 2 }],
      },
    },
    catalog,
  );
  assert.equal(p.after.total, 78000);
  assert.deepEqual(p.impacts, [{ ingredientId: "coffee", quantity: -20 }]);
});
test("backup checksum and link validation work", async () => {
  const b = {
    schemaVersion: 1,
    createdAt: "2026-10-09T00:00:00Z",
    datasetId: "live",
    scope: "active-dataset",
    collections: catalog,
  };
  const signed = { ...b, checksum: await checksum(b) };
  assert.equal((await validateBackup(signed)).ok, true);
  assert.deepEqual(checkLinks(catalog), []);
});
test("invalid backup is rejected", async () => {
  const b = {
    schemaVersion: 1,
    createdAt: "x",
    datasetId: "live",
    scope: "active-dataset",
    collections: {
      ...catalog,
      recipes: [{ id: "bad", menuItemId: "missing", items: [] }],
    },
    checksum: "wrong",
  };
  const result = await validateBackup(b);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("malformed nested backup and null metadata return validation errors", async () => {
  assert.equal((await validateBackup(null)).ok, false);
  const collections = structuredClone(catalog);
  collections.recipes[0].items = { invalid: true };
  const payload = {
    schemaVersion: 1,
    createdAt: "2026-10-09T00:00:00Z",
    datasetId: "live",
    scope: "active-dataset",
    collections,
  };
  assert.equal(
    (await validateBackup({ ...payload, checksum: await checksum(payload) }))
      .ok,
    false,
  );
  assert.throws(
    () =>
      previewChange(
        {
          collection: "recipes",
          id: "recipe-a",
          before: catalog.recipes[0],
          data: {
            ...catalog.recipes[0],
            items: [{ ingredientId: "coffee", quantity: 0, unit: "g" }],
          },
        },
        catalog,
      ),
    /lớn hơn 0/,
  );
});

test("backupDiff ignores dataset metadata but detects content changes", async () => {
  const { backupDiff } = await import("../js/domain.js");
  const live = [
    { id: "a", name: "X", datasetId: "new", version: 3 },
    { id: "b", name: "Y", datasetId: "new", version: 1 },
  ];
  const backup = [
    { id: "a", name: "X", datasetId: "old", version: 1 },
    { id: "b", name: "Z", datasetId: "old", version: 1 },
    { id: "c", name: "W", datasetId: "old", version: 1 },
  ];
  const d = backupDiff(backup, live);
  assert.deepEqual(d.changed.map((r) => r.id), ["b"]);
  assert.deepEqual(d.added.map((r) => r.id), ["c"]);
});
