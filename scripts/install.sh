#!/usr/bin/env bash
# Opentodo is self-contained: the app bundles its own opencode plugin and
# provisions an app-only config dir at runtime, so it needs no global setup.
#
# This script only CLEANS UP the old global install (plugin + agent + MCP) so
# the user's normal opencode sessions stay free of the opentodo mode/tools.
set -euo pipefail

CONFIG="$HOME/.config/opencode"

echo "==> remove old global opentodo plugin"
rm -f "$CONFIG/plugins/opentodo.js"

cat <<EOF

Done.

If your $CONFIG/opencode.jsonc still contains an "opentodo" entry under
"agent" or "mcp", remove those two blocks — the app no longer needs them and
they are what made "opentodo" show up as a mode in the TUI.

Build & run the app:
  ./scripts/build-app.sh
  open dist/Opentodo.app        # or unzip dist/Opentodo.zip elsewhere
EOF
