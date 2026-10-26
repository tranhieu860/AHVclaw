#!/bin/bash
# Make the AHV brand (logo + "AHV Harness") active in the web UI.
#
# Four things have to be true, and an update can undo any of them, so this
# script asserts all four and is safe to re-run:
#   1. @linxin666/dsh-client-ui-skin-center is a dependency of the web profile,
#      at the version the install closure pins
#   2. the skin assets live inside that package as skins/ahv/  (pnpm regenerates
#      the store on install and drops them)
#   3. the profile's patch layer loads the plugin — installing the package alone
#      does not register it, the loader only boots what a patch row inserts
#   4. $DSH_HOME/skin-center-active.json selects "ahv"
#
# Run after every `pnpm install`; scripts/prod/install.sh calls it.

set -e

FORK="${FORK:-$(cd "$(dirname "$0")/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-$DSH_HOME/profiles/web}"
SKIN_SRC="$FORK/packages/bundle/ahv/skin-assets"
PKG="@linxin666/dsh-client-ui-skin-center"

if [ ! -d "$SKIN_SRC" ]; then
  echo "[ahv-skin] skin assets not found at $SKIN_SRC"
  exit 1
fi

# 1. The plugin package, at exactly the version this install's own closure
# carries (the one @linxin666/dsh-web-ui-all depends on, which the AHV skin is
# tested against). Never "latest": skin-center 0.4 ships its own default skin,
# does not load "ahv", and once dsh 0.2.1 satisfies its peer it paints that
# skin over the AHV brand. A profile holding any other version — an earlier
# run of this script installed "latest" — is moved back to the pinned one.
WANT=$(node -e '
  const { createRequire } = require("module")
  try {
    const bundle = createRequire(process.argv[1] + "/package.json")
    const webUi = createRequire(bundle.resolve("@linxin666/dsh-web-ui-all/package.json"))
    console.log(webUi(process.argv[2] + "/package.json").version)
  } catch { console.log("") }
' "$FORK/packages/bundle/ahv" "$PKG" 2>/dev/null || true)
if [ -z "$WANT" ]; then
  echo "[ahv-skin] không thấy $PKG trong cây cài — không đổi profile web"
elif [ -d "$PROFILE" ]; then
  HAVE=$(node -e '
    try { console.log(require(process.argv[1] + "/package.json").version) } catch { console.log("") }
  ' "$PROFILE/node_modules/$PKG" 2>/dev/null || true)
  if [ "$HAVE" != "$WANT" ]; then
    echo "[ahv-skin] cài $PKG@$WANT vào profile web${HAVE:+ (đang $HAVE)}..."
    (cd "$PROFILE" && PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm add --save-exact "$PKG@$WANT") \
      || echo "[ahv-skin] pnpm add fail — skin sẽ không nạp được"
  fi
fi
# 2. Skin assets, into every copy of the package that resolution can reach.
# Plain globs, not `ls`: a glob that matches nothing expands to itself and is
# filtered out by the -d test, whereas `ls` exits non-zero and set -e kills the
# assignment mid-script.
targets=()
for d in "$FORK"/node_modules/.pnpm/@linxin666+dsh-client-ui-skin-center@*/node_modules/"$PKG" \
         "$PROFILE"/node_modules/.pnpm/@linxin666+dsh-client-ui-skin-center@*/node_modules/"$PKG" \
         "$PROFILE/node_modules/$PKG"; do
  [ -d "$d" ] && targets+=("$d")
done

installed=0
for t in "${targets[@]}"; do
  [ -d "$t" ] || continue
  mkdir -p "$t/skins/ahv"
  cp -r "$SKIN_SRC"/* "$t/skins/ahv/"
  echo "[ahv-skin] assets → $t/skins/ahv/"
  installed=$((installed + 1))
done

if [ $installed -eq 0 ]; then
  echo "[ahv-skin] no skin-center package found; is pnpm install done?"
  exit 1
fi

# 3. The patch row. The profile's own layer is the documented place for user
# inserts, and `[]` is the empty placeholder shipped with a fresh profile.
PATCH="$PROFILE/cordis.patch.yml"
if [ -d "$PROFILE" ]; then
  python3 - "$PATCH" <<'PY'
import sys, pathlib
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8") if path.exists() else ""
if "web-ui-skin-center" in text:
    print("[ahv-skin] patch row đã có")
    raise SystemExit
# Drop the empty-list placeholder — a document cannot be both [] and a list of
# entries, and leaving it makes the YAML parse to an empty tree.
kept = [ln for ln in text.splitlines() if ln.strip() != "[]"]
kept.append("")
kept.append("# AHV brand: load the skin center so the \"ahv\" skin (logo + \"AHV Harness\")")
kept.append("# applies. Which skin is active lives in $DSH_HOME/skin-center-active.json.")
kept.append("- insert:")
kept.append("    - id: web-ui-skin-center")
kept.append("      name: '@linxin666/dsh-client-ui-skin-center'")
path.write_text("\n".join(kept).lstrip("\n") + "\n", encoding="utf-8")
print("[ahv-skin] patch row → " + str(path))
PY
fi

# 4. The selection. Only when unset: a deliberate switch to another skin is the
# user's call, and an update should not stomp it.
ACTIVE="$DSH_HOME/skin-center-active.json"
if [ ! -s "$ACTIVE" ] || ! grep -q '"active"[[:space:]]*:[[:space:]]*"' "$ACTIVE" 2>/dev/null; then
  mkdir -p "$DSH_HOME"
  printf '{\n  "active": "ahv"\n}\n' > "$ACTIVE"
  echo "[ahv-skin] chọn skin ahv → $ACTIVE"
fi
