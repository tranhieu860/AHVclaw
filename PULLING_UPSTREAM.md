# Pulling upstream (dsh → AHV CLI)

Quy trình chuẩn để sync updates từ `deepseek-ai/deepseek-harness` về repo
này. Chạy khi upstream có release mới hoặc feature em muốn lấy về.

## Prerequisites

Remotes đã set (một lần khi clone):

```bash
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git remote -v   # phải thấy origin=tranhieu860/AHVclaw + upstream=deepseek-ai/...
```

## Fetch + merge

```bash
# 1. Fetch tất cả branches + tags từ upstream
git fetch upstream --tags

# 2. Xem diff với current
git log --oneline HEAD..upstream/master | head -20   # commits mới
git diff --stat HEAD upstream/master                 # files changed

# 3. Merge (fast-forward khi có thể)
git checkout master
git merge upstream/master

#   Nếu có conflict:
#   - Thường ở README-AHV.md, PULLING_UPSTREAM.md, apps/cli/package.json
#     (chỗ ta thêm bin "ahv"). Giữ phía "ours" cho các file này.
#     git checkout --ours README-AHV.md PULLING_UPSTREAM.md
#     git checkout --ours apps/cli/package.json  # rồi merge tay bin block
#   - Xong: git add . && git commit
```

## Validate

```bash
pnpm install                          # sync workspace deps
pnpm run typecheck
pnpm run test
pnpm run build
pnpm ahv --profile headless "hello"   # smoke E2E (cần DEEPSEEK_API_KEY)
```

## Push

```bash
git push origin master
```

## Nếu upstream force-pushed / rewrote history

Hiếm nhưng có thể xảy ra ở pre-release. Ta chọn 1 trong 2:

- **Rebase**: `git rebase upstream/master` — giữ AHV commits trên top,
  bắt buộc `--force-with-lease` push.
- **Reset + cherry-pick**: `git reset --hard upstream/master` rồi
  `git cherry-pick <ahv-commits>` lấy lại rebranding + docs.

## Tags

Upstream tag `dsh-v0.1.1-rc.1`, ta tag mirror `ahv-v0.1.1-rc.1` nếu
publish release AHV riêng:

```bash
git tag ahv-v0.1.1-rc.1 <sha>
git push origin ahv-v0.1.1-rc.1
```

## Frequency

- Sync mỗi khi upstream release tag mới (theo dõi
  <https://github.com/deepseek-ai/deepseek-harness/releases>).
- Hotfix nhanh: chỉ cherry-pick commit cụ thể thay vì merge full master.
