import {
  COLLECTIONS,
  ENTITY_COLLECTIONS,
  BusinessError,
  clone,
  round,
  canonical,
  changedFields,
  previewChange,
  validateBackup,
  checksum,
  checkLinks,
} from "./domain.js";

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
export const physicalId = (dataset, id) =>
  dataset === "live" ? id : dataset + "__" + id;
export const emptyCatalog = () => Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
const sortRows = (rows) =>
  rows.sort(
    (a, b) =>
      String(b.timestamp || b.updatedAt || b.createdAt || "").localeCompare(
        String(a.timestamp || a.updatedAt || a.createdAt || ""),
      ) || a.id.localeCompare(b.id),
  );

export async function makeBackup(catalog, datasetId) {
  const payload = {
    schemaVersion: 1,
    createdAt: now(),
    datasetId,
    scope: "active-dataset",
    collections: clone(catalog),
  };
  const backup = { ...payload, checksum: await checksum(payload) };
  const validation = await validateBackup(backup);
  if (!validation.ok)
    throw new BusinessError(
      "Không thể tạo backup đầy đủ: " + validation.errors.join(" "),
    );
  return backup;
}

// Both adapters use this mutation builder. Nothing in the supplied catalog is
// changed until validation succeeds and the complete write set is committed.
export function prepareCommit(
  plans,
  catalog,
  { datasetId, uid, revision, timestamp = now() },
) {
  const next = clone(catalog),
    writes = [],
    results = [],
    transactionId = uuid();
  for (const supplied of plans) {
    const before =
      next[supplied.collection].find((r) => r.id === supplied.id) || null;
    if ((before?.version || 0) !== supplied.expectedVersion)
      throw new BusinessError(
        "Phiên bản đã đổi. Tải lại và tạo preview mới.",
        "CONFLICT",
      );
    const plan = previewChange(
      {
        ...supplied,
        data: supplied.after,
        before,
        restore: supplied.action === "RESTORE",
      },
      next,
    );
    if (
      canonical(plan.after) !== canonical(supplied.after) ||
      canonical(plan.impacts) !== canonical(supplied.impacts)
    )
      throw new BusinessError("Preview đã cũ. Hãy kiểm tra lại.", "CONFLICT");
    const eventId = uuid(),
      versionId = uuid();
    const after = {
      ...plan.after,
      id: plan.id,
      datasetId,
      version: (before?.version || 0) + 1,
      createdAt: before?.createdAt || timestamp,
      updatedAt: timestamp,
      updatedSeq: revision + 1,
      lastEventId: eventId,
    };
    const event = {
      id: eventId,
      eventId,
      datasetId,
      entityType: plan.collection,
      entityId: plan.id,
      action: plan.action,
      timestamp,
      source: plan.source,
      uid,
      before: clone(before),
      after: clone(after),
      changedFields: changedFields(before, after),
      transactionId,
      note: plan.note,
      stockImpact: plan.impacts,
      warnings: plan.warnings,
    };
    const version = {
      id: versionId,
      datasetId,
      collection: plan.collection,
      entityId: plan.id,
      version: after.version,
      data: clone(after),
      createdAt: timestamp,
      action: plan.action,
      source: plan.source,
      uid,
    };
    function put(c, row) {
      next[c] = [...next[c].filter((r) => r.id !== row.id), row];
      writes.push({ collection: c, row });
    }
    put(plan.collection, after);
    put("entityVersions", version);
    put("activityEvents", event);
    for (const impact of plan.impacts) {
      const ing = next.ingredients.find((i) => i.id === impact.ingredientId);
      if (!ing) throw new BusinessError("Thiếu nguyên liệu khi ghi sổ kho.");
      const updated = {
        ...ing,
        stock: round(Number(ing.stock || 0) + impact.quantity),
        updatedAt: timestamp,
      };
      if (plan.collection === "stockCounts" && plan.action === "ADJUST")
        updated.lastCountAdjustmentSeq = revision + 1;
      put("ingredients", updated);
      put("stockLedger", {
        id: uuid(),
        datasetId,
        ingredientId: ing.id,
        quantity: impact.quantity,
        kind: plan.action === "RESTORE" ? "COMPENSATING" : plan.action,
        referenceType: plan.collection,
        referenceId: plan.id,
        createdAt: timestamp,
        transactionId,
        eventId,
      });
    }
    if (plan.collection === "stockCounts" && plan.action === "ADJUST")
      for (const item of after.items) {
        const ing = next.ingredients.find((i) => i.id === item.ingredientId);
        put("ingredients", { ...ing, lastCountAdjustmentSeq: revision + 1 });
      }
    results.push(after);
  }
  // Coalesce ingredient updates when a batch affects the same ingredient.
  const merged = new Map(writes.map((w) => [w.collection + "/" + w.row.id, w]));
  if (merged.size > 400)
    throw new BusinessError(
      "Batch quá lớn. Chia thành các đề xuất nhỏ hơn.",
      "LIMIT",
    );
  return {
    catalog: next,
    writes: [...merged.values()],
    results,
    transactionId,
  };
}

