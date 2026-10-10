import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  clone,
  previewChange,
  checksum,
  validateBackup,
  buildBatch,
} from "../js/domain.js";
import {
  MemoryRepository,
  FirestoreRepository,
  physicalId,
} from "../js/repository.js";

class Storage {
  value = null;
  getItem() {
    return this.value;
  }
  setItem(k, value) {
    if (this.fail) throw new Error("disk full");
    this.value = value;
  }
}
async function fixture() {
  const storage = new Storage(),
    repo = new MemoryRepository(storage);
  await repo.ready();
  async function plan(c, id, data, options = {}) {
    const catalog = await repo.currentCatalog();
    return {
      ...previewChange(
        { collection: c, id, data, before: await repo.get(c, id), ...options },
        catalog,
      ),
      datasetId: repo.datasetId,
      expectedRevision: repo.revision,
    };
  }
  async function save(c, id, data, options) {
    return repo.commit(await plan(c, id, data, options));
  }
  await save("menuItems", "americano", { name: "Americano", price: 39000 });
  await save("ingredients", "coffee", {
    name: "Coffee",
    baseUnit: "g",
    openingStock: 1000,
  });
  await save("recipes", "recipe", {
    menuItemId: "americano",
    items: [{ ingredientId: "coffee", quantity: 4, unit: "g" }],
  });
  return { repo, storage, plan, save };
}
const sale = (quantity) => ({
  date: "2026-10-09",
  invoiceNo: "HD1",
  items: [{ menuItemId: "americano", quantity }],
});

