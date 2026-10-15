# LE CORNER Inventory

HTML5, CSS3, Vanilla JavaScript, Firebase Authentication (email/mật khẩu) và Firestore project `qlnhanh`. Không dùng Firebase CLI.

## Đăng nhập & dữ liệu chung

Mọi tài khoản nhân viên dùng chung một kho `stores/le-corner/...`. Màn đăng nhập nhận **tên tài khoản**; app tự đổi thành email `<tên>@lecorner.app`.

Thêm tài khoản: Firebase Console → Authentication → Users → Add user (email `<tên>@lecorner.app`), rồi thêm email đó vào danh sách trong `firestore.rules` và dán Rules vào Firestore → Rules → Publish. Không lưu mật khẩu trong repository.

## Chạy local

```sh
npm start
npm test
```

Mở `http://localhost:8000/` trong Codex. SDK cố định ở 12.19.0, dùng long polling cho trình duyệt nhúng. Tạo `firebase-config.js` cục bộ từ Firebase Console; file này bị Git bỏ qua. GitHub Pages tạo file cấu hình trong workflow từ Actions secret để không lưu giá trị trong lịch sử repository.

Để giữ web local chạy sau khi terminal/lượt Codex kết thúc, dùng `npm run start:keep`. Server chạy độc lập, chỉ nghe trên `127.0.0.1:8000`; log ở thư mục tạm của hệ thống. Chạy lại lệnh sẽ tái sử dụng server LE CORNER đang chạy. Server vẫn cần khởi động lại sau khi tắt máy.

`?namespace=acceptance20261009` sử dụng settings riêng và dataset QA trên Firebase thật. `?mode=demo` sử dụng localStorage, không đồng bộ. Không tự chuyển sang demo nếu Firebase lỗi.

## Nghiệp vụ

- Mỗi thay đổi có version snapshot và activity event. Transaction ghi nghiệp vụ, version, event và bút toán kho nguyên tử. Revision trong settings chặn preview cũ, tab khác và xung đột với restore.
- Hóa đơn giữ giá và recipe snapshot khi bán. Sửa công thức chỉ tác động hóa đơn mới. Restore hóa đơn chỉ ghi chênh lệch tiêu hao; restore lặp cùng nội dung không trừ/cộng kho lặp.
- Tồn đầu chốt khi tạo nguyên liệu, được lưu trong version/event. Số dư = tồn đầu + tổng ledger. Sau đó điều chỉnh qua phiếu kiểm kho. Phiếu kiểm cần bấm **Áp dụng kiểm kê**; phiếu đã áp dụng phải dùng phiếu mới để sửa sai.
- Restore qua kỳ kiểm kê yêu cầu lý do hiệu chỉnh. Tồn âm cảnh báo và cần xác nhận. Archive giữ nguyên liên kết và lịch sử. UI không xóa vĩnh viễn.
- History lấy 50 event/trang. Bộ lọc ngày/entity/action/source áp dụng trên các trang đã tải; **Tải thêm lịch sử** để tìm các trang cũ. Mỗi dòng có lịch sử và version riêng.
- AI chỉ nhận JSON chuẩn bị sẵn, validate/preview trước xác nhận. Batch đã xác nhận commit nguyên tử; tối đa 50 records và 400 writes.

Ví dụ AI:

```json
{
  "schemaVersion": 1,
  "module": "sales",
  "operation": "create",
  "records": [
    {
      "invoiceNo": "HD002587",
      "date": "2026-10-09",
      "items": [{ "menuName": "AMERICANO", "quantity": 1 }],
      "expectedTotal": 39000
    }
  ]
}
```

## Backup và Restore

Backup đọc hết các collection theo trang 100, không cắt ở 300. Kiểm tra schema, ID, liên kết, SHA-256, snapshot và số dư trước khi báo thành công. Không chứa credential/token. Import UI tối đa 20 MiB. Checksum là kiểm tra nội dung, không phải chữ ký xác thực nguồn.

**Restore Selected** chọn bản ghi, preview hiện tại/snapshot và biến động kho rồi commit nguyên tử. Cấu hình nguyên liệu giữ tồn đầu hiện tại. Phiếu kiểm đã áp dụng cần phiếu mới. Giao dịch qua kiểm kê có thể restore riêng bằng History để nhập lý do hiệu chỉnh.

