// Screen Snapper
//
// Window snapping for Cinnamon (Muffin), replacing Cinnamon's edge tiling:
//
// 1. Eighths grid. Each monitor's usable area is split into eighths: 4 columns
//    x 2 rows in landscape, 2 columns x 4 rows in portrait. Every grid line and
//    screen edge has a drop band BAND px deep on each side. Drag a window with
//    the pointer in a band and let go, and it snaps to the window that band
//    stands for (see resolve()). In the open middle of a cell nothing snaps.
//    Cinnamon's own edge tiling is switched off while this is enabled.
//
// 2. Overlay. Hold Ctrl while dragging to see every drop band, colored by
//    rule. Add Shift (Ctrl+Shift) to see the targets for Muffin's Shift edge
//    snapping instead. Holding Shift turns grid snapping off for the drag.
//
// 3. Keep snapped size. Windows tiled by Cinnamon's keyboard shortcuts
//    (Super+arrows) still shrink back to their old size when dragged out of
//    the tile. We put the tiled size back as soon as the window untiles.

const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

// Depth (px) of each drop band on either side of a grid line, and inward
// from each screen edge.
const BAND = 50;
// How close (px) two edges must be to count as lined up (Ctrl+Shift view).
const ALIGN_TOLERANCE = 1;
// How often (ms) to check the pointer and keys during a drag.
const POLL_MS = 20;

const MUFFIN_SCHEMA = 'org.cinnamon.muffin';

let beginId = 0;
let endId = 0;
// True while we restart a grab ourselves, so our own grab-op-end/begin
// signals are ignored.
let restarting = false;
let keepSize = null;   // KeepSize for the current drag, if any
let session = null;    // DragSession for the current drag, if any
let muffinSettings = null;
let turnedOffEdgeTiling = false;