test("12 to 10 and repeated restore only compensate the difference", async () => {
  const { repo, save } = await fixture();
  const original = await save("sales", "sale", sale(10));
  await save("sales", "sale", sale(12));
  assert.equal((await repo.get("ingredients", "coffee")).stock, 952);
  await save("sales", "sale", original, { action: "RESTORE", restore: true });
  assert.equal((await repo.get("ingredients", "coffee")).stock, 960);
  await save("sales", "sale", original, { action: "RESTORE", restore: true });
  assert.equal((await repo.get("ingredients", "coffee")).stock, 960);
  const catalog = await repo.currentCatalog();
  assert.deepEqual(
    catalog.stockLedger.map((m) => m.quantity),
    [-40, -8, 8],
  );
  assert.equal(
    catalog.entityVersions.filter((v) => v.entityId === "sale").length,
    4,
  );
  assert.ok(
    catalog.activityEvents.every((e) =>
      catalog.entityVersions.some(
        (v) => v.entityId === e.entityId && v.version === e.after.version,
      ),
    ),
  );
  assert.equal((await validateBackup(await repo.backup())).ok, true);
});
test("recipe restore keeps historical invoice snapshot and archive keeps dependencies", async () => {
  const { repo, save } = await fixture();
  const recipe = await repo.get("recipes", "recipe");
  await save("sales", "sale", sale(10));
  await save("recipes", "recipe", {
    items: [{ ingredientId: "coffee", quantity: 3.5, unit: "g" }],
  });
  await save("recipes", "recipe", recipe, { action: "RESTORE", restore: true });
  assert.equal(
    (await repo.get("sales", "sale")).items[0].recipeSnapshot.items[0].quantity,
    4,
  );
  await save(
    "menuItems",
    "americano",
    { status: "ARCHIVED" },
    { action: "ARCHIVE" },
  );
  assert.ok(await repo.get("recipes", "recipe"));
  assert.ok(await repo.get("sales", "sale"));
  await save(
    "menuItems",
    "americano",
    { status: "ACTIVE" },
    { action: "RESTORE" },
  );
  assert.equal((await repo.get("menuItems", "americano")).status, "ACTIVE");
});
test("checkpoint requires controlled reason, including zero variance counts", async () => {
  const { repo, save, plan } = await fixture();
  const original = await save("sales", "sale", sale(10));
  await save("stockCounts", "count", {
    date: "2026-10-09",
    items: [{ ingredientId: "coffee", actual: 960, unit: "g" }],
  });
  await save("stockCounts", "count", await repo.get("stockCounts", "count"), {
    action: "ADJUST",
  });
  await assert.rejects(plan("sales", "sale", sale(12)), { code: "CHECKPOINT" });
  await save("sales", "sale", sale(12), {
    controlled: true,
    note: "Confirmed after count",
  });
  await assert.rejects(
    plan("sales", "sale", original, { action: "RESTORE", restore: true }),
    { code: "CHECKPOINT" },
  );
  await save("sales", "sale", original, {
    action: "RESTORE",
    restore: true,
    controlled: true,
    note: "Confirmed correction",
  });
  assert.equal((await repo.get("ingredients", "coffee")).stock, 960);
});
test("AI preview makes no writes, batch commit is atomic and duplicate IDs are rejected", async () => {
  const { repo } = await fixture(),
    catalog = await repo.currentCatalog(),
    before = repo.storage.value;
  const payload = {
    schemaVersion: 1,
    module: "sales",
    operation: "create",
    records: [
      { id: "s1", ...sale(2) },
      { id: "s2", ...sale(3), invoiceNo: "HD2" },
    ],
  };
  const plans = buildBatch(payload, catalog).map((p) => ({
    ...p,
    datasetId: repo.datasetId,
    expectedRevision: repo.revision,
  }));
  assert.equal(repo.storage.value, before);
  await repo.commitMany(plans);
  assert.equal((await repo.get("ingredients", "coffee")).stock, 980);
  const sameId = {
    ...payload,
    records: [
      { id: "x", ...sale(1) },
      { id: "x", ...sale(1), invoiceNo: "OTHER" },
    ],
  };
  assert.throws(() => buildBatch(sameId, catalog), { code: "DUPLICATE" });
});
test("failed commit does not persist entities, versions or events; stale tab is rejected", async () => {
  const { repo, storage, plan, save } = await fixture(),
    before = storage.value,
    p = await plan("sales", "sale", sale(1));
  storage.fail = true;
  await assert.rejects(repo.commit(p), /disk full/);
  assert.equal(storage.value, before);
  assert.equal(await repo.get("sales", "sale"), null);
  storage.fail = false;
  const other = new MemoryRepository(storage);
  await save("menuItems", "americano", { price: 40000 });
  await assert.rejects(other.commit(p), { code: "CONFLICT" });
});
test("full restore retains old dataset and creates new RESTORE versions", async () => {
  const { repo, save } = await fixture();
  await save("sales", "sale", sale(10));
  const backup = await repo.backup();
  await save("sales", "sale", sale(12));
  const oldCatalog = clone(repo.catalog());
  const result = await repo.fullRestore(backup);
  assert.equal((await repo.get("ingredients", "coffee")).stock, 960);
  assert.equal((await repo.get("sales", "sale")).quantity, 10);
  assert.deepEqual(repo.catalog("live"), oldCatalog);
  assert.notEqual(result.datasetId, "live");
  assert.equal((await repo.get("sales", "sale")).version, 3);
  assert.equal((await validateBackup(await repo.backup())).ok, true);
  assert.equal((await validateBackup(result.safetyBackup)).ok, true);
});
test("invalid checksum and semantic corruption never activate restore", async () => {
  const { repo } = await fixture(),
    valid = await repo.backup(),
    before = repo.storage.value;
  await assert.rejects(
    repo.fullRestore({ ...valid, checksum: "wrong" }),
    /Checksum/,
  );
  assert.equal(repo.storage.value, before);
  const corrupt = clone(valid);
  corrupt.collections.ingredients[0].stock = 99;
  delete corrupt.checksum;
  corrupt.checksum = await checksum(corrupt);
  assert.equal((await validateBackup(corrupt)).ok, false);
  const secrets = { ...valid, accessToken: "secret" };
  delete secrets.checksum;
  secrets.checksum = await checksum(secrets);
  assert.equal((await validateBackup(secrets)).ok, false);
});

