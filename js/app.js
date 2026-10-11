import { MemoryRepository, FirestoreRepository } from "./repository.js";
import {
  ENTITY_COLLECTIONS,
  COLLECTIONS,
  LABELS,
  ACTIONS,
  clone,
  normalize,
  previewChange,
  validateBackup,
  checksum,
  backupDiff,
  canonical,
  changedFields,
  backupSummary,
  buildBatch,
  BusinessError,
} from "./domain.js";

const config = window.LE_CORNER_FIREBASE_CONFIG || {};
const firebaseConfigured = Boolean(
  window.firebase && config.apiKey && config.appId,
);
if (firebaseConfigured && !firebase.apps.length) firebase.initializeApp(config);
if (firebaseConfigured)
  firebase.firestore().settings({
    experimentalForceLongPolling: true,
    experimentalAutoDetectLongPolling: false,
    merge: true,
  });
const state = {
  view: "dashboard",
  catalog: {},
  history: [],
  selectedEvent: null,
  editing: null,
  cart: [],
  salesDate: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
  salesInvoice: "",
  salesSearch: "",
  aiDraft: null,
  backupDraft: null,
  busy: false,
  connected: false,
  historyLimit: 50,
  filters: {
    q: "",
    entity: "",
    action: "",
    source: "",
    from: "",
    to: "",
    entityId: "",
  },
};
const labels = {
  ...LABELS,
  dashboard: "Tổng quan",
  backup: "Sao lưu & khôi phục",
  settings: "Cài đặt",
  history: "Lịch sử",
  salesList: "Hóa đơn bán",
};
const viewTitle = (v) => (v === "sales" ? "Nhập món bán" : labels[v] || v);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const dateText = (v) =>
  v
    ? new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(v))
    : "—";
const money = (v) => Number(v || 0).toLocaleString("vi-VN") + "đ";
let toastTimer = null;
// The toast is a popover so it renders in the top layer, above open dialogs.
const toast = (message, error = false) => {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.style.background = error ? "var(--red)" : "var(--green-strong)";
  el.className = "toast show";
  try {
    if (!el.matches(":popover-open")) el.showPopover();
  } catch {}
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.className = "toast";
      try {
        el.hidePopover();
      } catch {}
    },
    error ? 5500 : 3200,
  );
};
const ACTION_LABELS = {
  CREATE: "Thêm mới",
  UPDATE: "Chỉnh sửa",
  ARCHIVE: "Ẩn",
  RESTORE: "Khôi phục",
  ADJUST: "Điều chỉnh",
};
const STATUS_LABELS = {
  ACTIVE: "Đang dùng",
  ARCHIVED: "Đã ẩn",
  CANCELLED: "Đã hủy",
  SUPERSEDED: "Đã thay thế",
};
const UNIT_LABELS = { g: "g", ml: "ml", unit: "đơn vị", kg: "kg", l: "lít" };
const FIELD_LABELS = {
  name: "Tên",
  englishName: "Tên tiếng Anh",
  code: "Mã",
  group: "Nhóm",
  price: "Giá bán",
  unit: "Đơn vị",
  aliases: "Tên tương đương",
  status: "Trạng thái",
  baseUnit: "Đơn vị chuẩn",
  packageSize: "Quy cách",
  openingStock: "Tồn đầu",
  minimumStock: "Ngưỡng đặt hàng",
  unitCost: "Giá vốn",
  items: "Chi tiết",
  date: "Ngày",
  invoiceNo: "Mã hóa đơn",
  note: "Ghi chú",
  total: "Tổng tiền",
  quantity: "Số lượng",
  menuItemId: "Món",
  ingredientId: "Nguyên liệu",
  adjusted: "Đã điều chỉnh",
  consumptionIncomplete: "Thiếu định lượng",
  stock: "Tồn kho",
};
const HIDDEN_FIELDS = [
  "id",
  "version",
  "createdAt",
  "updatedAt",
  "updatedSeq",
  "lastEventId",
  "lastCountAdjustmentSeq",
  "datasetId",
  "stockImpact",
  "recipeSnapshot",
];
let ingredientIndex = null;
const ingredientById = (id) => {
  if (ingredientIndex?.source !== state.catalog.ingredients)
    ingredientIndex = {
      source: state.catalog.ingredients,
      map: new Map((state.catalog.ingredients || []).map((i) => [i.id, i])),
    };
  return ingredientIndex.map.get(id);
};
const ingName = (id) => ingredientById(id)?.name || id;
const unitText = (u) => UNIT_LABELS[u] || u || "";
const itemsText = (items, detail = false) =>
  (items || [])
    .map((i) => {
      const name = i.name || (i.ingredientId ? ingName(i.ingredientId) : i.menuItemId);
      const qty = i.quantity ?? i.actual;
      return (
        name +
        " × " +
        qty +
        (i.ingredientId && i.unit ? " " + unitText(i.unit) : "") +
        (detail && i.price != null ? " @ " + money(i.price) : "") +
        (detail && i.unitCost != null ? " (giá " + money(i.unitCost) + ")" : "")
      );
    })
    .join(", ");
