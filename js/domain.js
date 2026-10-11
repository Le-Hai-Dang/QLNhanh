// Pure business logic shared by manual entry, AI preview, version restore and backup import.
export const ENTITY_COLLECTIONS = [
  "menuItems",
  "ingredients",
  "recipes",
  "sales",
  "purchaseReceipts",
  "stockCounts",
  "reorderSettings",
];
export const COLLECTIONS = [
  ...ENTITY_COLLECTIONS,
  "stockLedger",
  "activityEvents",
  "entityVersions",
  "restoreJobs",
];
export const STATUSES = ["ACTIVE", "ARCHIVED", "CANCELLED", "SUPERSEDED"];
export const ACTIONS = Object.freeze({
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  ARCHIVE: "ARCHIVE",
  RESTORE: "RESTORE",
  ADJUST: "ADJUST",
});
export const SOURCES = ["Manual", "AI-Assisted"];
export const LABELS = {
  menuItems: "Món bán",
  ingredients: "Nguyên liệu",
  recipes: "Công thức",
  sales: "Hóa đơn bán",
  purchaseReceipts: "Nhập hàng",
  stockCounts: "Kiểm kho",
  reorderSettings: "Ngưỡng đặt hàng",
  stockLedger: "Sổ kho",
  activityEvents: "Lịch sử",
  entityVersions: "Phiên bản",
  restoreJobs: "Khôi phục",
};
export class BusinessError extends Error {
  constructor(message, code = "VALIDATION") {
    super(message);
    this.code = code;
  }
}
export const clone = (value) =>
  value == null ? value : JSON.parse(JSON.stringify(value));
export const round = (n) =>
  Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
