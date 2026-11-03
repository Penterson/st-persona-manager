// Shared DOM helpers for the three screens (quick panel, manager, settings).
//
// Each of these used to be copied into two or three files. One copy means the
// mobile rules they encode (tap targets, hangul composition, drawer-close
// blocking, gesture-safe redraws) are decided once and cannot drift.
//
// Nothing here holds a context, a state snapshot or a node past the call that
// made it, which is the rule every screen states at its top.
import { MODULE_NAME } from './store.js';

/* Element construction */

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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

/* SillyTavern interaction rules */

// SillyTavern closes its drawers on pointer events that land outside them, and a
// panel attached to body counts as outside. preventDefault is never called in
// these handlers, so the two that can be passive say so.
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

/* Rows that answer a key as well as a tap.

   The list rows are divs, because a div can hold a portrait, a name, a badge
   and a tick without a button's own box fighting the layout. What a div never
   gets is what a button gives away for free: a place in the tab order, a role a
   screen reader can announce, and Enter and Space. This supplies all three.

   The role is only supplied when the caller has not set one: a row in select
   mode is a checkbox, not a button, and says so itself. Space is prevented
   because otherwise it scrolls the panel out from under the row it just fired. */
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

// Hover carries no meaning on a touch screen, so the mark is always drawn and
// only its content changes.
export function checkMark(active) {
    return el('span', 'pm-check', active ? '✓' : '');
}

// An empty list gets a large glyph and the negation at size rather than a grey
// line in a corner (style.css, "Empty states"). The glyph is decoration, so it
// is not announced.
export function emptyBlock(text) {
    const box = el('div', 'pm-empty');
    const mark = el('div', 'pm-empty-mark', '✳');
    mark.setAttribute('aria-hidden', 'true');
    box.append(mark, el('div', 'pm-empty-text', text));
    return box;
}

// pm-mass, because a banner IS a filled ink block. The inversion that keeps a
// control readable on such a block is scoped to that class, and without it in
// the markup the banner's own buttons drew ink on ink and disappeared.
// prefix is the screen's class family ('pm-quickbar' or 'pm-manager').
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

/* Gesture-safe redraws.

   Both panels defer a redraw while a text field has focus, and release it on
   that field's blur. The blur is raised by the mousedown of the very tap the
   user is making on [저장] or [추가], and releasing the redraw there rebuilt the
   panel between that mousedown and its mouseup: the mouseup then landed on a
   node that did not exist a moment ago, the browser dispatched the click to a
   common ancestor with no handler, and the button did nothing. Measured in
   Chromium with a 60ms press. On a desktop every press is that slow; on a phone
   a careful one is.

   So a release waits for the gesture that caused it to finish. While a pointer
   is down the callback is queued behind its pointerup, and runs one task later,
   which is after the click that pointerup produces has been dispatched. With no
   pointer down (a keyboard Tab away from the field) it runs on the next task. */
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

// Installed at boot (index.js), before any gesture can start: a tracker that
// only appears at the first deferred release would be installed by the very
// blur that happens inside the gesture it needs to have seen begin.
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

// Teardown leaves nothing behind: the document listeners come off and anything
// still queued behind a pointer that never lifted is dropped with the screens
// that asked for it.
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
