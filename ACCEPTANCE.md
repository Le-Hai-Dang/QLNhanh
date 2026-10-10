# Bằng chứng nghiệm thu 09/10/2026

Mã nguồn còn untracked, chưa commit/push. Kiểm thử Firebase thật sử dụng `?namespace=acceptance20261009`, UID `SDrCnlTQq7SyUjK0RbLnWP7vEyx1`, tách settings và dataset khỏi dữ liệu sử dụng thông thường.

| Hạng mục                   | Kết quả và bằng chứng                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit/adapter               | `npm test`: 15/15 pass. Gồm chênh lệch kho, restore lặp, recipe snapshot, archive, checkpoint kiểm kê, atomic commit, stale tab, checksum, schema sai, hơn 300 rows, staging lỗi và activation conflict.                                          |
| Console                    | Web App + Anonymous Auth đã cấu hình; Spark, Firestore asia-east2. Rules append-only publish 19:37. Đã đọc trực tiếp bản ghi nguyên liệu 960g, ledger COMPENSATING +8g và snapshot hóa đơn RESTORE version 5 trong Console.                       |
| AI                         | Preview menu chưa tạo nghiệp vụ/event. Chỉ sau xác nhận mới ghi. Tạo món 39.000đ, nguyên liệu tồn đầu 1000g, recipe 4g/ly và hóa đơn 10 ly bằng AI input trên Firebase thật.                                                                      |
| Hóa đơn/restore            | Sửa 10 → 12: tồn 952g. Restore 12 → 10: hoàn 8g, tồn 960g. Restore lặp: preview không có movement; ledger vẫn ba dòng -40, -8, +8.                                                                                                                |
| Backup thực tế             | File `LE_CORNER_Backup_2026-10-09-12-36.json` trong Downloads; checksum `88cf5bfed060b3f5acfc922e01e6b57d2b888cbf72561c4cf8c1fbc171006c23`. Export/import hợp lệ. File sửa giá nhưng giữ checksum cũ bị UI từ chối.                               |
| Full Restore thực tế       | Hoàn tất lúc 19:43 dưới Rules mới. Tải safety JSON `LE_CORNER_Safety_1791549824363.json`. Dataset mới `restore-7eec2972-cc07-42ba-abcf-95c0ac3b8581`; job `22254bff-1639-4a7a-9d67-6675c7532854` COMPLETED. Dataset QA cũ vẫn hiện trong Console. |
| Đối chiếu sau Full Restore | Backup `LE_CORNER_Backup_2026-10-09-12-44.json` validate PASS: menu 1 (39.000đ, v2), ingredient 1 (960g, v2), recipe 1 (4g, v2), sale 1 (10 ly, 390.000đ, v5), ledger 3, events 12, versions 11, jobs 1.                                          |
| Restore Selected thực tế   | Chọn QA Americano từ backup, xem before/after và impacts []; xác nhận thành công, tạo version RESTORE mới.                                                                                                                                        |
| Responsive/accessibility   | 390px và 1280px; không tràn trang ở dashboard/nguyên liệu sau sửa wrap checksum. Tab từ menu mobile sang Làm mới; sidebar đóng dùng inert. DOM kiểm tra không trùng ID và không thiếu data-testid trên các control/row/dialog.                    |
| Hosting                    | Codex tự deploy qua Cloud Shell + Hosting REST lúc 20:13. Release `sites/qlnhanh/releases/1791551581775000`, version `d7f3e0bca3cb3f57`, 6 tệp. Console Current release khớp; Spark vẫn $0/month. Bản online xác thực ẩn danh và đồng bộ lúc 20:15 trong Brave. Trong Codex IAB, bản online báo auth/network-request-failed ở cả hai domain; local IAB vẫn đồng bộ thành công lúc 20:14.                                           |

Console bổ sung: đã đọc trực tiếp job `22254bff-1639-4a7a-9d67-6675c7532854` COMPLETED và event `6e53b341-e34d-4f2b-96aa-e34a7152050d` RESTORE; before/after trỏ đúng dataset cũ/mới, transactionId khớp job và safetyChecksum.

Kiểm tra bổ sung lúc 20:32–20:34, Codex tự thao tác trong trình duyệt nhúng trên Firebase thật:

- Archive món QA Americano: ACTIVE v3 → ARCHIVED v4; restore v3 qua preview rồi xác nhận: ACTIVE v5. Liên kết công thức/hóa đơn được giữ.
- Sửa công thức 4g → 5g tạo v3; tồn vẫn 960g. Restore công thức 4g tạo v4, preview không có movement. Hóa đơn cũ vẫn 10 ly, snapshot 4g, tổng 390.000đ.
- Backup cuối `LE_CORNER_Backup_2026-10-09-13-34.json` trong Downloads: schema/checksum/liên kết/số dư PASS. SHA-256 `1e76f95f4371a1fc1285f6f77975e6177949eecdea50a7c4bdd6ca3950e1fa15`. Menu 1 (ACTIVE v5, 39.000đ), recipe 1 (v4, 4g), ingredient 1 (960g), sale 1 (10 ly, v5), ledger vẫn 3 dòng tổng -40g; events 17, versions 16, job 1.
- Chạy lại `npm test`: 15/15 PASS. `start-local.py` parse Python PASS; `npm run start:keep` tái sử dụng đúng server đang chạy.
- Server local chạy độc lập trên loopback; giữ tab Codex mở. Phiên Anonymous mới trên `127.0.0.1:8000/?namespace=authsmoke20261009` xác thực và đồng bộ thành công lúc 20:28; không tạo nghiệp vụ trong namespace đó. Lỗi HTTPS Hosting trong Codex IAB vẫn là giới hạn chưa giải quyết.
- Dashboard local đã được chỉnh theo ưu tiên vận hành: bỏ số doanh thu khỏi vùng chỉ số, đưa “Cần đặt hàng”, “Đã hết hàng”, danh sách nguyên liệu chạm ngưỡng và “Tồn kho hiện tại” lên đầu. Với dữ liệu QA hiện tại, dashboard hiển thị QA Cà phê 960g, ngưỡng 100g; ảnh `artifacts/dashboard-inventory-priority.jpg`.

Ảnh bổ sung: `artifacts/archive-restored.jpg`, `artifacts/recipe-edit-stock-unchanged.jpg`, `artifacts/local-retained.jpg`.

Ảnh bổ sung: `artifacts/hosting-release.jpg`, `online-authenticated.jpg`, `console-restore-job.jpg`, `console-restore-event.jpg`.

Ảnh bằng chứng: `artifacts/console-stock.jpg`, `mobile-stock.jpg`, `history.jpg`, `full-restore.jpg`, `checksum-rejected.jpg`, `cloud-shell-terms.jpg`.

Kiểm thử lỗi staging/activation là adapter double, chưa chủ động tạo lỗi mạng giữa Full Restore trên Firebase thật. Security Rules append-only đã publish và happy path đã chạy, Rules Playground xác nhận owner read allowed, unauthenticated read denied, other UID read denied và owner update activityEvent denied; ảnh `rules-owner-allowed.jpg`, `rules-unauth-denied.jpg`, `rules-other-uid-denied.jpg`, `rules-audit-update-denied.jpg`. Rules chưa ép buộc ghép event/version cho mọi write bằng getAfter; tính nguyên tử được thực hiện trong transaction của ứng dụng. Backup tự động chưa cấu hình. Anonymous UID gắn với trình duyệt; chưa hỗ trợ liên kết tài khoản giữa thiết bị.
