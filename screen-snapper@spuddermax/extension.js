// Screen Snapper
//
// Window snapping for Cinnamon (Muffin), replacing Cinnamon's edge tiling.
//
// 1. Eighths grid. Each monitor's usable area is split into a grid: 4 columns
//    x 2 rows in landscape, 2 columns x 4 rows in portrait. Every grid line and
//    screen edge has a drop band BAND px deep on each side. Drag a window with
//    Ctrl held, and an overlay shows every band plus where the window will go;
//    let go (still holding Ctrl) and it snaps there (see resolve()). In the
//    open middle of a cell nothing snaps. Without Ctrl, dragging just moves
//    the window. Cinnamon's own edge tiling is off while this is enabled.
//
// 2. Movable grid lines. Ctrl+drag the edge of a window the grid placed and
//    the grid line under that edge moves across the whole monitor; every grid
//    window with an edge on it follows. Ctrl+Shift snaps the line to the even
//    positions. When a line reaches its MIN_CELL limit next to a line hidden
//    inside a window, the drag carries on with that line (see moveLine()).
//    Ctrl+drag on an outer edge takes over a grid line inside the window,
//    or does nothing if there is none. Without Ctrl, the edge resizes
//    just that window and it leaves the grid; pressing Ctrl once the edge
//    has left its line's band snaps the edge to the next line or screen edge
//    and puts the window back on the grid. Keys are checked the whole
//    drag. Each monitor and workspace keeps its own grid, saved to disk;
//    Super+Ctrl+G resets the one under the pointer.
//
// 3. Ctrl+Shift while moving a window shows the targets for Muffin's Shift
//    edge snapping (window keeps its size) instead of the grid.
//
// 4. Keep tiled size. Windows tiled by Cinnamon's keyboard shortcuts
//    (Super+arrows) still shrink back to their old size when dragged out of
//    the tile. We put the tiled size back as soon as the window untiles.

const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;

// Depth (px) of each drop band on either side of a grid line, and inward
// from each screen edge.
const BAND = 50;
// Grid cells never get narrower than this (px) when moving lines.
const MIN_CELL = 200;
// How far (px) the pointer must move before a press counts as a drag.
const DRAG_THRESHOLD = 8;
// How close (px) two edges must be to count as lined up (Ctrl+Shift view).
const ALIGN_TOLERANCE = 1;
// How far a grid window may be from its grid rect and still count as on the
// grid. Some apps (terminals) size in whole character cells.
const POS_TOLERANCE = 6;
const SIZE_TOLERANCE = 40;
// How often (ms) to check the pointer and keys during a drag.
const POLL_MS = 20;
// Shortest gap (ms) between window updates while dragging an edge.
const FRAME_MS = 16;

// The px sizes above are at 100% UI scale; this scales them for HiDPI.
function scaled(v) {
    return Math.round(v * (global.ui_scale || 1));
}

const DEFAULT_FRACTIONS = { long: [0.25, 0.5, 0.75], short: [0.5] };
const RESET_BINDING = '<Super><Control>g';
const RESET_NAME = 'screen-snapper-reset-grid';
const MUFFIN_SCHEMA = 'org.cinnamon.muffin';

let beginId = 0;
let endId = 0;
// True while we end or start a grab ourselves, so our own grab-op-end/begin
// signals are ignored.
let restarting = false;
let keepSize = null;   // KeepSize for the current drag, if any
let session = null;    // DragSession or ResizeSession for the current drag
let pendingSnap = 0;   // idle source applying a grid snap after a drop
let muffinSettings = null;
let turnedOffEdgeTiling = false;

function rectOf(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function sameRect(a, b) {
    if (!a || !b)
        return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function isTiled(win) {
    const mode = win.tile_mode;
    return mode !== Meta.TileMode.NONE && mode !== Meta.TileMode.MAXIMIZED;
}

function isMoveOp(op) {
    return op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING;
}

// Window sides moved by each pointer resize.
const RESIZE_SIDES = new Map([
    [Meta.GrabOp.RESIZING_E, ['right']],
    [Meta.GrabOp.RESIZING_W, ['left']],
    [Meta.GrabOp.RESIZING_N, ['top']],
    [Meta.GrabOp.RESIZING_S, ['bottom']],
    [Meta.GrabOp.RESIZING_NE, ['top', 'right']],
    [Meta.GrabOp.RESIZING_NW, ['top', 'left']],
    [Meta.GrabOp.RESIZING_SE, ['bottom', 'right']],
    [Meta.GrabOp.RESIZING_SW, ['bottom', 'left']],
]);
const RESIZE_CURSORS = new Map([
    [Meta.GrabOp.RESIZING_E, Meta.Cursor.EAST_RESIZE],
    [Meta.GrabOp.RESIZING_W, Meta.Cursor.WEST_RESIZE],
    [Meta.GrabOp.RESIZING_N, Meta.Cursor.NORTH_RESIZE],
    [Meta.GrabOp.RESIZING_S, Meta.Cursor.SOUTH_RESIZE],
    [Meta.GrabOp.RESIZING_NE, Meta.Cursor.NE_RESIZE],
    [Meta.GrabOp.RESIZING_NW, Meta.Cursor.NW_RESIZE],
    [Meta.GrabOp.RESIZING_SE, Meta.Cursor.SE_RESIZE],
    [Meta.GrabOp.RESIZING_SW, Meta.Cursor.SW_RESIZE],
]);

function isKeyboardResizeOp(op) {
    return op >= Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN && op <= Meta.GrabOp.KEYBOARD_RESIZING_SE;
}

// Muffin emits grab-op-begin/end as (display, display, window, op); stock
// Mutter uses (display, window, op). Pick the window and op out by type.
function grabArgs(args) {
    const win = args.find(a => a instanceof Meta.Window) || null;
    const op = args.find(a => typeof a === 'number');
    return [win, op];
}

function activeWorkspace() {
    return global.workspace_manager.get_active_workspace();
}

function workspaceAt(index) {
    return global.workspace_manager.get_workspace_by_index(index);
}

function keysHeld(mods) {
    return {
        ctrl: (mods & Clutter.ModifierType.CONTROL_MASK) !== 0,
        shift: (mods & Clutter.ModifierType.SHIFT_MASK) !== 0,
    };
}

function box(styleClass, r) {
    return new St.Widget({
        style_class: styleClass,
        reactive: false,
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.max(Math.round(r.width), 1),
        height: Math.max(Math.round(r.height), 1),
    });
}

function fullLayer() {
    return new St.Widget({
        reactive: false,
        x: 0, y: 0,
        width: global.stage.width,
        height: global.stage.height,
    });
}

// Put an actor just below or above a window (or on top of all windows if
// the window's actor isn't in the window group).
function placeNearWindow(actor, win, above) {
    const group = global.window_group;
    if (actor.get_parent() !== group)
        group.add_child(actor);
    const winActor = win.get_compositor_private();
    if (winActor && winActor.get_parent() === group) {
        if (above)
            group.set_child_above_sibling(actor, winActor);
        else
            group.set_child_below_sibling(actor, winActor);
    } else {
        group.set_child_above_sibling(actor, null);
    }
}

// Move and resize a window to a frame rect. Muffin ignores the position
// passed to move_resize_frame, so move as well.
function placeWindow(win, r) {
    if (win.get_maximized() !== 0)
        win.unmaximize(Meta.MaximizeFlags.BOTH);
    win.move_resize_frame(true, r.x, r.y, r.width, r.height);
    win.move_frame(true, r.x, r.y);
}

// ---------------------------------------------------------------------------
// Saved grids, one per monitor per workspace, as fractions of the work area.

let gridFractions = {};

function gridKey(monitor, wsIndex) {
    const g = global.display.get_monitor_geometry(monitor);
    return `${monitor}:${g.width}x${g.height}/${wsIndex}`;
}

function configFile(name) {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_config_dir(), 'screen-snapper', name]));
}