function rectOf(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function isTiled(win) {
    const mode = win.tile_mode;
    return mode !== Meta.TileMode.NONE && mode !== Meta.TileMode.MAXIMIZED;
}

function isMoveOp(op) {
    return op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING;
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

// ---------------------------------------------------------------------------
// Eighths grid
//
// Positions along an axis are classified as an edge band, a line band or the
// open middle of a cell. The long axis has 4 units, the short axis 2.

// Bands and cells along one axis of length len split into n units, as
// offsets from the start of the axis.
function regions(len, n) {
    const p = i => i * len / n;
    const out = [{ kind: 'edge', i: 0, a: 0, b: BAND }];
    for (let k = 1; k <= n; k++) {
        out.push({ kind: 'cell', i: k, a: p(k - 1) + BAND, b: p(k) - BAND });
        if (k < n)
            out.push({ kind: 'line', i: k, a: p(k) - BAND, b: p(k) + BAND });
    }
    out.push({ kind: 'edge', i: n, a: len - BAND, b: len });
    return out;
}

function classify(pos, len, n) {
    const regs = regions(len, n);
    pos = Math.min(Math.max(pos, 0), len - 1);
    return regs.find(r => pos >= r.a && pos < r.b) || regs[regs.length - 1];
}

// Units covered by the cells touching a position: a cell itself, the two
// cells either side of a line, or the cell next to an edge.
function coreSpan(c, n) {
    if (c.kind === 'cell')
        return [c.i, c.i];
    if (c.kind === 'line')
        return [c.i, c.i + 1];
    return c.i === 0 ? [1, 1] : [n, n];
}

// L: position on the long (4-unit) axis, S: on the short (2-unit) axis.
// Returns the units the window covers on each axis, or null for no snap.
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

function monitorAt(px, py) {
    const n = global.display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        const g = global.display.get_monitor_geometry(i);
        if (px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height)
            return i;
    }
    return global.display.get_current_monitor();
}

// Start and length in px of a span of units along one axis.
function spanPx(start, len, n, span) {
    const a = start + Math.round((span[0] - 1) * len / n);
    const b = start + Math.round(span[1] * len / n);
    return [a, b - a];
}

// Window rect (frame coordinates) for a resolved grid result.
function gridRect(W, res) {
    const landscape = W.width >= W.height;
    let x, y, width, height;
    if (landscape) {
        [x, width] = spanPx(W.x, W.width, 4, res.l);
        [y, height] = spanPx(W.y, W.height, 2, res.s);
    } else {
        [x, width] = spanPx(W.x, W.width, 2, res.s);
        [y, height] = spanPx(W.y, W.height, 4, res.l);
    }
    return { x, y, width, height };
}

// Rect of a zone (pair of regions) in screen coordinates.
function zoneRect(W, L, S) {
    const landscape = W.width >= W.height;
    const [xr, yr] = landscape ? [L, S] : [S, L];
    return { x: W.x + xr.a, y: W.y + yr.a, width: xr.b - xr.a, height: yr.b - yr.a };
}

// What dropping with the pointer at (px, py) would do, or null.
function gridTarget(px, py) {
    const monitor = monitorAt(px, py);
    const W = rectOf(activeWorkspace().get_work_area_for_monitor(monitor));
    const landscape = W.width >= W.height;
    const [lpos, llen, spos, slen] = landscape
        ? [px - W.x, W.width, py - W.y, W.height]
        : [py - W.y, W.height, px - W.x, W.width];
    const L = classify(lpos, llen, 4);
    const S = classify(spos, slen, 2);
    const res = resolve(L, S);
    if (!res)
        return null;
    return { monitor, res, rect: gridRect(W, res), zone: zoneRect(W, L, S) };
}

function sameRect(a, b) {
    if (!a || !b)
        return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function applyTarget(win, target) {
    if (target.res.rule === 'max') {
        win.maximize(Meta.MaximizeFlags.BOTH);
        return;
    }
    if (win.get_maximized() !== 0)
        win.unmaximize(Meta.MaximizeFlags.BOTH);
    const r = target.rect;
    // Muffin ignores the position passed to move_resize_frame, so move too.
    win.move_resize_frame(true, r.x, r.y, r.width, r.height);
    win.move_frame(true, r.x, r.y);
}

// Every drop band on every monitor, colored by rule, plus the grid lines.
function drawGridZones(layer) {
    const ws = activeWorkspace();
    const n = global.display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        const W = rectOf(ws.get_work_area_for_monitor(i));
        const landscape = W.width >= W.height;
        const [llen, slen] = landscape ? [W.width, W.height] : [W.height, W.width];
        for (const L of regions(llen, 4)) {
            for (const S of regions(slen, 2)) {
                const res = resolve(L, S);
                if (res)
                    layer.add_child(box(`screen-snapper-zone-${res.rule}`, zoneRect(W, L, S)));
            }
        }
        const [cols, rows] = landscape ? [4, 2] : [2, 4];
        for (let c = 1; c < cols; c++) {
            const x = W.x + Math.round(c * W.width / cols);
            layer.add_child(box('screen-snapper-gridline', { x: x - 1, y: W.y, width: 2, height: W.height }));
        }
        for (let r = 1; r < rows; r++) {
            const y = W.y + Math.round(r * W.height / rows);
            layer.add_child(box('screen-snapper-gridline', { x: W.x, y: y - 1, width: W.width, height: 2 }));
        }
        layer.add_child(box('screen-snapper-workarea', W));
    }
}

// ---------------------------------------------------------------------------
// Ctrl+Shift view: Muffin's Shift edge snapping keeps the window's size and
// lines its edges up with monitor, panel and other windows' edges.

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
// One drag: grid snapping, its preview, and the Ctrl / Ctrl+Shift overlays.

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
        const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;

        const mode = !ctrl ? null : shift ? 'edges' : 'zones';
        if (mode !== this.mode)
            this._setMode(mode);

        const canSnap = this.byPointer && !shift && this.window.allows_resize();
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

    // Put an actor just below the dragged window (or on top of everything if
    // the window's actor isn't in the window group).
    _placeBelowWindow(actor) {
        const group = global.window_group;
        if (actor.get_parent() !== group)
            group.add_child(actor);
        const dragged = this.window.get_compositor_private();
        if (dragged && dragged.get_parent() === group)
            group.set_child_below_sibling(actor, dragged);
        else
            group.set_child_above_sibling(actor, null);
    }

    _placeAboveWindow(actor) {
        const group = global.window_group;
        if (actor.get_parent() !== group)
            group.add_child(actor);
        const dragged = this.window.get_compositor_private();
        if (dragged && dragged.get_parent() === group)
            group.set_child_above_sibling(actor, dragged);
        else
            group.set_child_above_sibling(actor, null);
    }

    _updatePreview() {
        if (this.target) {
            if (!this.preview)
                this.preview = new St.Widget({ style_class: 'screen-snapper-preview', reactive: false });
            const r = this.target.rect;
            this.preview.set_position(r.x, r.y);
            this.preview.set_size(r.width, r.height);
            this.preview.show();
            this._placeBelowWindow(this.preview);
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
        this._placeBelowWindow(this.base);
        if (this.preview)
            this._placeBelowWindow(this.preview);
        this._placeAboveWindow(this.front);

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
        const check = (edges, vertical, positions, from, to) => {
            for (const pos of positions) {
                for (const e of edges) {
                    if (Math.abs(e.pos - pos) <= ALIGN_TOLERANCE)
                        guide(vertical, e.pos, Math.min(e.from, from), Math.max(e.to, to));
                }
            }
        };
        check(this.edges.vertical, true, [t.x, t.x + t.width], t.y, t.y + t.height);
        check(this.edges.horizontal, false, [t.y, t.y + t.height], t.x, t.x + t.width);
    }

    // The drag ended normally: snap if the pointer was in a band.
    finish() {
        this._tick();
        const target = this.target;
        const win = this.window;
        this.destroy();
        if (target) {
            // Apply once Muffin has finished ending the grab.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                applyTarget(win, target);
                return GLib.SOURCE_REMOVE;
            });
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
    // window it was grabbed at. Muffin ignores the position passed to
    // move_resize_frame (and any move while a move grab is active), so
    // resize and move separately with no grab running.
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
    stopAll();
    const [win, op] = grabArgs(args);
    if (!win || !isMoveOp(op))
        return;

    if (isTiled(win))
        keepSize = new KeepSize(win, op);
    session = new DragSession(win, op);
}

function onGrabEnd() {
    if (restarting)
        return;
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

// Remembers, across logins, that we were the ones who turned edge tiling off.
function markerFile() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_config_dir(), 'screen-snapper', 'edge-tiling-was-on']));
}

