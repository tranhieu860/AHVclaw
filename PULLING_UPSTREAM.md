# Nâng lõi dsh (upstream → AHV CLI)

AHV CLI là fork mềm của [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
Lõi được nâng **bằng tay, theo tag phát hành của upstream**, không tự động:
CMS `ahvclaw.com/admin` → *AHV CLI* chỉ báo "lõi dsh X — upstream mới nhất Y
(tụt N ngày)" và cảnh báo khi tụt quá 14 ngày; không có gì tự merge.

Lần gần nhất: `dsh-v0.2.0-rc.2` → `dsh-v0.2.1-rc.3` (26/10/2026, nhánh
`upgrade-dsh-0.2.1-rc.3`, 1.931 commit, 7 xung đột; dựng + test trên máy làm
việc #48). Lần trước: `dsh-v0.2.0-rc.1` → `dsh-v0.2.0-rc.2` (04/10/2026, 187
commit, 6 xung đột) và `dsh-v0.1.1-rc.1` → `dsh-v0.2.0-rc.1` (29/09/2026, 7.171
commit, 24 xung đột).

Upstream ghi mọi thay đổi cần sửa cấu hình/mã ở `docs/upgrade-guide/<bản>/*/guide.md`
— đọc hết các thư mục của những bản nằm giữa hai tag trước khi chạy thử.

### Ghi chú phát hành lõi 0.2.1-rc.3

- Lõi dsh lên 0.2.1-rc.3 (gồm 0.2.1-alpha.1…5, rc.1, rc.2). Lớp gọi model `pi-ai`
  lên 1.1.0. Định dạng phiên vẫn `session.v4`; phiên cũ của bot (cả phiên do lõi
  0.1.1-rc.1 ghi) mở tiếp được.
- `ahv run --model X` nay **thật sự** chạy model X. Từ lõi 0.2 (đã thử lại trên
  v0.2.78) cờ này bị bỏ qua: mọi lượt đi tới model mặc định của router dù
  `session_meta` báo X.
- Giao việc cho subagent: lõi mới trả lời của subagent về sau bằng một lượt nữa;
  `ahv run` chờ tới khi không còn subagent chạy rồi mới thoát.
- Phiên mà thư mục làm việc đã bị xoá: lõi mới lỗi mọi lượt; `ahv run --resume`
  chuyển phiên sang `--cwd` của lần gọi và báo model.
- Giữ nguyên: tắt gửi dữ liệu về DeepSeek (thêm tắt tìm kiếm/fetch qua
  api.deepseek.com mới của lõi), kho tài khoản không bị xoá khi làm mới lỗi,
  thương hiệu AHV trên web, hợp đồng `ahv run` của bot.
- **Lùi bản**: phiên đã có một lượt dùng công cụ trên lõi 0.2.1 ghi sự kiện
  `job/registered`/`job/settled` (và `working-directory/change` khi model đổi
  thư mục) mà lõi rc.2 không biết → v0.2.78 trở xuống từ chối mở phiên đó. Xem
  mục "Phát hành + lùi".
- `ahv web --host 0.0.0.0` (hay `::`) bị lõi mới từ chối; ahv-web phải bind một
  địa chỉ cụ thể (máy AHV dùng 127.0.0.1 sau cổng đăng nhập).

### Ghi chú phát hành lõi 0.2.0-rc.2 (AHV CLI v0.2.59)

### Ghi chú phát hành lõi 0.2.0-rc.2 (AHV CLI v0.2.59)

- Lõi dsh lên 0.2.0-rc.2. Phần lớn thay đổi của upstream là ứng dụng Desktop/Windows
  và giao diện web (ô tìm model, câu hỏi có hẹn giờ, mở thư mục từ cây tệp).
- Lớp gọi model `pi-ai` lên 0.87.1 (đường router AHV đi qua lớp này).
- Định dạng phiên không đổi (vẫn `session.v4`): phiên cũ của bot mở tiếp được,
  lùi về v0.2.58 vẫn đọc được phiên.
- Giữ nguyên: tắt gửi dữ liệu về DeepSeek, kho tài khoản không bị xoá khi làm mới
  lỗi, thương hiệu AHV, hợp đồng `ahv run` của bot.
- Plugin có `peerDependencies` đòi lõi ≥ 0.2.0-rc.2 (vd `@anweat/dsh-browser` 0.2.0)
  từ bản này mới nâng được — registry đang giữ dsh-browser < 0.2.0, gỡ giữ là việc riêng.

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
| `apps/cli/src/bin.ts` | `withAhvDefaultProfile()` | lấy bản upstream, cấy lại hàm quanh `process.argv.slice(2)` trong `parseDshArgs(...)` (rc.2: thêm tham số thứ 3 `manageDesktopProfile`; 0.2.1 không đổi) |
| `packages/boot/app-boot/src/profile.ts` | profile `ahv`, `ahv-web` | thêm vào `PROFILE_TEMPLATES` theo định dạng mới |
| `packages/bundle/ahv/**` | bundle AHV (router, persona, plugin, bot-runner) | của AHV; soát id dòng base/headless còn tồn tại, khoá cấu hình đổi tên (0.2: `persona` → `personaPrefix`), dòng upstream đã đưa vào base (0.2: storage, projection-cache) |
| `packages/bundle/ahv/src/bot-runner.ts` | `ahv run`: JSONL cho bot, `--model` (lựa chọn gắn vào Agent là model đã chọn), `--system-file` (section `ahv:system-file`, không nội suy), chờ subagent con + `agent/error` như runner headless upstream, `--resume` phiên mất thư mục → `--cwd` | mỗi lần gộp so với `packages/bundle/headless/src/index.ts` của upstream và cấy lại thay đổi của vòng chờ; test `packages/bundle/ahv/tests/*.spec.ts` |
| `packages/bundle/ahv/package.json` | ngoài plugin, khai các gói lõi mà plugin AHV đòi làm peer (`workspace:^`: client-*, settings, tools, commands, attachment, home-paths, host-webserver, web) | thiếu thì lõi mới không thoả khoảng peer cũ của plugin, `pnpm install` đi tìm bản 0.1/0.2.0 trên npm và hỏng (`ERR_PNPM_NO_MATCHING_VERSION`); peer mới của plugin thì thêm vào đây |
| `packages/session/session-list-metadata` | projection cho `ahv run` | đồng bộ với `sessionListMetadata` của session-controller |
| `packages/session/session-format-v0-to-v1/src/ahv-fork-legacy.ts` | chuẩn hoá phiên do lõi 0.1.1-rc.1 ghi | giữ; thiếu là mọi hội thoại bot cũ bị từ chối |
| `packages/client/connection` (`browserAuth: external`) | ahv-web bind loopback sau cổng ahv-web-ui-auth | giữ; 0.2.1 viết lại xác thực (Peer chủ cho trình duyệt, Peer API qua `/connect`): `admit()` trả Peer chủ cho mọi yêu cầu qua rào Host/Origin, `/connect` trả 401 vì không có launch token; vá AHV trong `cordis.patch.web.yml` phải chép đúng biểu thức `trustedHosts` của hàng connection web-app (0.2.1: `ctx.webStartup.trustedHosts`, test `web-connection.spec.ts`) |
| `packages/bundle/ahv/cordis.patch*.yml` (telemetry) + `ahv-wrapper.sh` (`DSH_TELEMETRY_DISABLED=1`) | không gửi gì về DeepSeek (0.2 bật mặc định gửi log phiên khi có phản hồi); tắt tài khoản DeepSeek trên web | mỗi lần gộp: soát dòng mới gửi dữ liệu ra ngoài trong `packages/bundle/{base,web-app}`; `scripts/prod/tests/test-no-telemetry.sh` phải xanh |
| `packages/client/**/locales.ts`, `apps/web/index.html`, `vite.config.ts`, `Rows.module.css` | thương hiệu AHV, tiêu đề, lời chào, thao tác hàng trên màn cảm ứng | lấy upstream, thay chữ |
| `pnpm-workspace.yaml` | allowBuilds + miễn tuổi phát hành cho plugin AHV; override `playwright: 1.62.1` (dsh-browser dùng bản hoist, máy AHV có Chromium 1234) | upstream + khối AHV; `scripts/prod/tests/test-browser-playwright.sh` phải xanh |
| `patches/dsh-plugin-subscriptions.patch` (+ khoá theo tên trong `patchedDependencies`) | kho `~/.dsh/plugins/subscriptions/auth.json` là kho gốc của máy: làm mới lỗi (kể cả lỗi vĩnh viễn: Codex `refresh_token_reused/expired/invalidated`, `invalid_refresh_token`, `invalid_grant`; Claude/Grok/Antigravity `invalid_grant`; Copilot 401/403) KHÔNG xoá phiên của bất kỳ nhà cung cấp nào, vẫn báo `INVALID_CREDENTIAL`; token chết không gửi lại trong tiến trình; kho có phiên khác (login-sync) thì chạy hook auth-changed để pool bỏ án nghỉ; mọi lần ghi kho giữ lại mục plugin bỏ qua khi đọc (tài khoản thiếu token, nhà cung cấp lạ, mục không đọc được; đăng nhập mới bên cạnh mục không đọc được thì gộp tài khoản của mục đó — những mục này không hiện ở giao diện, bỏ bằng `ahv login forget <provider> <khoá>`; ghi kho không có khoá giữa các tiến trình, như trước); chỉ đăng xuất do người dùng mới xoá | nâng pin plugin: vá không áp được thì `pnpm install` đỏ (`ERR_PNPM_PATCH_FAILED`; admin hoàn tác pin, `install.sh` dừng) → chuyển vá sang bản mới; `scripts/prod/tests/test-subscriptions-keep-session.mjs` phải xanh (release-cli + CI prebuilt chạy trên cây dựng) |
| `scripts/install-ahv-skin.sh` | skin-center của profile web đúng bản trong cây cài (bản `@linxin666/dsh-web-ui-all` dùng), không bao giờ `latest` | skin-center 0.4 có skin mặc định riêng (ảnh cá voi, chữ Trung) và không nạp skin `ahv`; `scripts/prod/tests/test-ahv-skin-version.sh` |
| `README.md`, `README.i18n.yaml`, `.gitlab-ci.yml` (xoá) | trang AHV | giữ phía fork |
| `scripts/prod/**`, `scripts/install-ahv-skin.sh`, `.github/workflows/prebuilt.yml` | công cụ phát hành AHV | của AHV |

## Kiểm bắt buộc trước khi phát hành

1. `pnpm run build` xanh.
2. Test liên quan: `npx vitest run packages/client/connection/tests packages/session/session-format-v0-to-v1/tests packages/bundle packages/boot/app-boot/tests apps/cli/tests packages/client/ui-sidebar/tests packages/llm/llm-pi-ai/tests packages/session/working-directory packages/subagent/subagent packages/jobs`
   và `for t in scripts/prod/tests/*.mjs; do node $t; done` (+ `bash scripts/prod/tests/test-*.sh`).
   `release-cli.sh` tự chạy `smoke-run.sh` (một `ahv run` thật), `test-browser-playwright.sh` và `test-subscriptions-keep-session.mjs` trên bản dựng.
   Trên #48, `packages/client/connection/tests/binary-rpc.host.spec.ts` (gzip/none qua HTTP bridge)
   hết giờ 5 s do môi trường máy đó; cùng tệp chạy xanh trên #20 (04/10); chạy với
   `--testTimeout=60000` thì xanh ở #48 (26/10).
3. Chạy thật từ cây vừa dựng trong một HOME tạm (không đụng `~/.ahv` thật):
   `ahv --version`, `ahv doctor`, `ahv run --prompt-file … --output jsonl`
   (ra `assistant_final` + `turn_end completed`), `ahv models list --json`,
   `ahv login usage --json`, `ahv sessions list --json`, `ahv web` (Playwright).
   Lượt có gọi công cụ kiểm bằng tài khoản thật qua `--model` (cổng kênh thử #20: mỗi
   nhà một câu + một lượt công cụ) và soi `request/header` trong log phiên: provider/model
   phải đúng cái đã chọn (trước 0.2.1 `--model` bị bỏ qua, mọi lượt đi tới router).
   HOME tạm cần `~/.cache/ms-playwright` trỏ tới Chromium 1234 thì công cụ trình duyệt mới chạy.
   Chạy `--resume` phiên thật bằng đúng user bot (`sudo -u ahvproxy`, HOME tạm) — dưới
   user khác lượt chạy sẽ lỗi `EACCES … AHV-ahvclaw/.git` dù phiên đã khôi phục được.
4. **Phiên cũ phải tiếp tục được**: chép kho phiên thật (`~ahvproxy/.dsh/sessions`)
   vào thư mục tạm và cho khôi phục thử qua catalog của lõi mới — 0 phiên chính
   bị từ chối. Lõi mới để nguyên tệp phiên cũ (tạo `session.vN.jsonl.zstd`
   bên cạnh), nên lùi bản vẫn đọc được — nhưng các lượt chạy trên lõi mới
   không hiện ra khi đã lùi.
5. **Lùi bản đọc được phiên do lõi mới ghi**: chép một phiên vừa có lượt dùng công cụ
   (và một phiên có `working_directory` đổi thư mục) sang cây của tag lùi về rồi
   `ahv run --resume`. Sự kiện mới không `ignorable` làm bản cũ từ chối cả phiên
   ("unknown to this harness and not marked ignorable").
6. `/etc/default/ahv-web` mọi máy: `AHV_WEB_BIND_HOST` là địa chỉ cụ thể (lõi 0.2.1
   từ chối `0.0.0.0`/`::`).
7. Plugin bị lõi mới tắt vì `peerDependencies`: wrapper gọi
   `scripts/prod/ahv-plugin-grants.mjs` cấp miễn trừ đúng `tên@bản` mà bản
   phát hành đóng gói, cho đúng phiên bản dsh — nên chỉ phát hành sau khi
   bước 3 chạy thật các plugin đó.

## Phát hành + lùi

- Gộp nhánh vào `master` (merge, không squash), rồi `scripts/prod/release-cli.sh`
  (tag `v0.2.N`, dựng, **smoke có `ahv run` thật**, prebuilt, kênh canary, push).
- CMS chỉ đưa canary → stable khi máy canary báo `ahv run` thật đạt trên đúng
  tag đó (cổng `run_ok`), sau thời gian ngấm.
- **Sàn an toàn kho** (30/09): v0.2.49 và v0.2.53–v0.2.55 xoá tài khoản khỏi kho
  khi làm mới token lỗi, nên không đường lùi nào xuống dưới sàn (mặc định
  v0.2.56; CMS ghi `store_floor` vào `channels.json`, chỉ hạ được ở CMS → Cài
  đặt với câu gõ xác nhận). `promote.sh` và bước kênh của `release-cli.sh` từ
  chối tag dưới sàn (`scripts/prod/tests/test-promote-floor.sh`); updater gói
  bot ≥ 0.0.412 cũng vậy. Bản sau này mà lại mất tài khoản kho thì đừng phát
  hành; sửa xong mới nâng sàn lên bản đó (sàn không cao hơn `stable`).
- **Lùi từ lõi 0.2.1 về lõi rc.2 (≤ v0.2.79)**: phiên đã có lượt dùng công cụ trên
  0.2.1 không mở được ở bản cũ (bot nhận `internal_error terminal`). Trước khi đưa
  0.2.1 ra cả đội, phát hành một bản cầu trên lõi rc.2 biết ba loại sự kiện
  `job/registered`, `job/settled`, `working-directory/change` (không ảnh hưởng lịch
  sử model), đưa bản cầu lên stable và coi nó là đích lùi thấp nhất của 0.2.1.
  Đã thử nguyên mẫu (thêm ba tên vào `KNOWN_SESSION_EVENT_TYPES` của rc.2): v0.2.78 +
  cầu mở và nối tiếp được phiên 0.2.1, rồi 0.2.1 mở lại phiên đó được (26/10, #48).
  Bản thật phải khai báo ba sự kiện trong `SessionEventMap` và sinh lại catalog
  (`pnpm run gen-persistence-catalog`), không sửa tay tệp sinh.
- Lùi: `promote.sh <tag cũ>` hoặc nút *Lùi* trên CMS (chỉ trong các bản ≥ sàn);
  trên máy, updater lật `~/.ahv/src` về `versions/<tag cũ>`. Phiên đã nâng vẫn đọc được ở bản cũ
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