function writeConfig(name, text) {
    const file = configFile(name);
    try {
        file.get_parent().make_directory_with_parents(null);
    } catch (e) {
        // Directory already exists.
    }
    try {
        file.replace_contents(text, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {
        global.logError(`screen-snapper: could not write ${file.get_path()}: ${e}`);
    }
}

function loadGrids() {
    gridFractions = {};
    try {
        const [, bytes] = configFile('grids.json').load_contents(null);
        gridFractions = JSON.parse(new TextDecoder().decode(bytes)) || {};
    } catch (e) {
        // No saved grids yet.
    }
}

function saveGrids() {
    writeConfig('grids.json', JSON.stringify(gridFractions, null, 1));
}

// Lengths of a work area along the long (4-unit) and short (2-unit) axes.
function lens(W) {
    return W.width >= W.height ? [W.width, W.height] : [W.height, W.width];
}

function isLandscape(W) {
    return W.width >= W.height;
}

// A grid: the work area, plus line positions along each axis as offsets
// from the work area's start (interior lines only).
function gridFor(monitor, wsIndex) {
    const ws = workspaceAt(wsIndex) || activeWorkspace();
    const W = rectOf(ws.get_work_area_for_monitor(monitor));
    const [L, S] = lens(W);
    const f = gridFractions[gridKey(monitor, wsIndex)] || DEFAULT_FRACTIONS;
    return {
        W,
        long: f.long.map(x => Math.round(x * L)),
        short: f.short.map(x => Math.round(x * S)),
    };
}

function evenLines(W, axis) {
    const [L, S] = lens(W);
    const len = axis === 'long' ? L : S;
    return DEFAULT_FRACTIONS[axis].map(x => Math.round(x * len));
}

function saveGrid(monitor, wsIndex, grid) {
    const key = gridKey(monitor, wsIndex);
    const [L, S] = lens(grid.W);
    const even = ['long', 'short'].every(axis =>
        grid[axis].every((v, i) => Math.abs(v - evenLines(grid.W, axis)[i]) <= 1));
    if (even)
        delete gridFractions[key];
    else
        gridFractions[key] = { long: grid.long.map(v => v / L), short: grid.short.map(v => v / S) };
    saveGrids();
}

// Line positions along an axis, including both screen edges.
function positions(grid, axis) {
    const [L, S] = lens(grid.W);
    return axis === 'long' ? [0, ...grid.long, L] : [0, ...grid.short, S];
}

// ---------------------------------------------------------------------------
// Snapping into the grid
//
// Positions along an axis are classified as an edge band, a line band or the
// open middle of a cell. The long axis has 4 cells, the short axis 2. A span
// is a pair of cell numbers [first, last]; cell c lies between lines c-1 and
// c (line 0 and line n are the screen edges).

// Bands and cells along one axis, given its line positions p.
function regions(p) {
    const BAND_PX = scaled(BAND);
    const n = p.length - 1;
    const out = [{ kind: 'edge', i: 0, a: 0, b: BAND_PX }];
    for (let k = 1; k <= n; k++) {
        out.push({ kind: 'cell', i: k, a: p[k - 1] + BAND_PX, b: p[k] - BAND_PX });
        if (k < n)
            out.push({ kind: 'line', i: k, a: p[k] - BAND_PX, b: p[k] + BAND_PX });
    }
    out.push({ kind: 'edge', i: n, a: p[n] - BAND_PX, b: p[n] });
    return out;
}

function classify(pos, p) {
    const regs = regions(p);
    pos = Math.min(Math.max(pos, 0), p[p.length - 1] - 1);
    return regs.find(r => pos >= r.a && pos < r.b) || regs[regs.length - 1];
}

// Cells touching a position: a cell itself, the two cells either side of a
// line, or the cell next to an edge.
function coreSpan(c, n) {
    if (c.kind === 'cell')
        return [c.i, c.i];
    if (c.kind === 'line')
        return [c.i, c.i + 1];
    return c.i === 0 ? [1, 1] : [n, n];
}

// L: position on the long axis, S: on the short axis. Returns the spans the
// window covers on each axis, or null for no snap.
function resolve(L, S) {
    const Le = L.kind === 'edge';
    const Se = S.kind === 'edge';
    if (L.kind === 'cell' && S.kind === 'cell')
        return null;   // open middle of a cell
    if (Le && Se)      // corner: quarter of the screen
        return { l: L.i === 0 ? [1, 2] : [3, 4], s: S.i === 0 ? [1, 1] : [2, 2], rule: 'corner' };
    if (Le)            // long-side edge: 3/4 against that edge
        return { l: L.i === 0 ? [1, 3] : [2, 4], s: coreSpan(S, 2), rule: 'edge' };
    if (Se && L.kind === 'line') {
        if (L.i === 2) // short-side edge, center line: maximize
            return { l: [1, 4], s: [1, 2], rule: 'max' };
        // short-side edge, quarter line: full-length strip along that edge
        return { l: [1, 4], s: S.i === 0 ? [1, 1] : [2, 2], rule: 'strip' };
    }
    return { l: coreSpan(L, 4), s: coreSpan(S, 2), rule: 'touch' };
}

// Screen rect from offsets along the long and short axes.
function axisRect(W, la, lb, sa, sb) {
    return isLandscape(W)
        ? { x: W.x + la, y: W.y + sa, width: lb - la, height: sb - sa }
        : { x: W.x + sa, y: W.y + la, width: sb - sa, height: lb - la };
}

// Window frame rect for spans on a grid.
function gridRect(grid, spans) {
    const pl = positions(grid, 'long');
    const ps = positions(grid, 'short');
    return axisRect(grid.W, pl[spans.l[0] - 1], pl[spans.l[1]], ps[spans.s[0] - 1], ps[spans.s[1]]);
}

function monitorAt(px, py) {
    const n = global.display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        const g = global.display.get_monitor_geometry(i);
        if (px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height)
            return i;
    }
    return global.display.get_current_monitor();
}

// What dropping with the pointer at (px, py) would do, or null.
function gridTarget(px, py) {
    const monitor = monitorAt(px, py);
    const wsIndex = activeWorkspace().index();
    const grid = gridFor(monitor, wsIndex);
    const W = grid.W;
    const [lpos, spos] = isLandscape(W) ? [px - W.x, py - W.y] : [py - W.y, px - W.x];
    const pl = positions(grid, 'long');
    const ps = positions(grid, 'short');
    const L = classify(lpos, pl);
    const S = classify(spos, ps);
    const res = resolve(L, S);
    if (!res)
        return null;
    return {
        monitor, wsIndex, res,
        rect: gridRect(grid, res),
        zone: axisRect(W, L.a, L.b, S.a, S.b),
    };
}

function applyTarget(win, target) {
    if (target.res.rule === 'max') {
        untrack(win);
        win.maximize(Meta.MaximizeFlags.BOTH);
        return;
    }
    placeWindow(win, target.rect);
    track(win, target.monitor, target.wsIndex, target.res.l, target.res.s);
}

// Every drop band on every monitor, colored by rule, plus the grid lines.
function drawGridZones(layer) {
    const wsIndex = activeWorkspace().index();
    const n = global.display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        const grid = gridFor(i, wsIndex);
        const W = grid.W;
        for (const L of regions(positions(grid, 'long'))) {
            for (const S of regions(positions(grid, 'short'))) {
                const res = resolve(L, S);
                if (res)
                    layer.add_child(box(`screen-snapper-zone-${res.rule}`, axisRect(W, L.a, L.b, S.a, S.b)));
            }
        }
        drawGridLines(layer, grid);
        layer.add_child(box('screen-snapper-workarea', W));
    }
}