// A small Firestore adapter double exercises actual pagination, batch staging
// and activation code; it is not proof that live Security Rules accept writes.
class FakeDb {
  store = new Map();
  batchCount = 0;
  failBatch = 0;
  collection(path) {
    return new Query(this, path);
  }
  batch() {
    const writes = [];
    return {
      set: (ref, data) => writes.push([ref.path, clone(data)]),
      commit: async () => {
        if (++this.batchCount === this.failBatch)
          throw new Error("injected staging failure");
        for (const [p, d] of writes) this.store.set(p, d);
      },
    };
  }
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, data) => writes.push([ref.path, clone(data)]),
      update: (ref, data) =>
        writes.push([
          ref.path,
          { ...clone(this.store.get(ref.path)), ...clone(data) },
        ]),
    };
    const result = await fn(tx);
    for (const [p, d] of writes) this.store.set(p, d);
    return result;
  }
}
class Ref {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").at(-1);
  }
  collection(c) {
    return new Query(this.db, this.path + "/" + c);
  }
  async get() {
    const value = this.db.store.get(this.path);
    return { id: this.id, exists: !!value, data: () => clone(value) };
  }
  async set(data) {
    this.db.store.set(this.path, clone(data));
  }
}
class Query {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.max = Infinity;
  }
  doc(id) {
    return new Ref(this.db, this.path + "/" + id);
  }
  where(key, op, value) {
    this.filter = { key, value };
    return this;
  }
  orderBy(key, direction) {
    this.order = key;
    this.direction = direction;
    return this;
  }
  limit(n) {
    this.max = n;
    return this;
  }
  startAfter(cursor) {
    this.cursor = cursor;
    return this;
  }
  async get() {
    let rows = [...this.db.store]
      .filter(
        ([p, d]) =>
          p.startsWith(this.path + "/") &&
          !p.slice(this.path.length + 1).includes("/") &&
          (!this.filter || d[this.filter.key] === this.filter.value),
      )
      .map(([p, d]) => ({ id: p.split("/").at(-1), data: () => clone(d) }));
    rows.sort((a, b) =>
      this.order === "timestamp"
        ? b.data().timestamp.localeCompare(a.data().timestamp)
        : a.id.localeCompare(b.id),
    );
    if (this.cursor) {
      rows = rows.slice(rows.findIndex((r) => r.id === this.cursor.id) + 1);
    }
    const docs = rows.slice(0, this.max);
    return { docs, size: docs.length };
  }
}
async function firestoreFixture() {
  const base = await fixture(),
    db = new FakeDb(),
    user = "test-user";
  for (const c of COLLECTIONS)
    for (const row of base.repo.catalog()[c])
      db.store.set("users/" + user + "/" + c + "/" + row.id, row);
  db.store.set("users/" + user + "/settings/app", {
    activeDatasetId: "live",
    revision: base.repo.revision,
  });
  const repo = new FirestoreRepository({
    auth: () => ({ currentUser: { uid: user } }),
    firestore: () => db,
  });
  await repo.ready();
  await repo.currentCatalog();
  return { repo, db };
}
test("Firestore exports more than 300 rows and staging failure preserves every active document", async () => {
  const { repo, db } = await firestoreFixture();
  for (let n = 0; n < 310; n++) {
    const id = "menu" + String(n).padStart(4, "0");
    db.store.set("users/test-user/menuItems/" + id, {
      id,
      datasetId: "live",
      name: "Item " + n,
      price: 1000,
      status: "ACTIVE",
    });
  }
  const backup = await repo.backup();
  assert.equal(backup.collections.menuItems.length, 311);
  const old = [...db.store].filter(
    ([p]) =>
      p.includes("/menuItems/") ||
      p.includes("/ingredients/") ||
      p.includes("/settings/"),
  );
  db.failBatch = 2;
  await assert.rejects(repo.fullRestore(backup), /injected staging failure/);
  for (const [path, value] of old) assert.deepEqual(db.store.get(path), value);
  assert.equal(repo.datasetId, "live");
  assert.ok([...db.store.values()].some((v) => v.status === "FAILED"));
});
test("Firestore restore stages distinct physical IDs and activates only complete reconciled state", async () => {
  const { repo, db } = await firestoreFixture(),
    backup = await repo.backup(),
    old = clone(db.store.get("users/test-user/menuItems/americano"));
  const result = await repo.fullRestore(backup);
  assert.deepEqual(db.store.get("users/test-user/menuItems/americano"), old);
  assert.notEqual(physicalId(result.datasetId, "americano"), "americano");
  const restored = await repo.backup();
  assert.equal((await validateBackup(restored)).ok, true);
  assert.equal(restored.collections.menuItems.length, 1);
  assert.equal(restored.collections.recipes.length, 1);
});
test("Firestore rejects activation if another tab changed the active dataset revision", async () => {
  const { repo, db } = await firestoreFixture(),
    backup = await repo.backup(),
    old = clone(db.store.get("users/test-user/ingredients/coffee"));
  let changed = false;
  await assert.rejects(
    repo.fullRestore(backup, (phase) => {
      if (phase === "staging" && !changed) {
        changed = true;
        const settings = db.store.get("users/test-user/settings/app");
        settings.revision++;
      }
    }),
    { code: "CONFLICT" },
  );
  assert.equal(
    db.store.get("users/test-user/settings/app").activeDatasetId,
    "live",
  );
  assert.deepEqual(db.store.get("users/test-user/ingredients/coffee"), old);
});