export class MemoryRepository {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.uid = "local-demo-user";
    this.mode = "demo";
    this.datasetId = "live";
    this.revision = 0;
    const saved = JSON.parse(storage.getItem("le-corner-inventory") || "{}");
    this.datasets = saved.datasets || { live: saved.store || saved };
    this.datasetId = saved.datasetId || "live";
    this.revision = saved.revision || 0;
  }
  async ready() {
    return this;
  }
  catalog(dataset = this.datasetId) {
    const store = this.datasets[dataset] || {};
    return Object.fromEntries(
      COLLECTIONS.map((c) => [
        c,
        Object.values(store[c] || {}).filter(
          (r) => !r.datasetId || r.datasetId === dataset,
        ),
      ]),
    );
  }
  persist(
    datasets = this.datasets,
    datasetId = this.datasetId,
    revision = this.revision,
  ) {
    this.storage.setItem(
      "le-corner-inventory",
      JSON.stringify({ datasets, datasetId, revision }),
    );
    this.datasets = datasets;
    this.datasetId = datasetId;
    this.revision = revision;
  }
  async currentCatalog() {
    return clone(this.catalog());
  }
  async get(c, id) {
    return this.catalog()[c].find((r) => r.id === id) || null;
  }
  async commit(plan) {
    return (await this.commitMany([plan]))[0];
  }
  async commitMany(plans) {
    const latest = JSON.parse(
      this.storage.getItem("le-corner-inventory") || "null",
    );
    if (latest?.datasets) {
      this.datasets = latest.datasets;
      this.datasetId = latest.datasetId;
      this.revision = latest.revision || 0;
    }
    if (
      plans.some(
        (p) =>
          p.datasetId !== this.datasetId ||
          p.expectedRevision !== this.revision,
      )
    )
      throw new BusinessError("Dữ liệu đã đổi. Tải lại preview.", "CONFLICT");
    const mutation = prepareCommit(plans, this.catalog(), this),
      datasets = clone(this.datasets);
    datasets[this.datasetId] = Object.fromEntries(
      COLLECTIONS.map((c) => [
        c,
        Object.fromEntries(mutation.catalog[c].map((r) => [r.id, r])),
      ]),
    );
    this.persist(datasets, this.datasetId, this.revision + 1);
    return mutation.results;
  }
  async backup() {
    return makeBackup(this.catalog(), this.datasetId);
  }
  async fullRestore(backup) {
    const check = await validateBackup(backup);
    if (!check.ok) throw new BusinessError(check.errors.join(" "));
    const safetyBackup = await this.backup(),
      old = this.datasetId,
      newId = "restore-" + uuid(),
      datasets = clone(this.datasets),
      timestamp = now(),
      eventId = uuid(),
      jobId = uuid();
    const target = restoreTarget(backup, safetyBackup.collections, {
      newId,
      uid: this.uid,
      revision: this.revision,
      timestamp,
      jobId,
    });
    const event = restoreEvent({
      eventId,
      jobId,
      newId,
      old,
      uid: this.uid,
      timestamp,
      safetyChecksum: safetyBackup.checksum,
    });
    target.activityEvents.push(event);
    target.restoreJobs.push({
      id: jobId,
      datasetId: newId,
      status: "COMPLETED",
      sourceDataset: old,
      targetDataset: newId,
      safetyChecksum: safetyBackup.checksum,
      startedAt: timestamp,
      finishedAt: timestamp,
    });
    datasets[newId] = Object.fromEntries(
      COLLECTIONS.map((c) => [
        c,
        Object.fromEntries(target[c].map((r) => [r.id, r])),
      ]),
    );
    this.persist(datasets, newId, this.revision + 1);
    return { datasetId: newId, safetyBackup };
  }
}