// Interior grid lines of one grid.
function drawGridLines(layer, grid) {
    const W = grid.W;
    const landscape = isLandscape(W);
    for (const axis of ['long', 'short']) {
        grid[axis].forEach(v => {
            const vertical = (axis === 'long') === landscape;
            const w = 2;
            const r = vertical
                ? { x: W.x + v - w / 2, y: W.y, width: w, height: W.height }
                : { x: W.x, y: W.y + v - w / 2, width: W.width, height: w };
            layer.add_child(box('screen-snapper-gridline', r));
        });
    }
}

// ---------------------------------------------------------------------------
// Windows placed by the grid. Each remembers its monitor, workspace and
// spans, and follows line moves while it stays where the grid put it.

const tracked = new Map();   // MetaWindow -> { monitor, ws, l, s, unmanagedId }

function track(win, monitor, wsIndex, l, s) {
    const old = tracked.get(win);
    const unmanagedId = old ? old.unmanagedId : win.connect('unmanaged', () => untrack(win));
    tracked.set(win, { monitor, ws: wsIndex, l: [...l], s: [...s], unmanagedId });
}

function untrack(win) {
    const info = tracked.get(win);
    if (!info)
        return;
    win.disconnect(info.unmanagedId);
    tracked.delete(win);
}

function untrackAll() {
    for (const win of [...tracked.keys()])
        untrack(win);
}

// Is a tracked window still where its grid put it?
function isOnGrid(win, info, grid) {
    if (win.get_monitor() !== info.monitor || win.get_maximized() !== 0 || win.is_fullscreen())
        return false;
    const ws = win.get_workspace();
    if (!win.is_on_all_workspaces() && (!ws || ws.index() !== info.ws))
        return false;
    const want = gridRect(grid, info);
    const r = win.get_frame_rect();
    return Math.abs(r.x - want.x) <= scaled(POS_TOLERANCE) && Math.abs(r.y - want.y) <= scaled(POS_TOLERANCE) &&
        Math.abs(r.width - want.width) <= scaled(SIZE_TOLERANCE) && Math.abs(r.height - want.height) <= scaled(SIZE_TOLERANCE);
}

// Every span pair a window can cover.
function allSpans() {
    const out = [];
    for (let a = 1; a <= 4; a++)
        for (let b = a; b <= 4; b++)
            for (const s of [[1, 1], [2, 2], [1, 2]])
                if (!(a === 1 && b === 4 && s[0] === 1 && s[1] === 2))   // that's maximized
                    out.push({ l: [a, b], s });
    return out;
}

// Start tracking untracked windows that sit exactly on a grid rect, so the
// grid still knows its windows after Cinnamon or the extension restarts.
function adoptWindows(monitor, wsIndex, grid) {
    const ws = workspaceAt(wsIndex);
    if (!ws)
        return;
    const spans = allSpans();
    for (const win of ws.list_windows()) {
        if (tracked.has(win) || win.get_monitor() !== monitor || win.minimized ||
            win.get_window_type() !== Meta.WindowType.NORMAL || !win.allows_resize())
            continue;
        for (const sp of spans) {
            const info = { monitor, ws: wsIndex, l: sp.l, s: sp.s };
            if (isOnGrid(win, info, grid)) {
                track(win, monitor, wsIndex, sp.l, sp.s);
                break;
            }
        }
    }
}

// Tracked windows on a monitor and workspace that are still on its grid.
// Ones that have wandered off are dropped from tracking.
function gridMembers(monitor, wsIndex, grid) {
    adoptWindows(monitor, wsIndex, grid);
    const out = [];
    for (const [win, info] of [...tracked]) {
        if (info.monitor !== monitor || info.ws !== wsIndex)
            continue;
        if (isOnGrid(win, info, grid))
            out.push(win);
        else
            untrack(win);
    }
    return out;
}

