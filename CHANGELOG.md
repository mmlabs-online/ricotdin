# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
đánh số theo [Semantic Versioning](https://semver.org/lang/vi/).

## [Unreleased]

### Tính năng
- Release theo tag: push `vX.Y.Z` → build `mingming21400/ricotdin:vX.Y.Z` (+ `latest` nếu cao nhất) và mở PR `ricotdin vX.Y.Z` trên `mmlabs-online/deployment` ghim image theo digest; thêm `GET /api/health` và `GET /version.json` công khai, `HEALTHCHECK` trong image (OPS-04)

### Sửa lỗi
- `docker compose up` không truy cập được app ở `localhost:3333` và container luôn `unhealthy`: compose map `3333:3333` trong khi image lắng nghe cổng `80`. Nay map `3333:80`, dùng `HEALTHCHECK` của image (`/api/health`); README cập nhật (`-p 3333:80`, bỏ mô tả nginx) (BUG-001)

### Checklist deploy
- Không có migration mới.
- Secret GitHub mới `DEPLOY_REPO_TOKEN` (fine-grained PAT, chỉ `mmlabs-online/deployment`, Contents + Pull requests read/write).
- Env runtime mới `RICOTDIN_VERSION` (không bí mật, do `release.env` của repo deployment đặt); build arg `BUILD_COMMIT`.
- Thay đổi hợp đồng release: image cố định `mingming21400/ricotdin`, tag image có tiền tố `v`. Deploy = merge PR trên repo deployment (cần OPS-05).

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

[1.0.0]: https://github.com/didi-code0980/ricotdin/releases/tag/v1.0.0
