// Screen Snapper
//
// Two tweaks to window dragging in Cinnamon (Muffin):
//
// 1. Keep snapped size. Muffin remembers a window's size from before it was
//    snapped (tiled) and restores it when you drag the window back out of the
//    snap zone. We put the snapped size back as soon as the window unsnaps.
//
// 2. Snap overlay. Hold Ctrl while dragging to see every edge-tiling zone and
//    the edge strips that trigger them. Add Shift (Ctrl+Shift) to see the
//    edge-snapping targets Shift uses instead.

const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;

// How close (px) two edges must be to count as lined up.
const ALIGN_TOLERANCE = 1;
// How often (ms) to check whether Ctrl/Shift are held during a drag.
const KEY_POLL_MS = 30;
// How close (px) the pointer must get to a work-area edge to trigger tiling,
// measured from Muffin. The top edge only triggers at the very top.
const TRIGGER_PX = 8;
const TOP_TRIGGER_PX = 2;

let beginId = 0;
let endId = 0;
// True while we restart a grab ourselves, so our own grab-op-end/begin
// signals are ignored.
let restarting = false;
let keepSize = null;   // KeepSize for the current drag, if any
let overlay = null;    // SnapOverlay for the current drag, if any

function isSnapped(win) {
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

// ---------------------------------------------------------------------------
// Keep snapped size
//
// Muffin also fixes the pointer's offset into the window when it unsnaps,
// based on the old (pre-snap) size, and keeps using that offset for the rest
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

    // True if the window has unsnapped and lost its snapped size.
    needsRestore() {
        const win = this.window;
        if (isSnapped(win) || win.get_maximized() !== 0 || win.minimized)
            return false;
        const r = win.get_frame_rect();
        return r.width !== this.width || r.height !== this.height;
    }

    // Resize to the snapped size, with the pointer on the same spot of the
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

            // Window has unsnapped; after this there is nothing left to watch.
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
// Snap overlay
//
// Ctrl held during a drag: show the edge-tiling zones (halves and quarters of
// each monitor), the strips along each edge that trigger them, and the zone
// the window will snap to right now.
//
// Ctrl+Shift held: Shift makes Muffin snap the window's edges (at its current
// size) to monitor, panel and other windows' edges, so show those targets
// instead, plus where the window will land and which edges it lines up with.

function rectOf(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
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

function activeWorkspace() {
    return global.workspace_manager.get_active_workspace();
}

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

function monitorAreas() {
    const ws = activeWorkspace();
    const out = [];
    const n = global.display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        out.push({
            index: i,
            monitor: rectOf(global.display.get_monitor_geometry(i)),
            work: rectOf(ws.get_work_area_for_monitor(i)),
        });
    }
    return out;
}

// Width of the left and right tiling columns on a monitor. Each is half the
// work area, unless a window is already tiled to the other side; then it
// fills the space that window leaves. (Measured from Muffin; for quarters it
// is not always applied, so those outlines can be slightly off. The
// active-zone highlight always comes straight from Muffin.)
function columnWidths(m, dragged) {
    const W = m.work;
    let left = W.width / 2;
    let right = W.width / 2;
    const M = Meta.TileMode;
    for (const w of otherWindows(dragged)) {
        if (w.get_monitor() !== m.index)
            continue;
        const r = w.get_frame_rect();
        if (w.tile_mode === M.LEFT)
            right = W.x + W.width - (r.x + r.width);
        else if (w.tile_mode === M.RIGHT)
            left = r.x - W.x;
    }
    return [left, right];
}

// --- Ctrl: edge-tiling zones ---

function drawTileZones(layer, dragged) {
    for (const m of monitorAreas()) {
        const W = m.work;
        const [leftW, rightW] = columnWidths(m, dragged);
        const x2 = W.x + W.width;
        const y2 = W.y + W.height;
        const sy = W.y + W.height / 2;
        const rx = x2 - rightW;

        layer.add_child(box('screen-snapper-workarea', W));

        // Four quarter cells; pairs of them make up the halves.
        const cells = [
            { x: W.x, y: W.y, width: leftW, height: sy - W.y },
            { x: rx, y: W.y, width: rightW, height: sy - W.y },
            { x: W.x, y: sy, width: leftW, height: y2 - sy },
            { x: rx, y: sy, width: rightW, height: y2 - sy },
        ];
        for (const c of cells)
            layer.add_child(box('screen-snapper-zone', c));

        // Strips the pointer has to touch to trigger each zone.
        const t = TRIGGER_PX;
        const top = TOP_TRIGGER_PX;
        const strips = [
            { x: W.x, y: W.y, width: t, height: W.height },           // left half
            { x: x2 - t, y: W.y, width: t, height: W.height },        // right half
            { x: W.x, y: W.y, width: W.width, height: top },          // top
            { x: W.x, y: y2 - t, width: W.width, height: t },         // bottom half
        ];
        for (const s of strips)
            layer.add_child(box('screen-snapper-trigger', s));

        const corners = [
            { x: W.x, y: W.y, width: t, height: t },
            { x: x2 - t, y: W.y, width: t, height: t },
            { x: W.x, y: y2 - t, width: t, height: t },
            { x: x2 - t, y: y2 - t, width: t, height: t },
        ];
        for (const c of corners)
            layer.add_child(box('screen-snapper-corner', c));
    }
}

// --- Ctrl+Shift: edge snapping at the window's current size ---

function snapRects(dragged) {
    const rects = [];
    for (const m of monitorAreas()) {
        rects.push(m.monitor);
        rects.push(m.work);
    }
    for (const w of otherWindows(dragged))
        rects.push(rectOf(w.get_frame_rect()));
    return rects;
}

function snapEdges(rects) {
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
    for (const m of monitorAreas()) {
        layer.add_child(box('screen-snapper-monitor', m.monitor));
        layer.add_child(box('screen-snapper-workarea', m.work));
    }
    for (const w of otherWindows(dragged))
        layer.add_child(box('screen-snapper-window', rectOf(w.get_frame_rect())));
}

class SnapOverlay {
    constructor(win) {
        this.window = win;
        this.mode = null;         // null, 'zones' or 'edges'
        this.base = null;         // drawn below the dragged window
        this.active = null;       // part of base: current tile zone
        this.front = null;        // drawn above the dragged window
        this.edges = null;
        this.tilePreview = null;  // zone Muffin will snap to, if any

        const wm = global.window_manager;
        this.signals = [
            [win, win.connect('position-changed', () => this._updateFront())],
            [win, win.connect('size-changed', () => this._updateFront())],
            [wm, wm.connect('show-tile-preview', (wm_, w, rect) => {
                this.tilePreview = rectOf(rect);
                this._updateFront();
            })],
            [wm, wm.connect('hide-tile-preview', () => {
                this.tilePreview = null;
                this._updateFront();
            })],
        ];
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEY_POLL_MS, () => {
            this._checkKeys();
            return GLib.SOURCE_CONTINUE;
        });
        this._checkKeys();
    }

    _checkKeys() {
        const [, , mods] = global.get_pointer();
        const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const mode = !ctrl ? null : shift ? 'edges' : 'zones';
        if (mode !== this.mode)
            this._show(mode);
    }

    _fullLayer() {
        return new St.Widget({
            reactive: false,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
    }

    _show(mode) {
        this._hide();
        this.mode = mode;
        if (!mode)
            return;

        this.base = this._fullLayer();
        this.front = this._fullLayer();
        if (mode === 'zones') {
            drawTileZones(this.base, this.window);
            this.active = this._fullLayer();
            this.base.add_child(this.active);
        } else {
            drawEdgeTargets(this.base, this.window);
            this.edges = snapEdges(snapRects(this.window));
        }

        // Zones go above every other window but below the dragged one, so the
        // dragged window isn't tinted. Highlights go on top of it.
        const group = global.window_group;
        group.add_child(this.base);
        group.add_child(this.front);
        const dragged = this.window.get_compositor_private();
        if (dragged && dragged.get_parent() === group) {
            group.set_child_below_sibling(this.base, dragged);
            group.set_child_above_sibling(this.front, dragged);
        } else {
            group.set_child_above_sibling(this.base, null);
            group.set_child_above_sibling(this.front, this.base);
        }

        this._updateFront();
    }

    _hide() {
        if (this.front)
            this.front.destroy();
        if (this.base)
            this.base.destroy();
        this.front = this.base = this.active = this.edges = null;
        this.mode = null;
    }

    _updateFront() {
        if (!this.front)
            return;
        this.front.destroy_all_children();
        if (this.active)
            this.active.destroy_all_children();
        if (this.mode === 'zones')
            this._drawActiveZone();
        else
            this._drawLanding();
    }

    // The zone the window will snap to if dropped now, as Muffin reports it.
    _drawActiveZone() {
        if (this.tilePreview)
            this.active.add_child(box('screen-snapper-active', this.tilePreview));
    }

    // Where the window sits, and the snap edges it lines up with.
    _drawLanding() {
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

    destroy() {
        if (this.timer)
            GLib.source_remove(this.timer);
        this.timer = 0;
        for (const [obj, id] of this.signals)
            obj.disconnect(id);
        this.signals = [];
        this._hide();
    }
}

// ---------------------------------------------------------------------------
// Grab tracking

function stopAll() {
    if (keepSize)
        keepSize.destroy();
    keepSize = null;
    if (overlay)
        overlay.destroy();
    overlay = null;
}

function onGrabBegin(...args) {
    if (restarting)
        return;
    stopAll();
    const [win, op] = grabArgs(args);
    if (!win || !isMoveOp(op))
        return;

    if (isSnapped(win))
        keepSize = new KeepSize(win, op);
    overlay = new SnapOverlay(win);
}

function onGrabEnd() {
    if (restarting)
        return;
    if (keepSize)
        keepSize.finish();
    keepSize = null;
    if (overlay)
        overlay.destroy();
    overlay = null;
}

function init(metadata) {}

function enable() {
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
}
