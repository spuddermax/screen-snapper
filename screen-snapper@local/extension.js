// Screen Snapper
//
// Two tweaks to window dragging in Cinnamon (Muffin):
//
// 1. Keep snapped size. Muffin remembers a window's size from before it was
//    snapped (tiled) and restores it when you drag the window back out of the
//    snap zone. We put the snapped size back as soon as the window unsnaps.
//
// 2. Snap overlay. Holding Shift while dragging makes Muffin snap the window's
//    edges to monitor edges, panel edges and other windows' edges. While Shift
//    is held during a drag we draw a transparent overlay showing every one of
//    those snap targets, plus where the dragged window will land.

const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;

// How close (px) two edges must be to count as lined up.
const ALIGN_TOLERANCE = 1;
// How often (ms) to check whether Shift is held during a drag.
const SHIFT_POLL_MS = 30;

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

function rectOf(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
}

// Windows Muffin snaps to: visible windows on the current workspace other
// than the one being dragged, in stacking order (bottom first).
function snapWindows(dragged) {
    const ws = global.workspace_manager.get_active_workspace();
    const skip = [Meta.WindowType.DESKTOP, Meta.WindowType.DOCK];
    return global.get_window_actors()
        .map(a => a.meta_window)
        .filter(w => w && w !== dragged &&
            !w.minimized &&
            w.showing_on_its_workspace() &&
            w.located_on_workspace(ws) &&
            !skip.includes(w.get_window_type()));
}

function snapAreas(dragged) {
    const ws = global.workspace_manager.get_active_workspace();
    const monitors = [];
    const n = global.display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        monitors.push({
            monitor: rectOf(global.display.get_monitor_geometry(i)),
            work: rectOf(ws.get_work_area_for_monitor(i)),
        });
    }
    const windows = snapWindows(dragged).map(w => rectOf(w.get_frame_rect()));
    return { monitors, windows };
}

// Every edge the dragged window can snap to, as vertical (x) and
// horizontal (y) line segments.
function snapEdges(areas) {
    const vertical = [];
    const horizontal = [];
    const add = r => {
        vertical.push({ pos: r.x, from: r.y, to: r.y + r.height });
        vertical.push({ pos: r.x + r.width, from: r.y, to: r.y + r.height });
        horizontal.push({ pos: r.y, from: r.x, to: r.x + r.width });
        horizontal.push({ pos: r.y + r.height, from: r.x, to: r.x + r.width });
    };
    for (const m of areas.monitors) {
        add(m.monitor);
        add(m.work);
    }
    areas.windows.forEach(add);
    return { vertical, horizontal };
}

function box(styleClass, r) {
    return new St.Widget({
        style_class: styleClass,
        reactive: false,
        x: r.x, y: r.y,
        width: Math.max(r.width, 1),
        height: Math.max(r.height, 1),
    });
}

class SnapOverlay {
    constructor(win) {
        this.window = win;
        this.actor = null;        // zones, below the dragged window
        this.targetLayer = null;  // landing outline + guides, above it
        this.edges = null;
        this.posId = win.connect('position-changed', () => this._updateTarget());
        this.sizeId = win.connect('size-changed', () => this._updateTarget());
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHIFT_POLL_MS, () => {
            this._checkShift();
            return GLib.SOURCE_CONTINUE;
        });
        this._checkShift();
    }

    _checkShift() {
        const [, , mods] = global.get_pointer();
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
        if (shift && !this.actor)
            this._show();
        else if (!shift && this.actor)
            this._hide();
    }

    _show() {
        const areas = snapAreas(this.window);
        this.edges = snapEdges(areas);

        this.actor = new St.Widget({
            style_class: 'screen-snapper-overlay',
            reactive: false,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });

        for (const m of areas.monitors) {
            this.actor.add_child(box('screen-snapper-monitor', m.monitor));
            this.actor.add_child(box('screen-snapper-workarea', m.work));
        }
        for (const r of areas.windows)
            this.actor.add_child(box('screen-snapper-window', r));

        this.targetLayer = new St.Widget({
            reactive: false,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });

        // Zones go above every other window but below the dragged one, so the
        // dragged window isn't tinted. Its landing outline and guides go on top.
        const group = global.window_group;
        group.add_child(this.actor);
        group.add_child(this.targetLayer);
        const dragged = this.window.get_compositor_private();
        if (dragged && dragged.get_parent() === group) {
            group.set_child_below_sibling(this.actor, dragged);
            group.set_child_above_sibling(this.targetLayer, dragged);
        } else {
            group.set_child_above_sibling(this.actor, null);
            group.set_child_above_sibling(this.targetLayer, this.actor);
        }

        this._updateTarget();
    }

    _hide() {
        if (this.targetLayer)
            this.targetLayer.destroy();
        if (this.actor)
            this.actor.destroy();
        this.actor = null;
        this.targetLayer = null;
        this.edges = null;
    }

    // Highlight where the dragged window is, and the snap edges it lines up with.
    _updateTarget() {
        if (!this.targetLayer)
            return;
        this.targetLayer.destroy_all_children();

        const t = rectOf(this.window.get_frame_rect());
        this.targetLayer.add_child(box('screen-snapper-target', t));

        const guide = (vertical, pos, from, to) => {
            const r = vertical
                ? { x: pos - 1, y: from, width: 3, height: to - from }
                : { x: from, y: pos - 1, width: to - from, height: 3 };
            this.targetLayer.add_child(box('screen-snapper-guide', r));
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
        if (this.posId)
            this.window.disconnect(this.posId);
        if (this.sizeId)
            this.window.disconnect(this.sizeId);
        this.posId = this.sizeId = 0;
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
