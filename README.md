# Screen Snapper

A Cinnamon extension (tested on Cinnamon 6.6, X11) that improves window snapping.

## Features

**Keep snapped size.** Drag a window to a screen edge or corner and it snaps
to that zone. When you later drag it back out, Cinnamon normally shrinks it
back to its size from before it was snapped. With this extension it keeps the
snapped size, and the cursor stays on the spot of the title bar you grabbed.

**Snap overlay.** While dragging a window, hold a key to see where it can snap.

Hold **Ctrl** to see the edge-tiling zones, where the window snaps when you
drag it to an edge or corner:

| Look | Meaning |
|---|---|
| Blue cells | The four quarters of each monitor; two side by side make a half |
| Amber strips along the edges | Touch one with the pointer to snap to that half |
| Pink corner squares | Touch one to snap to that quarter |
| Green fill | The zone the window snaps to if you let go now |

Hold **Ctrl+Shift** to see the targets for Shift's edge snapping. With Shift
held, the window keeps its current size and its edges jump to line up with
monitor, panel and other windows' edges:

| Look | Meaning |
|---|---|
| Blue outlines | Each monitor, and its usable area inside the panels |
| Amber outline, shaded | Other windows whose edges you can snap to |
| Green outline | Where the dragged window will land |
| Bright green lines | Edges the dragged window is lined up with |

Ctrl doesn't change how the window snaps; it only shows the overlay. Let go of
Ctrl and the overlay disappears.

Zone sizes are usually half the monitor, but if a window is already tiled to
one side, the other side's zone fills the space that's left. The quarter
outlines are estimates in some layouts; the green fill is always exactly
what Cinnamon will do.

Colors live in `screen-snapper@local/stylesheet.css`.

## Install

```sh
./install.sh
```

This symlinks `screen-snapper@local` into `~/.local/share/cinnamon/extensions/`
and enables it. Run it again after editing to reload the extension.

To turn it off, use System Settings → Extensions.