export function restoreTarget(
  backup,
  current,
  { newId, uid, revision, timestamp = now(), jobId = uuid() },
) {
  const target = clone(backup.collections);
  for (const c of COLLECTIONS)
    target[c] = target[c].map((r) => ({ ...r, datasetId: newId }));
  for (const c of ENTITY_COLLECTIONS)
    target[c] = target[c].map((row) => {
      const before = current[c].find((r) => r.id === row.id) || null,
        eventId = uuid(),
        versionId = uuid();
      const maxVersion = Math.max(
        row.version || 0,
        before?.version || 0,
        ...target.entityVersions
          .filter((v) => v.collection === c && v.entityId === row.id)
          .map((v) => v.version),
      );
      const after = {
        ...row,
        version: maxVersion + 1,
        updatedAt: timestamp,
        updatedSeq: revision + 1,
        lastEventId: eventId,
      };
      if (
        c === "ingredients" &&
        target.stockCounts.some(
          (count) =>
            count.adjusted &&
            count.items.some((i) => i.ingredientId === row.id),
        )
      )
        after.lastCountAdjustmentSeq = revision + 1;
      target.entityVersions.push({
        id: versionId,
        datasetId: newId,
        collection: c,
        entityId: row.id,
        version: after.version,
        data: clone(after),
        createdAt: timestamp,
        action: "RESTORE",
        source: "Manual",
        uid,
      });
      target.activityEvents.push({
        id: eventId,
        eventId,
        datasetId: newId,
        entityType: c,
        entityId: row.id,
        action: "RESTORE",
        timestamp,
        source: "Manual",
        uid,
        before: clone(before),
        after: clone(after),
        changedFields: changedFields(before, after),
        transactionId: jobId,
        note: "Full Restore sang dataset mới; sổ kho được phục hồi nguyên trạng.",
        stockImpact: [],
      });
      return after;
    });
  return target;
}

function restoreEvent({
  eventId,
  jobId,
  newId,
  old,
  uid,
  timestamp,
  safetyChecksum,
}) {
  return {
    id: eventId,
    eventId,
    datasetId: newId,
    entityType: "restoreJobs",
    entityId: jobId,
    action: "RESTORE",
    timestamp,
    source: "Manual",
    uid,
    before: { datasetId: old },
    after: { datasetId: newId },
    changedFields: ["datasetId"],
    transactionId: jobId,
    note:
      "Full Restore; dataset cũ được giữ và backup an toàn đã kiểm tra: " +
      safetyChecksum,
    stockImpact: [],
  };
}

