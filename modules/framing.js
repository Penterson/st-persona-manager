// Framing a version's picture: a crop stored as fractions, sent as SillyTavern's crop query.

/* SillyTavern covers avatars to 512 x 768, so a crop of any other shape would be cut again at
   its centre; 2:3 is only scaled. */
const FRAME_ASPECT = 512 / 768;

// The crop never gets narrower than a fifth of the largest the picture allows.
export const MAX_ZOOM = 5;

const finite = n => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// A stored crop as fractions of the picture: { x, y, w, h }, all in 0..1; anything else is none.
export function validCrop(crop) {
    if (!crop || typeof crop !== 'object') return null;
    const { x, y, w, h } = crop;
    if (![x, y, w, h].every(finite)) return null;
    // A rounding hair past an edge is the edge (a frame against the left edge gives -2e-17).
    if (w <= 0 || h <= 0 || x < -0.000001 || y < -0.000001) return null;
    if (x + w > 1.000001 || y + h > 1.000001) return null;
    return { x: Math.max(0, x), y: Math.max(0, y), w, h };
}

// The largest frame-shaped rectangle the picture holds, in pixels: what zoom 1 shows and the
// server's cover takes.
export function coverSize(nw, nh, aspect = FRAME_ASPECT) {
    if (!(nw > 0 && nh > 0)) return null;
    return nw / nh > aspect ? { w: nh * aspect, h: nh } : { w: nw, h: nw / aspect };
}

// The editor's state: a zoom and the frame's centre as fractions, clamped inside the picture.
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

// The clamped view and its frame, in picture pixels.
function frameOf(nw, nh, view, aspect) {
    const v = clampView(nw, nh, view, aspect);
    if (!v) return null;
    const base = coverSize(nw, nh, aspect);
    return { v, w: base.w / v.zoom, h: base.h / v.zoom };
}

export function cropFromView(nw, nh, view, aspect = FRAME_ASPECT) {
    const f = frameOf(nw, nh, view, aspect);
    if (!f) return null;
    return {
        x: Math.max(0, (f.v.cx * nw - f.w / 2) / nw),
        y: Math.max(0, (f.v.cy * nh - f.h / 2) / nh),
        w: f.w / nw,
        h: f.h / nh,
    };
}

// A crop made on a picture of another shape keeps its centre and zoom, clamped.
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

// The picture's drawn size and offset inside a preview frame frameWidth wide, in CSS pixels.
export function previewBox(nw, nh, view, frameWidth, aspect = FRAME_ASPECT) {
    const f = frameOf(nw, nh, view, aspect);
    if (!f || !(frameWidth > 0)) return null;
    const scale = frameWidth / f.w;
    return {
        width: nw * scale,
        height: nh * scale,
        left: -(f.v.cx * nw - f.w / 2) * scale,
        top: -(f.v.cy * nh - f.h / 2) * scale,
        scale,
    };
}

// The skip check's key for the avatar file: the label, plus the crop, so reframing still writes.
export function writtenKey(label, crop) {
    const c = validCrop(crop);
    if (!label) return null;
    if (!c) return label;
    const r = n => Math.round(n * 10000) / 10000;
    return `${label}#crop=${r(c.x)},${r(c.y)},${r(c.w)},${r(c.h)}`;
}