function fmtVal(key, v) {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Có" : "Không";
  if (key === "status") return STATUS_LABELS[v] || v;
  if (key === "price" || key === "total" || key === "unitCost") return money(v);
  if (key === "ingredientId") return ingName(v);
  if (key === "items" && Array.isArray(v)) return itemsText(v, true) || "—";
  if (Array.isArray(v)) return v.join(", ") || "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
const isBlank = (v) => v == null || v === "";
const diffFields = (before, after) =>
  changedFields(before || {}, after || {}).filter(
    (k) =>
      !HIDDEN_FIELDS.includes(k) &&
      !(isBlank(before?.[k]) && isBlank(after?.[k])),
  );
function diffTable(before, after) {
  const fields = diffFields(before, after);
  if (!fields.length)
    return '<p class="muted">Không có thay đổi hiển thị.</p>';
  return (
    '<div class="table-wrap"><table class="data-table diff-table"><thead><tr><th>Trường</th><th>Trước</th><th>Sau</th></tr></thead><tbody>' +
    fields
      .map(
        (k) =>
          "<tr><td>" +
          esc(FIELD_LABELS[k] || k) +
          '</td><td class="wrap">' +
          esc(fmtVal(k, before?.[k])) +
          '</td><td class="wrap"><strong>' +
          esc(fmtVal(k, after?.[k])) +
          "</strong></td></tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
function impactList(impacts) {
  if (!impacts?.length) return '<p class="muted">Không làm thay đổi tồn kho.</p>';
  return (
    '<ul class="impact-list">' +
    impacts
      .map((i) => {
        const ing = ingredientById(i.ingredientId);
        return (
          "<li><strong>" +
          esc(ing?.name || i.ingredientId) +
          "</strong>: " +
          (i.quantity > 0 ? "+" : "") +
          esc(i.quantity) +
          " " +
          esc(unitText(ing?.baseUnit)) +
          "</li>"
        );
      })
      .join("") +
    "</ul>"
  );
}
const impactPlain = (impacts) =>
  impacts?.length
    ? impacts
        .map(
          (i) =>
            ingName(i.ingredientId) +
            " " +
            (i.quantity > 0 ? "+" : "") +
            i.quantity +
            " " +
            unitText(ingredientById(i.ingredientId)?.baseUnit),
        )
        .join("; ")
    : "không đổi tồn kho";
const rawDetails = (value, title = "Dữ liệu gốc (JSON)") =>
  "<details><summary>" +
  title +
  "</summary><pre>" +
  esc(JSON.stringify(value, null, 2)) +
  "</pre></details>";
function localStamp() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return p.year + "-" + p.month + "-" + p.day + "_" + p.hour + p.minute;
}
const status = (t) => {
  const el = document.querySelector("#saveStatus");
  if (el) el.textContent = t;
};
const activeRows = (c) =>
  (state.catalog[c] || []).filter((r) => r.status === "ACTIVE");
const activeMenu = () => activeRows("menuItems");
const input = (id, label, value = "", type = "text", extra = "") =>
  '<div class="field"><label for="' +
  id +
  '">' +
  label +
  '</label><input class="input" id="' +
  id +
  '" name="' +
  id +
  '" type="' +
  type +
  '" value="' +
  esc(value) +
  '" ' +
  extra +
  "></div>";
const textarea = (id, label, value = "", extra = "") =>
  '<div class="field full"><label for="' +
  id +
  '">' +
  label +
  '</label><textarea class="textarea" id="' +
  id +
  '" name="' +
  id +
  '" rows="5" ' +
  extra +
  ">" +
  esc(value) +
  "</textarea></div>";
const select = (id, label, options, value = "") =>
  '<div class="field"><label for="' +
  id +
  '">' +
  label +
  '</label><select class="select" id="' +
  id +
  '" name="' +
  id +
  '">' +
  options
    .map(
      (o) =>
        '<option value="' +
        esc(o.value) +
        '"' +
        (o.value === value ? " selected" : "") +
        ">" +
        esc(o.label) +
        "</option>",
    )
    .join("") +
  "</select></div>";

const params = new URLSearchParams(location.search);
const namespace = params.get("namespace") || "";
if (namespace && !/^[a-zA-Z0-9_-]{1,40}$/.test(namespace))
  throw new Error("Namespace không hợp lệ");
let repo =
  params.get("mode") === "demo" || !firebaseConfigured
    ? new MemoryRepository()
    : new FirestoreRepository(firebase, { namespace });

async function load() {
  status("Đang tải dữ liệu...");
  try {
    state.catalog = await repo.currentCatalog();
    state.history = (state.catalog.activityEvents || []).sort((a, b) =>
      String(b.timestamp).localeCompare(String(a.timestamp)),
    );
    state.activeDatasetId = repo.datasetId;
    state.connected = true;
    status(
      (repo.mode === "demo" ? "Demo cục bộ · " : "Đã đồng bộ ") +
        dateText(now()),
    );
    render();
  } catch (e) {
    status("Tải dữ liệu thất bại");
    throw e;
  }
}
function planFromForm(collection, id, data, before, options = {}) {
  return {
    ...previewChange(
      {
        collection,
        id,
        data,
        before,
        action: options.action,
        restore: options.action === "RESTORE",
        source: options.source || "Manual",
        note: options.note || "",
        controlled: options.controlled,
      },
      state.catalog,
    ),
    expectedRevision: repo.revision,
    datasetId: repo.datasetId,
  };
}
async function commitPlan(plan, message) {
  await commitPlans([plan], message);
}
// Several plans are written in one repository transaction (all or nothing).
async function commitPlans(plans, message) {
  if (!state.connected)
    throw new BusinessError("Chưa kết nối. Hãy tải lại dữ liệu.");
  const warnings = plans.flatMap((p) => p.warnings);
  if (
    warnings.length &&
    !(await askConfirm(
      warnings.join("\n") + "\nXác nhận lưu với các cảnh báo này?",
    ))
  )
    throw new BusinessError("Đã hủy lưu.");
  status("Đang ghi transaction...");
  await repo.commitMany(plans);
  try {
    await load();
  } catch (e) {
    state.connected = false;
    status("Đã lưu; tải lại dữ liệu để kiểm tra");
  }
  toast(message || "Đã lưu " + (labels[plans[0].collection] || plans[0].collection));
}

const NAV = [
  ["dashboard", "nav-dashboard", "Tổng quan"],
  ["sales", "nav-sales", "Nhập món bán"],
  ["stockCounts", "nav-stock", "Kiểm kho"],
  ["ingredients", "nav-ingredients", "Nguyên liệu"],
  ["purchaseReceipts", "nav-purchases", "Nhập hàng"],
  ["menuItems", "nav-menu", "Món bán"],
  ["history", "nav-history", "Lịch sử"],
  ["backup", "nav-backup", "Sao lưu & khôi phục"],
];
function nav() {
  const current = state.view === "salesList" ? "sales" : state.view;
  return NAV.map(
    ([view, testid, label]) =>
      '<button class="nav-item' +
      (current === view ? " active" : "") +
      '" data-view="' +
      view +
      '" data-testid="' +
      testid +
      '"' +
      (current === view ? ' aria-current="page"' : "") +
      ">" +
      esc(label) +
      "</button>",
  ).join("");
}
function navigate(view, filters = {}) {
  state.view = view;
  state.filters = {
    q: "",
    entity: "",
    action: "",
    source: "",
    from: "",
    to: "",
    entityId: "",
    ...filters,
  };
  state.historyLimit = 50;
  document.querySelector(".sidebar").classList.remove("open");
  render();
  window.scrollTo({ top: 0 });
}
function renderShell() {
  document.querySelector("#mainNav").innerHTML = nav();
  syncSidebar();
  document.querySelector("#pageTitle").textContent =
    viewTitle(state.view);
  document.title = viewTitle(state.view) + " · LE CORNER Inventory";
  document.querySelector("#authStatus").textContent = state.connected
    ? repo.mode === "firebase"
      ? "Đã kết nối Firebase"
      : "Demo cục bộ · không đồng bộ"
    : "Chưa kết nối Firebase";
}
function render() {
  renderShell();
  const el = document.querySelector("#view");
  if (state.view === "dashboard") el.innerHTML = dashboard();
  else if (state.view === "sales") el.innerHTML = salesView();
  else if (state.view === "salesList") el.innerHTML = listView("sales");
  else if (state.view === "history") el.innerHTML = historyView();
  else if (state.view === "backup") el.innerHTML = backupView();
  else el.innerHTML = listView(state.view);
  decorateControls();
}
function dashboard() {
  const menu = activeMenu().length,
    ingredients = activeRows("ingredients"),
    ing = ingredients.length,
    reorderSettings = activeRows("reorderSettings"),
    inventoryRows = ingredients
      .map((i) => {
        const minimum = Number(
          reorderSettings.find((r) => r.ingredientId === i.id)?.minimumStock ??
            i.minimumStock ??
            0,
        );
        const stock = Number(i.stock || 0);
        return {
          ...i,
          stock,
          minimum,
          deficit: Math.max(0, minimum - stock),
          level: stock <= 0 ? "out" : stock <= minimum ? "low" : "ok",
        };
      })
      .sort((a, b) => {
        if (a.level !== b.level) return a.level === "out" ? -1 : b.level === "out" ? 1 : a.level === "low" ? -1 : 1;
        return a.stock - b.stock;
      }),
    lowRows = inventoryRows.filter((i) => i.level !== "ok"),
    out = inventoryRows.filter((i) => i.level === "out").length,
    low = lowRows.length;
  const inventoryRowsHtml = lowRows.length
    ? lowRows
        .map(
          (i) =>
            '<div class="inventory-alert-row"><div><strong>' +
            esc(i.name) +
            '</strong><small>' +
            esc(i.id) +
            '</small></div><div class="inventory-alert-values"><strong class="' +
            (i.level === "out" ? "critical" : "attention") +
            '">' +
            esc(i.stock) +
            " " +
            esc(i.baseUnit || i.unit || "") +
            '</strong><small>Ngưỡng ' +
            esc(i.minimum) +
            " · thiếu " +
            esc(i.deficit) +
            '</small></div><span class="badge ' +
            (i.level === "out" ? "critical-badge" : "warn") +
            '">' +
            (i.level === "out" ? "HẾT" : "SẮP HẾT") +
            '</span></div>',
        )
        .join("")
    : '<div class="empty inventory-empty"><strong>Tồn kho đang an toàn</strong><span>Chưa có nguyên liệu nào chạm ngưỡng đặt hàng.</span></div>';
  const inventorySnapshotHtml = inventoryRows.length
    ? inventoryRows
        .map(
          (i) =>
            '<div class="inventory-snapshot-row"><div><strong>' +
            esc(i.name) +
            '</strong><small>Ngưỡng đặt hàng: ' +
            esc(i.minimum) +
            ' ' +
            esc(i.baseUnit || i.unit || '') +
            '</small></div><strong class="inventory-snapshot-stock ' +
            (i.level === 'out' ? 'critical' : i.level === 'low' ? 'attention' : '') +
            '">' +
            esc(i.stock) +
            ' ' +
            esc(i.baseUnit || i.unit || '') +
            '</strong></div>',
        )
        .join('')
    : '<div class="empty inventory-empty"><strong>Chưa có nguyên liệu</strong><span>Thêm nguyên liệu để theo dõi số dư.</span></div>';
  return (
    '<div class="grid stats-grid inventory-stats"><div class="card stat-card"><p>Cần đặt hàng</p><strong>' +
    low +
    '</strong><small>Ưu tiên xử lý trước khi hết</small></div><div class="card stat-card"><p>Đã hết hàng</p><strong class="' +
    (out ? "critical" : "") +
    '">' +
    out +
    '</strong><small>Kiểm tra ngay hôm nay</small></div><div class="card stat-card"><p>Nguyên liệu</p><strong>' +
    ing +
    '</strong><small>Đang theo dõi tồn kho</small></div><div class="card stat-card"><p>Món đang bán</p><strong>' +
    menu +
    '</strong><small>Menu cố định</small></div></div><div class="grid inventory-dashboard-grid"><div class="card inventory-priority-card"><div class="section-head"><div><p class="eyebrow">Ưu tiên hôm nay</p><h2>Nguyên liệu cần đặt</h2></div><button class="secondary-button" data-view-link="ingredients">Chỉnh ngưỡng</button></div><p class="inventory-lead">Theo dõi số dư hiện tại và đặt hàng trước khi nguyên liệu chạm mức tối thiểu.</p><div class="inventory-alert-list">' +
    inventoryRowsHtml +
    '</div><div class="toolbar inventory-actions"><button class="primary-button" data-view-link="ingredients">Mở tồn kho</button><button class="secondary-button" data-view-link="stockCounts">Kiểm kho</button></div></div><div class="card inventory-snapshot-card"><div class="section-head"><div><p class="eyebrow">Số dư hiện tại</p><h2>Tồn kho hiện tại</h2></div></div><div class="inventory-snapshot-list">' +
    inventorySnapshotHtml +
    '</div></div></div><div class="grid backup-grid"><div class="card"><div class="section-head"><div><p class="eyebrow">Lối tắt</p><h2>Nhập liệu nhanh</h2></div></div><div class="toolbar"><button class="primary-button" data-view-link="purchaseReceipts">Nhập hàng</button><button class="secondary-button" data-view-link="stockCounts">Kiểm kho</button><button class="secondary-button" data-view-link="menuItems">Cài đặt menu</button></div><div class="notice" style="margin-top:16px">Dataset hiện tại: <strong>' +
    esc(repo.datasetId) +
    '</strong>. Mỗi thay đổi có phiên bản và lịch sử; thay đổi tồn kho có bút toán riêng.</div></div><details class="card ai-box"' + (state.aiDraft ? " open" : "") + '><summary>Nhập bằng AI (nâng cao)</summary><textarea id="ai-batch-input" class="textarea" rows="5" placeholder="{&quot;schemaVersion&quot;:1,&quot;module&quot;:&quot;sales&quot;,&quot;operation&quot;:&quot;create&quot;,&quot;records&quot;:[]}"></textarea><div class="toolbar" style="margin-top:10px"><button class="secondary-button" data-action="validate-ai" data-testid="validate-batch">Kiểm tra dữ liệu</button></div><div id="ai-preview-container">' +
    (state.aiDraft ? aiPreview() : "") +
    '</div></details></div><div class="card" style="margin-top:16px"><div class="section-head"><div><p class="eyebrow">Mới nhất</p><h2>Lịch sử gần đây</h2></div><button class="secondary-button" data-view-link="history">Xem tất cả</button></div>' +
    timeline(state.history.slice(0, 5), true) +
    "</div>"
  );
}
function salesView() {
  const menus = activeMenu(),
    q = normalize(state.salesSearch),
    filtered = menus.filter(
      (m) =>
        !q ||
        [m.name, m.code, ...(m.aliases || [])].some((v) =>
          normalize(v).includes(q),
        ),
    );
  const total = state.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const inCart = (id) => state.cart.find((i) => i.menuItemId === id)?.quantity;
  return (
    '<div class="section-head"><div><p class="eyebrow">Bán hàng</p><h2>Nhập món bán</h2></div><div class="toolbar"><button class="secondary-button" data-view-link="salesList" data-testid="view-invoices">Danh sách hóa đơn</button></div></div><div class="grid backup-grid"><div class="card"><div class="form-grid" style="padding:0">' +
    input("sale-date", "Ngày bán", state.salesDate, "date") +
    input(
      "invoice-number",
      "Mã hóa đơn (không bắt buộc)",
      state.salesInvoice,
      "text",
      'data-testid="invoice-number"',
    ) +
    '</div><div class="field" style="margin-top:14px"><label for="menu-search">Chạm vào món để thêm</label><input class="input" id="menu-search" type="search" placeholder="Tìm tên món..." value="' +
    esc(state.salesSearch) +
    '" data-testid="menu-search"></div>' +
    (filtered.length
      ? '<div class="menu-tiles">' +
        filtered
          .map(
            (m) =>
              '<button class="menu-tile" data-action="tile-add" data-id="' +
              esc(m.id) +
              '"><strong>' +
              esc(m.name) +
              "</strong><small>" +
              money(m.price) +
              "</small>" +
              (inCart(m.id)
                ? '<span class="tile-count">×' + inCart(m.id) + "</span>"
                : "") +
              "</button>",
          )
          .join("") +
        "</div>"
      : '<div class="empty"><strong>' +
        (menus.length ? "Không tìm thấy món" : "Chưa có món") +
        "</strong><span>" +
        (menus.length ? "Thử từ khóa khác." : "Thêm món ở mục “Món bán”.") +
        "</span></div>") +
    '</div><div class="card"><div class="section-head"><div><h2>Hóa đơn</h2></div><strong id="sale-total" data-testid="sale-total">' +
    money(total) +
    "</strong></div>" +
    (state.cart.length
      ? '<div class="cart-list">' +
        state.cart
          .map(
            (i, n) =>
              '<div class="cart-row" data-row-id="cart-' +
              esc(i.menuItemId) +
              '"><div><strong>' +
              esc(i.name) +
              "</strong><small>" +
              money(i.price) +
              ' · <span class="muted">' +
              money(i.price * i.quantity) +
              '</span></small></div><div class="stepper"><button class="secondary-button" data-action="cart-dec" data-index="' +
              n +
              '" aria-label="Giảm ' +
              esc(i.name) +
              '">−</button><span class="stepper-qty" aria-live="polite">' +
              i.quantity +
              '</span><button class="secondary-button" data-action="cart-inc" data-index="' +
              n +
              '" aria-label="Tăng ' +
              esc(i.name) +
              '">+</button><button class="danger-button" data-action="remove-cart" data-index="' +
              n +
              '" aria-label="Xóa ' +
              esc(i.name) +
              '">×</button></div></div>',
          )
          .join("") +
        '</div><div class="toolbar" style="justify-content:flex-end;margin-top:16px"><button class="secondary-button" data-action="clear-cart">Xóa hết</button><button class="primary-button" data-action="save-sale" data-testid="save-sale">Lưu hóa đơn</button></div>'
      : '<div class="empty"><strong>Chưa có món</strong><span>Chạm vào món để thêm vào hóa đơn.</span></div>') +
    '</div></div><details class="card ai-box" style="margin-top:16px"' +
    (state.aiDraft?.module === "sales" ? " open" : "") +
    '><summary>Nhập nhiều hóa đơn bằng AI (nâng cao)</summary><textarea id="sales-ai-input" class="textarea" rows="7" data-testid="ai-batch-input" placeholder="{&quot;schemaVersion&quot;:1,&quot;module&quot;:&quot;sales&quot;,&quot;operation&quot;:&quot;create&quot;,&quot;records&quot;:[{&quot;invoiceNo&quot;:&quot;HD002587&quot;,&quot;date&quot;:&quot;2026-10-09&quot;,&quot;items&quot;:[{&quot;menuName&quot;:&quot;AMERICANO&quot;,&quot;quantity&quot;:1}],&quot;expectedTotal&quot;:39000}]}"></textarea><div class="toolbar" style="margin-top:10px"><button class="secondary-button" data-action="validate-sales-ai" data-testid="validate-batch">Kiểm tra batch</button></div><div id="sales-ai-preview">' +
    (state.aiDraft?.module === "sales" ? aiPreview() : "") +
    "</div></details>"
  );
}
function rowSummary(collection, r) {
  if (collection === "menuItems")
    return [money(r.price), r.group, itemsText(recipeFor(r.id)?.items)]
      .filter(Boolean)
      .join(" · ");
  if (collection === "ingredients")
    return (
      "Tồn " + r.stock + " " + unitText(r.baseUnit) +
      " · ngưỡng " + (r.minimumStock ?? 0)
    );
  if (collection === "recipes") return itemsText(r.items) || "—";
  if (collection === "sales")
    return r.date + " · " + money(r.total) + " · " + itemsText(r.items);
  if (collection === "purchaseReceipts")
    return r.date + " · " + (itemsText(r.items) || "—");
  if (collection === "stockCounts")
    return (
      r.date + " · " + (r.adjusted ? "Đã điều chỉnh tồn" : "Chưa áp dụng") +
      " · " + itemsText(r.items)
    );
  if (collection === "reorderSettings")
    return "Ngưỡng " + r.minimumStock + (r.note ? " · " + r.note : "");
  return r.note || "—";
}
function listView(collection) {
  const rows = [...(state.catalog[collection] || [])].sort((a, b) =>
    a.status === b.status
      ? String(a.name || "").localeCompare(String(b.name || ""), "vi")
      : a.status === "ACTIVE"
        ? -1
        : b.status === "ACTIVE"
          ? 1
          : 0,
  );
  const q = state.filters.q.toLowerCase();
  const filtered = rows.filter(
    (r) => !q || JSON.stringify(r).toLowerCase().includes(q),
  );
  const noun = labels[collection];
  return (
    '<div class="section-head"><div><p class="eyebrow">Thiết lập</p><h2>' +
    esc(noun) +
    '</h2></div><div class="toolbar"><input class="input" id="list-search" type="search" aria-label="Tìm nhanh" placeholder="Tìm nhanh..." value="' +
    esc(state.filters.q) +
    '">' +
    (collection === "recipes"
      ? ""
      : '<button class="primary-button" data-action="add" data-collection="' +
        collection +
        '">+ Thêm</button>') +
    '</div></div>' +
    (collection === "recipes"
      ? '<p class="notice">Công thức được nhập cùng món ở mục “Món bán”. Tại đây chỉ xem phiên bản, lịch sử và khôi phục.</p>'
      : "") +
    '<div class="card">' +
    (filtered.length
      ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Tên</th><th>Thông tin</th><th>Trạng thái</th><th>Phiên bản</th><th>Thao tác</th></tr></thead><tbody>' +
        filtered
          .map(
            (r) =>
              '<tr data-row-id="' +
              esc(r.id) +
              '"><td class="wrap"><strong>' +
              esc(r.name || r.id) +
              "</strong>" +
              (r.code ? "<br><small>" + esc(r.code) + "</small>" : "") +
              '</td><td class="wrap summary-cell">' +
              esc(rowSummary(collection, r)) +
              '</td><td><span class="badge ' +
              (r.status === "ARCHIVED" ? "archived" : "") +
              '">' +
              esc(STATUS_LABELS[r.status] || r.status || "Đang dùng") +
              "</span></td><td>v" +
              (r.version || 1) +
              '</td><td class="wrap"><div class="toolbar row-actions">' +
              (collection === "recipes" || (collection === "stockCounts" && r.adjusted)
                ? ""
                : '<button class="secondary-button" data-action="edit" data-collection="' +
                  collection +
                  '" data-id="' +
                  esc(r.id) +
                  '">Sửa</button>') +
              (r.status === "ARCHIVED"
                ? '<button class="secondary-button" data-action="unarchive" data-collection="' +
                  collection +
                  '" data-id="' +
                  esc(r.id) +
                  '">Hiện lại</button>'
                : '<button class="danger-button" data-action="archive" data-collection="' +
                  collection +
                  '" data-id="' +
                  esc(r.id) +
                  '">Ẩn</button>') +
              '<details class="more-actions"><summary>Xem thêm</summary><div class="toolbar">' +
              '<button class="secondary-button" data-action="versions" data-collection="' +
              collection +
              '" data-id="' +
              esc(r.id) +
              '">Phiên bản</button>' +
              (collection === "menuItems" && recipeFor(r.id)
                ? '<button class="secondary-button" data-action="versions" data-collection="recipes" data-id="' +
                  esc(recipeFor(r.id).id) +
                  '">Phiên bản công thức</button>'
                : "") +
              '<button class="secondary-button" data-action="entity-history" data-collection="' +
              collection +
              '" data-id="' +
              esc(r.id) +
              '">Lịch sử</button></div></details>' +
              "</div></td></tr>",
          )
          .join("") +
        "</tbody></table></div>"
      : '<div class="empty"><strong>' +
        (q ? "Không tìm thấy kết quả" : "Chưa có dữ liệu") +
        "</strong><span>" +
        (q ? "Thử từ khóa khác." : "Bấm “+ Thêm” để tạo bản ghi đầu tiên.") +
        "</span></div>") +
    "</div>"
  );
}
function eventSummary(e) {
  const name = e.after?.name || e.before?.name || "";
  const parts = [];
  if (e.before && e.after) {
    for (const k of diffFields(e.before, e.after).slice(0, 4)) {
      const b = e.before[k],
        a = e.after[k];
      parts.push(
        (typeof a === "object" || typeof b === "object") && k !== "items"
          ? (FIELD_LABELS[k] || k) + " thay đổi"
          : (FIELD_LABELS[k] || k) + ": " + fmtVal(k, b) + " → " + fmtVal(k, a),
      );
    }
  } else if (e.after) {
    if (e.after.total != null) parts.push("Tổng " + money(e.after.total));
    else if (e.after.price != null) parts.push("Giá " + money(e.after.price));
    else if (e.after.stock != null && e.entityType === "ingredients")
      parts.push("Tồn đầu " + e.after.openingStock + " " + unitText(e.after.baseUnit));
    if (e.after.items?.length) parts.push(itemsText(e.after.items));
  }
  if (e.note) parts.push(e.note);
  return { name, text: parts.join(" · ") || "Thay đổi dữ liệu" };
}
function timeline(rows, compact = false) {
  if (!rows.length)
    return '<div class="empty"><strong>Chưa có lịch sử</strong><span>Các thay đổi đã xác nhận sẽ xuất hiện tại đây.</span></div>';
  return (
    '<div class="timeline">' +
    rows
      .map((e) => {
        const sum = eventSummary(e);
        return (
          '<article class="timeline-item"><div class="timeline-date">' +
          dateText(e.timestamp) +
          "</div><div><h3>" +
          esc(ACTION_LABELS[e.action] || e.action) +
          " · " +
          esc(labels[e.entityType] || e.entityType) +
          (sum.name ? " " + esc(sum.name) : "") +
          "</h3><p>" +
          esc(sum.text) +
          ' <span class="badge ' +
          (e.source === "AI-Assisted" ? "ai" : "") +
          '">' +
          esc(e.source || "Manual") +
          '</span></p></div><div class="event-actions"><button class="secondary-button" data-action="event-detail" data-event-id="' +
          esc(e.eventId) +
          '">Chi tiết</button>' +
          (!compact &&
          ENTITY_COLLECTIONS.includes(e.entityType) &&
          e.before &&
          e.after &&
          e.action !== "RESTORE"
            ? '<button class="secondary-button" data-action="restore-event" data-event-id="' +
              esc(e.eventId) +
              '">Khôi phục</button>'
            : "") +
          "</div></article>"
        );
      })
      .join("") +
    "</div>"
  );
}
function historyView() {
  const rows = state.history.filter((e) => {
    const f = state.filters,
      q = f.q.toLowerCase(),
      date = e.timestamp?.slice(0, 10);
    return (
      (!q || JSON.stringify(e).toLowerCase().includes(q)) &&
      (!f.entity || e.entityType === f.entity) &&
      (!f.entityId || e.entityId === f.entityId) &&
      (!f.action || e.action === f.action) &&
      (!f.source || e.source === f.source) &&
      (!f.from || date >= f.from) &&
      (!f.to || date <= f.to)
    );
  });
  return (
    '<div class="section-head"><div><p class="eyebrow">Lịch sử hoạt động</p><h2>Lịch sử toàn hệ thống</h2></div></div><div class="card"><div class="filter-row">' +
    input("history-search", "Tìm lịch sử", state.filters.q) +
    select(
      "history-entity",
      "Loại dữ liệu",
      [
        { value: "", label: "Mọi dữ liệu" },
        ...ENTITY_COLLECTIONS.map((c) => ({ value: c, label: labels[c] })),
      ],
      state.filters.entity,
    ) +
    select(
      "history-action",
      "Thao tác",
      [
        { value: "", label: "Mọi thao tác" },
        ...Object.keys(ACTIONS).map((a) => ({
          value: a,
          label: ACTION_LABELS[a] || a,
        })),
      ],
      state.filters.action,
    ) +
    select(
      "history-source",
      "Nguồn",
      [
        { value: "", label: "Mọi nguồn" },
        { value: "Manual", label: "Manual" },
        { value: "AI-Assisted", label: "AI-Assisted" },
      ],
      state.filters.source,
    ) +
    input("history-from", "Từ ngày", state.filters.from, "date") +
    input("history-to", "Đến ngày", state.filters.to, "date") +
    "</div>" +
    (state.filters.entityId
      ? '<p class="notice">Đang xem lịch sử của một đối tượng. <button class="secondary-button" data-view-link="history">Xem toàn bộ lịch sử</button></p>'
      : "") +
    timeline(rows.slice(0, state.historyLimit)) +
    (repo.historyMore || rows.length > state.historyLimit
      ? '<button class="secondary-button" data-action="history-more">Tải thêm lịch sử</button>'
      : "") +
    "</div>"
  );
}
function backupView() {
  return (
    '<div class="section-head"><div><p class="eyebrow">Data safety</p><h2>Sao lưu & khôi phục</h2></div></div><div class="notice warning">Full Restore tạo dataset mới qua staging và chỉ đổi dataset hoạt động sau khi kiểm tra checksum, liên kết và business schema. Dataset cũ vẫn giữ nguyên.</div><div class="grid backup-grid"><div class="card"><h2>Xuất backup</h2><p>Backup dataset <strong>' +
    esc(repo.datasetId) +
    '</strong>, giữ ID/liên kết, không chứa credential/token.</p><button class="primary-button" data-action="export-backup" data-testid="export-backup">Tạo file JSON</button><div id="backup-result"></div></div><div class="card"><h2>Nhập & preview</h2><p>Chọn JSON để kiểm tra schema, SHA-256, liên kết và số lượng thay đổi.</p><div class="drop-zone"><label for="backup-file">Chọn file backup</label><input id="backup-file" data-testid="backup-file" type="file" accept=".json,application/json"></div><div id="backup-preview">' +
    (state.backupDraft ? backupPreview() : "") +
    "</div></div></div>"
  );
}
function aiPreview() {
  const d = state.aiDraft;
  return (
    '<div class="notice" data-testid="batch-preview"><strong>Preview ' +
    esc(d.module) +
    "</strong><br>" +
    d.plans.length +
    ' bản ghi hợp lệ, chưa ghi dữ liệu chính thức.<div class="code-json">' +
    esc(
      JSON.stringify(
        d.plans.map((p) => ({
          id: p.id,
          action: p.action,
          warnings: p.warnings,
          before: p.before,
          after: p.after,
          stockImpact: p.impacts,
        })),
        null,
        2,
      ),
    ) +
    '</div><div class="toolbar"><button class="primary-button" data-action="confirm-ai" data-testid="commit-batch">Xác nhận lưu</button><button class="secondary-button" data-action="cancel-ai">Hủy</button></div></div>'
  );
}
function backupPreview() {
  const b = state.backupDraft;
  const diffRowsOf = (c) => {
    const d = backupDiff(b.collections[c], state.catalog[c]);
    return [...d.added, ...d.changed];
  };
  const groups = ENTITY_COLLECTIONS.map((c) => [c, diffRowsOf(c)]).filter(
    ([, rows]) => rows.length,
  );
  return (
    '<div class="notice" data-testid="backup-preview" style="margin-top:12px"><strong>Backup hợp lệ</strong><p>Dataset ' +
    esc(b.datasetId) +
    " · tạo lúc " +
    dateText(b.createdAt) +
    '</p><div class="table-wrap"><table class="data-table"><thead><tr><th>Dữ liệu</th><th>Backup</th><th>Hiện tại</th><th>Thêm</th><th>Khác</th></tr></thead><tbody>' +
    backupSummary(b, state.catalog)
      .map(
        (r) =>
          '<tr data-row-id="backup-' +
          esc(r.collection) +
          '"><td>' +
          esc(labels[r.collection]) +
          "</td><td>" +
          r.backup +
          "</td><td>" +
          r.current +
          "</td><td>" +
          r.added +
          "</td><td>" +
          r.changed +
          "</td></tr>",
      )
      .join("") +
    '</tbody></table></div><h3>Khôi phục chọn lọc</h3><p>Chỉ hiển thị bản ghi khác dữ liệu hiện tại. Khôi phục đi qua nghiệp vụ và bút toán chênh lệch. Cấu hình nguyên liệu giữ tồn đầu hiện tại; phiếu kiểm đã điều chỉnh cần phiếu mới.</p>' +
    (groups.length
      ? '<div class="toolbar"><button class="secondary-button" data-action="select-all-backup">Chọn tất cả</button><button class="secondary-button" data-action="select-none-backup">Bỏ chọn</button></div>' +
        groups
          .map(
            ([c, rows]) =>
              '<fieldset class="checklist"><legend>' +
              esc(labels[c]) +
              " (" +
              rows.length +
              ")</legend>" +
              rows
                .map(
                  (r) =>
                    '<div class="check-row"><input type="checkbox" id="selected-' +
                    esc(c) +
                    "-" +
                    esc(r.id) +
                    '" data-backup-selection="' +
                    c +
                    '" data-id="' +
                    esc(r.id) +
                    '" ' +
                    (c === "stockCounts" && r.adjusted ? "disabled" : "") +
                    '><label for="selected-' +
                    esc(c) +
                    "-" +
                    esc(r.id) +
                    '">' +
                    esc(r.name || r.id) +
                    (c === "stockCounts" && r.adjusted
                      ? " (đã điều chỉnh — không restore trực tiếp)"
                      : "") +
                    "</label></div>",
                )
                .join("") +
              "</fieldset>",
          )
          .join("")
      : '<p class="muted">Backup giống hệt dữ liệu hiện tại — không có gì để khôi phục chọn lọc.</p>') +
    '<div class="toolbar" style="margin-top:14px"><button class="primary-button" data-action="selected-preview">Xem trước các bản ghi đã chọn</button><button class="danger-button" data-action="confirm-full-restore">Full Restore (thay toàn bộ)</button><button class="secondary-button" data-action="cancel-backup">Hủy</button></div></div>'
  );
}
async function previewSelected() {
  const catalog = clone(state.catalog),
    plans = [];
  const chosen = [
    ...document.querySelectorAll("[data-backup-selection]:checked"),
  ];
  if (!chosen.length) throw new BusinessError("Chọn ít nhất một bản ghi.");
  for (const c of [
    "ingredients",
    "menuItems",
    "recipes",
    "sales",
    "purchaseReceipts",
    "stockCounts",
    "reorderSettings",
  ])
    for (const input of chosen.filter((i) => i.dataset.backupSelection === c)) {
      const row = state.backupDraft.collections[c].find(
          (r) => r.id === input.dataset.id,
        ),
        before = catalog[c].find((r) => r.id === row.id) || null,
        data = clone(row);
      if (c === "ingredients" && before)
        data.openingStock = before.openingStock;
      const plan = {
        ...previewChange(
          {
            collection: c,
            id: row.id,
            data,
            before,
            restore: true,
            action: "RESTORE",
            note: "Restore Selected từ backup " + state.backupDraft.createdAt,
          },
          catalog,
        ),
        datasetId: repo.datasetId,
        expectedRevision: repo.revision,
      };
      plans.push(plan);
      catalog[c] = [
        ...catalog[c].filter((r) => r.id !== row.id),
        { ...plan.after, id: row.id, version: plan.expectedVersion + 1 },
      ];
      for (const impact of plan.impacts) {
        const ing = catalog.ingredients.find(
          (i) => i.id === impact.ingredientId,
        );
        if (ing) ing.stock += impact.quantity;
      }
    }
  showRestorePreview(plans);
}
// Structured line-item editor (replaces raw JSON textareas).
const ITEM_KIND = {
  recipes: { main: "ingredient", label: "Nguyên liệu", qty: "Định lượng" },
  purchaseReceipts: {
    main: "ingredient",
    label: "Nguyên liệu nhập",
    qty: "Số lượng",
    unit: true,
    cost: true,
  },
  stockCounts: {
    main: "ingredient",
    label: "Nguyên liệu kiểm",
    qty: "Tồn thực tế",
    unit: true,
  },
  sales: { main: "menu", label: "Món", qty: "Số lượng" },
};
function rawItems(items = []) {
  return items.map((i) => ({
    main: i.menuItemId || i.ingredientId || "",
    qty: i.quantity ?? i.actual ?? "",
    unit: i.unit || "",
    cost: i.unitCost ?? "",
  }));
}
function unitChoices(ing) {
  if (!ing) return [{ value: "", label: "—" }];
  const o = [{ value: ing.baseUnit, label: unitText(ing.baseUnit) }];
  if (ing.baseUnit === "g") o.push({ value: "kg", label: "kg" });
  if (ing.baseUnit === "ml") o.push({ value: "l", label: "lít" });
  if (ing.packageSize > 0) o.push({ value: "package", label: "chai/hộp" });
  return o;
}
// Active rows plus the currently selected one (which may be archived).
const selectable = (collection, keepId) =>
  (state.catalog[collection] || []).filter(
    (r) => r.status === "ACTIVE" || r.id === keepId,
  );
function itemRow(collection, n, row) {
  const k = ITEM_KIND[collection];
  const opts = selectable(k.main === "menu" ? "menuItems" : "ingredients", row.main);
  const ing = k.main === "ingredient" ? ingredientById(row.main) : null;
  const options = [
    '<option value="">— Chọn ' + (k.main === "menu" ? "món" : "nguyên liệu") + " —</option>",
    ...opts.map(
      (o) =>
        '<option value="' +
        esc(o.id) +
        '"' +
        (o.id === row.main ? " selected" : "") +
        ">" +
        esc(o.name) +
        "</option>",
    ),
  ].join("");
  const no = n + 1;
  return (
    '<div class="item-row" role="group" aria-label="Dòng ' +
    no +
    '"><select class="select item-main" id="item-' +
    n +
    '-main" aria-label="' +
    k.label +
    " dòng " +
    no +
    '">' +
    options +
    '</select><input class="input item-qty" id="item-' +
    n +
    '-qty" type="number" min="0" step="any" inputmode="decimal" placeholder="' +
    k.qty +
    '" aria-label="' +
    k.qty +
    " dòng " +
    no +
    '" value="' +
    esc(row.qty) +
    '">' +
    (k.unit
      ? '<select class="select item-unit" id="item-' +
        n +
        '-unit" aria-label="Đơn vị dòng ' +
        no +
        '">' +
        unitChoices(ing)
          .map(
            (u) =>
              '<option value="' +
              esc(u.value) +
              '"' +
              ((row.unit || ing?.baseUnit) === u.value ? " selected" : "") +
              ">" +
              esc(u.label) +
              "</option>",
          )
          .join("") +
        "</select>"
      : k.main === "ingredient" && ing
        ? '<span class="item-unit-text">' + esc(unitText(ing.baseUnit)) + "</span>"
        : "") +
    (k.cost
      ? '<input class="input item-cost" id="item-' +
        n +
        '-cost" type="number" min="0" step="any" inputmode="decimal" placeholder="Giá / đơn vị" aria-label="Giá nhập dòng ' +
        no +
        '" value="' +
        esc(row.cost) +
        '">'
      : "") +
    '<button type="button" class="danger-button" data-item-op="remove" data-index="' +
    n +
    '" aria-label="Xóa dòng ' +
    no +
    '">Xóa</button></div>'
  );
}
function itemRowsHtml(collection, rows) {
  return (
    rows.map((r, n) => itemRow(collection, n, r)).join("") ||
    '<p class="muted">Chưa có dòng nào. Bấm “+ Thêm dòng”.</p>'
  );
}
function itemsEditor(collection, rows, title = "Chi tiết") {
  const list = rows.length ? rows : [{ main: "", qty: "", unit: "", cost: "" }];
  return (
    '<div class="field full" role="group" aria-labelledby="items-title"><span class="field-title" id="items-title">' +
    esc(title) +
    '</span><div id="items-editor" data-collection="' +
    collection +
    '">' +
    itemRowsHtml(collection, list) +
    '</div><div><button type="button" class="secondary-button" data-item-op="add">+ Thêm dòng</button></div></div>'
  );
}
function readRawRows() {
  return [...document.querySelectorAll("#items-editor .item-row")].map(
    (r) => ({
      main: r.querySelector(".item-main")?.value || "",
      qty: r.querySelector(".item-qty")?.value ?? "",
      unit: r.querySelector(".item-unit")?.value || "",
      cost: r.querySelector(".item-cost")?.value ?? "",
    }),
  );
}
function redrawItems(rows) {
  const el = document.querySelector("#items-editor");
  el.innerHTML = itemRowsHtml(el.dataset.collection, rows);
  decorateControls();
}
function readItems(collection) {
  return readRawRows().map((r) => {
    if (!r.main) throw new BusinessError("Mỗi dòng cần chọn một mục.");
    if (collection === "sales")
      return { menuItemId: r.main, quantity: r.qty };
    if (collection === "recipes")
      return { ingredientId: r.main, quantity: r.qty };
    if (collection === "stockCounts")
      return { ingredientId: r.main, actual: r.qty, unit: r.unit || undefined };
    return {
      ingredientId: r.main,
      quantity: r.qty,
      unit: r.unit || undefined,
      unitCost: r.cost === "" ? 0 : r.cost,
    };
  });
}
function formFields(collection, data = {}) {
  const menuOpts = [
    { value: "", label: "— Chọn món —" },
    ...selectable("menuItems", data.menuItemId).map((m) => ({
      value: m.id,
      label: m.name + " · " + money(m.price),
    })),
  ];
  const ingOpts = [
    { value: "", label: "— Chọn nguyên liệu —" },
    ...selectable("ingredients", data.ingredientId).map((i) => ({
      value: i.id,
      label: i.name + " (" + unitText(i.baseUnit) + ")",
    })),
  ];
  if (collection === "menuItems")
    return (
      input("entity-name", "Tên món (tiếng Anh)", data.name) +
      input(
        "entity-price",
        "Giá bán",
        data.price,
        "number",
        'min="0" step="1000" inputmode="numeric"',
      ) +
      '<details class="field full more-fields"' +
      (data.code || data.group || (data.unit && data.unit !== "ly") ? " open" : "") +
      '><summary>Tùy chọn khác (mã, nhóm, đơn vị)</summary><div class="form-grid">' +
      input("entity-code", "Mã món", data.code) +
      input("entity-group", "Nhóm món", data.group) +
      input("entity-unit", "Đơn vị bán", data.unit || "ly") +
      "</div></details>" +
      itemsEditor(
        "recipes",
        rawItems(data.recipeItems),
        "Thành phần cho 1 " + (data.unit || "ly"),
      )
    );
  if (collection === "ingredients")
    return (
      input("entity-name", "Tên nguyên liệu", data.name) +
      select(
        "entity-base-unit",
        "Đơn vị chuẩn",
        ["g", "ml", "unit"].map((u) => ({ value: u, label: unitText(u) })),
        data.baseUnit || "g",
      ) +
      input(
        "entity-package-size",
        "Quy cách 1 chai/hộp",
        data.packageSize || 0,
        "number",
      ) +
      input(
        "entity-opening-stock",
        "Tồn đầu",
        data.openingStock || 0,
        "number",
        data.id ? "readonly" : "",
      ) +
      input(
        "entity-minimum-stock",
        "Ngưỡng đặt hàng",
        data.minimumStock || 0,
        "number",
      ) +
      input(
        "entity-unit-cost",
        "Giá vốn / đơn vị",
        data.unitCost || 0,
        "number",
      )
    );
  if (collection === "recipes")
    return (
      select("entity-menu-id", "Món", menuOpts, data.menuItemId) +
      itemsEditor("recipes", rawItems(data.items))
    );
  if (collection === "sales")
    return (
      input("entity-date", "Ngày bán", data.date || state.salesDate, "date") +
      input("entity-invoice", "Mã hóa đơn", data.invoiceNo || "") +
      itemsEditor("sales", rawItems(data.items)) +
      textarea("entity-note", "Ghi chú", data.note || "")
    );
  if (collection === "purchaseReceipts")
    return (
      input("entity-date", "Ngày nhập", data.date || state.salesDate, "date") +
      itemsEditor("purchaseReceipts", rawItems(data.items)) +
      textarea("entity-note", "Ghi chú", data.note || "")
    );
  if (collection === "stockCounts")
    return (
      input("entity-date", "Ngày kiểm", data.date || state.salesDate, "date") +
      itemsEditor("stockCounts", rawItems(data.items)) +
      textarea("entity-note", "Ghi chú", data.note || "")
    );
  return (
    select("entity-ingredient-id", "Nguyên liệu", ingOpts, data.ingredientId || "") +
    input("entity-minimum-stock", "Ngưỡng", data.minimumStock || 0, "number") +
    textarea("entity-note", "Ghi chú", data.note || "")
  );
}
const recipeFor = (menuItemId) =>
  (state.catalog.recipes || []).find(
    (r) => r.menuItemId === menuItemId && r.status === "ACTIVE",
  );
function openEditor(collection, id) {
  state.editing = { collection, id };
  const data = id
    ? { ...((state.catalog[collection] || []).find((r) => r.id === id) || {}) }
    : {};
  if (collection === "menuItems" && id)
    data.recipeItems = recipeFor(id)?.items || [];
  document.querySelector("#dialogEyebrow").textContent = labels[collection];
  document.querySelector("#dialogTitle").textContent = id
    ? "Sửa bản ghi"
    : "Thêm bản ghi";
  document.querySelector("#dialogFields").innerHTML =
    '<div class=\"form-grid\">' + formFields(collection, data) + "</div>";
  decorateControls();
  document.querySelector("#entityDialog").showModal();
}
function readForm(collection) {
  const val = (id) => document.querySelector("#" + id)?.value ?? "";
  const data = {};
  if (collection === "menuItems")
    Object.assign(data, {
      name: val("entity-name"),
      englishName: "",
      aliases: [],
      code: val("entity-code"),
      group: val("entity-group"),
      price: val("entity-price"),
      unit: val("entity-unit"),
    });
  else if (collection === "ingredients")
    Object.assign(data, {
      name: val("entity-name"),
      baseUnit: val("entity-base-unit"),
      packageSize: val("entity-package-size"),
      openingStock: val("entity-opening-stock"),
      minimumStock: val("entity-minimum-stock"),
      unitCost: val("entity-unit-cost"),
    });
  else if (collection === "recipes")
    Object.assign(data, {
      menuItemId: val("entity-menu-id"),
      items: readItems("recipes"),
    });
  else if (collection === "sales")
    Object.assign(data, {
      date: val("entity-date"),
      invoiceNo: val("entity-invoice"),
      items: readItems("sales"),
      note: val("entity-note"),
    });
  else if (collection === "purchaseReceipts")
    Object.assign(data, {
      date: val("entity-date"),
      items: readItems("purchaseReceipts"),
      note: val("entity-note"),
    });
  else if (collection === "stockCounts")
    Object.assign(data, {
      date: val("entity-date"),
      items: readItems("stockCounts"),
      note: val("entity-note"),
    });
  else
    Object.assign(data, {
      ingredientId: val("entity-ingredient-id"),
      minimumStock: val("entity-minimum-stock"),
      note: val("entity-note"),
    });
  return data;
}
// A menu item and its recipe are entered together and committed atomically.
async function saveMenuWithRecipe(id, before) {
  const menuId = id || uid();
  const form = readForm("menuItems");
  const items = readItems("recipes");
  if (!items.length)
    throw new BusinessError("Món cần ít nhất một thành phần và định lượng.");
  const menuPlan = planFromForm("menuItems", menuId, form, before);
  const draft = clone(state.catalog);
  draft.menuItems = [
    ...(draft.menuItems || []).filter((m) => m.id !== menuId),
    { ...menuPlan.after, id: menuId, version: menuPlan.expectedVersion + 1 },
  ];
  const oldRecipe = recipeFor(menuId);
  const recipePlan = {
    ...previewChange(
      {
        collection: "recipes",
        id: oldRecipe?.id || uid(),
        data: {
          menuItemId: menuId,
          items,
          status: menuPlan.after.status === "ACTIVE" ? "ACTIVE" : oldRecipe?.status || "ACTIVE",
        },
        before: oldRecipe ? await repo.get("recipes", oldRecipe.id) : null,
        note: "Cập nhật cùng món " + menuPlan.after.name,
      },
      draft,
    ),
    expectedRevision: repo.revision,
    datasetId: repo.datasetId,
  };
  const sameItems =
    oldRecipe &&
    canonical(oldRecipe.items.map((i) => [i.ingredientId, i.quantity])) ===
      canonical(recipePlan.after.items.map((i) => [i.ingredientId, i.quantity]));
  const plans = [];
  if (!before || diffFields(before, menuPlan.after).length) plans.push(menuPlan);
  if (!sameItems) plans.push(recipePlan);
  if (!plans.length) throw new BusinessError("Không có thay đổi để lưu.");
  await commitPlans(plans, "Đã lưu món " + menuPlan.after.name + " cùng thành phần.");
}
async function applyCount(id) {
  const before = await repo.get("stockCounts", id);
  const plan = planFromForm("stockCounts", id, before, before, {
    action: "ADJUST",
    note: "Điều chỉnh theo phiếu kiểm kho",
  });
  if (
    await askConfirm(
      "Cập nhật tồn kho theo phiếu kiểm: " + impactPlain(plan.impacts) + "?",
    )
  )
    await commitPlan(plan, "Đã cập nhật tồn kho theo kiểm kê.");
}
async function saveEditor(event) {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  decorateControls();
  const { collection, id } = state.editing;
  try {
    const before = id ? await repo.get(collection, id) : null;
    const recordId = id || uid();
    if (collection === "menuItems") await saveMenuWithRecipe(id, before);
    else
      await commitPlan(
        planFromForm(collection, recordId, readForm(collection), before),
      );
    document.querySelector("#entityDialog").close();
    // A new stock count is applied right away (after confirming) instead of a second manual step.
    if (collection === "stockCounts" && !id) await applyCount(recordId);
  } catch (e) {
    toast(e.message || "Dữ liệu chưa hợp lệ.", true);
  } finally {
    state.busy = false;
    decorateControls();
  }
}
async function restoreEvent(event, target = "before") {
  if (!event || !ENTITY_COLLECTIONS.includes(event.entityType))
    throw new BusinessError("Sự kiện này không hỗ trợ restore từng đối tượng.");
  const current = await repo.get(event.entityType, event.entityId),
    snapshot = event[target];
  if (!snapshot) throw new BusinessError("Không có snapshot để restore.");
  const data = clone(snapshot);
  if (event.entityType === "ingredients" && current)
    data.openingStock = current.openingStock;
  let plan;
  try {
    plan = planFromForm(event.entityType, event.entityId, data, current, {
      action: "RESTORE",
      note: "Khôi phục snapshot " + event.eventId,
    });
  } catch (e) {
    if (e.code !== "CHECKPOINT" || event.entityType === "stockCounts") throw e;
    plan = planFromForm(event.entityType, event.entityId, data, current, {
      action: "RESTORE",
      controlled: true,
      note: "Chờ lý do hiệu chỉnh sau kiểm kê",
    });
    plan.requiresReason = true;
  }
  showRestorePreview([plan]);
}
function showRestorePreview(plans) {
  state.restorePlans = plans;
  document.querySelector("#detailTitle").textContent = "Xem trước khôi phục";
  document.querySelector("#detailBody").innerHTML =
    '<p class="notice">Chưa có gì được ghi. Kiểm tra thay đổi bên dưới rồi bấm “Xác nhận khôi phục”.</p>' +
    plans
      .map(
        (p) =>
          "<h3>" +
          esc(labels[p.collection]) +
          " · " +
          esc(p.after.name || p.id) +
          "</h3>" +
          diffTable(p.before, p.after) +
          "<h4>Ảnh hưởng tới kho</h4>" +
          impactList(p.impacts) +
          (p.warnings.length
            ? '<p class="notice warning">' + esc(p.warnings.join(" · ")) + "</p>"
            : "") +
          rawDetails({ hienTai: p.before, sauKhoiPhuc: p.after }),
      )
      .join("") +
    (plans.some((p) => p.requiresReason)
      ? textarea(
          "restore-reason",
          "Lý do hiệu chỉnh sau kiểm kê",
          "",
          "required",
        )
      : "") +
    '<div class="toolbar sticky-actions"><button class="primary-button" data-action="confirm-restore">Xác nhận khôi phục</button><button class="secondary-button" data-action="cancel-restore">Hủy</button></div>';
  decorateControls();
  if (!document.querySelector("#detailDialog").open)
    document.querySelector("#detailDialog").showModal();
}
async function confirmRestore() {
  const plans = state.restorePlans;
  if (!plans?.length) return;
  const reason = document.querySelector("#restore-reason")?.value.trim();
  if (plans.some((p) => p.requiresReason) && !reason)
    throw new BusinessError("Cần nhập lý do hiệu chỉnh sau kiểm kê.");
  for (const p of plans) if (p.requiresReason) p.note = reason;
  await repo.commitMany(plans);
  state.restorePlans = null;
  document.querySelector("#detailDialog").close();
  await load();
  toast("Đã tạo phiên bản RESTORE và ghi bút toán chênh lệch.");
}
function eventDetail(event) {
  if (!event) return;
  state.selectedEvent = event;
  const sum = eventSummary(event);
  document.querySelector("#detailTitle").textContent =
    (ACTION_LABELS[event.action] || event.action) +
    " · " +
    (labels[event.entityType] || event.entityType) +
    (sum.name ? " " + sum.name : "");
  document.querySelector("#detailBody").innerHTML =
    "<p>" +
    dateText(event.timestamp) +
    ' · <span class="badge ' +
    (event.source === "AI-Assisted" ? "ai" : "") +
    '">' +
    esc(event.source) +
    "</span></p><p>" +
    esc(event.note || "Không có ghi chú") +
    "</p><h4>Thay đổi (trước → sau)</h4>" +
    (event.before || event.after
      ? diffTable(event.before, event.after)
      : '<p class="muted">Không có dữ liệu.</p>') +
    "<h4>Biến động kho liên quan</h4>" +
    impactList(event.stockImpact) +
    rawDetails({ truoc: event.before, sau: event.after }) +
    (ENTITY_COLLECTIONS.includes(event.entityType)
      ? '<div class="toolbar sticky-actions">' +
        (event.before
          ? '<button class="secondary-button" data-action="restore-event" data-event-id="' +
            esc(event.eventId) +
            '">Khôi phục phiên bản trước</button>'
          : "") +
        (event.after
          ? '<button class="secondary-button" data-action="restore-event" data-target="after" data-event-id="' +
            esc(event.eventId) +
            '">Khôi phục phiên bản này</button>'
          : "") +
        "</div>"
      : "");
  decorateControls();
  const d = document.querySelector("#detailDialog");
  if (!d.open) d.showModal();
}
async function versionHistory(collection, id) {
  const rows =
    repo.mode === "firebase"
      ? await repo.versions(collection, id)
      : (state.catalog.entityVersions || [])
          .filter((v) => v.collection === collection && v.entityId === id)
          .sort((a, b) => b.version - a.version);
  state.versionRows = rows;
  document.querySelector("#detailTitle").textContent =
    "Phiên bản · " + labels[collection];
  document.querySelector("#detailBody").innerHTML =
    rows
      .map(
        (v) =>
          '<article class="card" data-row-id="' +
          esc(v.id) +
          '"><h3>v' +
          v.version +
          " · " +
          dateText(v.createdAt) +
          "</h3>" +
          (v.data?.name ? "<p><strong>" + esc(v.data.name) + "</strong></p>" : "") +
          diffTable(
            rows.find((x) => x.version === v.version - 1)?.data || null,
            v.data,
          ) +
          '<button class="secondary-button" data-action="restore-version" data-id="' +
          esc(v.id) +
          '">Khôi phục v' +
          v.version +
          "</button></article>",
      )
      .join("") || "<p>Chưa có phiên bản.</p>";
  decorateControls();
  document.querySelector("#detailDialog").showModal();
}
async function exportBackup() {
  try {
    const b = await repo.backup((c, n) =>
      status("Sao lưu " + labels[c] + " · " + n + " bản ghi"),
    );
    const counts = COLLECTIONS.map((c) => [c, b.collections[c]?.length || 0]);
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    const name = "LE_CORNER_Backup_" + localStamp() + ".json";
    downloadJSON(b, name);
    document.querySelector("#backup-result").innerHTML =
      '<div class="notice" style="margin-top:12px"><strong>Đã xuất ' +
      esc(name) +
      "</strong><br>" +
      COLLECTIONS.length +
      " collection · " +
      total +
      " bản ghi · SHA-256 " +
      esc(String(b.checksum).slice(0, 16)) +
      "…" +
      rawDetails(Object.fromEntries(counts), "Chi tiết từng collection") +
      "</div>";
    status("Đã sao lưu " + dateText(now()));
    toast("Đã tạo backup JSON (" + total + " bản ghi).");
  } catch (e) {
    status("Sao lưu thất bại");
    toast(e.message || "Backup thất bại — file chưa được tạo.", true);
  }
}
async function readBackup(file) {
  try {
    if (file.size > 20 * 1024 * 1024)
      throw new BusinessError("Backup tối đa 20 MB.");
    let b;
    try {
      b = JSON.parse(await file.text());
    } catch {
      throw new BusinessError("File không phải JSON hợp lệ.");
    }
    const check = await validateBackup(b);
    if (!check.ok) throw new BusinessError(check.errors.slice(0, 8).join(" "));
    state.backupDraft = b;
    render();
    toast("Backup hợp lệ, đã hiển thị preview.");
  } catch (e) {
    state.backupDraft = null;
    render();
    toast(e.message || "Backup không hợp lệ.", "error");
  }
}
async function fullRestore() {
  if (
    !state.backupDraft ||
    !(await askConfirm(
      "Thay thế toàn bộ trạng thái đang hoạt động bằng backup? Dữ liệu hiện tại sẽ được sao lưu và giữ riêng.",
    ))
  )
    return;
  try {
    const safety = await repo.backup();
    downloadJSON(safety, "LE_CORNER_Safety_" + localStamp() + ".json");
    status("Đang restore theo batch...");
    await repo.fullRestore(state.backupDraft, (c, n) =>
      status("Khôi phục " + c + " · " + n + " bản ghi"),
    );
    state.backupDraft = null;
    await load();
    toast("Full Restore hoàn tất, dataset cũ vẫn được giữ.");
  } catch (e) {
    status("Restore thất bại");
    toast(e.message || "Restore thất bại; dataset hiện tại được giữ.", "error");
  }
}
async function validateAI(text, place) {
  try {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new BusinessError("Nội dung dán vào không phải JSON hợp lệ.");
    }
    const plans = buildBatch(payload, state.catalog).map((p) => ({
      ...p,
      datasetId: repo.datasetId,
      expectedRevision: repo.revision,
    }));
    state.aiDraft = { ...payload, plans };
    document.querySelector(place).innerHTML = aiPreview();
    toast("Preview đã sẵn sàng; chưa có dữ liệu chính thức nào thay đổi.");
  } catch (e) {
    toast(e.message || "Payload AI không hợp lệ.", "error");
  }
}
async function confirmAI() {
  if (!state.aiDraft) return;
  try {
    await repo.commitMany(state.aiDraft.plans);
    state.aiDraft = null;
    await load();
    toast("Đã commit các bản ghi AI sau khi xác nhận.");
  } catch (e) {
    toast(e.message || "AI batch thất bại.", "error");
  }
}
function cartPlan() {
  const data = {
    date: state.salesDate,
    invoiceNo: state.salesInvoice,
    items: state.cart.map((i) => ({
      menuItemId: i.menuItemId,
      quantity: i.quantity,
    })),
  };
  return planFromForm("sales", uid(), data, null);
}
function cartAdd(id) {
  const menu = activeMenu().find((m) => m.id === id);
  if (!menu) return;
  const existing = state.cart.find((i) => i.menuItemId === id);
  if (existing) existing.quantity += 1;
  else
    state.cart.push({
      menuItemId: id,
      name: menu.name,
      price: menu.price,
      quantity: 1,
    });
  render();
}
async function saveSale() {
  try {
    const id = uid(),
      before = null,
      data = {
        date: document.querySelector("#sale-date").value,
        invoiceNo: document.querySelector("#invoice-number").value,
        items: state.cart.map((i) => ({
          menuItemId: i.menuItemId,
          quantity: i.quantity,
        })),
      };
    const plan = planFromForm("sales", id, data, before);
    await commitPlan(plan);
    state.cart = [];
    state.salesInvoice = "";
    render();
    toast("Đã lưu hóa đơn" + (data.invoiceNo ? " " + data.invoiceNo : "") + ".");
  } catch (e) {
    toast(e.message || "Không thể lưu hóa đơn.", "error");
  }
}
document.querySelector("#mainNav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b) return;
  navigate(b.dataset.view);
  syncSidebar();
});
async function handleAction(e) {
  const t = e.target.closest("[data-action],[data-view-link]");
  if (!t || state.busy) return;
  if (t.dataset.viewLink) {
    navigate(t.dataset.viewLink);
    return;
  }
  const a = t.dataset.action;
  state.busy = true;
  decorateControls();
  try {
    if (a === "add") openEditor(t.dataset.collection);
    if (a === "edit") openEditor(t.dataset.collection, t.dataset.id);
    if (a === "versions")
      await versionHistory(t.dataset.collection, t.dataset.id);
    if (a === "entity-history") {
      navigate("history", {
        entity: t.dataset.collection,
        entityId: t.dataset.id,
      });
    }
    if (a === "archive" || a === "unarchive") {
      const before = await repo.get(t.dataset.collection, t.dataset.id);
      const plan = planFromForm(
        t.dataset.collection,
        t.dataset.id,
        { status: a === "archive" ? "ARCHIVED" : "ACTIVE" },
        before,
        { action: a === "archive" ? "ARCHIVE" : "RESTORE" },
      );
      const name = plan.after.name || "bản ghi này";
      if (await askConfirm((a === "unarchive" ? "Hiện lại " : "Ẩn ") + name + "?"))
        await commitPlan(plan);
    }
    if (a === "adjust-count") await applyCount(t.dataset.id);
    if (a === "event-detail")
      eventDetail(state.history.find((x) => x.eventId === t.dataset.eventId));
    if (a === "restore-event")
      await restoreEvent(
        state.history.find((x) => x.eventId === t.dataset.eventId),
        t.dataset.target || "before",
      );
    if (a === "restore-version") {
      const v = state.versionRows.find((v) => v.id === t.dataset.id);
      await restoreEvent(
        {
          entityType: v.collection,
          entityId: v.entityId,
          eventId: v.id,
          after: v.data,
        },
        "after",
      );
    }
    if (a === "confirm-restore") await confirmRestore();
    if (a === "cancel-restore") {
      state.restorePlans = null;
      document.querySelector("#detailDialog").close();
    }
    if (a === "tile-add") cartAdd(t.dataset.id);
    if (a === "cart-inc") {
      state.cart[Number(t.dataset.index)].quantity += 1;
      render();
    }
    if (a === "cart-dec") {
      const line = state.cart[Number(t.dataset.index)];
      line.quantity = Math.max(1, line.quantity - 1);
      render();
    }
    if (a === "remove-cart") {
      state.cart.splice(Number(t.dataset.index), 1);
      render();
    }
    if (a === "clear-cart") {
      state.cart = [];
      render();
    }
    if (a === "save-sale") await saveSale();
    if (a === "validate-ai")
      await validateAI(
        document.querySelector("#ai-batch-input").value,
        "#ai-preview-container",
      );
    if (a === "validate-sales-ai")
      await validateAI(
        document.querySelector("#sales-ai-input").value,
        "#sales-ai-preview",
      );
    if (a === "confirm-ai") await confirmAI();
    if (a === "cancel-ai") {
      state.aiDraft = null;
      render();
    }
    if (a === "export-backup") await exportBackup();
    if (a === "select-all-backup" || a === "select-none-backup")
      for (const box of document.querySelectorAll(
        "[data-backup-selection]:not(:disabled)",
      ))
        box.checked = a === "select-all-backup";
    if (a === "confirm-full-restore") await fullRestore();
    if (a === "selected-preview") await previewSelected();
    if (a === "cancel-backup") {
      state.backupDraft = null;
      render();
    }
    if (a === "history-more") {
      if (repo.mode === "firebase") {
        const page = await repo.historyPage({}, repo.historyCursor);
        repo.historyCursor = page.cursor;
        repo.historyMore = page.more;
        state.history.push(...page.rows);
      }
      state.historyLimit += 50;
      render();
    }
  } catch (err) {
    toast(err.message || "Thao tác thất bại.", true);
  } finally {
    state.busy = false;
    decorateControls();
  }
}
document.querySelector("#view").addEventListener("click", handleAction);
document.querySelector("#detailBody").addEventListener("click", handleAction);
document.querySelector("#view").addEventListener("input", (e) => {
  if (["list-search", "history-search", "menu-search"].includes(e.target.id)) {
    const id = e.target.id,
      value = e.target.value;
    if (id === "menu-search") state.salesSearch = value;
    else state.filters.q = value;
    render();
    const field = document.getElementById(id);
    field.focus();
    field.setSelectionRange(value.length, value.length);
  }
  if (e.target.id === "sale-date") state.salesDate = e.target.value;
  if (e.target.id === "invoice-number") state.salesInvoice = e.target.value;
});
document.querySelector("#view").addEventListener("change", async (e) => {
  try {
    if (e.target.id === "backup-file" && e.target.files[0]) {
      await readBackup(e.target.files[0]);
      return;
    }
    if (e.target.matches("[data-backup-selection]")) return;
    let changed = false;
    for (const key of ["entity", "action", "source", "from", "to"])
      if (e.target.id === "history-" + key) {
        state.filters[key] = e.target.value;
        state.historyLimit = 50;
        changed = true;
      }
    if (changed) render();
  } catch (err) {
    toast(err.message, true);
  }
});
document.querySelector("#entityForm").addEventListener("submit", saveEditor);
document.querySelector("#dialogFields").addEventListener("click", (e) => {
  const b = e.target.closest("[data-item-op]");
  if (!b) return;
  const rows = readRawRows();
  if (b.dataset.itemOp === "add")
    rows.push({ main: "", qty: "", unit: "", cost: "" });
  else rows.splice(Number(b.dataset.index), 1);
  redrawItems(rows);
});
document.querySelector("#dialogFields").addEventListener("change", (e) => {
  if (!e.target.classList.contains("item-main")) return;
  const rows = readRawRows();
  const n = Number(e.target.id.split("-")[1]);
  rows[n].unit = "";
  redrawItems(rows);
  document.getElementById("item-" + n + "-qty")?.focus();
});
document
  .querySelector("#closeDialog")
  .addEventListener("click", () =>
    document.querySelector("#entityDialog").close(),
  );
document
  .querySelector("#cancelDialog")
  .addEventListener("click", () =>
    document.querySelector("#entityDialog").close(),
  );
document
  .querySelector("#closeDetail")
  .addEventListener("click", () =>
    document.querySelector("#detailDialog").close(),
  );
document.querySelector("#refreshButton").addEventListener("click", async () => {
  try {
    if (!state.connected) await repo.ready();
    await load();
  } catch (e) {
    toast(e.message, true);
  }
});
document.querySelector("#mobileMenu").addEventListener("click", () => {
  const sidebar = document.querySelector(".sidebar");
  sidebar.classList.toggle("open");
  syncSidebar();
});
function syncSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const mobile = window.matchMedia("(max-width: 680px)").matches;
  const open = sidebar.classList.contains("open");
  sidebar.inert = mobile && !open;
  document
    .querySelector("#mobileMenu")
    .setAttribute("aria-expanded", String(mobile && open));
}
window.addEventListener("resize", syncSidebar);
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    document.querySelector(".sidebar").classList.contains("open")
  ) {
    document.querySelector(".sidebar").classList.remove("open");
    syncSidebar();
    document.querySelector("#mobileMenu").focus();
  }
});
let confirmationResolve = null,
  previousDialog = null;
