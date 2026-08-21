# @ahv/dsh-bundle-ahv

Profile bundle của AHV Holding. Sits over `@deepseek-ai/dsh-base` và rewire
harness dùng router LLM riêng của AHV, kèm persona tiếng Việt.

## Dùng

```bash
# Với dsh bin:
pnpm dsh --profile ahv "hello"

# Với ahv bin (alias, cùng profile):
pnpm ahv "hello"
```

Cần env var `AHV_API_KEY` cho router `auto.ahvchat.com/v1`.

## Đè gì so với base

- **Model mặc định**: `AHV-Holding` (route `ahv-router`) thay vì
  `deepseek-v4-flash` của upstream. Combo router thấy models
  `AHV-Holding`, `AHV-Holding-TroLy`, `AHV-Holding-DEV`,
  `Grok-SuperHeavy`.
- **Web search**: tắt (DeepSeek search cần key riêng ta không có; sẽ
  mount Brave/Tavily/AHV-native trong bản sau).
- **System prompt**: persona tiếng Việt ngắn gọn.

Chi tiết row-by-row trong `cordis.patch.yml`.

## Extend

User cá nhân đè thêm trong `~/.dsh/settings.yaml` section
`llm-pi-ai.providers.ahv-router` — vd tăng `contextWindow` hoặc thêm
model.
