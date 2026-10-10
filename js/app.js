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
  sales: "Nhập món bán",
  backup: "Sao lưu & khôi phục",
  settings: "Cài đặt",
  history: "Lịch sử",
  salesList: "Hóa đơn",
};
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
const toast = (message, error = false) => {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.style.background = error ? "var(--red)" : "var(--green-strong)";
  el.className = "toast show";
  setTimeout(() => (el.className = "toast"), 3200);
};
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
async function commitPlan(plan) {
  if (!state.connected)
    throw new BusinessError("Chưa kết nối. Hãy tải lại dữ liệu.");
  if (
    plan.warnings.length &&
    !(await askConfirm(
      plan.warnings.join("\n") + "\nXác nhận lưu với các cảnh báo này?",
    ))
  )
    throw new BusinessError("Đã hủy lưu.");
  status("Đang ghi transaction...");
  await repo.commit(plan);
  try {
    await load();
  } catch (e) {
    state.connected = false;
    status("Đã lưu; tải lại dữ liệu để kiểm tra");
  }
  toast("Đã lưu " + (labels[plan.collection] || plan.collection));
}

function nav() {
  return (
    '<button class="nav-item ' +
    (state.view === "dashboard" ? "active" : "") +
    '" data-view="dashboard" data-testid="nav-dashboard">Tổng quan</button><button class="nav-item ' +
    (state.view === "sales" ? "active" : "") +
    '" data-view="sales" data-testid="nav-sales">Nhập món bán</button><button class="nav-item ' +
    (state.view === "stockCounts" ? "active" : "") +
    '" data-view="stockCounts" data-testid="nav-stock">Kiểm kho</button><button class="nav-item ' +
    (state.view === "ingredients" ? "active" : "") +
    '" data-view="ingredients" data-testid="nav-ingredients">Nguyên liệu</button><button class="nav-item ' +
    (state.view === "purchaseReceipts" ? "active" : "") +
    '" data-view="purchaseReceipts" data-testid="nav-purchases">Nhập hàng</button><button class="nav-item ' +
    (state.view === "menuItems" ? "active" : "") +
    '" data-view="menuItems" data-testid="nav-menu">Menu & công thức</button><button class="nav-item ' +
    (state.view === "recipes" ? "active" : "") +
    '" data-view="recipes" data-testid="nav-recipes">Phiên bản công thức</button><button class="nav-item ' +
    (state.view === "reorderSettings" ? "active" : "") +
    '" data-view="reorderSettings" data-testid="nav-reorder">Ngưỡng đặt hàng</button><button class="nav-item ' +
    (state.view === "history" ? "active" : "") +
    '" data-view="history" data-testid="nav-history">Lịch sử</button><button class="nav-item ' +
    (state.view === "backup" ? "active" : "") +
    '" data-view="backup" data-testid="nav-backup">Sao lưu & khôi phục</button>'
  );
}
function renderShell() {
  document.querySelector("#mainNav").innerHTML = nav();
  syncSidebar();
  document.querySelector("#pageTitle").textContent =
    labels[state.view] || state.view;
  document.querySelector("#authStatus").textContent = state.connected
    ? repo.mode === "firebase"
      ? "Đã xác thực ẩn"
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
    '</strong><small>Menu cố định</small></div></div><div class="grid inventory-dashboard-grid"><div class="card inventory-priority-card"><div class="section-head"><div><p class="eyebrow">Ưu tiên hôm nay</p><h2>Nguyên liệu cần đặt</h2></div><button class="secondary-button" data-view-link="reorderSettings">Cài đặt ngưỡng</button></div><p class="inventory-lead">Theo dõi số dư hiện tại và đặt hàng trước khi nguyên liệu chạm mức tối thiểu.</p><div class="inventory-alert-list">' +
    inventoryRowsHtml +
    '</div><div class="toolbar inventory-actions"><button class="primary-button" data-view-link="ingredients">Mở tồn kho</button><button class="secondary-button" data-view-link="stockCounts">Kiểm kho</button></div></div><div class="card inventory-snapshot-card"><div class="section-head"><div><p class="eyebrow">Số dư hiện tại</p><h2>Tồn kho hiện tại</h2></div></div><div class="inventory-snapshot-list">' +
    inventorySnapshotHtml +
    '</div></div></div><div class="grid backup-grid"><div class="card"><div class="section-head"><div><p class="eyebrow">Lối tắt</p><h2>Nhập liệu nhanh</h2></div></div><div class="toolbar"><button class="primary-button" data-view-link="purchaseReceipts">Nhập hàng</button><button class="secondary-button" data-view-link="stockCounts">Kiểm kho</button><button class="secondary-button" data-view-link="menuItems">Cài đặt menu</button></div><div class="notice" style="margin-top:16px">Dataset hiện tại: <strong>' +
    esc(repo.datasetId) +
    '</strong>. Mỗi thay đổi có phiên bản và lịch sử; thay đổi tồn kho có bút toán riêng.</div></div><div class="card"><div class="section-head"><div><p class="eyebrow">AI Input</p><h2>Dán đề xuất có cấu trúc</h2></div></div><textarea id="ai-batch-input" class="textarea" rows="5" placeholder="{&quot;schemaVersion&quot;:1,&quot;module&quot;:&quot;sales&quot;,&quot;operation&quot;:&quot;create&quot;,&quot;records&quot;:[]}"></textarea><div class="toolbar" style="margin-top:10px"><button class="secondary-button" data-action="validate-ai" data-testid="validate-batch">Kiểm tra dữ liệu</button></div><div id="ai-preview-container">' +
    (state.aiDraft ? aiPreview() : "") +
    '</div></div></div><div class="card" style="margin-top:16px"><div class="section-head"><div><p class="eyebrow">Mới nhất</p><h2>Lịch sử gần đây</h2></div><button class="secondary-button" data-view-link="history">Xem tất cả</button></div>' +
    timeline(state.history.slice(0, 5), true) +
    "</div>"
  );
}
function salesView() {
  const menus = activeMenu(),
    filtered = menus.filter(
      (m) =>
        !state.salesSearch ||
        [m.name, m.englishName, m.code, ...(m.aliases || [])].some((v) =>
          normalize(v).includes(normalize(state.salesSearch)),
        ),
    );
  const total = state.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  return (
    '<div class="section-head"><div><p class="eyebrow">Bán hàng</p><h2>Nhập món bán</h2></div><div class="toolbar"><button class="secondary-button" data-view-link="salesList" data-testid="view-invoices">Danh sách hóa đơn</button></div></div><div class="grid backup-grid"><div class="card"><div class="form-grid" style="padding:0">' +
    input("sale-date", "Ngày bán", state.salesDate, "date") +
    input(
      "invoice-number",
      "Mã hóa đơn",
      state.salesInvoice,
      "text",
      'data-testid="invoice-number"',
    ) +
    input(
      "menu-search",
      "Tìm tên món",
      state.salesSearch,
      "search",
      'data-testid="menu-search"',
    ) +
    select(
      "menu-item-select",
      "Chọn món",
      [
        { value: "", label: "— Chọn món —" },
        ...filtered.map((m) => ({
          value: m.id,
          label:
            m.name +
            (m.englishName ? " · " + m.englishName : "") +
            " · " +
            money(m.price),
        })),
      ],
      state.selectedMenu || "",
    ) +
    input(
      "sale-quantity",
      "Số lượng",
      1,
      "number",
      'min="1" step="1" data-testid="sale-quantity"',
    ) +
    '</div><div class="toolbar" style="margin-top:16px"><button class="primary-button" id="add-sale-item" data-action="add-cart" data-testid="add-sale-item">+ Thêm món</button><button class="secondary-button" data-action="clear-cart">Xóa giỏ</button></div><div id="sales-message" class="notice" style="margin-top:16px">Giá và công thức lấy từ Menu Settings. Hóa đơn chỉ ghi kho sau khi bấm Lưu.</div></div><div class="card"><div class="section-head"><div><p class="eyebrow">Preview trước commit</p><h2>Danh sách đã nhập</h2></div><strong id="sale-total" data-testid="sale-total">' +
    money(total) +
    "</strong></div>" +
    (state.cart.length
      ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Món</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th><th></th></tr></thead><tbody>' +
        state.cart
          .map(
            (i, n) =>
              '<tr data-row-id="cart-' +
              esc(i.menuItemId) +
              '"><td>' +
              esc(i.name) +
              "</td><td>" +
              i.quantity +
              "</td><td>" +
              money(i.price) +
              "</td><td>" +
              money(i.price * i.quantity) +
              '</td><td><button class="danger-button" data-action="remove-cart" data-index="' +
              n +
              '">Xóa</button></td></tr>',
          )
          .join("") +
        '</tbody></table></div><div class="toolbar" style="justify-content:flex-end;margin-top:16px"><button class="primary-button" data-action="save-sale" data-testid="save-sale">Lưu hóa đơn</button></div>'
      : '<div class="empty"><strong>Chưa có món</strong><span>Dùng search và dropdown ở bên trái để thêm.</span></div>') +
    '</div></div><div class="card" style="margin-top:16px"><div class="section-head"><div><p class="eyebrow">AI Batch Mode</p><h2>Nhập nhiều hóa đơn</h2></div></div><textarea id="sales-ai-input" class="textarea" rows="7" data-testid="ai-batch-input" placeholder="{&quot;schemaVersion&quot;:1,&quot;module&quot;:&quot;sales&quot;,&quot;operation&quot;:&quot;create&quot;,&quot;records&quot;:[{&quot;invoiceNo&quot;:&quot;HD002587&quot;,&quot;date&quot;:&quot;2026-10-09&quot;,&quot;items&quot;:[{&quot;menuName&quot;:&quot;AMERICANO&quot;,&quot;quantity&quot;:1}],&quot;expectedTotal&quot;:39000}]}"></textarea><div class="toolbar" style="margin-top:10px"><button class="secondary-button" data-action="validate-sales-ai" data-testid="validate-batch">Kiểm tra batch</button></div><div id="sales-ai-preview">' +
    (state.aiDraft?.module === "sales" ? aiPreview() : "") +
    "</div></div>"
  );
}
function listView(collection) {
  const rows = state.catalog[collection] || [];
  const q = state.filters.q.toLowerCase();
  const filtered = rows.filter(
    (r) => !q || JSON.stringify(r).toLowerCase().includes(q),
  );
  return (
    '<div class="section-head"><div><p class="eyebrow">Thiết lập</p><h2>' +
    esc(labels[collection]) +
    '</h2></div><div class="toolbar"><input class="input" id="list-search" aria-label="Tìm nhanh" placeholder="Tìm nhanh..." value="' +
    esc(state.filters.q) +
    '"><button class="primary-button" data-action="add" data-collection="' +
    collection +
    '">+ Thêm</button></div></div><div class="card">' +
    (filtered.length
      ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Tên / ID</th><th>Thông tin</th><th>Trạng thái</th><th>Phiên bản</th><th></th></tr></thead><tbody>' +
        filtered
          .map(
            (r) =>
              '<tr data-row-id="' +
              esc(r.id) +
              '"><td><strong>' +
              esc(r.name || r.id) +
              "</strong><br><small>" +
              esc(r.code || r.id) +
              "</small></td><td>" +
              esc(
                r.total != null
                  ? money(r.total)
                  : r.quantity != null
                    ? r.quantity + " " + (r.unit || "")
                    : r.price != null
                      ? money(r.price)
                      : r.baseUnit
                        ? r.stock + " " + r.baseUnit
                        : r.note || "—",
              ) +
              '</td><td><span class="badge ' +
              (r.status === "ARCHIVED" ? "archived" : "") +
              '">' +
              esc(r.status || "ACTIVE") +
              "</span></td><td>v" +
              (r.version || 1) +
              '</td><td><div class="toolbar">' +
              (collection === "stockCounts" && !r.adjusted
                ? '<button class="primary-button" data-action="adjust-count" data-id="' +
                  r.id +
                  '">Áp dụng kiểm kê</button>'
                : "") +
              '<button class="secondary-button" data-action="versions" data-collection="' +
              collection +
              '" data-id="' +
              r.id +
              '">Phiên bản</button><button class="secondary-button" data-action="entity-history" data-collection="' +
              collection +
              '" data-id="' +
              r.id +
              '">Lịch sử</button><button class="secondary-button" data-action="edit" data-collection="' +
              collection +
              '" data-id="' +
              r.id +
              '">Sửa</button>' +
              (r.status === "ARCHIVED"
                ? '<button class="secondary-button" data-action="unarchive" data-collection="' +
                  collection +
                  '" data-id="' +
                  r.id +
                  '">Hiện lại</button>'
                : '<button class="danger-button" data-action="archive" data-collection="' +
                  collection +
                  '" data-id="' +
                  r.id +
                  '">Ẩn</button>') +
              "</div></td></tr>",
          )
          .join("") +
        "</tbody></table></div>"
      : '<div class="empty"><strong>Chưa có dữ liệu</strong><span>Thêm bản ghi đầu tiên.</span></div>') +
    "</div>"
  );
}
function timeline(rows, compact = false) {
  if (!rows.length)
    return '<div class="empty"><strong>Chưa có lịch sử</strong><span>Các thay đổi đã xác nhận sẽ xuất hiện tại đây.</span></div>';
  return (
    '<div class="timeline">' +
    rows
      .map(
        (e) =>
          '<article class="timeline-item"><div class="timeline-date">' +
          dateText(e.timestamp) +
          "</div><div><h3>" +
          esc(labels[e.entityType] || e.entityType) +
          " · " +
          esc(e.action) +
          "</h3><p>" +
          esc(
            e.note || (e.changedFields || []).join(", ") || "Thay đổi dữ liệu",
          ) +
          ' · <span class="badge">' +
          esc(e.source || "Manual") +
          '</span></p></div><div class="event-actions"><button class="secondary-button" data-action="event-detail" data-event-id="' +
          e.eventId +
          '">Chi tiết</button>' +
          (!compact && e.before && e.after && e.action !== "RESTORE"
            ? '<button class="secondary-button" data-action="restore-event" data-event-id="' +
              e.eventId +
              '">Khôi phục</button>'
            : "") +
          "</div></article>",
      )
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
        ...Object.keys(ACTIONS).map((a) => ({ value: a, label: a })),
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
      ? "<p>Đối tượng: " + esc(state.filters.entityId) + "</p>"
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
  return (
    '<div class="notice" data-testid="backup-preview" style="margin-top:12px"><strong>Backup hợp lệ</strong><p>Dataset ' +
    esc(b.datasetId) +
    " · " +
    dateText(b.createdAt) +
    '</p><div class="table-wrap"><table><thead><tr><th>Collection</th><th>Backup</th><th>Hiện tại</th><th>Thêm</th><th>Đổi</th></tr></thead><tbody>' +
    backupSummary(b, state.catalog)
      .map(
        (r) =>
          '<tr data-row-id="backup-' +
          esc(r.collection) +
          '"><td>' +
          labels[r.collection] +
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
    "</tbody></table></div><h3>Restore Selected</h3><p>Khôi phục qua nghiệp vụ và bút toán chênh lệch. Cấu hình nguyên liệu giữ tồn đầu hiện tại; phiếu kiểm đã điều chỉnh cần phiếu mới.</p>" +
    ENTITY_COLLECTIONS.map((c) =>
      b.collections[c]
        .map(
          (r) =>
            '<div><input type="checkbox" id="selected-' +
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
            esc(labels[c]) +
            " · " +
            esc(r.name || r.id) +
            "</label></div>",
        )
        .join(""),
    ).join("") +
    '<div class="toolbar"><button class="secondary-button" data-action="selected-preview">Preview các bản ghi đã chọn</button><button class="primary-button" data-action="confirm-full-restore">Xác nhận Full Restore</button><button class="secondary-button" data-action="cancel-backup">Hủy</button></div></div>'
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
        ing.stock += impact.quantity;
      }
    }
  showRestorePreview(plans);
}
function formFields(collection, data = {}) {
  const menuOpts = (state.catalog.menuItems || [])
    .filter((m) => m.status === "ACTIVE" || m.id === data.menuItemId)
    .map((m) => ({ value: m.id, label: m.name + " · " + money(m.price) }));
  const ingOpts = activeRows("ingredients").map((i) => ({
    value: i.id,
    label: i.name + " (" + i.baseUnit + ")",
  }));
  if (collection === "menuItems")
    return (
      input("entity-name", "Tên món", data.name) +
      input("entity-english", "Tên tiếng Anh", data.englishName) +
      input("entity-code", "Mã món", data.code) +
      input("entity-group", "Nhóm món", data.group) +
      input(
        "entity-price",
        "Giá bán",
        data.price,
        "number",
        'min="0" step="1000"',
      ) +
      input("entity-unit", "Đơn vị bán", data.unit || "ly") +
      textarea(
        "entity-aliases",
        "Tên tương đương (mỗi dòng một tên)",
        (data.aliases || []).join("\n"),
      ) +
      select(
        "entity-status",
        "Trạng thái",
        [
          { value: "ACTIVE", label: "Đang bán" },
          { value: "ARCHIVED", label: "Ngừng bán" },
        ],
        data.status || "ACTIVE",
      )
    );
  if (collection === "ingredients")
    return (
      input("entity-name", "Tên nguyên liệu", data.name) +
      select(
        "entity-base-unit",
        "Đơn vị chuẩn",
        [
          { value: "g", label: "g" },
          { value: "ml", label: "ml" },
          { value: "unit", label: "đơn vị" },
        ],
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
      ) +
      select(
        "entity-status",
        "Trạng thái",
        [
          { value: "ACTIVE", label: "Đang dùng" },
          { value: "ARCHIVED", label: "Đã ẩn" },
        ],
        data.status || "ACTIVE",
      )
    );
  if (collection === "recipes")
    return (
      select("entity-menu-id", "Món", menuOpts, data.menuItemId) +
      textarea(
        "entity-items",
        "Định lượng JSON",
        JSON.stringify(data.items || [], null, 2),
      ) +
      select(
        "entity-status",
        "Trạng thái",
        [
          { value: "ACTIVE", label: "Đang dùng" },
          { value: "ARCHIVED", label: "Đã ẩn" },
        ],
        data.status || "ACTIVE",
      )
    );
  if (collection === "sales")
    return (
      input("entity-date", "Ngày bán", data.date || state.salesDate, "date") +
      input("entity-invoice", "Mã hóa đơn", data.invoiceNo || "") +
      textarea(
        "entity-items",
        "Items JSON",
        JSON.stringify(data.items || [], null, 2),
      ) +
      textarea("entity-note", "Ghi chú", data.note || "")
    );
  if (collection === "purchaseReceipts")
    return (
      input("entity-date", "Ngày nhập", data.date || state.salesDate, "date") +
      textarea(
        "entity-items",
        "Items JSON",
        JSON.stringify(data.items || [], null, 2),
      ) +
      textarea("entity-note", "Ghi chú", data.note || "")
    );
  if (collection === "stockCounts")
    return (
      input("entity-date", "Ngày kiểm", data.date || state.salesDate, "date") +
      textarea(
        "entity-items",
        "Items JSON",
        JSON.stringify(data.items || [], null, 2),
      ) +
      textarea("entity-note", "Ghi chú", data.note || "")
    );
  return (
    input("entity-ingredient-id", "Nguyên liệu", data.ingredientId || "") +
    input("entity-minimum-stock", "Ngưỡng", data.minimumStock || 0, "number") +
    textarea("entity-note", "Ghi chú", data.note || "")
  );
}
function openEditor(collection, id) {
  state.editing = { collection, id };
  const data = id
    ? (state.catalog[collection] || []).find((r) => r.id === id) || {}
    : {};
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
      englishName: val("entity-english"),
      code: val("entity-code"),
      group: val("entity-group"),
      price: Number(val("entity-price")),
      unit: val("entity-unit"),
      aliases: val("entity-aliases")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      status: val("entity-status"),
    });
  else if (collection === "ingredients")
    Object.assign(data, {
      name: val("entity-name"),
      baseUnit: val("entity-base-unit"),
      packageSize: Number(val("entity-package-size")),
      openingStock: Number(val("entity-opening-stock")),
      minimumStock: Number(val("entity-minimum-stock")),
      unitCost: Number(val("entity-unit-cost")),
      status: val("entity-status"),
    });
  else if (collection === "recipes")
    Object.assign(data, {
      menuItemId: val("entity-menu-id"),
      items: JSON.parse(val("entity-items") || "[]"),
      status: val("entity-status"),
    });
  else if (collection === "sales")
    Object.assign(data, {
      date: val("entity-date"),
      invoiceNo: val("entity-invoice"),
      items: JSON.parse(val("entity-items") || "[]"),
      note: val("entity-note"),
    });
  else if (collection === "purchaseReceipts")
    Object.assign(data, {
      date: val("entity-date"),
      items: JSON.parse(val("entity-items") || "[]"),
      note: val("entity-note"),
    });
  else if (collection === "stockCounts")
    Object.assign(data, {
      date: val("entity-date"),
      items: JSON.parse(val("entity-items") || "[]"),
      note: val("entity-note"),
    });
  else
    Object.assign(data, {
      ingredientId: val("entity-ingredient-id"),
      minimumStock: Number(val("entity-minimum-stock")),
      note: val("entity-note"),
    });
  return data;
}
async function saveEditor(event) {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  decorateControls();
  const { collection, id } = state.editing;
  try {
    const before = id ? await repo.get(collection, id) : null;
    const plan = planFromForm(
      collection,
      id || uid(),
      readForm(collection),
      before,
    );
    await commitPlan(plan);
    document.querySelector("#entityDialog").close();
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
  document.querySelector("#detailTitle").textContent = "Preview khôi phục";
  document.querySelector("#detailBody").innerHTML =
    plans
      .map(
        (p) =>
          "<h3>" +
          esc(labels[p.collection]) +
          " · " +
          esc(p.after.name || p.id) +
          '</h3><div class="diff-grid"><div class="diff-pane"><h3>Hiện tại</h3><pre>' +
          esc(JSON.stringify(p.before, null, 2)) +
          '</pre></div><div class="diff-pane"><h3>Sẽ khôi phục</h3><pre>' +
          esc(JSON.stringify(p.after, null, 2)) +
          "</pre></div></div><p>Chênh lệch kho: " +
          esc(JSON.stringify(p.impacts)) +
          '</p><p class="notice warning">' +
          esc(p.warnings.join(" · ") || "Không có cảnh báo tồn kho.") +
          "</p>",
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
    '<button class="primary-button" data-action="confirm-restore">Xác nhận khôi phục</button><button class="secondary-button" data-action="cancel-restore">Hủy</button>';
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
  state.selectedEvent = event;
  document.querySelector("#detailTitle").textContent =
    (labels[event.entityType] || event.entityType) + " · " + event.action;
  document.querySelector("#detailBody").innerHTML =
    "<p>" +
    dateText(event.timestamp) +
    " · " +
    esc(event.source) +
    "</p><p>" +
    esc(event.note || "Không có ghi chú") +
    '</p><div class="diff-grid"><div class="diff-pane"><h3>Trước</h3><pre>' +
    esc(JSON.stringify(event.before, null, 2)) +
    '</pre></div><div class="diff-pane"><h3>Sau</h3><pre>' +
    esc(JSON.stringify(event.after, null, 2)) +
    "</pre></div></div><h3>Biến động kho</h3><pre>" +
    esc(JSON.stringify(event.stockImpact || [], null, 2)) +
    "</pre>" +
    (ENTITY_COLLECTIONS.includes(event.entityType)
      ? (event.before
          ? '<button class="secondary-button" data-action="restore-event" data-event-id="' +
            esc(event.eventId) +
            '">Khôi phục phiên bản trước</button>'
          : "") +
        '<button class="secondary-button" data-action="restore-event" data-target="after" data-event-id="' +
        esc(event.eventId) +
        '">Khôi phục phiên bản này</button>'
      : "");
  decorateControls();
  document.querySelector("#detailDialog").showModal();
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
          "</h3><pre>" +
          esc(JSON.stringify(v.data, null, 2)) +
          '</pre><button class="secondary-button" data-action="restore-version" data-id="' +
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
        status("Sao lưu " + c + " · " + n + " bản ghi"),
      ),
      blob = new Blob([JSON.stringify(b, null, 2)], {
        type: "application/json",
      }),
      a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download =
      "LE_CORNER_Backup_" +
      new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") +
      ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    document.querySelector("#backup-result").innerHTML =
      '<div class=\"notice\" style=\"margin-top:12px\">Đã xuất ' +
      COLLECTIONS.length +
      " collection · SHA-256 " +
      esc(b.checksum) +
      "</div>";
    toast("Đã tạo backup JSON.");
  } catch (e) {
    toast(e.message || "Backup thất bại.", true);
  }
}
async function readBackup(file) {
  try {
    if (file.size > 20 * 1024 * 1024)
      throw new BusinessError("Backup tối đa 20 MB.");
    const b = JSON.parse(await file.text()),
      check = await validateBackup(b);
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
    downloadJSON(safety, "LE_CORNER_Safety_" + Date.now() + ".json");
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
    const payload = JSON.parse(text);
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
function addCart() {
  const id = document.querySelector("#menu-item-select")?.value,
    qty = Number(document.querySelector("#sale-quantity")?.value || 0),
    menu = activeMenu().find((m) => m.id === id);
  if (!menu || !Number.isInteger(qty) || qty < 1)
    return toast("Chọn món và số lượng hợp lệ.", "error");
  const existing = state.cart.find((i) => i.menuItemId === id);
  if (existing) existing.quantity += qty;
  else
    state.cart.push({
      menuItemId: id,
      name: menu.name,
      price: menu.price,
      quantity: qty,
    });
  state.salesDate =
    document.querySelector("#sale-date")?.value || state.salesDate;
  state.salesInvoice = document.querySelector("#invoice-number")?.value || "";
  state.salesSearch = document.querySelector("#menu-search")?.value || "";
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
    toast("Đã lưu hóa đơn " + (data.invoiceNo || id));
  } catch (e) {
    toast(e.message || "Không thể lưu hóa đơn.", "error");
  }
}
document.querySelector("#mainNav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b) return;
  state.view = b.dataset.view;
  state.filters = {
    q: "",
    entity: "",
    action: "",
    source: "",
    from: "",
    to: "",
    entityId: "",
  };
  state.historyLimit = 50;
  document.querySelector(".sidebar").classList.remove("open");
  render();
});
async function handleAction(e) {
  const t = e.target.closest("[data-action],[data-view-link]");
  if (!t || state.busy) return;
  if (t.dataset.viewLink) {
    state.view = t.dataset.viewLink;
    render();
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
      state.view = "history";
      state.filters.entity = t.dataset.collection;
      state.filters.entityId = t.dataset.id;
      render();
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
      if (a === "unarchive") showRestorePreview([plan]);
      else if (await askConfirm("Ẩn bản ghi này?")) await commitPlan(plan);
    }
    if (a === "adjust-count") {
      const before = await repo.get("stockCounts", t.dataset.id);
      const plan = planFromForm("stockCounts", t.dataset.id, before, before, {
        action: "ADJUST",
        note: "Điều chỉnh theo phiếu kiểm kho",
      });
      if (
        await askConfirm(
          "Áp dụng chênh lệch kiểm kê: " + JSON.stringify(plan.impacts) + "?",
        )
      )
        await commitPlan(plan);
    }
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
    if (a === "add-cart") addCart();
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
    if (e.target.id === "menu-item-select") state.selectedMenu = e.target.value;
    for (const key of ["entity", "action", "source", "from", "to"])
      if (e.target.id === "history-" + key) {
        state.filters[key] = e.target.value;
        state.historyLimit = 50;
      }
    if (["sale-date", "invoice-number"].includes(e.target.id)) return;
    render();
  } catch (err) {
    toast(err.message, true);
  }
});
document.querySelector("#entityForm").addEventListener("submit", saveEditor);
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