export const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
export const canonical = (value) => JSON.stringify(sortObject(value));
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, sortObject(value[k])]),
    );
  return value;
}
export const changedFields = (a = {}, b = {}) =>
  [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
    .filter((k) => canonical(a?.[k]) !== canonical(b?.[k]))
    .sort();
export function validId(id) {
  return (
    typeof id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
    !["__proto__", "constructor", "prototype"].includes(id)
  );
}
export function number(value, label, { min = 0, integer = false } = {}) {
  if (
    value === "" ||
    value == null ||
    typeof value === "boolean" ||
    !Number.isFinite(Number(value)) ||
    Number(value) < min ||
    (integer && !Number.isInteger(Number(value)))
  )
    throw new BusinessError(label + " không hợp lệ.");
  return round(value);
}
export function validDate(value) {
  const date = new Date(value + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value || "") ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new BusinessError("Ngày không hợp lệ.");
  return value;
}
function text(value, label) {
  const result = String(value || "").trim();
  if (!result || result.length > 200)
    throw new BusinessError(label + " cần có nội dung (tối đa 200 ký tự).");
  return result;
}
export function toBase(qty, unit, ingredient) {
  qty = number(qty, "Số lượng");
  const base = ingredient.baseUnit;
  if (unit === base) return qty;
  if ((unit === "kg" && base === "g") || (unit === "l" && base === "ml"))
    return round(qty * 1000);
  if (unit === "package") {
    if (!(ingredient.packageSize > 0))
      throw new BusinessError("Chưa cấu hình quy cách " + ingredient.name);
    return round(qty * ingredient.packageSize);
  }
  throw new BusinessError(
    "Không thể đổi " + unit + " sang " + base + ". Không tự đổi g sang ml.",
  );
}
export function packageQuantity(full, percent, ingredient) {
  return toBase(
    number(full, "Số bao bì nguyên", { integer: true }) +
      number(percent, "Phần bao bì còn lại") / 100,
    "package",
    ingredient,
  );
}
export function resolve(rows, value, label) {
  const matches = (rows || []).filter(
    (r) =>
      r.id === value ||
      [r.name, r.englishName, r.code, ...(r.aliases || [])].some(
        (n) => n && normalize(n) === normalize(value),
      ),
  );
  if (matches.length !== 1)
    throw new BusinessError(label + " không khớp duy nhất: " + value);
  return matches[0];
}
const mapRows = (rows) => new Map((rows || []).map((r) => [r.id, r]));
function stripMeta(data) {
  const out = clone(data || {});
  for (const k of [
    "id",
    "version",
    "createdAt",
    "updatedAt",
    "updatedSeq",
    "lastEventId",
    "lastCountAdjustmentSeq",
    "stock",
    "datasetId",
  ])
    delete out[k];
  return out;
}
export function previewChange(
  {
    collection,
    id,
    data,
    before = null,
    action,
    source = "Manual",
    note = "",
    restore = false,
    controlled = false,
  },
  catalog,
) {
  if (!ENTITY_COLLECTIONS.includes(collection) || !validId(id))
    throw new BusinessError("Đối tượng không được hỗ trợ.");
  if (!SOURCES.includes(source))
    throw new BusinessError("Nguồn thao tác không hợp lệ.");
  const result = {
    collection,
    id,
    expectedVersion: before?.version || 0,
    action: action || (restore ? "RESTORE" : before ? "UPDATE" : "CREATE"),
    source,
    note: String(note || "").slice(0, 1000),
    controlled: Boolean(controlled),
    before: clone(before),
    after: null,
    impacts: [],
    warnings: [],
  };
  if (
    !["CREATE", "UPDATE", "ARCHIVE", "RESTORE", "ADJUST"].includes(
      result.action,
    )
  )
    throw new BusinessError("Thao tác không hợp lệ.");
  const after = {
    ...stripMeta(before),
    ...stripMeta(data),
    status: data?.status || before?.status || "ACTIVE",
  };
  if (!STATUSES.includes(after.status))
    throw new BusinessError("Trạng thái không hợp lệ.");
  const ingredients = mapRows(catalog.ingredients),
    menus = mapRows(catalog.menuItems);
  if (collection === "menuItems") {
    after.name = text(after.name, "Tên món");
    after.englishName = String(after.englishName || "").trim();
    after.code = String(after.code || "").trim();
    after.group = String(after.group || "");
    after.unit = after.unit || "ly";
    after.price = number(after.price, "Giá bán", { integer: true });
    after.aliases = Array.isArray(after.aliases)
      ? after.aliases.map((a) => text(a, "Tên tương đương"))
      : [];
    const names = [after.name, after.englishName, after.code, ...after.aliases]
      .filter(Boolean)
      .map(normalize);
    if (
      (catalog.menuItems || []).some(
        (r) =>
          r.id !== id &&
          [r.name, r.englishName, r.code, ...(r.aliases || [])]
            .filter(Boolean)
            .some((n) => names.includes(normalize(n))),
      )
    )
      throw new BusinessError("Tên/mã/alias trùng món đã có.");
  }
  if (collection === "ingredients") {
    after.name = text(after.name, "Tên nguyên liệu");
    if (!["g", "ml", "unit"].includes(after.baseUnit))
      throw new BusinessError("Đơn vị chuẩn phải là g, ml hoặc unit.");
    if (before && before.baseUnit !== after.baseUnit)
      throw new BusinessError(
        "Không đổi đơn vị chuẩn của nguyên liệu đã tồn tại.",
      );
    after.minimumStock = number(after.minimumStock ?? 0, "Ngưỡng tồn");
    after.packageSize = number(after.packageSize ?? 0, "Quy cách");
    after.unitCost = number(after.unitCost ?? 0, "Giá vốn / đơn vị chuẩn");
    after.openingStock = before
      ? Number(before.openingStock || 0)
      : number(after.openingStock ?? 0, "Tồn đầu");
    after.stock = before ? Number(before.stock || 0) : after.openingStock;
    if (
      before &&
      data?.openingStock != null &&
      Number(data.openingStock) !== after.openingStock
    )
      throw new BusinessError(
        "Tồn đầu đã chốt. Dùng phiếu kiểm kho để điều chỉnh số dư.",
      );
  }
  if (collection === "recipes") {
    const menu = menus.get(after.menuItemId);
    if (!menu) throw new BusinessError("Chọn món cho công thức.");
    after.name = menu.name;
    if (!Array.isArray(after.items) || !after.items.length)
      throw new BusinessError("Công thức cần ít nhất một nguyên liệu.");
    const seen = new Set();
    after.items = after.items.map((item) => {
      const ing = ingredients.get(item.ingredientId);
      if (!ing || (!restore && ing.status !== "ACTIVE") || seen.has(ing.id))
        throw new BusinessError(
          "Nguyên liệu thiếu, đã ẩn hoặc trùng trong công thức.",
        );
      seen.add(ing.id);
      const quantity = toBase(item.quantity, item.unit || ing.baseUnit, ing);
      if (quantity <= 0)
        throw new BusinessError("Định lượng công thức phải lớn hơn 0.");
      return {
        ingredientId: ing.id,
        name: ing.name,
        quantity,
        unit: ing.baseUnit,
      };
    });
    if (
      (catalog.recipes || []).some(
        (r) =>
          r.id !== id &&
          r.menuItemId === after.menuItemId &&
          r.status === "ACTIVE",
      ) &&
      after.status === "ACTIVE"
    )
      throw new BusinessError(
        "Món đã có công thức. Hãy sửa công thức hiện tại.",
      );
  }
  if (collection === "sales") {
    after.date = validDate(after.date);
    after.invoiceNo = String(after.invoiceNo || "")
      .trim()
      .toUpperCase();
    after.name = after.invoiceNo || "Bán hàng " + after.date;
    if (
      after.invoiceNo &&
      (catalog.sales || []).some(
        (r) => r.id !== id && r.invoiceNo === after.invoiceNo,
      )
    )
      throw new BusinessError(
        "Hóa đơn " + after.invoiceNo + " đã tồn tại.",
        "DUPLICATE",
      );
    if (!Array.isArray(after.items) || !after.items.length)
      throw new BusinessError("Chọn ít nhất một món.");
    const seen = new Set();
    after.items = after.items.map((item) => {
      const menu = menus.get(item.menuItemId);
      const historical = before?.items?.find(
        (i) => i.menuItemId === item.menuItemId,
      );
      if (
        !menu ||
        seen.has(menu.id) ||
        (!historical && menu.status !== "ACTIVE")
      )
        throw new BusinessError("Món thiếu, đã ẩn hoặc trùng.");
      seen.add(menu.id);
      const qty = number(item.quantity, "Số món bán", {
        min: 1,
        integer: true,
      });
      const recipe = (catalog.recipes || []).find(
        (r) => r.menuItemId === menu.id && r.status === "ACTIVE",
      );
      // An existing line keeps the exact price and recipe recorded at first sale.
      const saved = restore ? item : historical;
      const snapshot = saved
        ? saved.recipeSnapshot
        : recipe
          ? {
              recipeId: recipe.id,
              version: recipe.version || 1,
              items: clone(recipe.items),
            }
          : null;
      if (
        snapshot &&
        (!Array.isArray(snapshot.items) ||
          snapshot.items.some((i) => !ingredients.has(i.ingredientId)))
      )
        throw new BusinessError("Snapshot công thức có liên kết bị thiếu.");
      if (!snapshot)
        result.warnings.push(
          "Chưa có định lượng: " +
            menu.name +
            ". Số ly vẫn được ghi nhận; tiêu hao chưa đầy đủ.",
        );
      return {
        menuItemId: menu.id,
        name: saved?.name || menu.name,
        quantity: qty,
        price: number(saved?.price ?? menu.price, "Giá bán", { integer: true }),
        recipeSnapshot: clone(snapshot),
      };
    });
    after.total = after.items.reduce((s, i) => s + i.price * i.quantity, 0);
    after.quantity = after.items.reduce((s, i) => s + i.quantity, 0);
    after.consumptionIncomplete = after.items.some((i) => !i.recipeSnapshot);
    after.stockImpact = saleImpact(after);
    if (
      data.expectedTotal != null &&
      number(data.expectedTotal, "Tổng hóa đơn", { integer: true }) !==
        after.total
    )
      throw new BusinessError("Tổng hóa đơn không khớp: " + after.total + "đ.");
    delete after.expectedTotal;
    result.impacts = impactDifference(
      before?.stockImpact || [],
      after.stockImpact,
    );
  }
  if (collection === "purchaseReceipts") {
    after.date = validDate(after.date);
    after.name = String(after.name || "Nhập hàng " + after.date);
    if (!Array.isArray(after.items) || !after.items.length)
      throw new BusinessError("Chọn nguyên liệu nhập hàng.");
    after.items = after.items.map((item) => {
      const ing = ingredients.get(item.ingredientId);
      if (!ing) throw new BusinessError("Nguyên liệu nhập không tồn tại.");
      const quantity = toBase(item.quantity, item.unit || ing.baseUnit, ing);
      if (!quantity) throw new BusinessError("Số nhập phải lớn hơn 0.");
      return {
        ingredientId: ing.id,
        name: ing.name,
        quantity,
        unit: ing.baseUnit,
        unitCost: number(item.unitCost ?? 0, "Giá nhập / đơn vị"),
      };
    });
    after.stockImpact =
      after.status === "CANCELLED"
        ? []
        : aggregate(
            after.items.map((i) => ({
              ingredientId: i.ingredientId,
              quantity: i.quantity,
            })),
          );
    result.impacts = impactDifference(
      before?.stockImpact || [],
      after.stockImpact,
    );
  }
  if (collection === "stockCounts") {
    after.date = validDate(after.date);
    after.name = String(after.name || "Kiểm kho " + after.date);
    if (!Array.isArray(after.items) || !after.items.length)
      throw new BusinessError("Chọn nguyên liệu kiểm kê.");
    if (before?.adjusted)
      throw new BusinessError(
        "Phiếu kiểm đã điều chỉnh: tạo phiếu kiểm mới để hiệu chỉnh có kiểm soát.",
        "CHECKPOINT",
      );
    if (before?.adjusted && result.action === "ADJUST")
      throw new BusinessError("Phiếu này đã được điều chỉnh.", "DUPLICATE");
    after.items = after.items.map((item) => {
      const ing = ingredients.get(item.ingredientId);
      if (!ing) throw new BusinessError("Nguyên liệu kiểm không tồn tại.");
      const actual = toBase(item.actual, item.unit || ing.baseUnit, ing);
      const theory =
        result.action === "ADJUST"
          ? Number(ing.stock || 0)
          : number(item.theoretical ?? ing.stock ?? 0, "Tồn lý thuyết", {
              min: -1e12,
            });
      return {
        ingredientId: ing.id,
        name: ing.name,
        actual,
        theoretical: theory,
        variance: round(actual - theory),
        unit: ing.baseUnit,
      };
    });
    after.adjusted = result.action === "ADJUST";
    if (after.adjusted)
      result.impacts = after.items
        .map((i) => ({ ingredientId: i.ingredientId, quantity: i.variance }))
        .filter((i) => i.quantity !== 0);
  }
  if (collection === "reorderSettings") {
    if (!ingredients.has(after.ingredientId))
      throw new BusinessError("Nguyên liệu không tồn tại.");
    after.minimumStock = number(after.minimumStock, "Ngưỡng đặt hàng");
    after.name = ingredients.get(after.ingredientId).name;
  }
  if (
    before &&
    ["sales", "purchaseReceipts"].includes(collection) &&
    result.impacts.length
  ) {
    const affected = result.impacts.map((i) => ingredients.get(i.ingredientId));
    const referenceSeq = restore
      ? Math.min(Number(before.updatedSeq || 0), Number(data.updatedSeq || 0))
      : Number(before.updatedSeq || 0);
    if (
      affected.some(
        (i) => Number(i?.lastCountAdjustmentSeq || 0) > referenceSeq,
      )
    ) {
      if (!controlled || !result.note.trim())
        throw new BusinessError(
          "Giao dịch đã qua kỳ điều chỉnh kiểm kho. Dùng hiệu chỉnh có kiểm soát và ghi lý do.",
          "CHECKPOINT",
        );
      result.warnings.push(
        "Hiệu chỉnh sau kiểm kê: bút toán mới sẽ tác động tồn hiện tại.",
      );
    }
  }
  result.impacts = aggregate(result.impacts);
  // Each ingredient costs two writes (balance + ledger); the repository also caps a batch at 400 writes.
  if (result.impacts.length > 40)
    throw new BusinessError(
      "Một giao dịch tối đa 40 nguyên liệu khác nhau. Hãy chia phiếu.",
      "LIMIT",
    );
  for (const impact of result.impacts) {
    const ing = ingredients.get(impact.ingredientId);
    const balance = round(Number(ing?.stock || 0) + impact.quantity);
    if (balance < 0)
      result.warnings.push(
        (ing?.name || after.name) +
          ": tồn dự kiến " +
          balance +
          (ing?.baseUnit || "") +
          " (âm).",
      );
  }
  result.after = after;
  return result;
}
export function aggregate(impacts) {
  const sums = new Map();
  for (const i of impacts)
    sums.set(
      i.ingredientId,
      round((sums.get(i.ingredientId) || 0) + Number(i.quantity)),
    );
  return [...sums]
    .map(([ingredientId, quantity]) => ({ ingredientId, quantity }))
    .filter((i) => i.quantity !== 0)
    .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
}
export function impactDifference(before, after) {
  return aggregate([
    ...after,
    ...before.map((i) => ({ ...i, quantity: -i.quantity })),
  ]);
}
export function saleImpact(sale) {
  if (sale.status === "CANCELLED") return [];
  return aggregate(
    sale.items.flatMap((i) =>
      (i.recipeSnapshot?.items || []).map((r) => ({
        ingredientId: r.ingredientId,
        quantity: -round(r.quantity * i.quantity),
      })),
    ),
  );
}
export async function checksum(payload) {
  const bytes = new TextEncoder().encode(canonical(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function checkLinks(collections) {
  const errors = [];
  const has = (c, id) => collections[c]?.some((r) => r.id === id);
  const ref = (c, id, label) => {
    if (!has(c, id)) errors.push(label + ": thiếu " + c + "/" + id);
  };
  for (const recipe of collections.recipes || []) {
    ref("menuItems", recipe.menuItemId, "Công thức");
    for (const i of recipe.items || [])
      ref("ingredients", i.ingredientId, "Công thức");
  }
  for (const sale of collections.sales || [])
    for (const i of sale.items || []) {
      ref("menuItems", i.menuItemId, "Hóa đơn");
      if (i.recipeSnapshot?.recipeId)
        ref("recipes", i.recipeSnapshot.recipeId, "Snapshot công thức");
      for (const r of i.recipeSnapshot?.items || [])
        ref("ingredients", r.ingredientId, "Snapshot hóa đơn");
    }
  for (const c of ["purchaseReceipts", "stockCounts"])
    for (const row of collections[c] || [])
      for (const i of row.items || []) ref("ingredients", i.ingredientId, c);
  for (const row of collections.reorderSettings || [])
    ref("ingredients", row.ingredientId, "Ngưỡng đặt hàng");
  for (const row of collections.stockLedger || []) {
    ref("ingredients", row.ingredientId, "Sổ kho");
    ref(row.referenceType, row.referenceId, "Tham chiếu sổ kho");
    ref("activityEvents", row.eventId, "Event sổ kho");
  }
  for (const row of collections.entityVersions || [])
    ref(row.collection, row.entityId, "Phiên bản");
  for (const row of collections.activityEvents || [])
    if (ENTITY_COLLECTIONS.includes(row.entityType))
      ref(row.entityType, row.entityId, "Lịch sử");
  const ledger = aggregate(collections.stockLedger || []);
  for (const ing of collections.ingredients || []) {
    // openingStock is the audited starting balance; every movement after that
    // point must reconcile with the append-only ledger.
    const sum = ledger.find((i) => i.ingredientId === ing.id)?.quantity || 0;
    const expected = round(Number(ing.openingStock || 0) + sum);
    if (round(ing.stock || 0) !== expected)
      errors.push(
        "Số dư " + ing.name + " không khớp sổ kho (" + expected + ").",
      );
  }
  return errors;
}
export async function validateBackup(backup) {
  const errors = [];
  function containsSecret(value) {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([k, v]) =>
        /^(accessToken|refreshToken|idToken|private_key|password|credential|credentials|serviceAccount)$/i.test(
          k,
        ) || containsSecret(v),
    );
  }
  if (containsSecret(backup))
    errors.push("Backup không được chứa credential/token.");
  if (backup?.schemaVersion !== 1)
    errors.push("Schema backup không được hỗ trợ.");
  if (
    !Number.isFinite(Date.parse(backup?.createdAt)) ||
    !validId(backup?.datasetId) ||
    backup?.scope !== "active-dataset"
  )
    errors.push("Metadata không hợp lệ.");
  if (
    !backup?.collections ||
    typeof backup.collections !== "object" ||
    Array.isArray(backup.collections)
  )
    errors.push("Thiếu collections.");
  for (const c of COLLECTIONS) {
    const rows = backup?.collections?.[c];
    if (!Array.isArray(rows)) {
      errors.push("Collection " + c + " không hợp lệ.");
      continue;
    }
    const seen = new Set();
    for (const row of rows) {
      if (!row || !validId(row.id) || seen.has(row.id)) {
        errors.push("ID thiếu/không hợp lệ/trùng trong " + c);
        continue;
      }
      seen.add(row.id);
      if (
        typeof row !== "object" ||
        new TextEncoder().encode(canonical(row)).length > 180000
      )
        errors.push("Bản ghi quá lớn trong " + c);
      if (row.datasetId && row.datasetId !== backup.datasetId)
        errors.push("Dataset không khớp trong " + c);
    }
  }
  if (
    backup?.collections &&
    Object.keys(backup.collections).some((c) => !COLLECTIONS.includes(c))
  )
    errors.push("Collection không được hỗ trợ.");
  if (!errors.length) {
    const { checksum: signature, ...payload } = backup;
    if (!signature || signature !== (await checksum(payload)))
      errors.push("Checksum SHA-256 không khớp.");
    try {
      errors.push(...checkLinks(backup.collections));
    } catch {
      errors.push("Cấu trúc bản ghi hoặc liên kết không hợp lệ.");
    }
    // Validate business records too. A valid checksum alone is not schema validation.
    for (const c of ENTITY_COLLECTIONS)
      for (const row of backup.collections[c]) {
        try {
          const before =
            c === "stockCounts" ? { ...row, adjusted: false } : row;
          const plan = previewChange(
            {
              collection: c,
              id: row.id,
              data: row,
              before,
              restore: true,
              action: "RESTORE",
            },
            backup.collections,
          );
          if (
            ["sales", "purchaseReceipts"].includes(c) &&
            canonical(plan.after.stockImpact) !== canonical(row.stockImpact)
          )
            throw new BusinessError("Tiêu hao không khớp snapshot.");
          if (c === "ingredients" && !Number.isFinite(row.stock))
            throw new BusinessError("Số dư không hợp lệ.");
        } catch (e) {
          errors.push(c + "/" + row.id + ": " + e.message);
        }
      }
    for (const row of backup.collections.stockLedger)
      if (
        !Number.isFinite(row.quantity) ||
        !validId(row.referenceId) ||
        !ENTITY_COLLECTIONS.includes(row.referenceType)
      )
        errors.push("Bút toán kho không hợp lệ.");
    for (const row of backup.collections.entityVersions)
      if (
        !ENTITY_COLLECTIONS.includes(row.collection) ||
        row.data?.id !== row.entityId ||
        !Number.isInteger(row.version) ||
        row.version < 1 ||
        row.data?.version !== row.version
      )
        errors.push("Snapshot version không hợp lệ.");
    for (const row of backup.collections.activityEvents)
      if (
        row.eventId !== row.id ||
        !Number.isFinite(Date.parse(row.timestamp)) ||
        !SOURCES.includes(row.source) ||
        !Object.keys(ACTIONS).includes(row.action)
      )
        errors.push("Event lịch sử không hợp lệ.");
  }
  return { ok: !errors.length, errors };
}
const CONTENT_META = [
  "datasetId",
  "version",
  "createdAt",
  "updatedAt",
  "updatedSeq",
  "lastEventId",
  "lastCountAdjustmentSeq",
];
// Business content of a row, without per-dataset bookkeeping that always differs after a restore.
export function contentKey(row) {
  const copy = { ...row };
  for (const k of CONTENT_META) delete copy[k];
  return canonical(copy);
}
export function backupDiff(backupRows, liveRows) {
  const live = new Map((liveRows || []).map((r) => [r.id, contentKey(r)]));
  const added = [],
    changed = [];
  for (const r of backupRows) {
    if (!live.has(r.id)) added.push(r);
    else if (live.get(r.id) !== contentKey(r)) changed.push(r);
  }
  return { added, changed };
}
export function backupSummary(backup, current) {
  return ENTITY_COLLECTIONS.map((collection) => {
    const rows = backup.collections[collection],
      live = current[collection] || [],
      diff = backupDiff(rows, live);
    return {
      collection,
      backup: rows.length,
      current: live.length,
      added: diff.added.length,
      changed: diff.changed.length,
    };
  });
}
export function buildBatch(payload, catalog) {
  if (
    payload?.schemaVersion !== 1 ||
    !ENTITY_COLLECTIONS.includes(payload.module) ||
    !["create", "update", "restore"].includes(payload.operation) ||
    !Array.isArray(payload.records) ||
    !payload.records.length ||
    payload.records.length > 50
  )
    throw new BusinessError(
      "Envelope cần schemaVersion:1, module, operation và records[1..50].",
    );
  const draftCatalog = clone(catalog),
    plans = [],
    seenIds = new Set();
  for (const record of payload.records) {
    const id = record.id || crypto.randomUUID();
    if (seenIds.has(id))
      throw new BusinessError("ID trùng trong batch.", "DUPLICATE");
    seenIds.add(id);
    const before =
      (catalog[payload.module] || []).find((r) => r.id === id) || null;
    if (payload.operation !== "create" && !before)
      throw new BusinessError("Không tìm thấy đối tượng cần sửa/restore.");
    if (payload.operation === "create" && before)
      throw new BusinessError("ID đã tồn tại.", "DUPLICATE");
    const data = clone(record);
    delete data.id;
    if (payload.module === "sales")
      data.items = (data.items || []).map((i) => ({
        ...i,
        menuItemId:
          i.menuItemId || resolve(catalog.menuItems, i.menuName, "Món").id,
        quantity: i.quantity,
      }));
    if (["stockCounts", "purchaseReceipts", "recipes"].includes(payload.module))
      data.items = (data.items || []).map((i) => ({
        ...i,
        ingredientId:
          i.ingredientId ||
          resolve(catalog.ingredients, i.ingredientName, "Nguyên liệu").id,
      }));
    const plan = previewChange(
      {
        collection: payload.module,
        id,
        data,
        before,
        source: "AI-Assisted",
        restore: payload.operation === "restore",
      },
      draftCatalog,
    );
    plans.push(plan);
    draftCatalog[payload.module] = [
      ...(draftCatalog[payload.module] || []).filter((r) => r.id !== id),
      { ...plan.after, id, version: plan.expectedVersion + 1 },
    ];
    for (const impact of plan.impacts) {
      const ing = draftCatalog.ingredients.find(
        (i) => i.id === impact.ingredientId,
      );
      ing.stock = round(Number(ing.stock || 0) + impact.quantity);
    }
  }
  return plans;
}