function askConfirm(message) {
  return new Promise((resolve) => {
    confirmationResolve = resolve;
    previousDialog = document.querySelector("dialog[open]");
    if (previousDialog) previousDialog.close();
    document.querySelector("#confirmationMessage").textContent = message;
    document.querySelector("#confirmationDialog").showModal();
  });
}
function finishConfirmation(accepted) {
  document.querySelector("#confirmationDialog").close();
  if (previousDialog) previousDialog.showModal();
  previousDialog = null;
  const resolve = confirmationResolve;
  confirmationResolve = null;
  if (resolve) resolve(accepted);
}
document
  .querySelector("#confirmYes")
  .addEventListener("click", () => finishConfirmation(true));
document
  .querySelector("#confirmNo")
  .addEventListener("click", () => finishConfirmation(false));
document
  .querySelector("#confirmationDialog")
  .addEventListener("cancel", (e) => {
    e.preventDefault();
    finishConfirmation(false);
  });
function downloadJSON(value, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function decorateControls() {
  // Keys use entity IDs and actions, so selectors survive re-renders and sorting.
  for (const el of document.querySelectorAll(
    "button,input,select,textarea,tr,dialog,[data-row-id]",
  )) {
    if (!el.id) {
      const key = [
        el.closest("nav,header,dialog,#view")?.id ||
          el.closest("nav,header,dialog,#view")?.tagName,
        el.dataset.action ||
          el.dataset.view ||
          el.dataset.viewLink ||
          el.tagName.toLowerCase(),
        el.dataset.collection,
        el.dataset.id || el.dataset.eventId || el.dataset.rowId,
        el.dataset.target || el.dataset.index,
        el.textContent.trim().slice(0, 40),
      ]
        .filter(Boolean)
        .join("-");
      let hash = 2166136261;
      for (const ch of key) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
      el.id = "control-" + (hash >>> 0).toString(36);
    }
    if (!el.dataset.testid) el.dataset.testid = el.id;
    if (el.tagName === "BUTTON" && !el.type) el.type = "button";
    if (
      ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) &&
      !document.querySelector('label[for="' + el.id + '"]') &&
      !el.getAttribute("aria-label")
    )
      el.setAttribute("aria-label", el.getAttribute("placeholder") || el.id);
    if (
      el.tagName === "BUTTON" &&
      el.dataset.action &&
      ![
        "add",
        "edit",
        "versions",
        "entity-history",
        "event-detail",
        "cancel-ai",
        "cancel-backup",
        "cancel-restore",
        "history-more",
      ].includes(el.dataset.action)
    )
      el.disabled = state.busy || !state.connected;
  }
  const save = document.querySelector('[data-testid="save-entity"]');
  save.disabled = state.busy || !state.connected;
}
(async () => {
  render();
  status("Đang kết nối Firebase...");
  try {
    await repo.ready();
    await load();
  } catch (e) {
    state.connected = false;
    renderShell();
    status("Chưa kết nối · chưa có dữ liệu");
    toast(e.message || "Không thể kết nối Firebase.", true);
  }
})();
