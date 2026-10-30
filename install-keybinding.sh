#!/bin/bash

# Binds Super+Alt+Esc to the Force Quit panel, like Cmd+Option+Esc on macOS.
# Adds a marked block to ~/.config/hypr/bindings.lua once; running it again
# changes nothing. --remove takes the block back out.

set -euo pipefail

BINDINGS="${XDG_CONFIG_HOME:-$HOME/.config}/hypr/bindings.lua"
BEGIN="-- BEGIN omarchy-force-quit"
END="-- END omarchy-force-quit"

[[ -f $BINDINGS ]] || { echo "install-keybinding: $BINDINGS not found" >&2; exit 1; }

reload() {
  command -v hyprctl >/dev/null || return 0
  hyprctl reload >/dev/null
  hyprctl configerrors
}

case "${1:-}" in
"")
  # Any existing toggle binding counts, so a hand-added one is not doubled.
  if grep -qF "thebenwalther.force-quit toggle" "$BINDINGS"; then
    echo "Force Quit is already bound in $BINDINGS"
    exit 0
  fi
  cp "$BINDINGS" "$BINDINGS.bak.$(date +%s)"
  cat >>"$BINDINGS" <<EOF

$BEGIN
o.bind("SUPER + ALT + ESCAPE", "Force quit apps", "omarchy-shell thebenwalther.force-quit toggle")
$END
EOF
  echo "Bound Super+Alt+Esc to Force Quit in $BINDINGS"
  reload
  ;;
--remove)
  if ! grep -qxF -- "$BEGIN" "$BINDINGS"; then
    echo "No Force Quit block in $BINDINGS"
    exit 0
  fi
  backup="$BINDINGS.bak.$(date +%s)"
  cp "$BINDINGS" "$backup"
  # Drop the block and the blank line added before it; writing through the
  # existing file keeps it in place if it is a symlink.
  awk -v b="$BEGIN" -v e="$END" '
    skip { if ($0 == e) skip = 0; next }
    $0 == b { skip = 1; blank = 0; next }
    blank { print ""; blank = 0 }
    $0 == "" { blank = 1; next }
    { print }
    END { if (blank) print "" }
  ' "$backup" >"$BINDINGS"
  echo "Removed the Force Quit binding from $BINDINGS"
  reload
  ;;
*)
  echo "Usage: install-keybinding.sh [--remove]" >&2
  exit 1
  ;;
esac
