// DOM helpers shared by the three screens (quick panel, manager, settings). Nothing here holds
// a context, a state snapshot or a node past the call that made it.
import { MODULE_NAME } from './store.js';
import { isTextEntry } from './quickbar-pure.js';

/* Element construction */

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// A type=button button that runs onClick, or is drawn disabled (pm-disabled).
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

// A native select (the Android picker beats a custom list) over [value, label] pairs.
export function selectOf(className, options, value, onChange) {
    const select = el('select', className);
    for (const [optionValue, label] of options) {
        const option = el('option', null, label);
        option.value = String(optionValue);
        select.append(option);
    }
    if (value !== undefined) select.value = value;
    if (onChange) select.addEventListener('change', () => onChange(select.value));
    return select;
}

// A label row holding a checkbox and its name: the whole row is the target.
export function checkRow(name, checked, enabled, onChange) {
    const row = el('label', 'pm-quickbar-labelrow');
    const checkbox = el('input', 'pm-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.disabled = !enabled;
    checkbox.addEventListener('change', onChange);
    row.append(checkbox, el('span', 'pm-quickbar-labelname', name));
    return row;
}

/* A new-group field and its button. onSubmit answers false to keep the text; otherwise the
   field empties and blurs, ending the typing session a deferred redraw waits on. */
export function newGroupRow({ placeholder, aria, buttonClass, buttonLabel, enabled, onSubmit }) {
    const row = el('div', 'pm-quickbar-newlabel');
    const input = el('input', 'pm-quickbar-newlabel-input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.disabled = !enabled;
    if (aria) input.setAttribute('aria-label', aria);
    const submit = () => {
        if (!input.value.trim()) return;
        if (onSubmit(input.value) === false) return;
        input.value = '';
        input.blur();
    };
    // An Enter that commits a hangul composition must not submit.
    input.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    const addBtn = el('button', buttonClass, buttonLabel);
    addBtn.type = 'button';
    addBtn.disabled = !enabled;
    if (enabled) addBtn.addEventListener('click', submit);
    row.append(input, addBtn);
    return row;
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

/* Modal hosts. Every screen rides a top-layer <dialog>: some themes transform an ancestor,
   which breaks position: fixed, and the top layer ignores ancestor transforms. */

// Shows a host as a modal, or (no showModal, or it threw) as a plain open dialog; answers which.
export function showHost(host) {
    try { host.showModal(); return true; } catch { host.setAttribute('open', ''); return false; }
}

/* Builds, shows and focuses a host. ESC and Android back fire cancel, routed to onCancel; without
   showModal there is no cancel, so a document ESC stands in, only while focus is inside. */
export function openHost(id, className, children, onCancel, cleanups) {
    const host = document.createElement('dialog');
    host.id = id;
    host.className = className;
    host.tabIndex = -1;
    blockDrawerClose(host);
    host.addEventListener('cancel', e => { e.preventDefault(); onCancel(); });
    host.append(...children);
    document.body.append(host);
    const modal = showHost(host);
    // Initial focus stays neutral instead of on whatever control comes first.
    try { host.focus(); } catch { /* focus is best effort */ }
    if (!modal) {
        track(cleanups, document, 'keydown', e => {
            if (isComposingKey(e) || e.key !== 'Escape') return;
            const open = document.getElementById(id);
            if (!open || !open.contains(document.activeElement)) return;
            onCancel();
        });
    }
    return host;
}

export function closeHost(id) {
    const host = document.getElementById(id);
    if (!host) return;
    try { if (typeof host.close === 'function') host.close(); } catch { /* already closed */ }
    host.remove();
}

// visualViewport tracks the on-screen keyboard (vh does not). Android fires scroll, not
// resize, when it pans a focused field into view.
export function trackViewport(cleanups, onChange) {
    if (!globalThis.visualViewport) return;
    track(cleanups, globalThis.visualViewport, 'resize', onChange);
    track(cleanups, globalThis.visualViewport, 'scroll', onChange);
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

// Runs fn once on the next animation frame however often it is scheduled (at once without
// requestAnimationFrame); pending() tells whether a run is queued.
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

/* Redraws held while the user types. Rebuilding a focused field drops a hangul composition
   in progress, so a draw waits for the blur, then for the gesture that caused it. */
export function typingHold(scheduleDraw) {
    return {
        held: false,
        // Whether the draw must wait; arms one release on the field's blur.
        wait(panel) {
            if (this.held) return true;
            const active = document.activeElement;
            if (!active || !panel.contains(active) || !isTextEntry(active)) return false;
            this.held = true;
            active.addEventListener('blur', () => afterGesture(() => { this.held = false; scheduleDraw(); }), { once: true });
            return true;
        },
    };
}

// A field's text and selection, carried across a rebuild.
export function fieldSnapshot(input) {
    return input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd } : null;
}

export function restoreField(input, snap) {
    if (!input || !snap) return;
    input.value = snap.value;
    if (snap.start != null && snap.end != null && typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(snap.start, snap.end);
    }
}

// At the end of a draw: focuses the field marked data-pm-focus and centres it, since merely
// scrolled into view it can sit behind a sticky header or footer.
export function focusMarked(panel) {
    const input = panel?.querySelector('input[data-pm-focus]');
    if (!input) return;
    delete input.dataset.pmFocus;
    input.scrollIntoView?.({ block: 'center' });
    input.focus?.({ preventScroll: true });
}

/* SillyTavern interaction rules */

// SillyTavern closes its drawers on pointer events outside them, and a panel on body counts
// as outside. No preventDefault here, so the touch and mouse ones are passive.
export function blockDrawerClose(node) {
    for (const type of ['touchstart', 'mousedown', 'click']) {
        node.addEventListener(type, e => e.stopPropagation(), { passive: type !== 'click' });
    }
}

// A hangul composition commits with an Enter whose keyCode is 229.
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

// Large glyph plus text; the glyph is aria-hidden decoration.
export function emptyBlock(text) {
    const box = el('div', 'pm-empty');
    const mark = el('div', 'pm-empty-mark', '✳');
    mark.setAttribute('aria-hidden', 'true');
    box.append(mark, el('div', 'pm-empty-text', text));
    return box;
}

// pm-mass marks a filled ink block, which the inverted control colours are scoped to.
// prefix: 'pm-quickbar' or 'pm-manager'.
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

/* Gesture-safe redraws. A redraw held for a focused field is released on blur, which a
   button's own mousedown raises; rebuilding before its mouseup would send the click nowhere.
   So a release waits until after the pointerup (and its click). */
let pointerHeld = false;
let trackerInstalled = false;
const pending = [];

function onPointerDown() { pointerHeld = true; }

function onPointerUp() {
    pointerHeld = false;
    const batch = pending.splice(0);
    // One task later: the click this pointerup produces is dispatched first.
    if (batch.length) setTimeout(() => { for (const fn of batch) fn(); }, 0);
}

// Installed at boot (index.js): installed lazily, it would miss the pointerdown of the very
// gesture whose blur first needs it.
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
