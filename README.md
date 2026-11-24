# Screen Snapper

A Cinnamon extension (tested on Cinnamon 6.6, X11) that improves window snapping.

## Features

**Keep snapped size.** Drag a window to a screen edge or corner and it snaps
to that zone. When you later drag it back out, Cinnamon normally shrinks it
back to its size from before it was snapped. With this extension it keeps the
snapped size, and the cursor stays on the spot of the title bar you grabbed.

**Snap overlay.** Hold **Shift** while dragging a window and Cinnamon snaps the
window's edges to nearby edges: monitor edges, panel edges and other
windows' edges. While Shift is held, a transparent overlay shows:

| Color | Meaning |
|---|---|
| Blue outline | Each monitor, and its usable area inside the panels (lightly shaded) |
| Amber outline, shaded | Other windows whose edges you can snap to |
| Green outline | Where the dragged window will land |
| Bright green lines | Edges the dragged window is lined up with |

Release Shift and the overlay disappears, and the drag goes back to normal.

Colors live in `screen-snapper@local/stylesheet.css`.

## Install

```sh
./install.sh
```

This symlinks `screen-snapper@local` into `~/.local/share/cinnamon/extensions/`
and enables it. Run it again after editing to reload the extension.

To turn it off, use System Settings → Extensions.
