# Nâng lõi dsh (upstream → AHV CLI)

AHV CLI là fork mềm của [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
Lõi được nâng **bằng tay, theo tag phát hành của upstream**, không tự động:
CMS `ahvclaw.com/admin` → *AHV CLI* chỉ báo "lõi dsh X — upstream mới nhất Y
(tụt N ngày)" và cảnh báo khi tụt quá 14 ngày; không có gì tự merge.

Lần gần nhất: `dsh-v0.1.1-rc.1` → `dsh-v0.2.0-rc.1` (29/09/2026, nhánh
`upgrade-dsh-0.2`, 7.171 commit, 24 xung đột).

## Vì sao phải nâng lõi đúng hạn

Plugin trong bundle AHV (`packages/bundle/ahv/package.json`) được ahv-admin tự
nâng pin mỗi ngày. Tác giả plugin viết cho lõi dsh mới; lõi cũ thiếu API là
`ahv run` sập. Sự cố thật: v0.2.50 (28/09) — `@anweat/dsh-browser` 0.1.15 gọi
`z.boolean().default().volatile()` của schemastery, có từ upstream #4579
(21/09, dsh 0.1.7-rc.2); lõi 0.1.1-rc.1 không có → mọi `ahv run` lỗi
`...volatile is not a function`.

## Quy trình

```bash
git fetch upstream --tags
git tag -l 'dsh-v*' --sort=-creatordate | head      # chọn tag đích (rc/phát hành, không lấy master)
git worktree add -b upgrade-dsh-<x.y> ../AHVclaw-upg master
cd ../AHVclaw-upg
git -c merge.renameLimit=20000 merge --no-ff --no-commit dsh-v<x.y.z>   # KHÔNG rebase lịch sử
```

Giải xung đột theo bảng dưới, rồi `pnpm install --no-frozen-lockfile`
(`PNPM_CONFIG_MINIMUM_RELEASE_AGE=0`) để dựng lại `pnpm-lock.yaml`.
Commit gộp chạy lefthook (lint, third-party notices, ghép bản dịch) — đừng
`--no-verify`.

### Các điểm vá AHV phải còn sau mỗi lần gộp

| Tệp | Bản vá AHV | Khi xung đột |
|---|---|---|
| `apps/cli/package.json` | bin `ahv`; phụ thuộc `@ahvclaw/dsh-bundle-ahv` | giữ cả hai (0.2 chỉ phân giải plugin trong bao đóng phụ thuộc của bản cài — thiếu dòng này là bot-runner không nạp, `ahv run` treo) |
| `apps/cli/src/bin.ts` | `withAhvDefaultProfile()` | lấy bản upstream, cấy lại hàm |
| `packages/boot/app-boot/src/profile.ts` | profile `ahv`, `ahv-web` | thêm vào `PROFILE_TEMPLATES` theo định dạng mới |
| `packages/bundle/ahv/**` | bundle AHV (router, persona, plugin, bot-runner) | của AHV; soát id dòng base/headless còn tồn tại, khoá cấu hình đổi tên (0.2: `persona` → `personaPrefix`), dòng upstream đã đưa vào base (0.2: storage, projection-cache) |
| `packages/session/session-list-metadata` | projection cho `ahv run` | đồng bộ với `sessionListMetadata` của session-controller |
| `packages/session/session-format-v0-to-v1/src/ahv-fork-legacy.ts` | chuẩn hoá phiên do lõi 0.1.1-rc.1 ghi | giữ; thiếu là mọi hội thoại bot cũ bị từ chối |
| `packages/client/connection` (`browserAuth: external`) | ahv-web bind loopback sau cổng ahv-web-ui-auth | giữ |
| `packages/bundle/ahv/cordis.patch*.yml` (telemetry) + `ahv-wrapper.sh` (`DSH_TELEMETRY_DISABLED=1`) | không gửi gì về DeepSeek (0.2 bật mặc định gửi log phiên khi có phản hồi); tắt tài khoản DeepSeek trên web | mỗi lần gộp: soát dòng mới gửi dữ liệu ra ngoài trong `packages/bundle/{base,web-app}`; `scripts/prod/tests/test-no-telemetry.sh` phải xanh |
| `packages/client/**/locales.ts`, `apps/web/index.html`, `vite.config.ts`, `Rows.module.css` | thương hiệu AHV, tiêu đề, lời chào, thao tác hàng trên màn cảm ứng | lấy upstream, thay chữ |
| `pnpm-workspace.yaml` | allowBuilds + miễn tuổi phát hành cho plugin AHV; override `playwright: 1.62.1` (dsh-browser dùng bản hoist, máy AHV có Chromium 1234) | upstream + khối AHV; `scripts/prod/tests/test-browser-playwright.sh` phải xanh |
| `patches/dsh-plugin-subscriptions.patch` (+ khoá theo tên trong `patchedDependencies`) | kho `~/.dsh/plugins/subscriptions/auth.json` là kho gốc của máy: làm mới lỗi (kể cả lỗi vĩnh viễn: Codex `refresh_token_reused/expired/invalidated`, `invalid_refresh_token`, `invalid_grant`; Claude/Grok/Antigravity `invalid_grant`; Copilot 401/403) KHÔNG xoá phiên của bất kỳ nhà cung cấp nào, vẫn báo `INVALID_CREDENTIAL`; token chết không gửi lại trong tiến trình; kho có phiên khác (login-sync) thì chạy hook auth-changed để pool bỏ án nghỉ; mọi lần ghi kho giữ lại mục plugin bỏ qua khi đọc (tài khoản thiếu token, nhà cung cấp lạ, mục không đọc được); chỉ đăng xuất do người dùng mới xoá | nâng pin plugin: vá không áp được thì `pnpm install` đỏ (`ERR_PNPM_PATCH_FAILED`; admin hoàn tác pin, `install.sh` dừng) → chuyển vá sang bản mới; `scripts/prod/tests/test-subscriptions-keep-session.mjs` phải xanh (release-cli + CI prebuilt chạy trên cây dựng) |
| `README.md`, `README.i18n.yaml`, `.gitlab-ci.yml` (xoá) | trang AHV | giữ phía fork |
| `scripts/prod/**`, `scripts/install-ahv-skin.sh`, `.github/workflows/prebuilt.yml` | công cụ phát hành AHV | của AHV |

## Kiểm bắt buộc trước khi phát hành

1. `pnpm run build` xanh.
2. Test liên quan: `npx vitest run packages/client/connection/tests packages/session/session-format-v0-to-v1/tests packages/bundle packages/boot/app-boot/tests apps/cli/tests packages/client/ui-sidebar/tests`
   và `for t in scripts/prod/tests/*.mjs; do node $t; done` (+ `bash scripts/prod/tests/test-*.sh`).
   `release-cli.sh` tự chạy `smoke-run.sh` (một `ahv run` thật), `test-browser-playwright.sh` và `test-subscriptions-keep-session.mjs` trên bản dựng.
3. Chạy thật từ cây vừa dựng trong một HOME tạm (không đụng `~/.ahv` thật):
   `ahv --version`, `ahv doctor`, `ahv run --prompt-file … --output jsonl`
   (ra `assistant_final` + `turn_end completed`), `ahv models list --json`,
   `ahv login usage --json`, `ahv sessions list --json`, `ahv web` (Playwright).
4. **Phiên cũ phải tiếp tục được**: chép kho phiên thật (`~ahvproxy/.dsh/sessions`)
   vào thư mục tạm và cho khôi phục thử qua catalog của lõi mới — 0 phiên chính
   bị từ chối. Lõi mới để nguyên tệp phiên cũ (tạo `session.vN.jsonl.zstd`
   bên cạnh), nên lùi bản vẫn đọc được — nhưng các lượt chạy trên lõi mới
   không hiện ra khi đã lùi.
5. Plugin bị lõi mới tắt vì `peerDependencies`: wrapper gọi
   `scripts/prod/ahv-plugin-grants.mjs` cấp miễn trừ đúng `tên@bản` mà bản
   phát hành đóng gói, cho đúng phiên bản dsh — nên chỉ phát hành sau khi
   bước 3 chạy thật các plugin đó.

## Phát hành + lùi

- Gộp nhánh vào `master` (merge, không squash), rồi `scripts/prod/release-cli.sh`
  (tag `v0.2.N`, dựng, **smoke có `ahv run` thật**, prebuilt, kênh canary, push).
- CMS chỉ đưa canary → stable khi máy canary báo `ahv run` thật đạt trên đúng
  tag đó (cổng `run_ok`), sau thời gian ngấm.
- Lùi: `promote.sh <tag cũ>` hoặc nút *Lùi* trên CMS; trên máy, updater lật
  `~/.ahv/src` về `versions/<tag cũ>`. Phiên đã nâng vẫn đọc được ở bản cũ
  (xem bước 4), nhưng các lượt chạy trên lõi mới không có ở bản cũ.
- Tiến lại sau khi lùi: `ahv run --resume` thấy log cũ ghi sau bản đã nâng thì
  cất bản đã nâng (`session.vN….superseded-<ts>`, không xoá) và để lõi mới nâng
  lại từ log cũ — giữ lượt làm lúc lùi, mất lượt làm trên lõi mới trước khi lùi.
  Web mở phiên không qua đường này: mở phiên trên web trước khi bot resume thì
  lõi mới dùng bản đã nâng cũ và các lượt lúc lùi bị che. Quy tắc dựa vào mtime
  — chép kho phiên sang máy khác phải giữ mtime (`cp -a`, `rsync -a`).
- Máy chỉ từng chạy lõi 0.2 (không có farm `~/.dsh/profiles/node_modules`) lùi
  về tag 0.1: updater gói bot (từ bản có `warm_ahv_cli_profile_for_user`) chạy
  `ahv models list` + `ahv version` bằng user bot để lõi 0.1 dựng farm trước khi
  ahv-web khởi động lại.

## Hotfix

Chỉ cần một sửa lẻ của upstream: `git cherry-pick <sha>` lên `master` thay vì
gộp cả tag, ghi rõ sha upstream trong commit.