// Super+Ctrl+G: put the grid on the monitor under the pointer, on the current
// workspace, back to even eighths, and move its windows to match.
function resetGrid() {
    const [px, py] = global.get_pointer();
    const monitor = monitorAt(px, py);
    const wsIndex = activeWorkspace().index();
    const members = gridMembers(monitor, wsIndex, gridFor(monitor, wsIndex));
    delete gridFractions[gridKey(monitor, wsIndex)];
    saveGrids();
    const grid = gridFor(monitor, wsIndex);
    for (const win of members)
        placeWindow(win, gridRect(grid, tracked.get(win)));
}

// ---------------------------------------------------------------------------
// Moving grid lines
//
// Which line a window side sits on: { axis, idx } (idx into grid[axis]), or
// 'outer' for a side on the screen edge.
function sideLine(W, spans, side) {
    const map = isLandscape(W)
        ? { left: ['long', 0], right: ['long', 1], top: ['short', 0], bottom: ['short', 1] }
        : { top: ['long', 0], bottom: ['long', 1], left: ['short', 0], right: ['short', 1] };
    const [axis, end] = map[side];
    const span = axis === 'long' ? spans.l : spans.s;
    const n = axis === 'long' ? 4 : 2;
    if (end === 0)
        return span[0] > 1 ? { axis, idx: span[0] - 2 } : 'outer';
    return span[1] < n ? { axis, idx: span[1] - 1 } : 'outer';
}

// Put line idx at t, within MIN_CELL of its neighbours. With Ctrl+Shift it
// snaps to the nearest even position in reach.
function setLine(grid, axis, idx, t, shift) {
    const p = positions(grid, axis);
    const lo = p[idx] + scaled(MIN_CELL);
    const hi = p[idx + 2] - scaled(MIN_CELL);
    if (shift) {
        const even = evenLines(grid.W, axis).filter(x => x >= lo && x <= hi);
        if (even.length)
            t = even.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);
    }
    grid[axis][idx] = Math.round(Math.min(Math.max(t, lo), hi));
}

// Would handing a drag from line a to line j squeeze a window to nothing?
// (A window covering only the cell between them would vanish.)
function canHandoff(spansList, key, a, j) {
    return spansList.every(sp => {
        const [c0, c1] = sp[key];
        return j < a ? !(c0 === a && c1 === a) : !(c0 === a + 1 && c1 === a + 1);
    });
}

function handoff(spansList, key, a, j) {
    for (const sp of spansList) {
        const span = sp[key];
        if (span[1] === a)
            span[1] = j;           // right or bottom edge on line a
        if (span[0] === a + 1)
            span[0] = j + 1;       // left or top edge on line a
    }
}

// Move line idx on an axis to t. Where it would hit its MIN_CELL limit next
// to another line, the drag hands off to that line instead of stopping: every
// window edge on the line being dragged moves onto the next line, which takes
// over at exactly t, and the dragged line goes back to its starting place
// (inside a window now), pushed ahead of t if it is in the way. The edge you
// see never jumps. It doesn't hand off if that would squeeze a window to
// nothing; then the limit holds. Returns the line that ended up moving.
function moveLine(grid, spansList, axis, idx, t, shift) {
    const key = axis === 'long' ? 'l' : 's';
    const n = axis === 'long' ? 4 : 2;
    const minCell = scaled(MIN_CELL);
    const pos = i => positions(grid, axis)[i];
    let a = idx + 1;   // line number; 0 and n are the screen edges
    // The direction is fixed for the whole drag update: handing off always
    // moves away from the starting line, so this can't bounce back and forth.
    const dir = Math.sign(t - pos(a));
    for (let step = 0; dir && step < n; step++) {
        const j = a + dir;
        if (j < 1 || j > n - 1)
            break;
        const reached = dir < 0 ? t <= pos(j) + minCell : t >= pos(j) - minCell;
        if (!reached || !canHandoff(spansList, key, a, j))
            break;
        handoff(spansList, key, a, j);
        // No window edge is on line a any more. Keep it at least a cell
        // away from t so line j can follow the pointer, within its own
        // limit on the far side.
        const far = pos(a - dir);
        grid[axis][a - 1] = dir < 0
            ? Math.min(Math.max(pos(a), t + minCell), far - minCell)
            : Math.max(Math.min(pos(a), t - minCell), far + minCell);
        a = j;
    }
    setLine(grid, axis, a - 1, t, shift);
    return { axis, idx: a - 1 };
}

// Ctrl+drag on a window side that lies on the screen edge. If the next grid
// line in from that edge lies inside the window, the side can take over that
// line. Lines span the whole monitor, so other windows with an edge on it
// (in other rows or columns) follow, as with any line move. Returns { axis, key, start, j } (j is the
// line number, 1..n-1), or null if there is no such line (then the drag is
// blocked).
function outerLine(W, mine, side) {
    const map = isLandscape(W)
        ? { left: ['long', true], right: ['long', false], top: ['short', true], bottom: ['short', false] }
        : { top: ['long', true], bottom: ['long', false], left: ['short', true], right: ['short', false] };
    const [axis, start] = map[side];
    const key = axis === 'long' ? 'l' : 's';
    const n = axis === 'long' ? 4 : 2;
    const span = mine[key];
    if (span[0] === span[1])
        return null;   // one cell wide: no line inside the window
    return { axis, key, start, j: start ? 1 : n - 1 };
}