**Full Restore** tạo/tải JSON an toàn của trạng thái hiện tại và giữ dataset gốc. Tạo dataset mới với physical ID `datasetId__entityId` để không ghi đè dataset cũ (`live` giữ ID gốc). Stage tối đa 200 writes hoặc khoảng 2 MB mỗi batch. Đọc lại toàn bộ staging, so nội dung, liên kết và số dư. Tạo version/event RESTORE mới. Transaction cuối kiểm tra revision, đổi activeDatasetId, ghi event kết quả và job COMPLETED cùng nhau. Lỗi trước bước kích hoạt giữ nguyên dataset đang hoạt động.

Full Restore phục hồi một trạng thái ledger đầy đủ ở dataset mới. Restore Selected trên dataset hiện tại luôn dùng bút toán chênh lệch. Dataset cũ và staging lỗi giữ lại để điều tra/khôi phục; chưa tự dọn dữ liệu.

## GitHub Pages

Website: [le-hai-dang.github.io/QLNhanh/](https://le-hai-dang.github.io/QLNhanh/). Workflow `.github/workflows/pages.yml` chạy kiểm thử rồi deploy khi push lên `main`. Chỉ sáu tệp ứng dụng, cấu hình Firebase được tạo lúc build và `.nojekyll` được xuất bản; ảnh nghiệm thu, JSON backup, Rules và script không nằm trong website. Tài nguyên dùng đường dẫn tương đối nên chạy trong thư mục `/QLNhanh/`.

Pages vẫn dùng Firebase project `qlnhanh`; UID ẩn danh thuộc origin mới nên dữ liệu của phiên local không tự xuất hiện trên Pages. Backup/import thủ công là cách chuyển dữ liệu trong phiên bản hiện tại. Ảnh và backup nghiệm thu được giữ ở máy local, không đưa vào Git.

## Firebase Console và Hosting

Anonymous Auth và Web App đã cấu hình qua Console. `firestore.rules` đã publish lúc 19:37 ngày 09/10/2026: UID chủ sở hữu được đọc/ghi, events/versions/ledger chỉ tạo mới. Wildcard rộng trong rules cũ đã được thay thế vì các match Firestore kết hợp theo OR.

UID ẩn danh thuộc trình duyệt. Đổi trình duyệt hoặc xóa dữ liệu trình duyệt có thể nhận UID khác và không nhìn thấy dataset cũ. Giữ JSON backup; phiên bản này chưa có liên kết tài khoản giữa thiết bị.

Không dùng Firebase CLI/token local để deploy. Hosting Console không có upload trực tiếp thư mục static; tự động deploy cần Hosting REST API với đúng phiên Google và quyền deploy. Đăng ký Hosting không chứng minh website đã deploy.

Bản ứng dụng đã deploy lên [qlnhanh.web.app](https://qlnhanh.web.app) lúc 20:13 ngày 09/10/2026 và xác thực/đồng bộ thành công trong trình duyệt ngoài. Codex IAB hiện chạy local thành công nhưng gặp `auth/network-request-failed` trên bản HTTPS Hosting; xem bằng chứng và giới hạn trong ACCEPTANCE.md.

`scripts/deploy-hosting.py` dùng REST API trong Cloud Shell đã xác thực; chỉ upload sáu file ứng dụng. Token ngắn hạn được lấy trong Cloud Shell, giữ trong bộ nhớ, không in ra hoặc lưu vào file. Gói `artifacts/le-corner-hosting.tar.gz` chứa source và script, không chứa dữ liệu quán hoặc credential. Chạy trong Cloud Shell: `tar -xzf le-corner-hosting.tar.gz` rồi `python3 le-corner-hosting/scripts/deploy-hosting.py`. Trạng thái deploy và bằng chứng nghiệm thu được ghi riêng trong [ACCEPTANCE.md](ACCEPTANCE.md).

Backup thủ công là chính. Chưa cấu hình backup tự động. Managed backup/export hoặc Scheduler/Functions là tùy chọn cần kiểm tra gói, quyền và chi phí trước khi bật; không dựa vào tab luôn mở.

Tài liệu chính thức: [transactions](https://firebase.google.com/docs/firestore/manage-data/transactions), [Hosting REST API](https://firebase.google.com/docs/hosting/api-deploy), [SDK release notes](https://firebase.google.com/support/release-notes/js).

## Kiểm thử

`npm test` kiểm tra chênh lệch 12 → 10, restore lặp, snapshot hóa đơn, archive, checkpoint, AI preview, ghi nguyên tử, xung đột revision, backup toàn vẹn, hơn 300 rows và lỗi staging. Firestore adapter double kiểm tra thuật toán; không thay thế kiểm chứng Security Rules/Console thực tế.