export class FirestoreRepository {
  constructor(firebase, { namespace = "" } = {}) {
    this.auth = firebase.auth();
    this.db = firebase.firestore();
    this.uid = null;
    this.mode = "firebase";
    this.datasetId = "live";
    this.revision = 0;
    this.settingsId = namespace ? "app-" + namespace : "app";
    this.initialDataset = namespace ? "qa-" + namespace : "live";
  }
  col(c) {
    return this.db.collection("users").doc(this.uid).collection(c);
  }
  settings() {
    return this.col("settings").doc(this.settingsId);
  }
  ref(c, id, dataset = this.datasetId) {
    return this.col(c).doc(physicalId(dataset, id));
  }
  async ready() {
    if (!this.auth.currentUser) await this.auth.signInAnonymously();
    this.uid = this.auth.currentUser.uid;
    await this.db.runTransaction(async (tx) => {
      const s = await tx.get(this.settings());
      if (!s.exists)
        tx.set(this.settings(), {
          activeDatasetId: this.initialDataset,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        });
    });
    await this.refreshState();
    return this;
  }
  async refreshState() {
    const s = await this.settings().get({ source: "server" });
    this.datasetId = s.data().activeDatasetId;
    this.revision = s.data().revision || 0;
  }
  async list(c, dataset = this.datasetId, { limit = 100, cursor = null } = {}) {
    let query = this.col(c)
      .where("datasetId", "==", dataset)
      .orderBy("__name__")
      .limit(limit);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get({ source: "server" });
    return {
      rows: snap.docs.map((d) => d.data()),
      cursor: snap.docs.at(-1) || null,
      more: snap.size === limit,
    };
  }
  async all(c, dataset = this.datasetId, onProgress = () => {}) {
    const rows = [];
    let cursor = null,
      more = true;
    while (more) {
      const page = await this.list(c, dataset, { cursor });
      rows.push(...page.rows);
      cursor = page.cursor;
      more = page.more;
      onProgress(c, rows.length);
    }
    return sortRows(rows);
  }
  async currentCatalog({ complete = false, onProgress } = {}) {
    await this.refreshState();
    const dataset = this.datasetId,
      revision = this.revision,
      out = emptyCatalog();
    for (const c of COLLECTIONS) {
      if (complete || ENTITY_COLLECTIONS.includes(c))
        out[c] = await this.all(c, dataset, onProgress);
    }
    if (!complete) {
      const page = await this.historyPage();
      out.activityEvents = page.rows;
      this.historyCursor = page.cursor;
      this.historyMore = page.more;
    }
    const settings = await this.settings().get({ source: "server" });
    if (
      settings.data().activeDatasetId !== dataset ||
      (settings.data().revision || 0) !== revision
    )
      throw new BusinessError(
        "Dữ liệu thay đổi khi đang tải. Hãy tải lại.",
        "CONFLICT",
      );
    this.cachedCatalog = out;
    return out;
  }
  async get(c, id) {
    const d = await this.ref(c, id).get({ source: "server" });
    return d.exists ? d.data() : null;
  }
  async versions(c, id) {
    return (await this.all("entityVersions"))
      .filter((v) => v.collection === c && v.entityId === id)
      .sort((a, b) => b.version - a.version);
  }
  async historyPage(filters = {}, cursor = null) {
    // One timestamp index; entity/action/source filters are applied in the UI.
    // Each server page is bounded even when many rows fail the filters.
    let q = this.col("activityEvents").orderBy("timestamp", "desc").limit(50);
    if (cursor) q = q.startAfter(cursor);
    const s = await q.get({ source: "server" });
    return {
      rows: s.docs
        .map((d) => d.data())
        .filter((r) => r.datasetId === this.datasetId),
      cursor: s.docs.at(-1) || null,
      more: s.size === 50,
    };
  }
  async commit(plan) {
    return (await this.commitMany([plan]))[0];
  }
  async commitMany(plans) {
    if (!plans.length) return [];
    if (
      plans.some(
        (p) =>
          p.datasetId !== this.datasetId ||
          p.expectedRevision !== this.revision,
      )
    )
      throw new BusinessError("Preview đã cũ. Tải lại dữ liệu.", "CONFLICT");
    const expectedRevision = this.revision,
      dataset = this.datasetId,
      catalog = this.cachedCatalog;
    // Read the revision fence before writing. All business writes increment it,
    // so transactions from another tab cannot commit a stale recipe or balance.
    const results = await this.db.runTransaction(async (tx) => {
      const settings = await tx.get(this.settings());
      if (
        settings.data().activeDatasetId !== dataset ||
        (settings.data().revision || 0) !== expectedRevision
      )
        throw new BusinessError(
          "Dữ liệu đã đổi ở tab khác. Tải lại và xem preview mới.",
          "CONFLICT",
        );
      const mutation = prepareCommit(plans, catalog, {
        datasetId: dataset,
        uid: this.uid,
        revision: expectedRevision,
      });
      for (const w of mutation.writes)
        tx.set(this.ref(w.collection, w.row.id, dataset), w.row);
      tx.update(this.settings(), {
        revision: expectedRevision + 1,
        updatedAt: now(),
      });
      return mutation.results;
    });
    this.revision = expectedRevision + 1;
    return results;
  }
  async backup(onProgress) {
    const catalog = await this.currentCatalog({ complete: true, onProgress });
    return makeBackup(catalog, this.datasetId);
  }
  async fullRestore(backup, onProgress = () => {}) {
    const check = await validateBackup(backup);
    if (!check.ok) throw new BusinessError(check.errors.join(" "));
    const safetyBackup = await this.backup(onProgress),
      old = this.datasetId,
      revision = this.revision,
      newId = "restore-" + uuid(),
      jobId = uuid(),
      job = this.ref("restoreJobs", jobId, old),
      timestamp = now();
    await job.set({
      id: jobId,
      datasetId: old,
      status: "STAGING",
      sourceDataset: old,
      backupDataset: backup.datasetId,
      targetDataset: newId,
      safetyChecksum: safetyBackup.checksum,
      safetyDataset: old,
      startedAt: timestamp,
    });
    try {
      const target = restoreTarget(backup, safetyBackup.collections, {
        newId,
        uid: this.uid,
        revision,
        timestamp,
        jobId,
      });
      const rows = COLLECTIONS.flatMap((c) =>
        target[c].map((row) => ({ collection: c, row })),
      );
      // Also cap payload size well below Firestore's 10 MiB request limit.
      for (let start = 0; start < rows.length; ) {
        const batch = this.db.batch();
        let count = 0,
          bytes = 0;
        while (start < rows.length && count < 200) {
          const w = rows[start],
            size = new TextEncoder().encode(JSON.stringify(w.row)).length;
          if (count && bytes + size > 2000000) break;
          batch.set(this.ref(w.collection, w.row.id, newId), w.row);
          start++;
          count++;
          bytes += size;
        }
        await batch.commit();
        onProgress("staging", start);
      }
      const staged = emptyCatalog();
      for (const c of COLLECTIONS)
        staged[c] = await this.all(c, newId, onProgress);
      for (const c of COLLECTIONS) {
        const original = target[c].sort((a, b) => a.id.localeCompare(b.id));
        const actual = staged[c].sort((a, b) => a.id.localeCompare(b.id));
        if (canonical(original) !== canonical(actual))
          throw new BusinessError("Staging không khớp " + c);
      }
      const links = checkLinks(staged);
      if (links.length) throw new BusinessError(links.join(" "));
      const eventId = uuid(),
        event = restoreEvent({
          eventId,
          jobId,
          newId,
          old,
          uid: this.uid,
          timestamp: now(),
          safetyChecksum: safetyBackup.checksum,
        });
      await this.db.runTransaction(async (tx) => {
        const settings = await tx.get(this.settings());
        if (
          settings.data().activeDatasetId !== old ||
          (settings.data().revision || 0) !== revision
        )
          throw new BusinessError(
            "Dữ liệu hiện tại đã đổi trong khi restore. Dataset cũ tiếp tục hoạt động.",
            "CONFLICT",
          );
        tx.set(this.ref("activityEvents", eventId, newId), event);
        tx.set(this.ref("restoreJobs", jobId, newId), {
          id: jobId,
          datasetId: newId,
          status: "COMPLETED",
          sourceDataset: old,
          targetDataset: newId,
          safetyChecksum: safetyBackup.checksum,
          safetyDataset: old,
          startedAt: timestamp,
          finishedAt: now(),
        });
        tx.update(job, { status: "COMPLETED", finishedAt: now() });
        tx.update(this.settings(), {
          activeDatasetId: newId,
          revision: revision + 1,
          updatedAt: now(),
        });
      });
      this.datasetId = newId;
      this.revision = revision + 1;
      return { datasetId: newId, safetyBackup };
    } catch (error) {
      const eventId = uuid();
      await this.db
        .runTransaction(async (tx) => {
          tx.update(job, {
            status: "FAILED",
            finishedAt: now(),
            error: String(error.message).slice(0, 500),
          });
          tx.set(this.ref("activityEvents", eventId, old), {
            id: eventId,
            eventId,
            datasetId: old,
            entityType: "restoreJobs",
            entityId: jobId,
            action: "RESTORE",
            outcome: "FAILED",
            timestamp: now(),
            source: "Manual",
            uid: this.uid,
            before: { datasetId: old },
            after: { datasetId: old },
            changedFields: [],
            transactionId: jobId,
            note: "Full Restore thất bại; dữ liệu hoạt động được giữ.",
            stockImpact: [],
          });
        })
        .catch(() => {});
      throw error;
    }
  }
}
