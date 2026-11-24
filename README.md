# Screen Snapper

A Cinnamon extension (tested on Cinnamon 6.6, X11) that replaces Cinnamon's
edge tiling with an eighths snapping grid.

## Snapping grid

Each monitor's usable area (inside the panels) is split into eighths:
4 columns × 2 rows on a landscape monitor, 2 columns × 4 rows on a portrait
one. Every grid line and every screen edge has a drop band 50 px deep on each
side, so bands on interior lines are 100 px wide.

Drag a window by its title bar. When the pointer is in a band, an orange
preview shows where the window will go; let go to snap it there. In the open
middle of a cell nothing snaps and the window just moves.

| Where you drop | Window you get |
|---|---|
| A corner | The quarter of the screen in that corner |
| A long-side edge (left/right in landscape, top/bottom in portrait) | ¾ of the screen against that edge; where you are along the edge picks which row (or column), or both on the middle line |
| A short-side edge on the center line | Maximized |
| A short-side edge on one of the other lines | A full-length strip along that edge |
| Anywhere else in a band | Every cell touching where you drop: on a line, the cells either side; on a line crossing, the 4 cells around it; on an edge at the middle of a cell, that cell |

Together these reach all 30 rectangles the grid allows.

Cinnamon's own edge tiling is turned off while the extension is enabled and
turned back on when you disable it. Super+arrow keyboard tiling still works.

## Overlays

Hold **Ctrl** while dragging to see every drop band, colored by rule, with the
band under the pointer outlined.

Hold **Shift** while dragging to use Cinnamon's edge snapping instead of the
grid: the window keeps its size and its edges line up with monitor, panel and
other windows' edges. Hold **Ctrl+Shift** to see those targets.

Ctrl doesn't change where a window snaps; it only shows the overlay.

## Keep tiled size

Windows tiled with Super+arrows normally shrink back to their old size when
you drag them out of the tile. This extension keeps the tiled size, and the
pointer stays where you grabbed the title bar.

## Install

```sh
./install.sh
```

This symlinks `screen-snapper@local` into `~/.local/share/cinnamon/extensions/`
and enables it. Run it again after editing to reload the extension.

Colors live in `screen-snapper@local/stylesheet.css`. The band depth is
`BAND` at the top of `screen-snapper@local/extension.js`.

To turn it off, use System Settings → Extensions.
