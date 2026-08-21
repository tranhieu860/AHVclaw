# AHV CLI

**AHV CLI** — agentic dev terminal cho developer Việt, built on
[DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).

## Quan hệ với upstream

Repo này là một soft fork của `deepseek-ai/deepseek-harness`:

- Giữ **nguyên** kiến trúc plugin (Cordis), package names `@deepseek-ai/*`,
  và ecosystem workspace. Không rebrand deep — mọi thứ bên trong vẫn là dsh
  để merge upstream không xung đột.
- Chỉ thêm **surface aliases**: binary `ahv` (song song với `dsh`) và tài
  liệu tiếng Việt. User gõ `ahv` hay `dsh` đều chạy cùng entrypoint.
- Landing site tiếng Việt: <https://ahvclaw.com>.

## Vì sao fork thay vì dùng thẳng dsh?

- **Localisation**: hướng dẫn + system prompt + demo bằng tiếng Việt.
- **Tự chủ**: giữ chủ động khi upstream đổi hướng hoặc pause.
- **Đóng gói riêng**: sau này có thể phân phối bundle riêng cho AHV Holding
  (skill packs, config presets) mà không cần merge ngược upstream.

## Chạy từ source

```bash
git clone https://github.com/tranhieu860/AHVclaw.git
cd AHVclaw
pnpm install                                       # node ^22.19 || >=24
export DEEPSEEK_API_KEY=sk-...                     # hoặc OpenAI-compat endpoint
pnpm ahv --profile headless "hello from AHV CLI"   # hoặc `pnpm dsh …`
```

Đầy đủ hướng dẫn dev (test, build, snapshot, doc-sync…) ở `AGENTS.md` gốc.

## Cập nhật từ upstream

```bash
git fetch upstream
git merge upstream/master
# Xử lý conflict (thường chỉ trong file README/BRAND_GUIDELINES nếu ta chạm)
pnpm install && pnpm run typecheck && pnpm run test
git push origin master
```

Xem [PULLING_UPSTREAM.md](./PULLING_UPSTREAM.md) cho quy trình chi tiết.

## Attribution

- **Tác giả gốc**: DeepSeek + cộng đồng dsh — <https://github.com/deepseek-ai/deepseek-harness>
- **License**: MIT (giữ nguyên upstream; xem [LICENSE](./LICENSE))
- **Trademark**: "DeepSeek Harness" là trademark của DeepSeek. Tuân thủ
  [BRAND_GUIDELINES.md](./BRAND_GUIDELINES.md) — AHV CLI dùng tên "AHV" cho
  fork của mình, không dùng trademark "DeepSeek Harness" trong tên project.

## Liên hệ

- Landing: <https://ahvclaw.com>
- Owner: Hiếu (`tranhieu860@gmail.com`)
- Repo: <https://github.com/tranhieu860/AHVclaw>
