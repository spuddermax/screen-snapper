#!/bin/bash
# Link the extension into Cinnamon's extensions folder and enable it.
set -euo pipefail

UUID=screen-snapper@spuddermax
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/cinnamon/extensions"

mkdir -p "$DEST"
ln -sfn "$SRC" "$DEST/$UUID"
# Earlier, unpublished names of this extension.
OLD=(keep-snapped-size@local screen-snapper@local)
for old in "${OLD[@]}"; do
    if [ -L "$DEST/$old" ]; then rm "$DEST/$old"; fi
done

python3 - "$UUID" "${OLD[@]}" <<'PY'
import ast, subprocess, sys
uuid, old = sys.argv[1], sys.argv[2:]
cur = subprocess.check_output(["gsettings", "get", "org.cinnamon", "enabled-extensions"], text=True).strip()
cur = [] if cur.startswith("@as") else ast.literal_eval(cur)
new = [e for e in cur if e not in old and e != uuid]
# Re-adding the uuid makes Cinnamon reload the extension.
subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-extensions", str(new)])
subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-extensions", str(new + [uuid])])
PY

echo "Installed and enabled $UUID"
