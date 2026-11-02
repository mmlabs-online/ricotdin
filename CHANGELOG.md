# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
đánh số theo [Semantic Versioning](https://semver.org/lang/vi/).

## [Unreleased]

### Thay đổi
- API v2 phần lõi, đợt 2 (file trên Google Drive): tạo meeting kèm link upload Drive, xác nhận upload (kiểm tra file với Drive, chỉ tạo một job), link nghe audio `/media` 15 phút, xoá meeting (xoá file Drive trước, có `warning` nếu lỗi), xoá folder kèm meeting của chính mình, upload / đổi avatar. Chỉ chủ meeting được chuyển meeting sang folder khác (quyết định 2026-11-02). Deploy: migration Alembic `0004_meetings_gdrive`; không có biến môi trường mới (ARC-07)
- API v2 lưu file trên Google Drive của chủ dự án thay cho Cloudflare R2:
  - Kết nối một lần bằng `python -m scripts.connect_gdrive` (đăng nhập Google, quyền `drive.file`); client secret và refresh token được mã hoá bằng `KEY_ENCRYPTION_SECRET` trong bảng `drive_config`.
  - Trình duyệt upload thẳng lên Drive qua phiên resumable; API kiểm tra lại tên key, thư mục, kích thước và kiểu file, file sai bị xoá (422).
  - Bảng `storage_objects` ghi key → file id Drive; xoá file là xoá vĩnh viễn, không vào thùng rác.
  - Phát audio qua `GET /media?t=…`: link ký HMAC, sống tối đa 15 phút, hỗ trợ `Range` để tua, tối đa 8 luồng phát cùng lúc.
  - Tự thử lại khi Drive báo quá tải (429, 403 rate limit, 5xx); `check()` báo nếu thư mục gốc bị chia sẻ.
  - Deploy: migration Alembic `0003_drive_storage`; không có biến môi trường mới; chủ dự án tạo OAuth client "Desktop app" (consent screen **In production**), chạy `connect_gdrive` rồi `drive_smoke` (ARC-17)
- API v2 phần lõi, đợt 1 (không đụng file): danh sách / chi tiết meeting, transcript, to-do, gợi ý lịch; đổi tên, chuyển folder, ghim, đưa vào hàng đợi xử lý; đổi trạng thái to-do, bỏ gợi ý lịch, tải `.ics`; folder + chia sẻ + sắp xếp + tìm người dùng; profile (kèm số dư quota), đổi username / tên hiển thị / theme, chọn model mặc định; ghi activity từ trình duyệt. Status code giống v1 cho owner / editor / viewer / người lạ (test ma trận quyền). Không có migration, không có env mới. Đợt 2 (tạo meeting + upload, audio, xoá meeting, avatar) làm sau ARC-17 (ARC-07)
- Script chuyển dữ liệu v1 → v2 `app/api/scripts/migrate_from_supabase.py` (chủ dự án tự chạy):
  - Chép toàn bộ người dùng (giữ id và mật khẩu, tự băm lại sang argon2 ở lần đăng nhập đầu), mọi bảng và audio còn trên Supabase Storage sang Neon + R2.
  - Kiểm tra trước khi ghi; đọc Supabase trong một snapshot chỉ đọc; chạy lại không tạo bản trùng.
  - Báo cáo PASS/FAIL theo số dòng + checksum từng bảng, thử giải mã mọi secret, kết quả chép audio — không chứa secret, email hay nội dung cuộc họp.
  - Hướng dẫn chạy thử 2 lần: `docs/ops/v2-migration-rehearsal.md`.
  - Không có migration, không có env runtime mới (ARC-03)
- Dịch vụ nền của API v2:
  - Mã hoá AES-256-GCM đọc được ciphertext của v1 (cùng `KEY_ENCRYPTION_SECRET`).
  - Kho API key của nhà cung cấp lấy từ `admin_config`, dự phòng bằng biến môi trường, cache 30 giây; xoay vòng key khi bị giới hạn tần suất, tạm khoá key khi bị từ chối.
  - Đọc `app_config` an toàn: giá trị sai không bao giờ bật cờ.
  - Lưu trữ R2 theo cấu hình admin: URL ký sẵn, giới hạn dung lượng khi tải, kiểm tra quyền sở hữu key file.
  - Không có migration, không có env mới (ARC-06)
- Đăng nhập tự quản trên API v2 (thay Supabase Auth): đăng ký + xác minh email (mail song ngữ Anh/Việt qua SMTP), đăng nhập bằng email hoặc username, giữ phiên bằng cookie refresh đổi sau mỗi lần dùng (dùng lại token cũ sau 10 giây → huỷ cả phiên), đăng xuất, quên/đặt lại mật khẩu, đổi mật khẩu; mật khẩu argon2id (tài khoản chuyển từ Supabase tự băm lại khi đăng nhập); access token EdDSA 15 phút + JWKS; giới hạn tần suất. Env mới: `JWT_PRIVATE_KEY` (sinh bằng `scripts.gen_jwt_key`), `WEB_ORIGIN`, `SMTP_*`, `MAIL_FROM`; không có migration (ARC-05)
- Lõi API v2 (FastAPI): log JSON có che secret, Sentry không nhận nội dung, CORS theo danh sách, lỗi có kiểu, `/health` + `/version.json`, image Docker (non-root, ffmpeg) và artifact `openapi.json` trong CI; mỗi role DB một login riêng (NOINHERIT, timeout), API từ chối khởi động nếu login có quyền quá mức; role `ricotdin_worker` tách khỏi service, bảng log chỉ được ghi thêm (migration 0002) (ARC-04)
- Schema Postgres cho v2 trên Neon (Alembic): sinh tự động từ schema + 38 migration của v1 (thay `auth.*` của Supabase bằng bảng `users`/`refresh_tokens`/`email_tokens` riêng và ngữ cảnh `app.user_id`/`app.role` cho RLS), có test đối chiếu v1↔v2 và test RLS; siết quyền so với v1 (role app không còn TRUNCATE/TRIGGER/TEMP, chỉ được ghi nơi có policy) (ARC-02)
- Ma trận theo dõi v2 `ai-instruction/v2-tracking.md`: 76 feature đã xong ↔ endpoint v2 ↔ màn hình, 55 route cũ (+ `version.json`) ↔ endpoint mới, logic chạy trong trình duyệt và các lệnh gọi Supabase trực tiếp từ trình duyệt cần thay bằng API (ARC-01)
- Bắt đầu chuyển sang v2: app v1 (Next.js + Supabase) dời vào `legacy/` (giữ lịch sử); khung `app/api` (FastAPI, uv) và `app/web` (Vite + React) có CI riêng; CI của v1 chỉ chạy khi `legacy/` đổi và nay build thử image + kiểm tra `/api/health`; image v1 build từ gốc repo bằng `docker build -f legacy/Dockerfile .`. Lệnh v1 chạy trong `legacy/`, file env ở `legacy/.env.local` (ARC-00)

### Sửa lỗi
- Script chuyển dữ liệu v1 → v2 bị chặn ở bước kiểm tra trước vì 2 bảng mới của v2 (`drive_config`, `storage_objects`); nay được bỏ qua đúng cách (BUG-020)
- Script chuyển dữ liệu v1 → v2 không còn bị crash khi in báo cáo trên console Windows (cp1252) và trả đúng exit code (0 PASS/dry run, 1 FAIL, 2 bị chặn); ký tự console không hiển thị được thành `?`, file báo cáo vẫn đầy đủ (BUG-019)
- Tài liệu nói đúng nhánh mặc định là `dev` và cách cấu hình environment `backup` (cần 6 secret, nhận nhánh `dev`) — trước đây hướng dẫn sai nên không ai nhận ra backup DB chưa từng chạy được vì thiếu secret; PRF-08 được đánh dấu đã xong (qua AIP-06) (BUG-018, PRF-08)

## [1.1.1] — 2026-10-25

> Bản cuối của dòng v1 có thay đổi mới. Từ đây v1 đóng băng, chỉ nhận hotfix trên `release/1.1`;
> phát triển chuyển sang v2 (module ARC trong `ai-instruction/tracking.md`).

### Tính năng
- Bản nháp cài ricotdin vào repo `mmlabs-online/deployment`: `apps/ricotdin/compose.yml` (image ghim theo digest, cổng 3000, secret chỉ từ file `/etc/mmlabs/ricotdin.env` trên server), workflow `deploy-ricotdin.yml` (healthcheck `/api/health`, tự khôi phục bản trước khi lỗi, comment kết quả lên PR) và README kèm prompt kiểm tra sau release — trong `docs/ops/deployment-repo/` (OPS-05)
- CI (lint · typecheck · test) giờ chạy cả trên PR vào `dev` và khi push lên `dev`; chỉ hiển thị kết quả, không chặn merge; khắc phục known issue "CI không chạy cho PR vào `dev`" của 1.1.0 (OPS-06)
- Runbook phát hành `docs/ops/release-runbook.md` (deploy tay v1.1.0 một lần, backup lần đầu, cài pipeline OPS-05, rồi thứ tự cho mọi release) và lệnh `npm run verify:deploy -- <url> --expect vX.Y.Z` kiểm tra `/version.json` + `/api/health` sau deploy (OPS-07)

### Bảo mật
- Admin không còn đọc được ciphertext của API key, secret R2 (`admin_config`, `storage_config`) qua REST trực tiếp; migration 023 trước đây không có tác dụng. Trình duyệt mất mọi quyền trên 2 bảng này, UI admin vẫn dùng API phía server (migration 037) (BUG-006)
- Người dùng không còn xoá thẳng được cuộc họp qua REST (trước đây làm vậy sẽ bỏ lại file audio trên storage mãi mãi, ngoài tầm của job purge); xoá luôn đi qua `DELETE /api/meetings/:id` để xoá audio trước (migration 038) (BUG-008)

### Sửa lỗi
- Xoá folder kèm cuộc họp giờ xoá cả file audio trên R2 (trước đây chỉ xoá trên bucket Supabase cũ nên audio R2 bị bỏ lại), và báo lỗi (500) thay vì âm thầm bỏ qua khi không lấy được hoặc không xoá được các cuộc họp (BUG-004)
- Xoá folder chia sẻ kèm cuộc họp không còn xoá cuộc họp của người khác (editor đã bỏ cuộc họp của họ vào folder): chỉ xoá cuộc họp của chính chủ folder, cuộc họp của người khác chuyển về Uncategorized của họ; mỗi cuộc họp bị xoá có log `meeting_deleted` (BUG-011)
- Sự kiện `meeting_deleted` trong activity log trước đây không bao giờ được lưu (vướng khoá ngoại tới cuộc họp vừa xoá); nay lưu với ID cuộc họp trong `metadata` (BUG-012)
- Hộp thoại xoá folder (cả ở menu folder lẫn modal Manage Folders) giờ báo trước rằng lịch sử chat của folder sẽ bị xoá cho mọi người, kể cả các thành viên được chia sẻ (BUG-014)
- Hộp thoại xoá folder hiển thị đúng số cuộc họp: tính cả cuộc họp đã ghim, và chỉ đếm cuộc họp của chính chủ folder là "sẽ bị xoá"; cuộc họp của thành viên được chia sẻ được báo là chuyển về Uncategorized của họ (BUG-015)
- Sau khi xoá folder (giữ cuộc họp), cuộc họp của thành viên được chia sẻ không còn hiện "ma" trong Uncategorized của chủ folder cho đến khi tải lại trang (BUG-016)

### Checklist deploy
- **Migration mới `migrations/037_revoke_ciphertext_tables.sql`** — không phụ thuộc code, chạy được ngay; xác nhận bằng câu kiểm tra trong file (BUG-006).
- **Migration mới `migrations/038_meetings_revoke_client_delete.sql`** — không phụ thuộc code, chạy được ngay; xác nhận bằng câu kiểm tra trong file (BUG-008).
- **OPS-05:** tạo `/etc/mmlabs/ricotdin.env` (600, user của runner) với secret production; copy 2 bản nháp vào repo deployment; thêm hostname cloudflared → `http://ricotdin:3000`; cập nhật Supabase Site URL/redirect; dừng container ricotdin chạy tay; rồi merge PR `ricotdin v1.1.0` (đã mở) để deploy qua pipeline. Trước đó nên rotate token Cloudflare Tunnel đang bị commit trong `proxy/compose.yml` của repo deployment.

## [1.1.0] — 2026-10-22

### Tính năng
- Release theo tag: push `vX.Y.Z` → build `mingming21400/ricotdin:vX.Y.Z` (+ `latest` nếu cao nhất) và mở PR `ricotdin vX.Y.Z` trên `mmlabs-online/deployment` ghim image theo digest; thêm `GET /api/health` và `GET /version.json` công khai, `HEALTHCHECK` trong image (OPS-04)
- Tự động xoá audio theo thời hạn lưu: mỗi ngày xoá file audio của các cuộc họp `done` cũ hơn `storage.audio_retention_days` ngày (mặc định `null` = giữ mãi, tắt), giữ nguyên transcript/ghi chú/todos/chat, ghi audit `meeting.audio_purged`; trang cuộc họp hiện "Audio deleted (retention policy)"; `/process` và admin requeue trả 409 khi không còn audio (tránh mất transcript); chính sách nội bộ `docs/privacy/retention-policy.md` (PRV-02)
- Thông báo ghi âm: bấm "Start recording" sẽ hiện hộp thoại nhắc rằng mọi người tham gia cần biết và đồng ý (kèm câu mẫu để đọc), chỉ ghi âm sau khi bấm "I understand — start recording"; xác nhận được ghi vào activity log (`recording_notice_ack`, xem ở `/admin/activity`) và hỏi lại sau 12 giờ (COM-01)
- Backup DB hằng ngày (Supabase Free): GitHub Actions dump DB, mã hoá bằng khoá công khai `age`, đẩy lên bucket R2 riêng và giữ 30 ngày; hướng dẫn khôi phục ở `docs/ops/backup-restore.md` (OPS-03)

### Bảo mật
- Mọi lệnh xoá audio bằng service role (purge, xoá cuộc họp, admin xoá user) chỉ xoá đúng object `<user_id>/<meeting_id>.<ext>` của chính cuộc họp đó — trước đây `audio_path` do người dùng sửa được có thể trỏ sang file của người khác (PRV-02)
- `avatar_key` trong hồ sơ không còn trỏ được tới object bất kỳ trên R2: trước đây người dùng có thể lấy link nghe hoặc xoá audio cuộc họp của người khác qua `GET`/`PATCH /api/profile`. Nay chỉ chấp nhận `avatars/<user_id>/<uuid>.(jpg|png|webp)` của chính mình (BUG-002)
- Không còn nghe hoặc xử lý được audio của người khác bằng cách sửa `meetings.audio_path`: link nghe (`/api/audio-url`) và pipeline chỉ dùng file `<user_id>/<meeting_id>.<ext>` của chính cuộc họp; trình duyệt không còn quyền INSERT/UPDATE bảng `meetings` (migration 033) (BUG-003)
- Người dùng không còn gọi trực tiếp được hàm SQL `quota_apply_movement` (tự cộng quota cho bất kỳ ai) và `claim_next_job` (chiếm job xử lý) qua REST; chỉ service role được gọi (migration 034) (BUG-005)
- Người dùng không còn ghi thẳng được vào `transcript_segments` / `transcript_chunks` qua REST — trước đây chủ một folder chia sẻ có thể cài nội dung giả vào dữ liệu chatbot của người được chia sẻ; chỉ pipeline (service role) được ghi (migration 035) (BUG-007)
- Người dùng không còn sửa thẳng được todos, gợi ý lịch và lịch sử chat qua REST (trước đây chủ/editor folder chia sẻ có thể giả mạo nội dung todo/sự kiện `.ics` mà người được chia sẻ thấy); chỉ server được ghi, đổi trạng thái vẫn qua các route PATCH (migration 036) (BUG-009, BUG-010)

### Sửa lỗi
- `docker compose up` không truy cập được app ở `localhost:3333` và container luôn `unhealthy`: compose map `3333:3333` trong khi image lắng nghe cổng `80`. Nay map `3333:80`, dùng `HEALTHCHECK` của image (`/api/health`); README cập nhật (`-p 3333:80`, bỏ mô tả nginx) (BUG-001)

### Thay đổi
- Dockerfile viết lại theo mẫu CaleChip: stage deps/build/runner, cache npm, `NODE_VERSION` arg; giá trị `NEXT_PUBLIC_*` lấy từ BuildKit secret (`--secret id=env,src=.env.local`, chỉ đọc các dòng `NEXT_PUBLIC_*`) hoặc `--build-arg`, build báo lỗi nếu thiếu URL/anon key Supabase; container chạy user non-root `node` trên **cổng 3000** (trước là 80), `HEALTHCHECK` `:3000/api/health`. Compose: `3333:3000`, ghim `PORT=3000`, không cần `--env-file` nữa. Xoá `start.sh` + `nginx.conf` không còn dùng (OPS-04, BUG-001)

### Checklist deploy
**Thứ tự:** chạy migration 032 → 036 (và câu kiểm tra trong từng file) TRƯỚC khi khởi động image `v1.1.0`. v1.1.0 deploy theo cách hiện tại (OPS-05 chưa xong): dùng image `mingming21400/ricotdin:v1.1.0`, map cổng host → **3000**.
- **Tag `v1.1.0` → `release.yml`:** image được build + push; bước "Open deployment PR" cần secret `DEPLOY_REPO_TOKEN` — chưa có thì bước đó fail (image vẫn dùng được). Thêm token trước khi tag nếu muốn PR `ricotdin v1.1.0` trên `mmlabs-online/deployment`.
- **Backup DB (OPS-03):** tạo cặp khoá `age` (giữ khoá riêng offline), bucket R2 `ricotdin-db-backups` + token chỉ cho bucket đó, GitHub Environment `backup` (chỉ nhánh `main`) với 6 environment secret (`SUPABASE_DB_URL` = Session pooler, `AGE_RECIPIENT`, `R2_BACKUP_*`); workflow chỉ chạy sau khi lên `main` — chạy `db-backup` một lần và khôi phục thử — xem `docs/ops/backup-restore.md`.
- **Migration mới `migrations/032_meetings_audio_purged.sql`** (thêm cột `meetings.audio_purged_at` + index) — chạy TRƯỚC khi khởi động image mới. Sau đó (tuỳ chọn) đặt `storage.audio_retention_days` ở `/admin/config` để bật purge (PRV-02).
- **Migration mới `migrations/033_meetings_revoke_client_writes.sql`** — thu hồi INSERT/UPDATE trên `meetings` từ `anon`/`authenticated`; chạy trước khi khởi động image mới, rồi chạy câu `has_table_privilege` trong file để xác nhận (đều `false`) (BUG-003).
- **Migration mới `migrations/034_revoke_definer_rpc_execute.sql`** — không phụ thuộc code, chạy được ngay; xác nhận bằng câu `has_function_privilege` trong file (BUG-005).
- **Migration mới `migrations/035_transcript_revoke_client_writes.sql`** — không phụ thuộc code, chạy được ngay; xác nhận bằng câu kiểm tra trong file (BUG-007).
- **Migration mới `migrations/036_content_revoke_client_writes.sql`** — không phụ thuộc code, chạy được ngay; xác nhận bằng câu kiểm tra trong file (BUG-009, BUG-010).
- **Cổng container đổi 80 → 3000.** Compose trên repo deployment (OPS-05) phải trỏ healthcheck/route vào `ricotdin:3000` (`wget -q --spider http://127.0.0.1:3000/api/health`), nếu không container sẽ `unhealthy`.
- Secret GitHub mới `DEPLOY_REPO_TOKEN` (fine-grained PAT, chỉ `mmlabs-online/deployment`, Contents + Pull requests read/write).
- Env runtime mới `RICOTDIN_VERSION` (không bí mật, do `release.env` của repo deployment đặt); build arg `BUILD_COMMIT`.
- Thay đổi hợp đồng release: image cố định `mingming21400/ricotdin`, tag image có tiền tố `v`. Deploy = merge PR trên repo deployment (cần OPS-05).

### Known issues
- File ghi âm WebM từ trình duyệt không tua được đầy đủ (thiếu Duration/Cues); flag giảm nhẹ `user_hack_audio_render` (mặc định tắt). Xem `CLAUDE.md` §9j.
- Rate-limit đăng nhập lưu trong bộ nhớ, reset khi restart process.
- Gemini free tier có thể dùng dữ liệu đầu vào để huấn luyện — bật billing (PRV-01) trước khi xử lý cuộc họp thật của người khác.
- Chưa có staging (OPS-02). Backup DB (OPS-03) chỉ chạy sau khi cài secret/bucket và workflow ở trên `main`.
- Deploy tự động qua repo deployment (OPS-05) chưa xong — v1.1.0 deploy thủ công.
- Lỗi bảo mật mức S3 còn mở: BUG-004 (xoá folder không xoá audio trên R2), BUG-006 (admin đọc được ciphertext key qua REST), BUG-008 (xoá cuộc họp qua REST bỏ lại audio).
- CI (lint/typecheck/test) chỉ chạy cho PR vào `main`/`release/**`, không chạy cho PR vào `dev`.
- Lint còn 39 cảnh báo (0 lỗi).

## [1.0.0] — 2026-09-19

Bản release ổn định đầu tiên. Toàn bộ phạm vi MVP (phase 1–15 trong `CLAUDE.md` §11)
đã chạy đầu-cuối: ghi âm → phiên âm → tóm tắt/biên bản/to-do → hỏi đáp RAG có trích dẫn.

### Tính năng

**Ghi âm & tải lên**
- Ghi âm trong trình duyệt (Chrome/Edge): trộn âm thanh tab/hệ thống với micro; cảnh báo khi thiếu nguồn âm thanh.
- Tải lên file audio có sẵn (mp3/m4a/…); upload trực tiếp từ trình duyệt lên storage qua signed URL.

**Pipeline xử lý**
- Hàng đợi job bền vững (`jobs`, `claim_next_job`): sống sót qua restart, tự phục hồi job bị kẹt, retry idempotent.
- Speech-to-text qua Speechmatics; phân tích qua Gemini (JSON mode, retry/backoff khi 429, fallback Flash → Flash-Lite).
- Chuyển mã bằng ffmpeg, chia nhỏ audio dài; sinh transcript có timestamp, tóm tắt, biên bản, to-do, gợi ý lịch.
- Embedding 768 chiều cho RAG (pgvector HNSW, iterative scan).

**Chi tiết cuộc họp**
- Trình phát audio với timestamp click-để-tua, biên bản markdown, to-do (tick/bỏ qua), xuất `.ics` cho gợi ý lịch, xuất transcript.

**Chatbot RAG**
- Ba phạm vi hỏi đáp: một cuộc họp, một folder, toàn bộ kho; câu trả lời có trích dẫn timestamp; lưu lịch sử phiên chat.

**Quản lý cuộc họp & cộng tác**
- Ghim, đổi tên, xóa (xóa kèm file audio trên storage).
- Folder có sắp xếp kéo-thả; chia sẻ folder cho người dùng khác theo vai trò (viewer/editor).

**Tài khoản & bảo mật**
- Đăng ký email + xác minh email; đăng nhập bằng email hoặc username; rate-limit đăng nhập.
- Hai vai trò `user`/`admin` (role nằm trong `app_metadata` + JWT claim); RLS owner-or-shared trên mọi bảng nội dung; admin không đọc được nội dung họp qua API công khai.
- API key nhà cung cấp mã hóa AES-256-GCM trong DB, quản lý qua UI.

**Hồ sơ người dùng**
- Trang hồ sơ, đổi tên hiển thị/username/mật khẩu, avatar, theme, model AI mặc định.

**Quota**
- Ví trả trước hai trục (giây audio / lượt hỏi agent), sổ cái append-only, trừ quota idempotent.

**Nhà cung cấp AI**
- Lớp trừu tượng provider (Gemini, OpenAI, Grok); khóa model theo từng cuộc họp; allow-list model và model mặc định do admin cấu hình.

**Quản trị (`/admin`)**
- Người dùng (role, bật/tắt, reset mật khẩu, xóa), trạng thái Unverified/Active/Disabled.
- Giám sát pipeline + requeue; thống kê chi phí AI (token và giây audio tách riêng); nhật ký hoạt động người dùng; audit log (`/admin/audit`).
- Pool API key + health check tự động hằng ngày; cấu hình storage R2; feature flags; feature registry.

**Vận hành**
- Sentry (tùy chọn), log JSON có cấu trúc, `GET /api/admin/health`.
- CI (lint · typecheck · test) trên PR vào `main`; image Docker cho `dev` và cho mỗi tag release.

### Checklist triển khai

Làm lần lượt trên môi trường production **trước khi** chạy image `1.0.0`.

**1. Biến môi trường**

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Có | Được nhúng lúc **build** (build-arg) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Có | Được nhúng lúc **build** (build-arg) |
| `SUPABASE_SERVICE_ROLE_KEY` | Có | Chỉ server |
| `KEY_ENCRYPTION_SECRET` | Có | 64 ký tự hex. **Mất là mất toàn bộ key đã lưu trong DB** — phải dùng đúng secret đã mã hóa chúng |
| `GEMINI_API_KEY` / `GEMINI_API_KEYS` / `GEMINI_API_KEY_n` | Không | Fallback khi DB chưa có key |
| `SPEECHMATICS_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | Không | Fallback khi DB chưa có key |
| `SENTRY_DSN` | Không | Bỏ trống = tắt Sentry |

R2 **không** còn đọc từ env; các dòng `R2_*` trong `.env.example` đã lỗi thời (cấu hình ở `/admin/storage`).

**2. Migration database** — chạy trong Supabase SQL editor theo đúng thứ tự dưới đây.
Hai cặp trùng số (`006`, `018`) chạy theo thứ tự liệt kê.

```
001_profiles                  017_features
002_jwt_hook                  018_chat_sessions_folder
003_rls_owner_or_admin        018_profiles_extended
004_meetings_pinned           019_usage_log_key
005_audit_logs                020_quota
006_app_config                021_jobs
006_meetings_source           022_rls_meeting_delete_owner_only
007_meetings_source_video     023_rls_admin_config_column_privilege
008_meetings_storage_provider 024_rls_function_grants
009_usage_log                 025_rls_admin_content_access
010_transcript_segments_confidence  026_meetings_model_lock
011_folders                   027_model_control
012_folder_shares             028_storage_config
013_folders_position          029_admin_config_health
014_provider_keys             030_match_chunks_iterative_scan
015_admin_config              031_audio_render_hack_flag
016_activity_log
```

Nếu production đã chạy một phần, chỉ chạy các file còn thiếu (hầu hết migration idempotent,
nhưng nên đối chiếu trước).

**3. Supabase dashboard**
- Authentication → Hooks → Custom Access Token → chọn `public.custom_access_token_hook`.
- Authentication → Providers → **tắt** Anonymous sign-ins.
- Authentication → Providers → Email → bật "Confirm email"; cấu hình SMTP (không có SMTP thì không gửi được mail xác minh / reset mật khẩu).

**4. Sau khi app chạy**
- Tạo admin đầu tiên: `npx tsx scripts/seed-admin.ts <email>`.
- `/admin/keys`: thêm API key Gemini / Speechmatics (…), bấm "Run health check now".
- `/admin/storage`: nhập thông tin R2 (+ CORS cho bucket theo `lib/storage/CORS.json`).
- `/admin/config`: kiểm tra model mặc định và allow-list.
- Feature registry (tùy chọn): `npx tsx scripts/seed-features.ts`.

**5. Image Docker**
- Deploy tag cố định `ricotdin:1.0.0` (không dùng `dev`/`latest` cho production). Container lắng nghe cổng **80**.

### Known issues

- File ghi âm WebM từ trình duyệt không tua được đầy đủ (thiếu Duration/Cues). Có flag giảm nhẹ `user_hack_audio_render` (mặc định tắt); cách sửa triệt để (remux khi upload) chưa làm. Xem `CLAUDE.md` §9j.
- `docker-compose.yml` map và healthcheck cổng `3333`, trong khi image lắng nghe cổng `80` — cần sửa compose (hoặc đặt `PORT=3333`) nếu chạy bằng compose.
- Rate-limit đăng nhập lưu trong bộ nhớ, reset khi restart process.
- Gemini free tier có thể dùng dữ liệu đầu vào để huấn luyện — bật billing trước khi xử lý cuộc họp thật của người khác.
- Chưa có: staging environment, backup DB định kỳ.
- Lint còn 39 cảnh báo (0 lỗi).

[1.1.0]: https://github.com/mmlabs-online/ricotdin/releases/tag/v1.1.0
[1.0.0]: https://github.com/didi-code0980/ricotdin/releases/tag/v1.0.0
