# Screen Snapper

A Cinnamon extension (tested on Cinnamon 6.6, X11) that replaces Cinnamon's
edge tiling with an eighths snapping grid.

**Try it in a browser first:** [`docs/demo.html`](docs/demo.html) is an
interactive model of the grid. Drag window edges with Ctrl and Shift, switch
monitors and workspaces, and hover any drop band to see the window it gives.
Download it and open it locally; it needs no install. The screenshots below
come from it.

## Snapping grid

Each monitor's usable area (inside the panels) is split into eighths:
4 columns × 2 rows on a landscape monitor, 2 columns × 4 rows on a portrait
one. Every grid line and every screen edge has a drop band 50 px deep on each
side, so bands on interior lines are 100 px wide.

Snapping only happens while you hold **Ctrl**. Drag a window by its title
bar, hold Ctrl, and the drop bands appear with the band under the pointer
outlined. When the pointer is in a band, an orange preview shows where the
window will go; let go of the mouse while still holding Ctrl to snap it there.
In the open middle of a cell nothing snaps.

Without Ctrl, dragging just moves the window and clicking does nothing.
Letting go of Ctrl before you drop cancels the snap.

| Where you drop | Window you get |
|---|---|
| A corner | The quarter of the screen in that corner |
| A long-side edge (left/right in landscape, top/bottom in portrait) | ¾ of the screen against that edge; where you are along the edge picks which row (or column), or both on the middle line |
| A short-side edge on the center line | Maximized |
| A short-side edge on one of the other lines | A full-length strip along that edge |
| Anywhere else in a band | Every cell touching where you drop: on a line, the cells either side; on a line crossing, the 4 cells around it; on an edge at the middle of a cell, that cell |

Together these reach all 30 rectangles the grid allows.

![Drop zone map: colored bands along every grid line and screen edge. The
pointer is on the crossing of the first column line and the middle line, and
the dashed outline shows the window covering columns 1–2 in both
rows.](docs/images/drop-map.png)

Cinnamon's own edge tiling is turned off while the extension is enabled and
turned back on when you disable it. Super+arrow keyboard tiling still works.

## Moving grid lines

Once windows are snapped into the grid, **Ctrl+drag** the edge they share
and that grid line moves across the whole monitor. Every grid window with an
edge on it resizes live, and later snaps use the moved line.

![Ctrl-dragging Editor's right edge moves the line between columns 2 and 3
from 960 to 1180 px. Browser and Files, which share that line, shrink to
match.](docs/images/move-line.png)

- **Ctrl+Shift** while dragging makes the line jump to the even-eighths
  positions, so it's easy to put back exactly.
- A line stops 200 px from its neighbours. If the next line is hidden inside
  a window, the drag carries on smoothly with that line instead, so an edge
  can pass it. It won't do that if a window would be squeezed to nothing.

  ![Dragging Editor's edge further left carries on past the hidden line
  between columns 1 and 2: Editor ends up 330 px wide and Browser and Files
  stretch across columns 2–3.](docs/images/hand-off.png)
- **Ctrl+drag on an edge at the screen edge** does nothing.
- **Without Ctrl**, dragging an edge resizes just that window as usual, and
  it leaves the grid: it won't follow line moves until you Ctrl-snap it again.
  Moving a grid window by hand also takes it off the grid.
- The keys are checked the whole drag. Press Ctrl partway through to switch
  to moving the line; release it and the line goes back to where it was and
  the drag becomes a plain resize. **Escape** cancels the drag.

Each monitor and each workspace keeps its own grid, saved in
`~/.config/screen-snapper/grids.json`. **Super+Ctrl+G** puts the grid on the
monitor under the pointer, on the current workspace, back to even eighths
and moves its windows to match. Windows sitting exactly on grid cells are
recognised again after Cinnamon restarts.
Grids belong to a workspace's position, so removing a workspace in the
middle shifts the later workspaces' grids down by one.

## Shift snapping

Hold **Shift** while dragging to use Cinnamon's edge snapping instead of the
grid: the window keeps its size and its edges line up with monitor, panel and
other windows' edges. Hold **Ctrl+Shift** to see those targets.

## Keep tiled size

Windows tiled with Super+arrows normally shrink back to their old size when
you drag them out of the tile. This extension keeps the tiled size, and the
pointer stays where you grabbed the title bar.

## Requirements

- Cinnamon 6.0 to 6.6 on X11 (tested on Linux Mint with Cinnamon 6.6)
- `python3` and `gsettings` for the install script

## Install

```sh
git clone https://github.com/spuddermax/screen-snapper.git
cd screen-snapper
./install.sh
```

This symlinks `screen-snapper@spuddermax` into
`~/.local/share/cinnamon/extensions/` and enables it, so keep the clone where
it is. Run `./install.sh` again after pulling or editing to reload the
extension.

Colors live in `screen-snapper@spuddermax/stylesheet.css`. The band depth
(`BAND`) and minimum cell size (`MIN_CELL`) are at the top of
`screen-snapper@spuddermax/extension.js`.

## Uninstall

Turn it off in System Settings → Extensions (this turns Cinnamon's edge
tiling back on if the extension turned it off), then remove the link and the
saved grids:

```sh
rm ~/.local/share/cinnamon/extensions/screen-snapper@spuddermax
rm -r ~/.config/screen-snapper
```

## License

[MIT](LICENSE)