function enable() {
    // Turn off Cinnamon's edge tiling so it doesn't fight the grid.
    muffinSettings = new Gio.Settings({ schema_id: MUFFIN_SCHEMA });
    const marker = markerFile();
    if (muffinSettings.get_boolean('edge-tiling')) {
        muffinSettings.set_boolean('edge-tiling', false);
        try {
            marker.get_parent().make_directory_with_parents(null);
        } catch (e) {
            // Directory already exists.
        }
        try {
            marker.replace_contents('1', null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            global.logError(`screen-snapper: could not write ${marker.get_path()}: ${e}`);
        }
    }
    turnedOffEdgeTiling = marker.query_exists(null);
    beginId = global.display.connect('grab-op-begin', onGrabBegin);
    endId = global.display.connect('grab-op-end', onGrabEnd);
}

function disable() {
    stopAll();
    if (beginId)
        global.display.disconnect(beginId);
    if (endId)
        global.display.disconnect(endId);
    beginId = endId = 0;
    if (muffinSettings && turnedOffEdgeTiling) {
        muffinSettings.set_boolean('edge-tiling', true);
        try {
            markerFile().delete(null);
        } catch (e) {
            // Already gone.
        }
    }
    turnedOffEdgeTiling = false;
    muffinSettings = null;
}
