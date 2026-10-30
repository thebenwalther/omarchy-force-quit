# Force Quit for Omarchy

A macOS-style Force Quit panel for the Omarchy bar. One row per open app (windows grouped by the process that owns them), with live CPU and memory, so a spinning or frozen app stands out. **Quit** asks the app's windows to close; **Force Quit** kills its process tree after a confirmation.

An independent community plugin, licensed under [MIT](LICENSE). Not affiliated with Omarchy.

## Controls

- Bar click or **Super+Alt+Esc** (with the keybinding below): open or close the panel.
- Arrow keys select an app. **q** quits it; **Enter** or **Delete** force quits it after a confirmation. **Escape** cancels the confirmation or closes the panel.
- Chromium web apps and Steam games are named from their desktop entries, not their window classes.
- Windows that share a process (Chromium and its web apps) collapse into one row, because killing that process closes all of them.
- CPU turns urgent above 80%.

## Install, update, remove

Requires Omarchy 4.x with Quickshell and Hyprland with the Lua API.

```sh
omarchy plugin add https://github.com/thebenwalther/omarchy-force-quit --enable
~/.config/omarchy/plugins/thebenwalther.force-quit/install-keybinding.sh
omarchy restart shell
```

The keybinding script adds a marked block binding Super+Alt+Esc to `~/.config/hypr/bindings.lua`, after backing the file up. Running it again changes nothing.

Update:

```sh
omarchy plugin update thebenwalther.force-quit
omarchy restart shell
```

**Remove in this order** so the binding goes before the script does:

```sh
~/.config/omarchy/plugins/thebenwalther.force-quit/install-keybinding.sh --remove
omarchy plugin remove thebenwalther.force-quit
omarchy restart shell
```

## Implementation

- `Panel.qml`: the panel and bar widget. Reads `hyprctl clients -j` and samples `/proc/*/stat` twice to compute CPU like `top`.
- `Model.js`: pure helpers (parsing, CPU, process trees, app naming), with no QML, so they can be exercised with `node` against live output.
