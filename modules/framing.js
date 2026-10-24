// 페르소나 이미지 위치·크기 조절 (user request, 2026-10-24).
//
// A version's bound picture used to become the persona image exactly as uploaded:
// SillyTavern crops an avatar only when its own crop dialog sends a crop, and this
// extension writes through the same endpoint without one, so the server kept the
// whole picture and every list and chat icon showed whatever its centre happened
// to be. The user now frames it: a crop rectangle stored on the version, handed to
// the endpoint as SillyTavern's own crop query when the picture is written.
//
// Pure: numbers in, numbers out. No document, so the node suite runs it as is.

/* The frame is the avatar's own shape. SillyTavern's server covers an avatar to
   AVATAR_WIDTH x AVATAR_HEIGHT, 512 x 768 (src/constants.js, read 2026-10-24),
   when resizing is on, and older builds always did. A crop of any other shape
   would be cropped AGAIN, around its centre, by that cover; a 2:3 crop is only
   scaled. */
export const FRAME_ASPECT = 512 / 768;

// How far in the user may zoom: the crop never gets narrower than a fifth of the
// largest crop the picture allows.
export const MAX_ZOOM = 5;

const finite = n => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// A stored crop as fractions of the picture: { x, y, w, h }, all in 0..1. Anything
// else (a hand edit, a value from a newer build) is no crop at all.
export function validCrop(crop) {
    if (!crop || typeof crop !== 'object') return null;
    const { x, y, w, h } = crop;
    if (![x, y, w, h].every(finite)) return null;
    if (w <= 0 || h <= 0 || x < 0 || y < 0) return null;
    // A rounding hair past the edge is still the edge.
    if (x + w > 1.000001 || y + h > 1.000001) return null;
    return { x, y, w, h };
}

// The largest frame-shaped rectangle the picture holds, in pixels: what zoom 1
// shows, and what the server's cover would have taken from the centre.
export function coverSize(nw, nh, aspect = FRAME_ASPECT) {
    if (!(nw > 0 && nh > 0)) return null;
    return nw / nh > aspect ? { w: nh * aspect, h: nh } : { w: nw, h: nw / aspect };
}

/* What the editor holds while the user drags: a zoom and the centre of the frame
   as fractions of the picture. Clamped so the frame never leaves the picture. */
export function clampView(nw, nh, view, aspect = FRAME_ASPECT) {
    const base = coverSize(nw, nh, aspect);
    if (!base) return null;
    const zoom = clamp(finite(view?.zoom) ? view.zoom : 1, 1, MAX_ZOOM);
    const w = base.w / zoom;
    const h = base.h / zoom;
    const cx = clamp((finite(view?.cx) ? view.cx : 0.5) * nw, w / 2, nw - w / 2) / nw;
    const cy = clamp((finite(view?.cy) ? view.cy : 0.5) * nh, h / 2, nh - h / 2) / nh;
    return { zoom, cx, cy };
}

export function cropFromView(nw, nh, view, aspect = FRAME_ASPECT) {
    const v = clampView(nw, nh, view, aspect);
    if (!v) return null;
    const base = coverSize(nw, nh, aspect);
    const w = base.w / v.zoom;
    const h = base.h / v.zoom;
    return {
        x: (v.cx * nw - w / 2) / nw,
        y: (v.cy * nh - h / 2) / nh,
        w: w / nw,
        h: h / nh,
    };
}

// The editor opens on the stored crop. A crop stored for a picture of another
// shape (the file under that name was replaced) is read for its centre and zoom
// and clamped, rather than thrown away.
export function viewFromCrop(nw, nh, crop, aspect = FRAME_ASPECT) {
    const c = validCrop(crop);
    const base = coverSize(nw, nh, aspect);
    if (!base) return null;
    if (!c) return clampView(nw, nh, { zoom: 1, cx: 0.5, cy: 0.5 }, aspect);
    return clampView(nw, nh, { zoom: base.w / (c.w * nw), cx: c.x + c.w / 2, cy: c.y + c.h / 2 }, aspect);
}

// The crop query SillyTavern's endpoint reads: whole pixels inside the picture.
export function cropPixels(crop, nw, nh) {
    const c = validCrop(crop);
    if (!c || !(nw > 0 && nh > 0)) return null;
    const x = clamp(Math.round(c.x * nw), 0, nw - 1);
    const y = clamp(Math.round(c.y * nh), 0, nh - 1);
    const width = clamp(Math.round(c.w * nw), 1, nw - x);
    const height = clamp(Math.round(c.h * nh), 1, nh - y);
    return { x, y, width, height };
}

// Where the picture sits inside a frame frameWidth wide, for the editor's preview:
// its drawn size and its offset, in CSS pixels.
export function previewBox(nw, nh, view, frameWidth, aspect = FRAME_ASPECT) {
    const v = clampView(nw, nh, view, aspect);
    if (!v || !(frameWidth > 0)) return null;
    const base = coverSize(nw, nh, aspect);
    const scale = frameWidth / (base.w / v.zoom);
    const w = base.w / v.zoom;
    const h = base.h / v.zoom;
    return {
        width: nw * scale,
        height: nh * scale,
        left: -(v.cx * nw - w / 2) * scale,
        top: -(v.cy * nh - h / 2) * scale,
        scale,
    };
}

/* What is on the avatar file, as the skip check compares it: the label alone for
   a picture written whole, the label and the crop for a framed one. Changing only
   the framing must write again. */
export function writtenKey(label, crop) {
    const c = validCrop(crop);
    if (!label) return null;
    if (!c) return label;
    const r = n => Math.round(n * 10000) / 10000;
    return `${label}#crop=${r(c.x)},${r(c.y)},${r(c.w)},${r(c.h)}`;
}
