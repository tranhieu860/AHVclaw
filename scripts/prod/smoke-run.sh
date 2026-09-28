#!/usr/bin/env bash
# One real `ahv run`, exactly the way the Telegram bot calls it, and a verdict.
#
# `ahv doctor` only proves the tree is installed; v0.2.50 passed it and every
# run still died at plugin load ("...volatile is not a function"), and the CMS
# promoted it to stable. A release is only good if a prompt goes in and an
# answer comes out, so the smoke asks for PONG and reads the bot's JSONL.
#
# Usage: smoke-run.sh <ahv-bin> [timeout-seconds]
# Prints one JSON verdict line: {"ok":bool,"reason":str,"answer":str,"seconds":n}
# Exit 0 when ok, 1 otherwise.
set -uo pipefail

bin="${1:?ahv binary}"
limit="${2:-240}"
work="$(mktemp -d "${TMPDIR:-/tmp}/ahv-smoke-run.XXXXXX")"
trap 'rm -rf "$work"' EXIT
printf 'Reply with exactly one word: PONG\n' > "$work/prompt.txt"
mkdir -p "$work/cwd"

start=$(date +%s)
# The bot's own flags (ahv-bot/bot.py): prompt file, cwd, JSONL, no colour/banner.
timeout "$limit" "$bin" run --prompt-file "$work/prompt.txt" --cwd "$work/cwd" \
  --output jsonl --no-color --no-banner > "$work/out.jsonl" 2> "$work/err.txt"
rc=$?
elapsed=$(( $(date +%s) - start ))

python3 - "$work/out.jsonl" "$work/err.txt" "$rc" "$elapsed" <<'PY'
import json, re, sys
out, err, rc, elapsed = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
answer, turn_end, error = "", None, None
for line in open(out, encoding="utf-8", errors="replace"):
    try:
        event = json.loads(line)
    except ValueError:
        continue
    kind = event.get("type")
    if kind == "assistant_final":
        answer = str(event.get("text") or "")
    elif kind == "turn_end":
        turn_end = event.get("reason")
    elif kind == "error" and error is None:
        error = str(event.get("message") or event.get("code") or "error")
lines = [l.strip() for l in open(err, encoding="utf-8", errors="replace") if l.strip()]
# Node prints its version last; the line naming the error is the useful one.
# The innermost "[cause]: TypeError: ..." is what actually broke.
named = [l for l in lines if re.search(r"(^|\]: )\w*Error: ", l)]
tail = (named[-1:] or lines[-1:] or [""])
if rc == 124:
    reason = f"timed out after {elapsed}s"
elif error is not None:
    reason = f"error event: {error}"
elif rc != 0:
    reason = f"exit {rc}: {tail[0]}"
elif turn_end != "completed":
    reason = f"turn_end {turn_end!r}"
elif "PONG" not in answer.upper():
    reason = f"unexpected answer {answer[:80]!r}"
else:
    reason = ""
ok = reason == ""
print(json.dumps({"ok": ok, "reason": reason[:300], "answer": answer[:80], "seconds": elapsed}, ensure_ascii=False))
sys.exit(0 if ok else 1)
PY
