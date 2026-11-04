// Shared DOM helpers for the three screens (quick panel, manager, settings). Nothing
// here holds a context, a state snapshot or a node past the call that made it.
import { MODULE_NAME } from './store.js';

/* Element construction */

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// A type=button button that runs onClick, or is drawn disabled (pm-disabled) when not
// enabled.
export function button(className, label, onClick, enabled = true) {
    const btn = el('button', className, label);
    btn.type = 'button';
    if (enabled) btn.addEventListener('click', onClick);
    else disable(btn);
    return btn;
}

export function disable(node) {
    node.disabled = true;
    node.classList.add('pm-disabled');
}

/* Listener bookkeeping */

// Registers a listener and records how to remove it, so teardown is one loop.
export function track(list, target, type, fn, options) {
    target.addEventListener(type, fn, options);
    list.push(() => target.removeEventListener(type, fn, options));
}

export function runCleanups(list) {
    for (const off of list.splice(0)) {
        try { off(); } catch (e) { console.warn(`[${MODULE_NAME}] cleanup failed`, e); }
    }
}

/* Images carried across a redraw */

// Thumbnails matching selector, kept by class and address so a redraw neither decodes a
// picture again nor shows it empty. harvest() collects a subtree's, take() reuses one or
// makes a lazy <img>, clear() lets go of whatever no new row claimed.
export function imagePool(selector) {
    const pool = new Map();
    return {
        harvest(node) {
            for (const img of node?.querySelectorAll?.(selector) ?? []) {
                const key = `${img.className}|${img.getAttribute('src')}`;
                if (!pool.has(key)) pool.set(key, img);
            }
        },
        take(className, url) {
            const key = `${className}|${url}`;
            const kept = pool.get(key);
            if (kept) { pool.delete(key); return kept; }
            const img = document.createElement('img');
            img.className = className;
            img.loading = 'lazy';
            img.alt = '';
            img.src = url;
            return img;
        },
        clear: () => pool.clear(),
    };
}

/* Frame scheduling */

// Runs fn once on the next animation frame however often it is scheduled (at once
// where there is no requestAnimationFrame); pending() tells whether a run is queued.
export function frameTask(fn) {
    let frame = 0;
    return {
        schedule() {
            if (frame) return;
            if (typeof requestAnimationFrame !== 'function') { fn(); return; }
            frame = requestAnimationFrame(() => { frame = 0; fn(); });
        },
        cancel() {
            if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
            frame = 0;
        },
        pending: () => frame !== 0,
    };
}

/* SillyTavern interaction rules */

// SillyTavern closes its drawers on pointer events outside them, and a panel on body
// counts as outside. No preventDefault here, so the touch and mouse ones are passive.
export function blockDrawerClose(node) {
    for (const type of ['touchstart', 'mousedown', 'click']) {
        node.addEventListener(type, e => e.stopPropagation(), { passive: type !== 'click' });
    }
}

// A hangul composition commits with an Enter whose keyCode is 229, and acting
// on it would fire the control while the user is still typing.
export function isComposingKey(e) {
    return e.isComposing || e.keyCode === 229;
}

/* Gives a div row what a button has: tab order, a role (unless the caller set one, e.g.
   checkbox in select mode), and Enter/Space. Space is prevented, or it scrolls the panel. */
export function makeRowActivatable(node, onActivate) {
    if (!node || typeof onActivate !== 'function') return node;
    if (!node.hasAttribute('role')) node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.addEventListener('click', onActivate);
    node.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onActivate(e);
    });
    return node;
}

/* Small shared pieces of markup */

// Always drawn (hover means nothing on touch); only its content changes.
export function checkMark(active) {
    return el('span', 'pm-check', active ? '✓' : '');
}

// Large glyph plus text (style.css, Empty states); the glyph is aria-hidden decoration.
export function emptyBlock(text) {
    const box = el('div', 'pm-empty');
    const mark = el('div', 'pm-empty-mark', '✳');
    mark.setAttribute('aria-hidden', 'true');
    box.append(mark, el('div', 'pm-empty-text', text));
    return box;
}

// pm-mass marks a filled ink block, which the inverted control colours are scoped to;
// without it the banner's buttons vanish. prefix: 'pm-quickbar' or 'pm-manager'.
export function bannerOf(prefix, className, message) {
    const box = el('div', `${prefix}-banner pm-mass ${className}`);
    box.append(el('div', `${prefix}-banner-text`, message));
    return box;
}

export function groupOf(prefix, title) {
    const box = el('div', `${prefix}-group`);
    box.append(el('div', `${prefix}-head`, title));
    return box;
}

/* Gesture-safe redraws. A redraw deferred while a field has focus is released on blur,
   which a button's own mousedown raises; rebuilding before its mouseup would send the
   click nowhere. So a release waits until after the pointerup (and its click). */
let pointerHeld = false;
let trackerInstalled = false;
const pending = [];

function onPointerDown() { pointerHeld = true; }

function onPointerUp() {
    pointerHeld = false;
    const batch = pending.splice(0);
    // One task later: the click this pointerup produces is dispatched before a
    // queued task can run, so the redraw cannot get between the two.
    if (batch.length) setTimeout(() => { for (const fn of batch) fn(); }, 0);
}

// Installed at boot (index.js): installed lazily, it would miss the pointerdown of the
// very gesture whose blur first needs it.
export function installGestureTracking() {
    if (trackerInstalled || typeof document === 'undefined') return;
    trackerInstalled = true;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
}

export function afterGesture(fn) {
    installGestureTracking();
    if (pointerHeld) { pending.push(fn); return; }
    setTimeout(fn, 0);
}

// Teardown: listeners off, and callbacks queued behind a pointer that never lifted dropped.
export function resetGestureTracking() {
    if (trackerInstalled && typeof document !== 'undefined') {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('pointercancel', onPointerUp, true);
    }
    trackerInstalled = false;
    pointerHeld = false;
    pending.length = 0;
}