// One edge (or corner) drag on a grid window. Muffin's own resize is ended
// and the drag is run here, under a modal grab, so every grid window can be
// placed exactly. Each update starts again from the layout at the start of
// the drag and applies the keys held right now.
class ResizeSession {
    constructor(win, op, info) {
        this.window = win;
        this.sides = RESIZE_SIDES.get(op);
        this.monitor = info.monitor;
        this.wsIndex = info.ws;
        this.grid0 = gridFor(this.monitor, this.wsIndex);
        this.members = gridMembers(this.monitor, this.wsIndex, this.grid0);
        this.spans0 = new Map(this.members.map(w => {
            const i = tracked.get(w);
            return [w, { l: [...i.l], s: [...i.s] }];
        }));
        this.startRect = rectOf(win.get_frame_rect());
        [this.startX, this.startY] = global.get_pointer();
        this.applied = new Map(this.members.map(w => [w, rectOf(w.get_frame_rect())]));
        this.result = null;
        this.ctrlMode = null;   // what Ctrl does this drag: 'line' or 'snap'
        this.done = false;

        const time = global.display.get_current_time_roundtrip();
        restarting = true;
        try {
            global.display.end_grab_op(time);
        } finally {
            restarting = false;
        }

        this.catcher = new St.Widget({
            reactive: true, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height,
        });
        Main.uiGroup.add_child(this.catcher);
        restarting = true;
        let ok = false;
        try {
            ok = Main.pushModal(this.catcher, time);
        } finally {
            restarting = false;
        }
        if (!ok) {
            this.catcher.destroy();
            this.catcher = null;
            this.done = true;
            return;
        }
        global.display.set_cursor(RESIZE_CURSORS.get(op));
        this.pending = 0;
        // A window closing mid-drag leaves the drag; closing the one being
        // dragged cancels it.
        this.closeIds = this.members.map(w => [w, w.connect('unmanaged', () => this._dropWindow(w))]);

        this.eventId = global.stage.connect('captured-event', (actor, event) => this._onEvent(event));
        // Safety net: finish if the button was released without an event.
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS * 2, () => {
            const [, , mods] = global.get_pointer();
            if ((mods & Clutter.ModifierType.BUTTON1_MASK) === 0) {
                this.timer = 0;
                this.finish(true);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._safeUpdate();
    }

    _dropWindow(win) {
        for (const [w, id] of this.closeIds) {
            if (w === win)
                w.disconnect(id);
        }
        this.closeIds = this.closeIds.filter(([w]) => w !== win);
        this.members = this.members.filter(w => w !== win);
        this.spans0.delete(win);
        this.applied.delete(win);
        if (win === this.window)
            this.finish(false);
    }

    // An error mid-drag must never leave the modal grab (and so all input)
    // stuck: cancel the drag instead.
    _safeUpdate(pointer) {
        try {
            this._update(pointer);
            return true;
        } catch (e) {
            global.logError(`screen-snapper: edge drag: ${e}\n${e.stack}`);
            this.finish(false);
            return false;
        }
    }

    _onEvent(event) {
        switch (event.type()) {
        case Clutter.EventType.MOTION:
            this._scheduleUpdate();
            return Clutter.EVENT_STOP;
        case Clutter.EventType.BUTTON_RELEASE: {
            // Use the pointer and keys as they were at the release, not now:
            // Ctrl may already be up by the time we get here.
            const [x, y] = event.get_coords();
            this.finish(true, [x, y, event.get_state()]);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.KEY_PRESS:
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.finish(false);
                return Clutter.EVENT_STOP;
            }
            this._scheduleUpdate();
            return Clutter.EVENT_STOP;
        case Clutter.EventType.KEY_RELEASE:
            this._scheduleUpdate();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_STOP;
        }
    }

    _place(win, r) {
        if (sameRect(this.applied.get(win), r))
            return;
        placeWindow(win, r);
        this.applied.set(win, r);
    }

    // Motion events can arrive far faster than windows can redraw; resizing
    // on each one makes the windows fall behind. Update at most once a frame.
    _scheduleUpdate() {
        if (this.pending || this.done)
            return;
        this.pending = GLib.timeout_add(GLib.PRIORITY_HIGH, FRAME_MS, () => {
            this.pending = 0;
            this._safeUpdate();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The window's rect if each dragged side just followed the pointer.
    _plainRect(px, py) {
        const r = { ...this.startRect };
        for (const side of this.sides) {
            const delta = side === 'left' || side === 'right' ? px - this.startX : py - this.startY;
            if (side === 'left') {
                const right = r.x + r.width;
                r.x = Math.min(this.startRect.x + delta, right - 1);
                r.width = right - r.x;
            } else if (side === 'right') {
                r.width = Math.max(this.startRect.width + delta, 1);
            } else if (side === 'top') {
                const bottom = r.y + r.height;
                r.y = Math.min(this.startRect.y + delta, bottom - 1);
                r.height = bottom - r.y;
            } else {
                r.height = Math.max(this.startRect.height + delta, 1);
            }
        }
        return r;
    }

    // Where a side sits along its axis, as an offset into the work area:
    // { axis, key, start, at } for rect r.
    _sideAt(r, side) {
        const W = this.grid0.W;
        const land = isLandscape(W);
        const horiz = side === 'left' || side === 'right';
        const axis = horiz === land ? 'long' : 'short';
        const start = side === 'left' || side === 'top';
        const edge = side === 'left' ? r.x : side === 'right' ? r.x + r.width
            : side === 'top' ? r.y : r.y + r.height;
        return { axis, key: axis === 'long' ? 'l' : 's', start, at: edge - (horiz ? W.x : W.y) };
    }

    // When Ctrl goes down mid-drag: if every dragged side is still within
    // BAND of the line (or screen edge) it started on, Ctrl moves lines;
    // otherwise it snaps the sides to whatever line or edge they reach.
    _ctrlMode(px, py) {
        const r = this._plainRect(px, py);
        const near = this.sides.every(side => {
            const now = this._sideAt(r, side);
            const was = this._sideAt(this.startRect, side);
            return Math.abs(now.at - was.at) <= scaled(BAND);
        });
        return near ? 'line' : 'snap';
    }

    // pointer: [x, y, mods], or omitted to read them now.
    _update(pointer) {
        if (this.done)
            return;
        const [px, py, mods] = pointer || global.get_pointer();
        const { ctrl, shift } = keysHeld(mods);
        // What Ctrl does is decided when it goes down, and kept until it is
        // released.
        if (!ctrl)
            this.ctrlMode = null;
        else if (!this.ctrlMode)
            this.ctrlMode = this._ctrlMode(px, py);
        const grid = { W: this.grid0.W, long: [...this.grid0.long], short: [...this.grid0.short] };
        const spans = new Map([...this.spans0].map(([w, sp]) => [w, { l: [...sp.l], s: [...sp.s] }]));
        const mine = spans.get(this.window);
        if (!mine)
            return;

        if (!ctrl || this.ctrlMode === 'snap') {
            // Others stay where they were; only this window changes.
            for (const w of this.members) {
                if (w !== this.window)
                    this._place(w, gridRect(this.grid0, this.spans0.get(w)));
            }
            const plain = this._plainRect(px, py);
            let onGrid = false;
            if (ctrl) {
                // Snap each side to the line or screen edge whose band it is
                // in. The window is back on the grid once every side has one.
                onGrid = this.sides.every(side => {
                    const { axis, key, start, at } = this._sideAt(plain, side);
                    const p = positions(grid, axis);
                    const k = p.findIndex(v => Math.abs(v - at) <= scaled(BAND));
                    if (k < 0)
                        return false;
                    const span = mine[key];
                    if (start ? k + 1 > span[1] : k < span[0])
                        return false;   // would turn the window inside out
                    span[start ? 0 : 1] = start ? k + 1 : k;
                    return true;
                });
            }
            this._place(this.window, onGrid ? gridRect(grid, mine) : plain);
            this.result = { mode: onGrid ? 'snap' : 'plain', grid, spans };
            return;
        }

        // Ctrl moves lines.
        // A side that came off the screen edge but isn't yet far enough in to
        // take over a grid line: [side, offset from the work area start].
        const loose = [];
        for (const side of this.sides) {
            const delta = side === 'left' || side === 'right' ? px - this.startX : py - this.startY;
            const line = sideLine(grid.W, mine, side);
            if (line === 'outer') {
                // The side is on the screen edge. It can only move inward
                // onto a grid line inside the window; otherwise Ctrl+drag on
                // an outer edge does nothing.
                const o = outerLine(grid.W, mine, side);
                if (!o)
                    continue;
                const len = positions(grid, o.axis)[o.key === 'l' ? 4 : 2];
                const at = (o.start ? 0 : len) + delta;
                const inward = o.start ? at : len - at;
                if (inward < scaled(MIN_CELL)) {
                    // Too close to the screen edge for a grid line: the side
                    // follows the pointer, and goes back if released here.
                    loose.push([side, Math.min(Math.max(at, 0), len)]);
                    continue;
                }
                mine[o.key][o.start ? 0 : 1] = o.start ? o.j + 1 : o.j;
                moveLine(grid, [...spans.values()], o.axis, o.j - 1, at, shift);
                continue;
            }
            const t = grid[line.axis][line.idx] + delta;
            moveLine(grid, [...spans.values()], line.axis, line.idx, t, shift);
        }
        for (const w of this.members) {
            const r = gridRect(grid, spans.get(w));
            if (w === this.window) {
                for (const [side, at] of loose)
                    this._looseSide(r, grid.W, side, at);
            }
            this._place(w, r);
        }
        this.result = { mode: 'line', grid, spans };
    }

    // Move one side of rect r to `at` (an offset into the work area W), keeping
    // the window at least MIN_CELL across.
    _looseSide(r, W, side, at) {
        const minSize = scaled(MIN_CELL);
        if (side === 'left') {
            const right = r.x + r.width;
            r.x = Math.min(W.x + at, right - minSize);
            r.width = right - r.x;
        } else if (side === 'right') {
            r.width = Math.max(W.x + at - r.x, minSize);
        } else if (side === 'top') {
            const bottom = r.y + r.height;
            r.y = Math.min(W.y + at, bottom - minSize);
            r.height = bottom - r.y;
        } else {
            r.height = Math.max(W.y + at - r.y, minSize);
        }
    }

    // commit: false (Escape) puts everything back as it was.
    // pointer: where the pointer and keys were when the button was released.
    finish(commit, pointer) {
        if (this.done)
            return;
        if (this.pending)
            GLib.source_remove(this.pending);
        this.pending = 0;
        // Apply the final pointer position, which a pending update may not
        // have reached yet.
        if (commit && pointer) {
            try {
                this._update(pointer);
            } catch (e) {
                global.logError(`screen-snapper: edge drag: ${e}`);
                commit = false;
            }
        }
        this.done = true;
        this._teardown();
        if (session === this)
            session = null;

        if (!commit || !this.result) {
            for (const w of this.members)
                this._place(w, w === this.window ? this.startRect : gridRect(this.grid0, this.spans0.get(w)));
            return;
        }
        if (this.result.mode === 'line') {
            for (const [w, sp] of this.result.spans)
                this._place(w, gridRect(this.result.grid, sp));
            saveGrid(this.monitor, this.wsIndex, this.result.grid);
            for (const [w, sp] of this.result.spans)
                track(w, this.monitor, this.wsIndex, sp.l, sp.s);
        } else if (this.result.mode === 'snap') {
            // Snapped back onto the grid with new cells; no line moved.
            const sp = this.result.spans.get(this.window);
            track(this.window, this.monitor, this.wsIndex, sp.l, sp.s);
        } else {
            untrack(this.window);   // resized by hand: off the grid now
        }
    }

    // Release the modal grab and everything else the drag holds. Each step
    // is separate so one failing can't keep the grab.
    _teardown() {
        const steps = [
            () => {
                if (this.timer)
                    GLib.source_remove(this.timer);
                this.timer = 0;
            },
            () => {
                if (this.eventId)
                    global.stage.disconnect(this.eventId);
                this.eventId = 0;
            },
            () => {
                for (const [w, id] of this.closeIds)
                    w.disconnect(id);
                this.closeIds = [];
            },
            () => global.display.set_cursor(Meta.Cursor.DEFAULT),
            () => {
                restarting = true;
                try {
                    Main.popModal(this.catcher, global.display.get_current_time_roundtrip());
                } finally {
                    restarting = false;
                }
            },
            () => {
                this.catcher.destroy();
                this.catcher = null;
            },
        ];
        for (const step of steps) {
            try {
                step();
            } catch (e) {
                global.logError(`screen-snapper: ending edge drag: ${e}`);
            }
        }
    }

    destroy() {
        this.finish(true);
    }
}

// ---------------------------------------------------------------------------
// Ctrl+Shift view while moving: Muffin's Shift edge snapping keeps the
// window's size and lines its edges up with monitor, panel and other
// windows' edges.

// Visible windows on the current workspace other than the dragged one,
// in stacking order (bottom first).
function otherWindows(dragged) {
    const ws = activeWorkspace();
    const skip = [Meta.WindowType.DESKTOP, Meta.WindowType.DOCK];
    return global.get_window_actors()
        .map(a => a.meta_window)
        .filter(w => w && w !== dragged &&
            !w.minimized &&
            w.showing_on_its_workspace() &&
            w.located_on_workspace(ws) &&
            !skip.includes(w.get_window_type()));
}

function monitorRects() {
    const ws = activeWorkspace();
    const out = [];
    const n = global.display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        out.push({
            monitor: rectOf(global.display.get_monitor_geometry(i)),
            work: rectOf(ws.get_work_area_for_monitor(i)),
        });
    }
    return out;
}

function snapEdges(dragged) {
    const rects = [];
    for (const m of monitorRects())
        rects.push(m.monitor, m.work);
    for (const w of otherWindows(dragged))
        rects.push(rectOf(w.get_frame_rect()));

    const vertical = [];
    const horizontal = [];
    for (const r of rects) {
        vertical.push({ pos: r.x, from: r.y, to: r.y + r.height });
        vertical.push({ pos: r.x + r.width, from: r.y, to: r.y + r.height });
        horizontal.push({ pos: r.y, from: r.x, to: r.x + r.width });
        horizontal.push({ pos: r.y + r.height, from: r.x, to: r.x + r.width });
    }
    return { vertical, horizontal };
}

function drawEdgeTargets(layer, dragged) {
    for (const m of monitorRects()) {
        layer.add_child(box('screen-snapper-monitor', m.monitor));
        layer.add_child(box('screen-snapper-workarea', m.work));
    }
    for (const w of otherWindows(dragged))
        layer.add_child(box('screen-snapper-window', rectOf(w.get_frame_rect())));
}

// ---------------------------------------------------------------------------
// One move drag: grid snapping, its preview, and the Ctrl / Ctrl+Shift
// overlays.

class DragSession {
    constructor(win, op) {
        this.window = win;
        this.byPointer = op === Meta.GrabOp.MOVING;
        this.target = null;     // gridTarget() result for the current pointer spot
        this.preview = null;    // where the window will go
        this.mode = null;       // overlay: null, 'zones' or 'edges'
        this.base = null;       // overlay below the dragged window
        this.front = null;      // overlay above the dragged window
        this.edges = null;
        // Where the pointer was when the grab started, to tell a click from
        // a drag.
        [this.startX, this.startY] = global.get_pointer();
        this.moved = false;

        this.signals = [
            [win, win.connect('position-changed', () => this._updateLanding())],
            [win, win.connect('size-changed', () => this._updateLanding())],
        ];
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick();
    }

    _tick() {
        const [px, py, mods] = global.get_pointer();
        const { ctrl, shift } = keysHeld(mods);

        const mode = !ctrl ? null : shift ? 'edges' : 'zones';
        if (mode !== this.mode)
            this._setMode(mode);

        if (!this.moved &&
            Math.hypot(px - this.startX, py - this.startY) >= scaled(DRAG_THRESHOLD))
            this.moved = true;

        // Grid snapping only happens during a real drag with Ctrl held (and
        // not Shift, which is Muffin's own edge snapping).
        const canSnap = this.byPointer && this.moved && ctrl && !shift &&
            this.window.allows_resize();
        const target = canSnap ? gridTarget(px, py) : null;
        const oldZone = this.target ? this.target.zone : null;
        const oldRect = this.target ? this.target.rect : null;
        const newZone = target ? target.zone : null;
        const newRect = target ? target.rect : null;
        if (!sameRect(oldZone, newZone) || !sameRect(oldRect, newRect)) {
            this.target = target;
            this._updatePreview();
        }
    }

    _updatePreview() {
        if (this.target) {
            if (!this.preview)
                this.preview = new St.Widget({ style_class: 'screen-snapper-preview', reactive: false });
            const r = this.target.rect;
            this.preview.set_position(r.x, r.y);
            this.preview.set_size(r.width, r.height);
            this.preview.show();
            placeNearWindow(this.preview, this.window, false);
        } else if (this.preview) {
            this.preview.hide();
        }
        this._updateCurrentZone();
    }

    _setMode(mode) {
        this._clearOverlay();
        this.mode = mode;
        if (!mode)
            return;

        this.base = fullLayer();
        this.front = fullLayer();
        if (mode === 'zones') {
            drawGridZones(this.base);
        } else {
            drawEdgeTargets(this.base, this.window);
            this.edges = snapEdges(this.window);
        }
        // The base goes under the dragged window so the window isn't tinted,
        // the preview above the base, and highlights on top of the window.
        placeNearWindow(this.base, this.window, false);
        if (this.preview)
            placeNearWindow(this.preview, this.window, false);
        placeNearWindow(this.front, this.window, true);

        this._updateCurrentZone();
        this._updateLanding();
    }

    _clearOverlay() {
        if (this.front)
            this.front.destroy();
        if (this.base)
            this.base.destroy();
        this.front = this.base = this.edges = null;
        this.mode = null;
    }

    // Ctrl view: outline the band the pointer is in.
    _updateCurrentZone() {
        if (this.mode !== 'zones' || !this.front)
            return;
        this.front.destroy_all_children();
        if (this.target)
            this.front.add_child(box('screen-snapper-current-zone', this.target.zone));
    }

    // Ctrl+Shift view: where the window sits, and the edges it lines up with.
    _updateLanding() {
        if (this.mode !== 'edges' || !this.front)
            return;
        this.front.destroy_all_children();

        const t = rectOf(this.window.get_frame_rect());
        this.front.add_child(box('screen-snapper-target', t));

        const guide = (vertical, pos, from, to) => {
            const r = vertical
                ? { x: pos - 1, y: from, width: 3, height: to - from }
                : { x: from, y: pos - 1, width: to - from, height: 3 };
            this.front.add_child(box('screen-snapper-guide', r));
        };
        const check = (edges, vertical, at, from, to) => {
            for (const pos of at) {
                for (const e of edges) {
                    if (Math.abs(e.pos - pos) <= ALIGN_TOLERANCE)
                        guide(vertical, e.pos, Math.min(e.from, from), Math.max(e.to, to));
                }
            }
        };
        check(this.edges.vertical, true, [t.x, t.x + t.width], t.y, t.y + t.height);
        check(this.edges.horizontal, false, [t.y, t.y + t.height], t.x, t.x + t.width);
    }

    // The drag ended normally: snap if the pointer was in a band. A grid
    // window moved by hand leaves the grid.
    finish() {
        this._tick();
        const target = this.target;
        const win = this.window;
        const moved = this.moved;
        this.destroy();
        if (target) {
            // Apply once Muffin has finished ending the grab.
            if (pendingSnap)
                GLib.source_remove(pendingSnap);
            pendingSnap = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                pendingSnap = 0;
                applyTarget(win, target);
                return GLib.SOURCE_REMOVE;
            });
        } else if (moved) {
            untrack(win);
        }
        return target;
    }

    destroy() {
        if (this.timer)
            GLib.source_remove(this.timer);
        this.timer = 0;
        for (const [obj, id] of this.signals)
            obj.disconnect(id);
        this.signals = [];
        this._clearOverlay();
        if (this.preview)
            this.preview.destroy();
        this.preview = null;
    }
}

// ---------------------------------------------------------------------------
// Keep tiled size
//
// Muffin also fixes the pointer's offset into the window when it untiles,
// based on the old (pre-tile) size, and keeps using that offset for the rest
// of the drag. So after resizing we restart the move grab from the current
// pointer position, which makes Muffin take the offset from the new geometry.

class KeepSize {
    constructor(win, op) {
        const r = win.get_frame_rect();
        const [px, py] = global.get_pointer();
        let fx = r.width > 0 ? (px - r.x) / r.width : 0.5;
        fx = Math.min(Math.max(fx, 0), 1);

        this.window = win;
        this.op = op;
        this.width = r.width;
        this.height = r.height;
        this.fx = fx;
        this.offY = Math.max(py - r.y, 0);
        this.pending = 0;
        this.sizeId = win.connect('size-changed', () => this._onSizeChanged());
    }

    // True if the window has untiled and lost its tiled size.
    needsRestore() {
        const win = this.window;
        if (isTiled(win) || win.get_maximized() !== 0 || win.minimized)
            return false;
        const r = win.get_frame_rect();
        return r.width !== this.width || r.height !== this.height;
    }

    // Resize to the tiled size, with the pointer on the same spot of the
    // window it was grabbed at. Muffin ignores moves while a move grab is
    // active, so this runs with no grab running.
    apply() {
        const [px, py] = global.get_pointer();
        const x = Math.round(px - this.fx * this.width);
        const y = Math.min(Math.round(py - this.offY), py);
        this.window.move_resize_frame(true, x, y, this.width, this.height);
        this.window.move_frame(true, x, y);
    }

    // End the current move, resize, then start a fresh move from the pointer
    // so Muffin measures the pointer's offset against the new geometry.
    applyAndRestartGrab() {
        const display = global.display;
        const time = display.get_current_time_roundtrip();

        restarting = true;
        try {
            display.end_grab_op(time);
            this.apply();
            const [px, py] = global.get_pointer();
            display.begin_grab_op(this.window, Meta.GrabOp.MOVING, false, false,
                1, 0, time, px, py);
        } finally {
            restarting = false;
        }
    }

    _onSizeChanged() {
        if (this.pending)
            return;
        this.pending = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.pending = 0;
            if (keepSize !== this || !this.needsRestore())
                return GLib.SOURCE_REMOVE;

            // Window has untiled; after this there is nothing left to watch.
            keepSize = null;
            this.destroy();
            if (this.op === Meta.GrabOp.MOVING)
                this.applyAndRestartGrab();
            else
                this.apply();   // keyboard move: just fix the size
            return GLib.SOURCE_REMOVE;
        });
    }

    // Called when the drag ends normally.
    finish() {
        if (this.needsRestore())
            this.apply();
        this.destroy();
    }

    destroy() {
        if (this.pending)
            GLib.source_remove(this.pending);
        this.pending = 0;
        if (this.sizeId)
            this.window.disconnect(this.sizeId);
        this.sizeId = 0;
    }
}

// ---------------------------------------------------------------------------
// Grab tracking

function stopAll() {
    if (keepSize)
        keepSize.destroy();
    keepSize = null;
    if (session)
        session.destroy();
    session = null;
}

function onGrabBegin(...args) {
    if (restarting)
        return;
    const [win, op] = grabArgs(args);
    if (!win)
        return;
    stopAll();

    if (isMoveOp(op)) {
        if (isTiled(win))
            keepSize = new KeepSize(win, op);
        session = new DragSession(win, op);
        return;
    }

    if (!tracked.has(win) && RESIZE_SIDES.has(op) && win.get_workspace()) {
        const monitor = win.get_monitor();
        const wsIndex = win.get_workspace().index();
        adoptWindows(monitor, wsIndex, gridFor(monitor, wsIndex));
    }
    const info = tracked.get(win);
    if (!info)
        return;   // not a grid window: Muffin resizes it as usual
    if (RESIZE_SIDES.has(op) && isOnGrid(win, info, gridFor(info.monitor, info.ws))) {
        const s = new ResizeSession(win, op, info);
        session = s.done ? null : s;
    } else if (RESIZE_SIDES.has(op) || isKeyboardResizeOp(op)) {
        untrack(win);   // resized some other way: off the grid
    }
}

function onGrabEnd() {
    if (restarting)
        return;
    if (session instanceof ResizeSession)
        return;   // finishes itself on button release
    const ks = keepSize;
    const s = session;
    keepSize = session = null;
    const snapped = s ? s.finish() : null;
    if (ks) {
        // A grid snap sets the size itself; otherwise keep the tiled size.
        if (snapped)
            ks.destroy();
        else
            ks.finish();
    }
}

function init(metadata) {}

function enable() {
    loadGrids();

    // Turn off Cinnamon's edge tiling so it doesn't fight the grid. A marker
    // file remembers, across logins, that we were the ones who turned it off.
    muffinSettings = new Gio.Settings({ schema_id: MUFFIN_SCHEMA });
    // If the file can't be written, still remember for this login.
    let turnedOff = false;
    if (muffinSettings.get_boolean('edge-tiling')) {
        muffinSettings.set_boolean('edge-tiling', false);
        writeConfig('edge-tiling-was-on', '1');
        turnedOff = true;
    }
    turnedOffEdgeTiling = turnedOff || configFile('edge-tiling-was-on').query_exists(null);

    beginId = global.display.connect('grab-op-begin', onGrabBegin);
    endId = global.display.connect('grab-op-end', onGrabEnd);
    Main.keybindingManager.addHotKey(RESET_NAME, RESET_BINDING, resetGrid);
}

function disable() {
    stopAll();
    if (pendingSnap)
        GLib.source_remove(pendingSnap);
    pendingSnap = 0;
    Main.keybindingManager.removeHotKey(RESET_NAME);
    if (beginId)
        global.display.disconnect(beginId);
    if (endId)
        global.display.disconnect(endId);
    beginId = endId = 0;
    untrackAll();
    if (muffinSettings && turnedOffEdgeTiling) {
        muffinSettings.set_boolean('edge-tiling', true);
        try {
            configFile('edge-tiling-was-on').delete(null);
        } catch (e) {
            // Already gone.
        }
    }
    turnedOffEdgeTiling = false;
    muffinSettings = null;
}
