// The quick switch bar: one icon in #leftSendForm and a panel on body.
// Everything that touches the DOM lives here; the logic worth
// testing is in quickbar-pure.js, which the node tests import instead.
import { MODULE_NAME, getPersona, TILE_SHAPES, makeId } from './store.js';
import {
    getState, saveAndCompose, adopt, getPreciseApi, getRoot, adoptFor, refresh, KEEP_DESCRIPTION_KINDS,
} from './state.js';
import { freshContext } from './ctx.js';
import { compose } from './compose.js';
import { addLog, snapshot, enforceGlobalBudget, expireOldHistory } from './history.js';
import { toggleMember, SORT_KEYS, livingLabels } from './roster.js';
import {
    pickPersonaCommand, quoteArg, describeSelection, waitFor, schedulerTurn, divergedActions,
    buildRosterView, sortLabel, isTextEntry, versionApplicable, versionAlreadyApplied,
    popupVerdict, shouldSelfCorrect, POPUP_STUCK_MS, POPUP_STUCK_CHECKS, rosterVersionLine,
    pickAutoName, nameCollides,
} from './quickbar-pure.js';
// Every sentence the user reads on this panel comes from there.
import { STRINGS } from './strings.js';
// One helper, not the screen: manager-pure.js holds no DOM and importing it here
// keeps both screens comparing the empty section set the same way. A second copy
// of the rule would be a second chance to get it wrong.
import {
    missingSignature, addTag, removeTag, tagsAcross, boundAsset, pictureSettled,
    renameVersionIn, duplicateVersionIn, overwriteVersionPicks, dropVersionFrom, moveVersion,
} from './manager-pure.js';
// assets.js imports nothing at all, so reaching it from here adds no cycle.
import { applyBoundImage } from './assets.js';
import { validCrop, writtenKey } from './framing.js';
import { itemsWithText } from './classify.js';
// Matching, language detection and paging.
import { rankOf, matchRanges, srcOf, detectLanguage, chatLanguage, pageOf } from './search-pure.js';

// QuickPersona is installed on this device and puts its own icon in the same host.
// Every id and class here carries the pm- prefix so neither extension can reach the
// other's nodes, and we append to the host instead of rewriting it so its icon
// keeps working. This is duplication, not a collision.
const BUTTON_ID = 'pm-quickbar';
const PANEL_ID = 'pm-quickbar-panel';
const BACKDROP_ID = 'pm-quickbar-backdrop';
const HOST_ID = 'pm-quickbar-host';

let mounted = false;
let cleanups = [];
let panelCleanups = [];
// The roster's search, filters and page. Panel local UI
// state, strings and numbers only, reset when the panel closes.
let rosterSearchOpen = false;
let rosterQuery = '';
let rosterPage = 1;
let rosterLang = null;
let rosterTags = [];
// The avatar the open panel was drawn for. Every write is checked against it, and
// then checked again inside saveAndCompose, so a persona change between opening
// the panel and tapping a row cannot write the edit onto the wrong persona.
let panelAvatar = null;
let bannerDismissed = false;
// Which persona row (if any) has its label checkboxes open, and
// whether edit mode is on at all. Both are panel local UI state, reset whenever the
// panel opens, exactly like bannerDismissed above.
let editMode = false;
let expandedAvatar = null;
// Multi select (user request). A dedicated button turns it on, chosen over a long
// press because a long press on a list of portraits is also how Android starts a
// text selection or an image save. Strings only, per the module state rule.
let selectMode = false;
let selectedAvatars = [];
/* What the persona list actually drew, after the group chip, the language and tag
   chips, the search and the page cut. The bulk bar stands ABOVE the list and its
   [전체 선택] is scoped to "what the user can see they are choosing", which is this
   and not buildRosterView's output: that one has only had the group chip applied,
   so a search showing two personas had [전체 선택] pick all thirty and [삭제]
   take them. Written by fillRosterList, read by the bulk bar at tap time. */
let rosterVisible = [];
// One redraw per frame, and none at all while the user is typing. See scheduleDraw.
let drawFrame = 0;
let drawDeferred = false;
// The set of empty sections the user has already been told about, as a string.
// The loss has to be visible; that does not mean a toast per tap for a
// section the user has decided to leave empty. The banner stays either way.
let lastMissing = null;
// Two runtime measurements, both explained where they are used. Neither is a
// guess about the build: each is taken once per session from what actually
// happened, and reset by unmountQuickbar so a re-enable measures again.
// probePromise is the popup measurement itself, and every popup waits on the same
// one: a boolean set before the measurement had an answer is what let a second
// popup take the unmeasured path 96ms later.
let probePromise = null;
let popupNeedsDrop = false;

// No event handler in this file closes over a context. Handlers outlive the draw
// that created them, and a context is only true for the instant it was read, so
// anything that needs one calls freshContext() when it runs. The functions that
// take a ctx parameter are the ones a single synchronous draw passes it down to.

function track(list, target, type, fn, options) {
    target.addEventListener(type, fn, options);
    list.push(() => target.removeEventListener(type, fn, options));
}

function runCleanups(list) {
    for (const off of list.splice(0)) {
        try { off(); } catch (e) { console.warn(`[${MODULE_NAME}] cleanup failed`, e); }
    }
}

// Exported for modules/manager.js, which is a second screen under the same
// mobile constraints and must not answer any of them differently. notify, el,
// blockDrawerClose, isComposingKey, askConfirm,
// askText, closePanel and guardStartAvatar are shared for that reason; a second
// copy of any of them would be a second chance to get the rule wrong. Nothing
// exported here holds a context or a node past the call that made it.

// toastr is a SillyTavern global that the diagnostics never measured, so it is
// discovered here rather than assumed. Without it the message still has to go
// somewhere, because a failed persona switch that says nothing is the exact
// outcome that is forbidden.
export function notify(kind, message) {
    const t = globalThis.toastr;
    if (t && typeof t[kind] === 'function') { t[kind](message); liftToasts(); }
    else console.warn(`[${MODULE_NAME}] ${message}`);
}

/* SillyTavern's toast container hangs off body. Our screens are dialogs opened
   with showModal, which puts them in the TOP LAYER: above everything in body and
   making all of it inert. So a message raised from an open screen was drawn
   underneath that screen and could not be tapped either - [+ 태그] on a name the
   persona already has reported the refusal into a layer with nobody in it, and
   from the user's side the button simply did nothing.

   The container is borrowed for as long as one of our screens is up, and handed
   straight back when it comes down. Handing it back is not optional: closeManager
   REMOVES its host, and a container still inside it would leave the document with
   SillyTavern's toasts. */
let toastHome = null;

function toastContainer() {
    if (typeof document === 'undefined') return null;
    return document.getElementById('toast-container');
}

function liftToasts() {
    const host = ourOpenHost();
    const box = toastContainer();
    if (!host || !box || box.parentElement === host) return;
    if (!toastHome) toastHome = box.parentElement ?? document.body;
    host.append(box);
}

// Called before any of our hosts is closed, dropped or removed. Puts the
// container back where SillyTavern keeps it; the next notify lifts it again into
// whichever of our screens is still standing.
export function releaseToasts() {
    const box = toastContainer();
    if (!box || !toastHome) return;
    if (box.parentElement !== toastHome) toastHome.append(box);
    toastHome = null;
}

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// SillyTavern closes its drawers on pointer events that land outside them, and a
// panel attached to body counts as outside. preventDefault is never
// called in these handlers, so the two that can be passive say so.
export function blockDrawerClose(node) {
    for (const type of ['touchstart', 'mousedown', 'click']) {
        node.addEventListener(type, e => e.stopPropagation(), { passive: type !== 'click' });
    }
}

// A hangul composition commits with an Enter whose keyCode is 229,
// and acting on it would fire the control while the user is still typing.
export function isComposingKey(e) {
    return e.isComposing || e.keyCode === 229;
}

/* A row that answers a tap has to answer a key as well.

   The rows in this panel are divs, because a div is what can hold a portrait, a
   name, a badge and a tick without a button's own box fighting the layout - the
   fold heads made the same choice and say so where they are built. What the divs
   never got is what a button gives away for free: a place in the tab order, a
   role a screen reader can announce, and Enter and Space. So the persona list,
   which is the one thing this panel exists for, could be operated by a finger and
   by nothing else. TalkBack read the names and had no way to choose one.

   The role is only supplied when the caller has not set one: a row in select mode
   is a checkbox, not a button, and it says so itself. Space is prevented because
   otherwise it scrolls the panel out from under the row it just fired. */
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

// getThumbnailUrl's third argument was never measured. On some SillyTavern builds
// it is a cache buster that appends a fresh timestamp per call, which would make
// every repaint of the icon and every row of the 30 persona list request a picture
// the browser already has, and would defeat the "assign only when it differs" check
// in paintButton because it always differs.
//
// It was measured by asking twice and comparing, and the measurement could not
// see it: SillyTavern builds the argument as &t=Date.now(), two calls in a row
// land in the same millisecond, the answers agree, and the verdict said keep
// passing it - so every draw asked for twenty pictures under a fresh address once
// the clock ticked. The argument is never passed. A replaced picture gets its one
// reload from thumbBumps below, which is the only reload this needs.
/* Bumped when a persona's PICTURE has been replaced, and at no other time.

   The URL above is deliberately stable so that repaints do not re-request thirty
   pictures the browser already holds. The cost of that is the case the device
   reported: replace an image and the icon beside the send box keeps the old one
   until you switch persona and back. The list looked fine only because its rows
   are built fresh each draw and get to consult the cache again; the icon is ONE
   node that lives for the session, its src never changes, so the browser is never
   asked anything and goes on showing the picture it decoded once.

   A token in the query string, changed once per replacement, makes exactly one
   reload happen and leaves every other draw as cheap as it was. Not a timestamp
   per call: that is the cache buster this function measures for and refuses.

   Per avatar, because the replacement is per avatar: one global token changed
   every URL and made one 이미지 변경 refetch all thirty thumbnails on the next
   draw. Only the address whose picture actually changed needs to change. */
const thumbBumps = new Map();

// The browser locale and numeric: true, and nothing else. Built once: the locale
// cannot change inside a session, and fillRosterList runs once per frame while
// the user types in the search box.
const LIST_COLLATOR = new Intl.Collator(undefined, { numeric: true });

export function bumpThumbnails(avatarId) {
    if (!avatarId) return;
    thumbBumps.set(avatarId, (thumbBumps.get(avatarId) ?? 0) + 1);
}

export function thumbnailUrl(ctx, avatarId) {
    if (!avatarId || typeof ctx?.getThumbnailUrl !== 'function') return null;
    let url;
    try {
        url = ctx.getThumbnailUrl('persona', avatarId);
    } catch { return null; }
    const bump = thumbBumps.get(avatarId);
    if (!url || !bump) return url ?? null;
    return `${url}${url.includes('?') ? '&' : '?'}pmv=${bump}`;
}

// Every redraw this module asks for goes through here, never straight to drawPanel.
// One tap produces two or three of them: writeDescription emits PERSONA_UPDATED,
// the commit path draws for itself, and SillyTavern's debounced settings save is
// assumed to re-emit SETTINGS_UPDATED some time after the tap. That delay has never
// been measured, so nothing here depends on how long it is. Each of those events
// used to run its own replaceChildren, which on
// the 30 persona list throws the scroll position back to the top and destroys
// whatever had focus. One frame absorbs the burst; a settings save that lands later
// is handled by the focus deferral inside drawPanel.
function scheduleDraw() {
    if (drawFrame) return;
    if (typeof requestAnimationFrame !== 'function') { drawPanel(); return; }
    // Nothing is captured here. The frame calls drawPanel, which reads the state
    // and the context itself, at the moment it actually runs.
    drawFrame = requestAnimationFrame(() => { drawFrame = 0; drawPanel(); });
}

function personaNames(ctx) {
    return ctx?.powerUserSettings?.personas ?? {};
}

/* Button */

function buildButton(host) {
    const btn = el('div', 'pm-quickbar interactable');
    btn.id = BUTTON_ID;
    btn.tabIndex = 0;
    btn.setAttribute('role', 'button');
    btn.append(el('img', 'pm-quickbar-img'), el('span', 'pm-quickbar-label'));
    btn.querySelector('.pm-quickbar-img').alt = '';
    host.append(btn);

    // Selection reacts to click only: opening on touchstart lets the
    // synthesized click land on whatever the panel just put under the finger.
    btn.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });
    btn.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); }
    });
    return btn;
}

// The avatar shape, as a class on whatever element should carry it. Exported so
// the manager and the input bar icon share one implementation: the class was
// applied at panel CONSTRUCTION only, so changing the setting left an already
// open panel on the shape it opened with.
export function applyShapeClass(node) {
    if (!node) return;
    const stored = getRoot()?.settings?.rosterTileShape;
    const shape = TILE_SHAPES.includes(stored) ? stored : 'circle';
    for (const known of TILE_SHAPES) node.classList.toggle(`pm-tileshape-${known}`, known === shape);
}

function paintButton(ctx, btn) {
    const s = getState();
    // The icon sits in SillyTavern's send row, outside both panels, so it cannot
    // inherit the panel's --pm-avatar-radius. It carries the class itself.
    applyShapeClass(btn);
    const img = btn.querySelector('.pm-quickbar-img');
    const label = btn.querySelector('.pm-quickbar-label');
    const avatar = s?.avatar ?? null;
    // getThumbnailUrl is measured present on the device. Guarded inside
    // thumbnailUrl anyway, so a build without it shows the label instead of
    // throwing on every repaint.
    const url = thumbnailUrl(ctx, avatar);
    // Assigned only when it actually differs. This repaints on every pm:changed,
    // and every one of those events fires while the persona is unchanged, so an
    // unconditional assignment hands the browser the same URL over and over.
    if (url) {
        if (img.getAttribute('src') !== url) img.src = url;
        img.hidden = false;
    } else {
        img.removeAttribute('src');
        img.hidden = true;
    }
    const title = describeSelection(s?.persona ?? null);
    label.textContent = title;
    // The send form allots this button a 28px slot on the phone, which crushed the
    // text label to 9px wide (icon diagnostics). style.css hides the label now; the
    // same text rides on the tooltip and the accessible name instead.
    btn.title = title;
    btn.setAttribute('aria-label', STRINGS.quick.iconAria(title));
}

function syncButton() {
    const ctx = freshContext();
    const s = getState();
    const existing = document.getElementById(BUTTON_ID);
    // The setting exists so a QuickPersona user can drop one of the
    // two icons. It is read on every state change, not only at mount.
    if (s && s.settings?.showQuickBar === false) {
        closePanel();
        existing?.remove();
        return;
    }
    const host = document.getElementById('leftSendForm');
    if (!host) return;
    // getElementById only ever returns a node that is in the document, so there is
    // no detached case to test for here.
    const btn = existing ?? buildButton(host);
    paintButton(ctx, btn);
    if (document.getElementById(PANEL_ID)) scheduleDraw();
}

/* Panel shell */

// The gap between the panel and the bottom edge of what the user can actually see.
// Matches the bottom in style.css, which is what applies until this runs.
const PANEL_GAP_PX = 12;

// One geometry write per frame (device jank): visualViewport fires
// scroll continuously while the keyboard pans the page, and writing height and
// top per event forced a layout each time. The frame reads the final position.
let sizeFrame = 0;
function scheduleSize() {
    if (sizeFrame) return;
    if (typeof requestAnimationFrame !== 'function') { sizeToViewport(); return; }
    sizeFrame = requestAnimationFrame(() => { sizeFrame = 0; sizeToViewport(); });
}

/* What was last written to the panel, so an unchanged value is not written again.

   Every assignment to panel.style invalidates layout, and the next line here READS
   documentElement.clientHeight, which forces the browser to lay the document out
   again to answer. Inside SillyTavern that document is a whole chat. This runs on
   every visualViewport scroll and resize, which on Android is a stream of events
   while a list is being flung, so the cost was a full reflow per frame for values
   that had not moved. Comparing first is what makes the quiet case free.

   Not a cache of the panel: the panel is looked up by id every call, as everything
   here does. These are two numbers and a nulled marker. */
let sizedMaxHeight = null;
let sizedBottom = null;

function forgetSizing() {
    sizedMaxHeight = null;
    sizedBottom = null;
}

function sizeToViewport() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    // CSS vh does not shrink when the on screen keyboard opens, so a
    // vh sized panel ends up partly under the keyboard.
    const vv = globalThis.visualViewport;
    const height = vv?.height ?? globalThis.innerHeight ?? 0;
    if (!height) return;
    const maxHeight = Math.round(height * 0.7);
    if (maxHeight !== sizedMaxHeight) {
        sizedMaxHeight = maxHeight;
        panel.style.maxHeight = `${maxHeight}px`;
    }
    if (!vv) return;
    // The same rule applied to the position, which used to come from a fixed CSS
    // bottom. A fixed element is placed against the layout viewport, and the layout
    // viewport does not shrink for the keyboard, so a panel opened while the keyboard
    // was already up sat behind it until a resize event happened to fire. The bottom
    // edge of the visual viewport sits offsetTop + height below the layout viewport's
    // top, so the distance from the layout bottom is what we have to offset by.
    const layout = document.documentElement?.clientHeight ?? height;
    const bottom = Math.max(PANEL_GAP_PX, Math.round(layout - (vv.offsetTop + height)) + PANEL_GAP_PX);
    if (bottom !== sizedBottom) {
        sizedBottom = bottom;
        panel.style.bottom = `${bottom}px`;
    }
}

function togglePanel() {
    if (document.getElementById(PANEL_ID)) closePanel();
    else openPanel();
}

// Exported for modules/manager.js. Closing the manager is a step
// back up to the panel the user came from, not an exit from everything, so the
// manager reopens exactly this panel rather than building a second one of its own.
export function openPanel() {
    if (document.getElementById(PANEL_ID)) return;
    // A new panel element carries none of the inline geometry the old one had, so
    // what was written to the old one must not stand in for it.
    forgetSizing();
    bannerDismissed = false;
    editMode = false;
    selectMode = false;
    selectedAvatars = [];
    expandedAvatar = null;
    // A fresh session of looking at this persona, so the empty section set is
    // worth saying once more even if it is the same one as last time.
    lastMissing = null;
    // A deferral left over from the previous panel would swallow the first redraw
    // of this one, and the input it was waiting on is long gone.
    drawDeferred = false;
    panelAvatar = getState()?.avatar ?? null;

    const backdrop = el('div', 'pm-quickbar-backdrop');
    backdrop.id = BACKDROP_ID;
    // pm-grain paints the reference's paper tooth as a fixed overlay on the
    // panel, not on the scrolling content, so it composites once (style.css).
    const panel = el('div', 'pm-panel pm-quickbar-panel pm-grain');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');

    blockDrawerClose(backdrop);
    blockDrawerClose(panel);
    // stopPropagation above only stops the event from reaching SillyTavern; other
    // listeners on the same node still run, so this close handler is unaffected.
    backdrop.addEventListener('click', () => closePanel());

    // The icon diagnostics measured the panel at y=-576 with a zero height backdrop:
    // one of the installed themes decorates an ancestor with a transform, which
    // makes that ancestor the containing block for position fixed, so viewport
    // anchored coordinates land off screen. A modal dialog renders in the top
    // layer, which the spec pins to the viewport regardless of ancestor transforms.
    // The backdrop and panel ride inside it unchanged, repositioned as absolute
    // against the full viewport host by style.css.
    const host = document.createElement('dialog');
    host.id = HOST_ID;
    host.className = 'pm-quickbar-host';
    host.tabIndex = -1;
    blockDrawerClose(host);
    // Native ESC fires cancel on the dialog. Route it through our own close so the
    // cleanup path stays single; the document level Escape handler below becomes a
    // harmless second no-op call.
    host.addEventListener('cancel', e => { e.preventDefault(); closePanel(); });
    host.append(backdrop, panel);
    document.body.append(host);
    let modal = false;
    if (typeof host.showModal === 'function') {
        try { host.showModal(); modal = true; } catch { host.setAttribute('open', ''); }
    } else {
        host.setAttribute('open', '');
    }
    // Keep initial focus neutral instead of whatever focusable comes first.
    try { host.focus(); } catch { /* focus is best effort */ }
    drawPanel();
    sizeToViewport();

    if (globalThis.visualViewport) {
        track(panelCleanups, globalThis.visualViewport, 'resize', scheduleSize);
        // Android fires scroll and not resize when the visual viewport is panned,
        // which is what happens when a focused field is scrolled into view above
        // the keyboard. Without this the panel keeps the offset it had before the
        // pan and ends up half off the visible area.
        track(panelCleanups, globalThis.visualViewport, 'scroll', scheduleSize);
    }
    // A dialog opened with showModal already fires cancel for ESC and for the
    // Android back gesture, and the handler above routes that to closePanel. A
    // document level listener on top of it also fired for the ESC that dismissed a
    // SillyTavern popup drawn over us, which closed the panel underneath the user.
    // Kept only for the fallback path, where no cancel event will ever come, and
    // even there only while the focus is still inside our own host.
    if (!modal) {
        track(panelCleanups, document, 'keydown', e => {
            if (isComposingKey(e)) return;
            if (e.key !== 'Escape') return;
            const open = document.getElementById(HOST_ID);
            if (!open || !open.contains(document.activeElement)) return;
            closePanel();
        });
    }
}

/* Search rendering helpers, shared with the manager screen. */

// A text with its match against `query` marked. Draws the NFC form matchRanges
// indexes into, so decomposed names cannot skew the highlight. Built with
// createElement and text nodes only, never innerHTML.
export function markedText(className, text, query) {
    const span = el('span', className);
    const src = srcOf(text);
    const ranges = query ? matchRanges(text, query) : [];
    if (!ranges.length) { span.textContent = src; return span; }
    let at = 0;
    for (const [from, to] of ranges) {
        if (from > at) span.append(document.createTextNode(src.slice(at, from)));
        span.append(el('mark', 'pm-mark', src.slice(from, to + 1)));
        at = to + 1;
    }
    if (at < src.length) span.append(document.createTextNode(src.slice(at)));
    return span;
}

// The one pager every paged list draws. Hidden entirely on a
// single page. The callbacks re-read their own state when they run, exactly
// like every other handler in this extension.
export function pagerRow(page, pages, onPrev, onNext) {
    if (pages <= 1) return null;
    const row = el('div', 'pm-pager');
    const prev = el('button', 'pm-quickbar-btn', STRINGS.common.pagePrev);
    prev.type = 'button';
    if (page <= 1) { prev.disabled = true; prev.classList.add('pm-disabled'); }
    else prev.addEventListener('click', onPrev);
    const next = el('button', 'pm-quickbar-btn', STRINGS.common.pageNext);
    next.type = 'button';
    if (page >= pages) { next.disabled = true; next.classList.add('pm-disabled'); }
    else next.addEventListener('click', onNext);
    row.append(prev, el('span', 'pm-pager-count', STRINGS.common.pageOf(page, pages)), next);
    return row;
}

// Whether the quick panel is on screen right now. The manager asks at the moment
// it opens, because the return trip only exists when this panel is
// what the manager replaced; the id stays private to this file either way.
export function isPanelOpen() {
    return typeof document !== 'undefined' && !!document.getElementById(PANEL_ID);
}

export function closePanel() {
    runCleanups(panelCleanups);
    releaseToasts();
    const host = document.getElementById(HOST_ID);
    if (host) {
        try { if (typeof host.close === 'function') host.close(); } catch { /* already closed */ }
        host.remove();
    }
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(BACKDROP_ID)?.remove();
    if (sizeFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sizeFrame);
    sizeFrame = 0;
    panelAvatar = null;
    // Panel local UI state, gone with the panel.
    rosterSearchOpen = false;
    rosterQuery = '';
    rosterPage = 1;
    rosterLang = null;
    rosterTags = [];
    rosterVisible = [];
    versionToolsAt = null;
    // Removing a focused input does not reliably fire blur, so the one shot listener
    // may never run. It is registered with once and dies with its node; the flag is
    // the only thing that would outlive the panel.
    drawDeferred = false;
    // The same reasoning as unmountQuickbar: a frame already queued would call
    // drawPanel after the panel is gone. It finds no panel and returns, but the id
    // must not be left looking like a live schedule.
    if (drawFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    // A list rebuild queued for a panel that is going away.
    if (rosterListFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rosterListFrame);
    rosterListFrame = 0;
}

/* Writes */

// Every action starts here. If the active persona moved while the panel was open,
// the state we would mutate belongs to a different persona, so we stop before
// touching anything rather than after.
function guardAvatar() {
    const s = getState();
    if (!s || s.avatar !== panelAvatar) {
        notify('error', STRINGS.common.personaChanged);
        closePanel();
        return null;
    }
    return writableOrSay(s);
}

/* The buttons are drawn disabled while the active persona is ambiguous or the
   data belongs to a newer build, but a draw can be held back behind a focused
   field, and a tap on a button drawn before the state changed still arrives.
   Several writers change the persona before commit, and commit's refusal does
   not undo that: the change stays in the live settings for SillyTavern's next
   save. So the guards ask too. */
function writableOrSay(s) {
    if (rosterWritable(s)) return s;
    notify('error', s.readOnly ? STRINGS.common.readOnly : STRINGS.quick.ambiguous);
    scheduleDraw();
    return null;
}

// The same question asked across an await, which guardAvatar cannot answer. Every
// redraw re-adopts panelAvatar to whoever is active now, and a PERSONA_CHANGED that
// lands while a popup is open redraws, so after the await guardAvatar compares the
// new persona to itself and passes. startAvatar is a plain string read before the
// await and nothing can move it, which is what makes the comparison mean something.
export function guardStartAvatar(startAvatar) {
    const s = getState();
    if (!s || s.avatar !== startAvatar) {
        notify('error', STRINGS.common.personaChanged);
        closePanel();
        return null;
    }
    return writableOrSay(s);
}

function commit(kind, detail) {
    // Read before the save, used after it. The log line describes an accepted write,
    // so writing it first grows persona.log by one line every time state.js refuses,
    // and a refused write is exactly the case where nothing happened to record.
    const persona = getState()?.persona ?? null;
    // Second line of defence: state.js refuses the write outright when the active
    // persona is no longer the one this panel was drawn for.
    const result = saveAndCompose(panelAvatar, { write: !KEEP_DESCRIPTION_KINDS.has(kind) });
    if (!result) { notify('error', STRINGS.common.cannotSaveNow); return false; }
    if (result.ok === false) {
        notify('error', STRINGS.common.personaChangedNotSaved);
        closePanel();
        return false;
    }
    if (persona) {
        addLog(persona, kind, detail, Date.now());
        // writeDescription already saved, so this line needs a save of its own.
        freshContext()?.saveSettingsDebounced?.();
    }
    // A kept description emits no PERSONA_UPDATED, and the icon beside the send
    // box reads the version name from that event's pm:changed: rename or delete
    // the version it shows and the icon went on showing the old name.
    if (result.kept && typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('pm:changed'));
    // The loss has to be visible, and the banner in the panel carries it
    // permanently. The toast is only for the moment the set CHANGES: a section the
    // user has decided to leave empty otherwise produced one toast per tap, which
    // is how a real warning gets trained away.
    const signature = missingSignature(result.missing);
    if (signature !== lastMissing) {
        if (result.missing?.length) notify('warning', STRINGS.common.emptyItems(result.missing.length));
        lastMissing = signature;
    }
    scheduleDraw();
    return true;
}

/* SillyTavern popups, and the one thing about them we never measured */

// Every screen this extension draws rides a modal <dialog> in the top layer,
// because a themed ancestor with a transform drags a position:fixed overlay off
// screen (measured, 아이콘 진단). A modal dialog also makes the rest of the document
// inert and paints above it. That is fine when SillyTavern's popup is a <dialog>
// of its own, because it joins the same top layer above us.
//
// Whether THIS build's popup is a dialog or a plain z-indexed div was never
// measured. Under a div popup the consequence is total: the popup is inert and
// painted underneath our host, so nothing can answer it, and every await in this
// extension sits on a promise that will never settle. A hang with nothing on
// screen to tap is the worst failure available here.
//
// So the answer is measured rather than assumed. The first popup of the session
// is started normally and then looked for: if no dialog[open] other than one of
// ours appeared AND STAYED open, this build draws a div, and from then on every
// popup await is wrapped in closing our host first and reopening it afterwards.
// The verdict is applied to that first popup too, which is what unsticks it.
//
// Three things make that verdict trustworthy, and all three were missing:
//   1. every popup waits on the same probe, so a second question opened inside the
//      probe window cannot branch on an answer that does not exist yet
//   2. a dialog counts only if it is still open when the probe ends, so another
//      extension's dialog flashing past is not mistaken for SillyTavern's popup
//   3. a verdict of "no drop needed" that leaves a popup unanswered for
//      POPUP_STUCK_MS corrects itself, because nothing else ever revisits it
//
// Our own hosts are told apart by the pm- id prefix every node in this extension
// carries (see the note at the top of this file).
const POPUP_PROBE_TURNS = 3;

// Told apart from any value a popup can resolve with, because a popup that answers
// with undefined or false is a popup that answered.
const POPUP_STUCK = Symbol('popup-stuck');

function openDialogs(ours) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
    const all = [...document.querySelectorAll('dialog[open]')];
    return all.filter(node => String(node.id ?? '').startsWith('pm-') === ours);
}

// The topmost of our own open hosts. The manager opens over the quick panel, so
// the last one in document order is the one actually covering the popup.
function ourOpenHost() {
    const hosts = openDialogs(true);
    return hosts[hosts.length - 1] ?? null;
}

function dropHost(host) {
    // Closing lifts the inertness the top layer imposes on everything else, which
    // is what lets a div popup receive a tap at all.
    // The toast container goes back to body first, or it would be sitting inside
    // a dialog that is no longer being painted.
    releaseToasts();
    if (!host || !host.isConnected || typeof host.close !== 'function') return false;
    try { host.close(); return true; } catch { return false; }
}

function raiseHost(host) {
    // Only if it is still in the document: the screen may have been closed while
    // the popup was up, and reopening a host nobody wants would put an orphaned
    // dialog back on top of everything.
    if (!host || !host.isConnected || host.open || typeof host.showModal !== 'function') return;
    try { host.showModal(); } catch { host.setAttribute('open', ''); }
}

// Waits for a popup we believe needs no help, and corrects the belief rather than
// hanging on it. A wait past POPUP_STUCK_MS with our host still up and no foreign
// dialog on screen is the shape of a mismeasurement: the question is painted under
// our modal host and the user has nothing to tap. Dropping the host is what makes
// it interactive, and the wait then continues normally.
//
// The shape is examined over POPUP_STUCK_CHECKS windows rather than once. A
// foreign dialog on screen defers the verdict (the question may be theirs to
// answer), and a single check meant one unrelated dialog at the four second mark
// silenced the correction for that popup for good: when it closed a moment later,
// nothing ever looked again. Each window only runs while the popup is still
// unanswered, and correction happens at most once.
async function awaitPopup(pending, host) {
    let timer = 0;
    let dropped = false;
    try {
        for (let check = 0; check < POPUP_STUCK_CHECKS; check++) {
            const stuck = new Promise(resolve => { timer = setTimeout(() => resolve(POPUP_STUCK), POPUP_STUCK_MS); });
            const first = await Promise.race([pending, stuck]);
            clearTimeout(timer);
            timer = 0;
            if (first !== POPUP_STUCK) return first;
            const correct = shouldSelfCorrect({
                needsDrop: popupNeedsDrop,
                elapsedMs: POPUP_STUCK_MS,
                foreignOpen: openDialogs(false).length > 0,
            });
            if (correct) {
                // Recorded for the rest of the session as well: the next popup should
                // not have to spend another four seconds discovering the same thing.
                popupNeedsDrop = true;
                dropped = dropHost(host);
                break;
            }
        }
        return await pending;
    } finally {
        if (timer) clearTimeout(timer);
        if (dropped) raiseHost(host);
    }
}

// The path taken once the build is known.
async function runMeasuredPopup(start) {
    const host = ourOpenHost();
    if (!popupNeedsDrop) return awaitPopup(start(), host);
    const dropped = dropHost(host);
    try { return await start(); }
    finally { if (dropped) raiseHost(host); }
}

async function runPopup(start) {
    // Everything waits on the one measurement, including the calls that arrive
    // while it is still being taken. The flag used to be set before the probe had
    // an answer, so a second popup opened inside the 96ms window read the default
    // verdict, took the no-drop path, and hung with its question under our host.
    if (probePromise) {
        await probePromise;
        return runMeasuredPopup(start);
    }

    const host = ourOpenHost();
    // What was already open before we asked for anything. Another extension can
    // have a dialog up, and counting that one would record a div build as a dialog
    // build and leave every popup of the session unanswerable. These sets are local
    // to this call and die with it, so nothing outlives its moment.
    const before = new Set(openDialogs(false));
    const pending = start();
    // Published before the first await, so a caller one turn behind waits for this
    // measurement instead of starting a second one.
    let measured;
    probePromise = new Promise(resolve => { measured = resolve; });
    try {
        // A few scheduler turns rather than exactly one: a build that renders its
        // dialog a frame late would otherwise be recorded as a div build for the
        // whole session, and every popup after it would flash our screen closed for
        // nothing. Sampled on every turn including the first, so a dialog that is
        // already up costs nothing.
        const during = new Set();
        for (let turn = 0; turn <= POPUP_PROBE_TURNS; turn++) {
            for (const dialog of openDialogs(false)) during.add(dialog);
            if (turn < POPUP_PROBE_TURNS) await new Promise(resolve => schedulerTurn(resolve));
        }
        popupNeedsDrop = !popupVerdict({ before, during, openAtEnd: new Set(openDialogs(false)) });
    } finally {
        // Released whatever happened, so a failed probe cannot leave every later
        // popup waiting on a promise that never settles.
        measured();
    }

    if (!popupNeedsDrop) return awaitPopup(pending, host);

    // Retroactive, on the popup that is already in flight. Without this the first
    // question of the session is precisely the one that hangs.
    const dropped = dropHost(host);
    try { return await pending; }
    finally { if (dropped) raiseHost(host); }
}

// Reached only on a build with no callGenericPopup at all. A browser configured to
// block dialogs returns null from prompt and Chromium answers confirm with false,
// and neither is distinguishable from a user who said no. Saying so is still better
// than a tap that does nothing and explains nothing.
function fallbackBlocked() {
    notify('info', STRINGS.common.popupBlocked);
}

export async function askConfirm(message) {
    // Popup, POPUP_TYPE and callGenericPopup are all measured present, but the
    // member names inside POPUP_TYPE were not, so they are checked at runtime.
    const ctx = freshContext();
    if (typeof ctx?.callGenericPopup === 'function' && ctx.POPUP_TYPE?.CONFIRM !== undefined) {
        return !!(await runPopup(() => ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM)));
    }
    if (typeof globalThis.confirm !== 'function') { fallbackBlocked(); return false; }
    const answer = globalThis.confirm(message);
    if (!answer) fallbackBlocked();
    return !!answer;
}

// One of a known list. There is no measured popup type for a picker on this
// build, so this reuses the text input and validates the answer against the list
// rather than inventing an API that may not exist. The options are printed in the
// prompt because an input box with no list is a guess; a number is asked for
// because typing a Korean tag name exactly is harder than typing 3.
/* The same question, answered by POSITION rather than by the string at it.

   Two groups may share a name, so the caller cannot resolve the answer by name
   without silently picking the first of a pair - and the caller that knew this
   worked around it by numbering its own options before handing them over, which
   this function then numbered again: the user read 1. 1. 그룹A at the top of the
   list. One numbering,
   done here, and the index is what comes back. -1 is a cancel or no match. */
export async function askChoiceIndex(message, options) {
    const list = (options ?? []).filter(o => typeof o === 'string' && o.length);
    if (!list.length) return -1;
    const menu = list.map((o, i) => `${i + 1}. ${o}`).join('\n');
    const answer = await askText(`${message}\n${menu}`, '1');
    if (answer === null) return -1;
    const trimmed = String(answer).trim();
    // The exact NAME first, for the same reason askChoice states below.
    const named = list.indexOf(trimmed);
    if (named !== -1) return named;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return n - 1;
    notify('info', STRINGS.quick.choiceNoMatch);
    return -1;
}

export async function askChoice(message, options) {
    const list = (options ?? []).filter(o => typeof o === 'string' && o.length);
    if (!list.length) return null;
    const menu = list.map((o, i) => `${i + 1}. ${o}`).join('\n');
    const answer = await askText(`${message}\n${menu}`, '1');
    if (answer === null) return null;
    const trimmed = String(answer).trim();
    // The exact NAME is tried first. Position was tried first and a tag literally
    // named "3" sitting at position 1 then picked entry 3 instead, which for
    // 태그 삭제 strips a tag the user never chose from every selected persona with
    // no undo. Only when nothing is named that does the input read as a position.
    const named = list.find(o => o === trimmed);
    if (named !== undefined) return named;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
    // Neither a name nor a position. Saying nothing here reads as a cancel, and
    // the caller cannot tell the two apart.
    notify('info', STRINGS.quick.choiceNoMatch);
    return null;
}

export async function askText(message, initial) {
    const ctx = freshContext();
    if (typeof ctx?.callGenericPopup === 'function' && ctx.POPUP_TYPE?.INPUT !== undefined) {
        const value = await runPopup(() => ctx.callGenericPopup(message, ctx.POPUP_TYPE.INPUT, initial ?? ''));
        return typeof value === 'string' ? value : null;
    }
    if (typeof globalThis.prompt !== 'function') { fallbackBlocked(); return null; }
    const value = globalThis.prompt(message, initial ?? '');
    if (value === null) fallbackBlocked();
    return value;
}

// Nothing read before the await is carried across it. The version id is a string the
// row was drawn with, and the version object itself is looked up again on the persona
// that is active when the write actually happens: the object found before the await
// belongs to the persona the panel opened on, and putting its picks on a different
// persona replaces every one of that persona's variant ids with ids it does not have,
// which empties its composed description.
async function applyVersion(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    // Read before any await, and a string, so it cannot be re-adopted by a redraw.
    const startAvatar = s.avatar;
    if (!versionApplicable(s.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    // A second tap on the row already applied: nothing to write, and the first
    // tap's picture upload is still in flight. With an outside edit pending it
    // is not a no-op, since applying puts the version's text back.
    if (!s.diverged && versionAlreadyApplied(s.persona, versionId) && pictureSettled(s.persona, versionId)) return;
    // Switching version on top of an outside edit throws that edit
    // away, so ask once more instead of doing it quietly.
    if (s.diverged && !(await askConfirm(STRINGS.common.confirmVersionOverOutsideEdit))) return;
    const after = guardStartAvatar(startAvatar);
    if (!after?.persona) return;
    // Asked again of the persona being written to. The avatar matching is necessary
    // and not sufficient: our own data for it can have been rewritten meanwhile.
    if (!versionApplicable(after.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    const version = (after.persona.versions ?? []).find(v => v.id === versionId);
    // Kept so a refused write can be undone. Left in place, the new picks stayed in
    // the live settings, showed the version as applied while the prompt still
    // carried the old text, and went out with the next save of anything at all.
    const previous = { id: after.persona.activeVersionId, picks: after.persona.activePicks };
    after.persona.activeVersionId = version.id;
    after.persona.activePicks = { ...(version.picks ?? {}) };
    // Only when the prompt write was accepted. commit answers false when state.js
    // refuses - a read only root, an unknowable active persona, a persona that
    // moved out from under the screen - and in every one of those cases the
    // version was NOT applied. Overwriting the avatar file anyway puts the
    // picture of a combination on a persona whose prompt does not carry it, and
    // it consumes the one backup that is taken before the first overwrite.
    if (!commit('version-apply', version.name ?? '')) {
        after.persona.activeVersionId = previous.id;
        after.persona.activePicks = previous.picks;
        return;
    }
    // Same rule as the manager's copy: the prompt is committed, the picture
    // follows on its own, and a picture that fails never undoes the version.
    void runBoundImageFromPanel(startAvatar, versionId);
}

/* The one write behind 버전별 페르소나 이미지, shared by both screens.

   Only the SENTENCES differ between the manager and this panel, so only the
   sentences live in the callers. The write itself is here once: it was a copy
   in each file for one round, which in this codebase is how a block starts
   drifting - manager-pure.js still carries a comment about the last time.

   Everything the write touches is re-read AFTER the await, not carried across
   it. applyBoundImage makes three network round trips, and a settings import
   during them installs a whole new root: writing avatarWritten onto the object
   read beforehand would file it under data nothing reads any more. */
export async function runBoundImageWrite(avatarId, versionId, force, known) {
    const before = getRoot();
    if (!before || before.readOnly) return null;
    const first = getPersona(before, avatarId);
    const version = (first?.versions ?? []).find(entry => entry.id === versionId);
    const label = boundAsset(version);
    if (!label) return null;
    // The framing goes with the picture: a stored crop is cut by the server, and
    // what the avatar file now holds is recorded as the label AND the crop.
    const crop = validCrop(version?.avatarCrop);
    const ctx = freshContext();
    if (!ctx) return null;
    const now = Date.now();
    const result = await applyBoundImage({
        ctx, root: before, persona: first, avatarId, label, crop, force, known, now,
    });
    if (!result.ok) {
        /* A failure that still took a backup. The file is ON THE SERVER by then -
           applyBoundImage copies the picture out of the way before it overwrites
           anything, and only the steps after that can fail - so the record has to
           be written here or the picture becomes unreachable: avatarBackup stays
           null so [원본 되돌리기] answers 보관된 원본 없음, and withoutBackups
           hides the file from the asset list, the picker and the prompt. Worse, a
           later apply in a new session finds no record, takes ANOTHER backup, and
           that one holds the picture the first attempt had already replaced.

           avatarWritten is deliberately not touched: nothing was written to the
           avatar file, and claiming otherwise would make the next apply skip. */
        const failed = getRoot();
        const kept = failed && !failed.readOnly ? getPersona(failed, avatarId) : null;
        if (result.backup && kept && !kept.avatarBackup) {
            kept.avatarBackup = result.backup;
            addLog(kept, 'image-apply', result.backup.label, Date.now());
            freshContext()?.saveSettingsDebounced?.();
        }
        return result;
    }
    // The address holds a different picture whatever happens next, so the token
    // is bumped before any of the bookkeeping below can return early.
    bumpThumbnails(avatarId);
    // Read again, because the three round trips above are long enough for the
    // root to have been replaced under us.
    const root = getRoot();
    const persona = root && !root.readOnly ? getPersona(root, avatarId) : null;
    if (!persona) {
        // The picture was written but the record of it cannot be. Said out loud,
        // because a backup was possibly consumed and the next apply will take
        // another one: a silent success here is a lie about what was saved.
        return { ...result, backedUp: !!result.backup, unrecorded: true };
    }
    // The backup record closes the guard that decides whether to take one. Without
    // it every apply takes another, and the second holds the first one's
    // replacement rather than the picture that was there to begin with.
    if (result.backup && !persona.avatarBackup) persona.avatarBackup = result.backup;
    persona.avatarWritten = writtenKey(label, crop);
    // Stamped when the write FINISHED, not when the tap happened: the three
    // round trips above can take seconds on a phone, and an entry dated before
    // edits that actually happened earlier sorts wrongly in the history tab.
    addLog(persona, 'image-apply', label, Date.now());
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
    return { ...result, backedUp: !!result.backup };
}

/* The panel's half. Quieter than the manager's: this screen closes on apply, so
   only a failure is worth a sentence. Success is the picture itself changing. */
async function runBoundImageFromPanel(avatarId, versionId) {
    const result = await runBoundImageWrite(avatarId, versionId, false, null);
    if (!result || result.skipped) return;
    if (result.ok) {
        if (result.unrecorded) notify('warning', STRINGS.manager.imageAppliedUnrecorded);
        return;
    }
    if (result.error === 'missing') { notify('warning', STRINGS.manager.imageAssetMissing(result.detail)); return; }
    if (result.error === 'backup') { notify('error', STRINGS.manager.imageBackupFailed(result.detail)); return; }
    if (result.error === 'decode') { notify('error', STRINGS.manager.framingDecodeFailed(result.detail)); return; }
    notify('error', STRINGS.manager.imageApplyFailed(result.detail ?? result.error));
}

async function saveAsVersion() {
    const s = guardAvatar();
    if (!s?.persona) return;
    // Same rule as applyVersion, milder consequence: the picks written below are read
    // after the await, so a persona change during it leaves a version belonging to
    // nobody on the wrong persona rather than replacing its whole combination.
    const startAvatar = s.avatar;
    const name = await askText(STRINGS.common.newVersionName, '');
    if (!name || !name.trim()) return;
    const after = guardStartAvatar(startAvatar);
    if (!after?.persona) return;
    const uuid = freshContext()?.uuidv4;
    const version = {
        id: typeof uuid === 'function' ? uuid() : `v-${Date.now().toString(36)}`,
        name: name.trim(),
        picks: { ...(after.persona.activePicks ?? {}) },
        // null, not absent: the manager's two constructors both write it, and the
        // asset macros now read it to decide which files a version sends. Leaving
        // it undefined works only for as long as nothing distinguishes the two.
        assetSelection: null,
        avatarAsset: null,
        updatedAt: Date.now(),
    };
    after.persona.versions = [...(after.persona.versions ?? []), version];
    after.persona.activeVersionId = version.id;
    commit('version-create', version.name);
}

function revertOutsideEdit() {
    const s = guardAvatar();
    if (!s?.persona) return;
    // Rewriting the composed text is enough: writeDescription updates lastComposed,
    // which is what made the state look diverged.
    commit('diverge-revert', '');
}

function absorbOutsideEdit() {
    const s = guardAvatar();
    if (!s?.persona) return;
    const text = freshContext()?.powerUserSettings?.persona_descriptions?.[s.avatar]?.description ?? '';
    const sections = s.persona.sections ?? [];
    const last = sections[sections.length - 1];
    const variantId = last ? s.persona.activePicks?.[last.id] : null;
    const variant = last ? (s.persona.variants?.[last.id] ?? []).find(v => v.id === variantId) : null;
    if (!variant) { notify('error', STRINGS.quick.absorbNoItem); return; }
    /* Absorbing puts the WHOLE description into one item, and the description is
       the concatenation of every item. So it is only lossless when that item is
       the only one carrying text: with anything else filled, what those items
       hold is now written twice and every prompt from here on carries it twice.

       Refused rather than absorbed-and-deduplicated, because there is no honest
       way to tell which part of an edit made outside belongs to which item. The
       banner keeps [되돌리기] and the manager is one tap away, so the user still
       has two ways out. */
    const doubled = sections.some(sec => {
        if (sec.id === last.id) return false;
        const pick = s.persona.activePicks?.[sec.id];
        const body = (s.persona.variants?.[sec.id] ?? []).find(v => v.id === pick);
        return !!(body?.text ?? '').trim();
    });
    if (doubled) { notify('warning', STRINGS.quick.absorbNotOnly); return; }
    const now = Date.now();
    // The text we are about to overwrite goes into history first, so absorbing is
    // never the operation that loses something.
    snapshot(s.persona, variantId, variant.text ?? '', now, s.settings);
    // The per variant cap does not bound the total, and the
    // total is what fills settings.json. Taking a snapshot is the only moment the
    // total can grow, so it is the moment to enforce the cap.
    expireOldHistory(s.root, s.settings, now);
    enforceGlobalBudget(s.root, s.settings, now);
    variant.text = text;
    variant.updatedAt = now;
    commit('diverge-absorb', last.name ?? '');
}

// These four write labels or settings, not persona content,
// so they check ambiguous/readOnly directly rather than go through guardAvatar:
// a label or the sort order is not tied to whichever persona the panel happened to
// open on, so a persona change in the background does not bear on whether they may
// proceed.
function rosterWritable(s) {
    return !!s && !s.ambiguous && !s.readOnly;
}

function setSortBy(value) {
    const s = getState();
    if (!rosterWritable(s)) return;
    if (s.root.settings.sortBy === value) return;
    s.root.settings.sortBy = value;
    // A reordered list starts from its first page.
    rosterPage = 1;
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

// Same shape as setSortBy for the same reasons.
function setViewMode(value) {
    const s = getState();
    if (!rosterWritable(s)) return;
    if ((s.root.settings.rosterViewMode ?? 'list') === value) return;
    s.root.settings.rosterViewMode = value;
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

function setActiveLabel(labelId) {
    const s = getState();
    if (!rosterWritable(s)) return;
    if ((s.root.settings.activeLabelId ?? null) === labelId) return;
    s.root.settings.activeLabelId = labelId;
    // The group chips are a filter too, so they restart paging.
    rosterPage = 1;
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

function toggleLabelMembership(labelId, avatarId) {
    const s = getState();
    if (!rosterWritable(s)) return;
    if (!Array.isArray(s.root.labels)) s.root.labels = [];
    const known = personaNames(freshContext());
    const living = label => (label?.members ?? []).filter(id => Object.hasOwn(known, id)).length;
    const label = s.root.labels.find(entry => entry.id === labelId);
    const before = living(label);
    toggleMember(s.root.labels, labelId, avatarId);
    freshContext()?.saveSettingsDebounced?.();
    /* The tapped checkbox already shows the new state, and no row shows its
       groups. Only two things elsewhere depend on it: a list filtered by a group
       (the persona may have to leave it), and a group's chip, which turns on with
       its first living member and off with its last. Anything else drew the whole
       panel to show one tick the browser had already drawn. */
    const filtering = (s.root.settings?.activeLabelId ?? null) !== null;
    if (filtering || (before === 0) !== (living(label) === 0)) scheduleDraw();
}

/* 그룹 편집: a row tap opens that persona's group ticks under it. The editor
   moves from one row to another; nothing else changes. Text typed into the new
   group field of the editor being closed goes through the full draw, which is the
   path that carries typing across a rebuild. */
function toggleEditRow(avatarId) {
    expandedAvatar = expandedAvatar === avatarId ? null : avatarId;
    if (!placeLabelEditor()) scheduleDraw();
}

function placeLabelEditor() {
    if (!inPlaceAllowed()) return false;
    const list = document.getElementById(PANEL_ID)?.querySelector('[data-pm-roster-list]');
    if (!list) return false;
    const old = list.querySelector('.pm-quickbar-labeleditor');
    if (old?.querySelector('.pm-quickbar-newlabel-input')?.value) return false;
    if (expandedAvatar === null) { old?.remove(); return true; }
    const row = [...list.querySelectorAll('.pm-quickbar-row[data-pm-avatar]')]
        .find(node => node.dataset.pmAvatar === expandedAvatar);
    if (!row) return false;
    const s = getState();
    old?.remove();
    row.after(labelEditor(s, expandedAvatar, rosterWritable(s)));
    return true;
}

function createLabel(name, avatarId) {
    const s = getState();
    if (!rosterWritable(s)) return;
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return;
    const uuid = freshContext()?.uuidv4;
    const id = typeof uuid === 'function' ? uuid() : `pm-label-${Date.now().toString(36)}`;
    if (!Array.isArray(s.root.labels)) s.root.labels = [];
    s.root.labels.push({ id, name: trimmed, members: [] });
    // Creating a label from this input immediately attaches it to
    // the persona whose row was open, so the user never sees a label that was just
    // made with nothing in it.
    toggleMember(s.root.labels, id, avatarId);
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

// Exported for the manager's 언어별 이름 [적용]: after renaming the persona in
// SillyTavern's own map, name1 still holds the old name, and name1 is what the
// chat and {{user}} read. Re-selecting the persona by its new name is what makes
// SillyTavern pick the change up, and this is the one path in the extension that
// has been measured to do it.
//
// closeOnDone is false for the automatic rename: that one can land while the user
// has the panel open and is reading it, and a panel that shuts by itself because
// a message arrived is a worse surprise than the rename it is reporting.
// Bumped by every switchPersona call. A call whose number is no longer the
// current one has been overtaken and stops talking.
let switchSeq = 0;

/* quiet is for the automatic rename and for nothing else.

   That rule is documented as "this one happens by itself and has to stay quiet",
   and it was true of runAutoName's own code and false of everything it called: a
   switch that did not land toasts an error from in here, and an ambiguous landing
   toasts a warning. So a persona whose chat language kept flipping put a red
   failure on screen after character messages the user had not acted on at all.
   The result is still returned, and the caller still decides what to say. */
export async function switchPersona(avatar, name, { closeOnDone = true, quiet = false } = {}) {
    /* Who started last wins. Nothing here lands in one frame - every path is an
       await on a slash command followed by a poll - and the panel stays open with
       no sign that anything is happening, so a switch that feels slow gets tapped
       again. Two of these then ran side by side: the second landed, and the first,
       still polling for a name that had stopped being current, ran its retry and
       pulled the user back to the persona they had just left. A superseded call
       stops where it stands. It does not retry, does not report a failure that
       belongs to nobody, and does not close a panel the live switch is using. */
    const my = ++switchSeq;
    const current = () => my === switchSeq;
    const say = (kind, message) => { if (!quiet) notify(kind, message); };
    /* Read now, not taken from the argument. The name in a row's handler is the
       one that row was DRAWN with, and a draw deferred behind a focused search
       field can outlive a rename: the row then asks to land on a name nobody
       carries any more, waits three turns for it, and calls a switch that worked
       a failure. The argument stays as the fallback for a persona the map has
       forgotten, which is the case where there is nothing fresher to read. */
    const wanted = freshContext()?.powerUserSettings?.personas?.[avatar] ?? name;
    // Every name1 read below is a new context. The old snapshot comment here said the
    // same thing as a local rule; the rule is now the structure of the whole module.
    // closeOnDone is honoured here too. It used to close unconditionally, so the
    // automatic rename - which calls this with closeOnDone false, through the
    // rename path - could shut the panel the user was reading whenever the name
    // happened to have landed already.
    if (freshContext()?.name1 === wanted && (getState()?.avatar ?? null) === avatar) {
        if (closeOnDone) closePanel();
        return true;
    }

    const finish = () => {
        // Verified by name only. With duplicate names the invariant in ctx.js still
        // cannot say which avatar we landed on, so we say that rather than imply
        // more certainty than we have.
        // Landed, and that much is observed however this call ended up. What a
        // superseded call must not do is talk about it or close the panel the
        // switch that overtook it is still working in.
        if (!current()) return true;
        if ((getState()?.duplicateNames ?? []).includes(wanted)) {
            say('warning', STRINGS.quick.switchAmbiguous(wanted));
        }
        if (closeOnDone) closePanel();
        return true;
    };

    // Every attempt below is judged by this, never by reading name1 on the line after
    // the await. SillyTavern finishes the swap after the command resolves, so the
    // synchronous read reports a failure that did not happen, and the retry it
    // triggers is the mode argument whose allowed values were never measured.
    const landed = () => waitFor(() => freshContext()?.name1 === wanted);

    /* The precise path is a bonus, and it stayed a bonus only
       because the import was looking one directory too high. 0.1.6 corrected the
       depth and the device answered: 페르소나 식별: 정밀 (파일 직접). So this is
       now the FIRST thing tried and it switches by FILE.

       That matters here more than anywhere else. Everything below resolves a
       persona by NAME, which is what failed on the device when a rename and a
       switch were asked for together: the command was told to find a name that the
       machinery had not been told about yet. setUserAvatar has no such problem.

       Still guarded, and still followed by the same landed() check: a build that
       does not export it falls through to the commands exactly as before. */
    const api = getPreciseApi();
    if (api && typeof api.setUserAvatar === 'function') {
        try { await api.setUserAvatar(avatar); } catch (e) { console.warn(`[${MODULE_NAME}] setUserAvatar failed`, e); }
        if (await landed()) return finish();
        if (!current()) return false;
    }

    // The command name is discovered, never hardcoded: the plan
    // hardcoded /persona-set-name, which does not exist on this build, and only
    // measuring on the phone caught it.
    const command = pickPersonaCommand(freshContext()?.SlashCommandParser?.commands);
    if (!command) {
        say('error', STRINGS.quick.noSwitchCommand);
        return false;
    }
    const run = async text => {
        // Read at the moment of the call: the previous command may have changed the
        // chat, and SillyTavern hands out a different object once it has.
        try { await freshContext()?.executeSlashCommandsWithOptions(text); }
        catch (e) { console.warn(`[${MODULE_NAME}] ${text} failed`, e); }
    };

    // The allowed values of the named mode argument were never measured, so the
    // first attempt omits it and the result is checked instead of assumed.
    await run(`/${command} ${quoteArg(wanted)}`);
    if (await landed()) return finish();
    if (!current()) return false;
    await run(`/${command} mode=lookup ${quoteArg(wanted)}`);
    if (await landed()) return finish();
    if (!current()) return false;

    // Never report a success we did not observe, and never report a failure we did
    // not observe either: both waits above have expired by the time we get here.
    say('error', STRINGS.quick.switchFailed(wanted));
    return false;
}

/* ── Persona names ───────────────────────────────────────────────────────────
   One rename path, used by the manager's [적용] and by the automatic rule below.
   Both halves matter: the map is what the roster and every other extension read,
   and name1 is what the chat prints and what {{user}} resolves to. Writing only
   the first is what the device reported as 설정해도 채팅에 적용되지 않음.

   Answers {ok, reason} instead of throwing or toasting, because the two callers
   want to say different things about the same failure: one is a button the user
   just pressed, the other happens by itself and has to stay quiet. */
/* SillyTavern's own rename, which is what this should have used from the start.
   접점 진단 5 measured the command and its arguments:

       /persona-update  named[persona, name, description, title, avatar, ...]

   The first version wrote power_user.personas[avatar] by hand and then ran
   /persona-set to make the chat follow. That failed on the device with 전환 실패,
   and the reason is visible from here: a rename is not a write to one map. It is
   whatever SillyTavern does when a persona is renamed, and /persona-set resolves
   a NAME, so it was being asked to find a name through machinery that had not
   been told the rename happened.

   Verified rather than assumed: the map has to come back carrying the new name,
   and for the persona being played, name1 has to follow. */
async function renameThroughSillyTavern(avatar, from, to, toChat, quiet) {
    const commands = freshContext()?.SlashCommandParser?.commands;
    const command = PERSONA_UPDATE_COMMANDS.find(
        name => commands && Object.hasOwn(commands, name) && commands[name]);
    if (!command) return { ok: false, reason: 'no-command' };
    try {
        await freshContext()?.executeSlashCommandsWithOptions(
            `/${command} persona=${quoteArg(from)} name=${quoteArg(to)}`);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] ${command} failed`, e);
    }
    // SillyTavern finishes after the command resolves, the same way it does for a
    // switch, so this waits for the answer rather than reading the next line.
    const renamed = await waitFor(
        () => freshContext()?.powerUserSettings?.personas?.[avatar] === to);
    if (!renamed) return { ok: false, reason: 'not-renamed' };
    if (!toChat) return { ok: true, reason: 'listed' };
    // For the persona being played, SillyTavern's own rename should carry name1
    // with it. Should is not a measurement, so it is checked, and the switch is
    // only run when it did not.
    if (await waitFor(() => freshContext()?.name1 === to)) return { ok: true, reason: 'applied' };
    /* The rename itself is done and the map carries the new name. All that is
       left is making the chat follow, and the only way to do that is a persona
       switch - so it must not run for a persona the user has meanwhile moved off.
       The automatic rename reaches this line by itself, quietly, on a timer after
       a character message: without this check it took a user who had just chosen
       another persona and put them back on the previous one with nothing on
       screen to say why. Nothing is owed to a persona that is no longer playing. */
    if ((getState()?.avatar ?? null) !== avatar) return { ok: true, reason: 'listed' };
    return (await switchPersona(avatar, to, { closeOnDone: false, quiet }))
        ? { ok: true, reason: 'applied' }
        : { ok: false, reason: 'switch-failed' };
}

const PERSONA_UPDATE_COMMANDS = Object.freeze(['persona-update']);

export async function applyPersonaName(avatar, name, { closeOnDone = true, toChat = true, quiet = false } = {}) {
    const ctx = freshContext();
    const personas = ctx?.powerUserSettings?.personas;
    if (!personas || !Object.hasOwn(personas, avatar)) return { ok: false, reason: 'unknown' };
    const previous = personas[avatar];
    if (previous === name) return { ok: true, reason: 'same' };
    // The duplicate name rule again, checked here as well as in the pure decision:
    // this function is also reached from a button, and the two must refuse alike.
    for (const [key, other] of Object.entries(personas)) {
        if (key !== avatar && other === name) return { ok: false, reason: 'taken' };
    }
    /* SillyTavern's own rename does the WHOLE job, which is what makes it right
       for the chat scope and wrong for the list scope. Asked to rename the persona
       being played, it carries name1 along with the map - and the list scope is
       the request to leave name1 exactly where it is. So the command is used only
       where its thoroughness is the point; the list scope writes the one map entry
       it was asked to write and nothing else. */
    if (toChat) {
        const own = await renameThroughSillyTavern(avatar, previous, name, toChat, quiet);
        if (own.ok) return { ...own, previous };
        if (own.reason === 'switch-failed') return { ok: false, reason: 'switch-failed', previous };
    }

    // Fallback: write the map ourselves. Kept because /persona-update's ARGUMENTS
    // are measured but its behaviour is not, and a build where it does nothing
    // would otherwise leave the user with a button that never works.
    personas[avatar] = name;
    ctx.saveSettingsDebounced();
    // The map is the whole job for a persona that is not the one being played.
    // Re-selecting there would SWITCH the user's active persona to it, which is
    // what this function used to do to anybody who renamed a background persona
    // from the manager: they asked for a name and got a persona switch.
    if (!toChat) return { ok: true, reason: 'listed', previous };
    // The check renameThroughSillyTavern makes, on the path that reaches the same
    // switch without going through it.
    if ((getState()?.avatar ?? null) !== avatar) return { ok: true, reason: 'listed', previous };
    const landed = await switchPersona(avatar, name, { closeOnDone, quiet });
    if (landed) return { ok: true, reason: 'applied', previous };
    // Put it back. A map that says one thing while the chat says another is worse
    // than a rename that did not happen, and the caller can only report the
    // failure honestly if the state is unchanged when it does.
    const back = freshContext()?.powerUserSettings?.personas;
    if (back && back[avatar] === name) back[avatar] = previous;
    freshContext()?.saveSettingsDebounced?.();
    return { ok: false, reason: 'switch-failed', previous };
}

/* 언어별 이름 자동 적용 (user request). The chat's language decides, and the
   decision itself is pure (pickAutoName) so the rule can be tested without a
   SillyTavern to rename in.

   Debounced rather than run per event: a rendered message, a settings save and a
   persona update all arrive within a beat of each other, and this ends in a
   persona switch. Off unless the user turned it on. */
let autoNameTimer = 0;
// Bumped by cancelAutoName. A run holding an older number has been called off.
let autoNameGen = 0;

export function scheduleAutoName() {
    if (!getRoot()?.settings?.autoLocalName) return;
    if (autoNameTimer) clearTimeout(autoNameTimer);
    autoNameTimer = setTimeout(() => { autoNameTimer = 0; runAutoName(); }, 1500);
}

export function cancelAutoName() {
    if (autoNameTimer) clearTimeout(autoNameTimer);
    autoNameTimer = 0;
    /* And the run already under way. Clearing the timer only ever cancelled a
       rename that had not started; one that was inside its slash command carried
       on past a teardown and came back to log a line and toast into a panel that
       no longer existed. The work cannot be recalled once the command is out, but
       everything after it - the log line, the save, the message - belongs to a
       feature that has been switched off, and none of it is written now. */
    autoNameGen += 1;
}

// One at a time. This awaits a persona switch, and the events that schedule it
// arrive in bursts, so without the flag a second run can start while the first
// is between writing the map and verifying name1: two renames racing over one
// persona, with the loser's rollback undoing the winner's write.
let autoNameRunning = false;

async function runAutoName() {
    if (autoNameRunning) return;
    const root = getRoot();
    if (!root || root.readOnly || !root.settings?.autoLocalName) return;
    const s = getState();
    // ambiguous is the unknowable active persona. Renaming there
    // would be renaming whichever of two personas we guessed at.
    if (!s || s.ambiguous || !s.avatar || !s.persona) return;
    const ctx = freshContext();
    const lang = chatLanguage(ctx?.chat);
    const name = pickAutoName({
        persona: s.persona,
        lang,
        avatar: s.avatar,
        personas: ctx?.powerUserSettings?.personas,
    });
    if (!name) return;
    // The user's concern about 동명이인, applied where nobody is watching: a
    // button can warn and let them decide, an automatic rule has nobody to ask,
    // so it declines. The screen says so where the names are.
    if (nameCollides({ name, characterName: ctx?.name2, chat: ctx?.chat })) return;
    const avatar = s.avatar;
    const gen = autoNameGen;
    autoNameRunning = true;
    let result;
    try {
        result = await applyPersonaName(avatar, name, { closeOnDone: false, quiet: true });
    } finally {
        // In a finally, so a throw anywhere in the switch does not leave this
        // feature switched off for the rest of the session.
        autoNameRunning = false;
    }
    if (!result?.ok) return;
    // Called off while the command was out. See cancelAutoName.
    if (gen !== autoNameGen) return;
    // Something changed the persona, so the log says what and why.
    // A rename nobody asked for and nothing recorded is the shape of a bug report
    // that cannot be answered.
    const persona = getPersona(getRoot(), avatar);
    if (persona) {
        addLog(persona, 'name-auto', `${STRINGS.common.languageNames[lang] ?? lang}: ${name}`, Date.now());
        freshContext()?.saveSettingsDebounced?.();
    }
    notify('info', STRINGS.quick.autoNameApplied(name));
}

/* Panel content */

// 관리 시작 from this panel. When the description was split into items by its
// titles, that is said once: the panel shows no items, and a description that
// went in as thirteen parts should not have to be discovered in the manager.
function adoptHere() {
    // A second tap, or a tap on a row drawn before the first one landed, finds the
    // persona already managed: nothing was imported, so nothing is announced.
    if (getState()?.persona) { scheduleDraw(); return; }
    const s = adopt();
    const count = itemsWithText(s?.persona);
    if (count > 1) notify('success', STRINGS.common.adoptSplit(count));
}

function groupOf(title) {
    const box = el('div', 'pm-quickbar-group');
    box.append(el('div', 'pm-quickbar-head', title));
    return box;
}

function rowOf(text, onClick) {
    const row = el('div', 'pm-row pm-quickbar-row');
    row.append(el('span', 'pm-quickbar-name', text));
    if (onClick) makeRowActivatable(row, onClick);
    else row.classList.add('pm-disabled');
    return row;
}

function checkMark(active) {
    // Hover carries no meaning on a touch screen, so the mark is
    // always drawn and only its content changes.
    return el('span', 'pm-check', active ? '✓' : '');
}

// Matches the manager's emptyOf: an empty list gets the asterisk and the negation
// at size rather than a grey line in the corner (style.css, "Empty states").
function emptyBlock(text) {
    const box = el('div', 'pm-empty');
    const mark = el('div', 'pm-empty-mark', '✳');
    // The word underneath carries the meaning; the glyph is the reference's
    // divider doing duty as a graphic, so it is not announced.
    mark.setAttribute('aria-hidden', 'true');
    box.append(mark);
    box.append(el('div', 'pm-empty-text', text));
    return box;
}

// pm-mass, because a banner IS a filled ink block: it already draws --pm-mass
// under --pm-on-mass type. The inversion that keeps a control readable on such a
// block is scoped to that class, and without it in the markup the banner's own
// buttons drew ink on ink and disappeared.
function bannerOf(className, message) {
    const box = el('div', `pm-quickbar-banner pm-mass ${className}`);
    box.append(el('div', 'pm-quickbar-banner-text', message));
    return box;
}

function divergedBanner(writable) {
    const box = bannerOf('pm-quickbar-warn', STRINGS.quick.divergedBanner);
    const actions = el('div', 'pm-quickbar-actions');
    const handlers = {
        revert: () => revertOutsideEdit(),
        absorb: () => absorbOutsideEdit(),
        later: () => { bannerDismissed = true; scheduleDraw(); },
    };
    // Gated here, where the other writing controls are gated, and not inside the save
    // that follows. 가져오기 overwrites the variant text before it ever reaches state.js,
    // so a refusal down there leaves the overwrite sitting in the live
    // extensionSettings for SillyTavern to persist on its own next save.
    for (const action of divergedActions(writable)) {
        const btn = el('button', 'pm-quickbar-btn', action.label);
        if (action.enabled) btn.addEventListener('click', handlers[action.key]);
        else { btn.disabled = true; btn.classList.add('pm-disabled'); }
        actions.append(btn);
    }
    box.append(actions);
    return box;
}

function currentGroup(ctx, s) {
    // The quick panel's one solid shape, same treatment as the manager header:
    // the current persona is what this panel is about, so it is what gets drawn as
    // the mass. See style.css, "The liquid edge".
    const box = groupOf(STRINGS.quick.headCurrent);
    box.classList.add('pm-mass');
    const name = personaNames(ctx)[s.avatar] ?? ctx?.name1 ?? STRINGS.quick.unknownName;
    box.append(el('div', 'pm-quickbar-current', `${name}${STRINGS.common.dotSeparator}${describeSelection(s.persona)}`));
    if (s.persona) {
        // A section that fell out of the prompt has to be visible here.
        const missing = compose(s.persona).missing;
        if (missing.length) box.append(el('div', 'pm-quickbar-note', STRINGS.common.emptyItems(missing.length)));
    }
    return box;
}

/* 버전 접기 (user request). The panel is opened to switch a persona, and the
   version list was standing between the header and the persona list at full
   height even when it had nothing in it: 253px of a 388px wide panel, of which
   143px was the empty block saying there were no versions.

   The open state is a preference, so it is kept in settings and survives the
   panel closing. The override exists for the one case settings cannot serve: a
   root nobody may write to still has to be foldable, because folding is a way of
   looking at the panel rather than a change to anything in it. */
let versionOpenOverride = null;

function versionOpen(s) {
    if (versionOpenOverride !== null) return versionOpenOverride;
    return !!s?.root?.settings?.quickVersionOpen;
}

/* ── One group or one row, redrawn in place (user request) ──────────────────
   Folding a group, opening a version's [⋯] and ticking a persona in select mode
   each change one part of the panel, and each rebuilt all of it: every group, the
   twenty-row list and its pictures (measured 4 to 7ms per tap on the desktop,
   an estimated four to eight times that on the phone). The fold and [⋯] now
   rebuild their own group, and a tick changes the ticked row's mark and the count.
   A full draw already queued, a field being typed in, or the active persona having
   moved since the panel was drawn all take the full draw instead. */
const groupNodes = new Map();

function liveGroupArgs() {
    const s = getState();
    return [s, rosterWritable(s)];
}

function inPlaceAllowed() {
    if (drawFrame || drawDeferred) return false;
    const s = getState();
    return !!s && s.avatar === panelAvatar;
}

function redrawGroup(name) {
    if (!inPlaceAllowed()) return false;
    const entry = groupNodes.get(name);
    if (!entry || !entry.node.isConnected) return false;
    const fresh = entry.build();
    entry.node.replaceWith(fresh);
    entry.node = fresh;
    return true;
}

function markSelection(avatarId) {
    if (!inPlaceAllowed()) return false;
    const panel = document.getElementById(PANEL_ID);
    const nodes = [...(panel?.querySelectorAll('[data-pm-avatar]') ?? [])].filter(node => node.dataset.pmAvatar === avatarId);
    if (!nodes.length) return false;
    const picked = selectedAvatars.includes(avatarId);
    for (const node of nodes) {
        node.classList.toggle('pm-picked', picked);
        node.setAttribute('aria-checked', picked ? 'true' : 'false');
    }
    const count = panel.querySelector('.pm-quickbar-bulkcount');
    if (count) count.textContent = STRINGS.quick.selectedCount(selectedAvatars.length);
    // The 전체 선택 / 선택 해제 label follows what is picked on screen.
    publishVisible(rosterVisible);
    return true;
}

function toggleVersionOpen() {
    const s = getState();
    const next = !versionOpen(s);
    if (rosterWritable(s)) {
        s.root.settings.quickVersionOpen = next;
        // The setting is the truth again, so the override must not shadow it.
        versionOpenOverride = null;
        // No save of its own. A fold is a way of looking, and a save is every
        // extension's settings serialized and posted (several MB here); the
        // value rides along with the next save anything makes.
    } else {
        versionOpenOverride = next;
    }
    if (!redrawGroup('version')) scheduleDraw();
}

/* The same mark the manager folds with, so the two screens fold alike.

   The title is the SAME span the roster head carries, in the same kind of head,
   and the head itself is the control. It used to be a button wrapping the title,
   and a button brings its own box: the title sat two pixels above where the title
   next to it sits, and the gap grew with the theme's font size, so the two
   headings could not be made to line up by any fixed number. Two headings that
   should share a rule now share the structure that produces it. */
function foldHead(title, open, onToggle) {
    const head = el('div', 'pm-quickbar-head pm-quickbar-foldhead');
    head.append(el('span', 'pm-quickbar-headlabel', title));
    head.append(el('span', 'pm-quickbar-foldmark', open ? '↑' : '↗'));
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.addEventListener('click', onToggle);
    // What the button gave for free and a div has to be given. Space scrolls the
    // page otherwise, which on a panel this size is the whole screen moving.
    head.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
    });
    return head;
}

function versionGroup(s, writable) {
    const box = el('div', 'pm-quickbar-group');
    const open = versionOpen(s);
    box.append(foldHead(STRINGS.quick.headVersion, open, toggleVersionOpen));
    if (!open) return box;
    if (!s.persona) {
        box.append(rowOf(STRINGS.quick.adoptRow, writable ? () => { adoptHere(); scheduleDraw(); } : null));
        return box;
    }
    const versions = s.persona.versions ?? [];
    if (!versions.length) box.append(emptyBlock(STRINGS.quick.noVersions));
    versions.forEach((version, index) => {
        if (!version || typeof version !== 'object') return;
        const open = versionToolsOpen(s, version.id);
        // The row and [⋯] are siblings, not a button inside a button: a keypress
        // on the inner one would bubble into the row's Enter handler and apply
        // the version the user only meant to open tools for.
        const line = el('div', `pm-quickbar-vrow${open ? ' pm-quickbar-vrow-open' : ''}`);
        const row = rowOf(version.name ?? '', writable ? () => { if (!rowTapTooSoon()) applyVersion(version.id); } : null);
        row.append(checkMark(version.id === s.persona.activeVersionId));
        line.append(row);
        line.append(versionMoreButton(version, open, writable));
        box.append(line);
        if (open) box.append(versionTools(version, index, versions.length, writable));
    });
    box.append(rowOf(STRINGS.quick.saveCurrentAsVersion, writable ? () => saveAsVersion() : null));
    return box;
}

/* ── 버전 이름 변경·삭제, 빠른 패널판 (user request) ─────────────────────────
   The manager had every version write and this panel had only 적용 and 저장, so
   renaming or deleting a version meant leaving the chat for the manager's 버전
   tab. [⋯] on a row opens that row's tools in place, as real buttons under the
   row: askChoiceIndex would ask for a typed digit, the slowest way to pick one of
   six on a phone keyboard. One row at a time, and only on the persona it was
   opened for, so a persona switch never shows tools for a stranger's version. */
let versionToolsAt = null;

/* 복제, 위로 이동 and 아래로 이동 redraw the list with the tools in a new place,
   and the place the finger just tapped now holds another version's row. A quick
   second tap - the double tap this user makes - applied that version. A row tap
   that arrives this soon after a tool is taken as the tool's second tap.
   Android's own double tap timeout is 300ms; 500 covers a slow second tap. */
const TOOL_SETTLE_MS = 500;
let toolTappedAt = 0;

function rowTapTooSoon() {
    return Date.now() - toolTappedAt < TOOL_SETTLE_MS;
}

function versionToolsOpen(s, versionId) {
    return versionToolsAt !== null && versionToolsAt.avatar === s?.avatar && versionToolsAt.id === versionId;
}

function toggleVersionTools(versionId) {
    const s = getState();
    versionToolsAt = versionToolsOpen(s, versionId) ? null : { avatar: s?.avatar ?? null, id: versionId };
    if (!redrawGroup('version')) scheduleDraw();
}

function versionMoreButton(version, open, writable) {
    const btn = el('button', 'pm-quickbar-btn pm-quickbar-vmore', '⋯');
    btn.type = 'button';
    btn.setAttribute('aria-label', STRINGS.quick.versionToolsAria(version.name ?? ''));
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (writable) btn.addEventListener('click', () => toggleVersionTools(version.id));
    else { btn.disabled = true; btn.classList.add('pm-disabled'); }
    return btn;
}

function versionTools(version, index, count, writable) {
    const bar = el('div', 'pm-manager-actions pm-quickbar-vtools');
    const atTop = index === 0;
    const atEnd = index === count - 1;
    for (const [label, action, enabled, danger] of [
        [STRINGS.common.rename, () => renameVersionFromPanel(version.id), true, false],
        [STRINGS.manager.overwrite, () => overwriteVersionFromPanel(version.id), true, false],
        [STRINGS.common.duplicate, () => duplicateVersionFromPanel(version.id), true, false],
        [STRINGS.manager.moveUp, () => shiftVersionFromPanel(version.id, -1), !atTop, false],
        [STRINGS.manager.moveDown, () => shiftVersionFromPanel(version.id, 1), !atEnd, false],
        [STRINGS.common.remove, () => dropVersionFromPanel(version.id), true, true],
    ]) {
        const btn = el('button', `pm-quickbar-btn${danger ? ' pm-manager-danger' : ''}`, label);
        btn.type = 'button';
        const run = () => { toolTappedAt = Date.now(); action(); };
        if (writable && enabled) btn.addEventListener('click', run);
        else { btn.disabled = true; btn.classList.add('pm-disabled'); }
        bar.append(btn);
    }
    return bar;
}

function versionNamed(persona, versionId) {
    return (persona?.versions ?? []).find(entry => entry?.id === versionId) ?? null;
}

// Each write reads the version again on the persona that is active AFTER its
// question, by the id the row was drawn with (see applyVersion below).
async function renameVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const startAvatar = s.avatar;
    const name = await askText(STRINGS.manager.versionName, versionNamed(s.persona, versionId)?.name ?? '');
    if (!name || !name.trim()) return;
    const after = guardStartAvatar(startAvatar);
    if (!after?.persona) return;
    const version = renameVersionIn(after.persona, versionId, name, Date.now());
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-rename', version.name);
}

async function overwriteVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const startAvatar = s.avatar;
    const name = versionNamed(s.persona, versionId)?.name ?? '';
    if (!(await askConfirm(STRINGS.manager.confirmOverwriteVersion(name)))) return;
    const after = guardStartAvatar(startAvatar);
    if (!after?.persona) return;
    const version = overwriteVersionPicks(after.persona, versionId, Date.now());
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-overwrite', version.name ?? '');
}

function duplicateVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const uuid = freshContext()?.uuidv4;
    const copy = duplicateVersionIn(s.persona, versionId, () => makeId(uuid), Date.now());
    if (!copy) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    // The tools move to the copy: a duplicate is made to be renamed or changed,
    // and that is the next tap.
    versionToolsAt = { avatar: s.avatar, id: copy.id };
    commit('version-duplicate', copy.name);
}

function shiftVersionFromPanel(versionId, delta) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const name = versionNamed(s.persona, versionId)?.name ?? '';
    if (!moveVersion(s.persona, versionId, delta)) return;
    commit('version-move', name);
}

async function dropVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const startAvatar = s.avatar;
    const name = versionNamed(s.persona, versionId)?.name ?? '';
    if (!(await askConfirm(STRINGS.manager.confirmDropVersion(name)))) return;
    const after = guardStartAvatar(startAvatar);
    if (!after?.persona) return;
    if (!dropVersionFrom(after.persona, versionId)) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    versionToolsAt = null;
    commit('version-delete', name);
}

/* ── 언어별 이름, 빠른 패널판 (user request) ─────────────────────────────────
   The manager's version of this screen has to offer a scope: it can be looking at
   any persona, and for one that is NOT being played the only legal scope is the
   list. This panel is never looking at any other persona than the one being
   played, and for that one the list-only scope is forbidden outright: the
   extension identifies the active persona by personas[avatar] === name1, so
   renaming one half alone leaves it unable to say who is active. So there is
   nothing here to choose between, and the simpler screen is not a reduction of the
   manager's - it is what is left when the choice that does not exist is removed.

   A language, the name registered for it, a tick on the one in use. One tap. */
const NAME_LANGUAGES = Object.freeze(['ko', 'ja', 'zh', 'en']);

let namesOpenOverride = null;

function namesOpen(s) {
    if (namesOpenOverride !== null) return namesOpenOverride;
    return !!s?.root?.settings?.quickNamesOpen;
}

function toggleNamesOpen() {
    const s = getState();
    const next = !namesOpen(s);
    if (rosterWritable(s)) {
        s.root.settings.quickNamesOpen = next;
        namesOpenOverride = null;
        // No save of its own. A fold is a way of looking, and a save is every
        // extension's settings serialized and posted (several MB here); the
        // value rides along with the next save anything makes.
    } else {
        namesOpenOverride = next;
    }
    if (!redrawGroup('names')) scheduleDraw();
}

function toggleAutoName() {
    const s = getState();
    if (!rosterWritable(s)) { notify('error', STRINGS.quick.namesNeedWritable); return; }
    s.root.settings.autoLocalName = !s.root.settings.autoLocalName;
    freshContext()?.saveSettingsDebounced?.();
    // Turning it ON should act on the chat that is already there rather than wait
    // for the next message; turning it off must cancel whatever was queued.
    if (s.root.settings.autoLocalName) scheduleAutoName();
    else cancelAutoName();
    scheduleDraw();
}

/* One tap applies. No confirmation for the ordinary case: the panel's other rows
   (a version, a persona) apply on a tap too, this is undone by tapping another
   language, and every one of them is written to the log. The one case that does
   ask is a name the chat already has somebody else using, because that is the
   thing the user cannot see from here and cannot undo by tapping. */
/* One at a time, the way runAutoName already guards itself. These rows sit in a
   list under 언어별 이름 and each one takes a slash command and two polls to
   finish, with nothing on the panel to say a tap was received. A second row
   tapped in that gap renamed the same persona twice over, and the first call -
   still waiting for the name IT asked for - then went looking for a name the
   second had already replaced.

   The flag is taken here rather than inside, because the confirmation for a
   clashing name is an await too and the gap it opens is the longest of them. In
   a finally, so a throw does not switch the rows off for the rest of the
   session. */
let nameApplyRunning = false;

async function applyLocalName(lang, name) {
    if (nameApplyRunning) return;
    nameApplyRunning = true;
    try { await applyLocalNameNow(lang, name); } finally { nameApplyRunning = false; }
}

async function applyLocalNameNow(lang, name) {
    const s = getState();
    if (!s || !s.avatar) { notify('error', STRINGS.common.personaChanged); return; }
    if (!rosterWritable(s)) { notify('error', STRINGS.quick.namesNeedWritable); return; }
    const startAvatar = s.avatar;
    const ctx = freshContext();
    if ((ctx?.powerUserSettings?.personas?.[startAvatar] ?? '') === name) {
        notify('info', STRINGS.manager.nothingChanged);
        return;
    }
    const clash = nameCollides({ name, characterName: ctx?.name2, chat: ctx?.chat });
    if (clash && !(await askConfirm(STRINGS.quick.confirmNameClash(name, clash)))) return;
    // The question above is an await, and the persona being played can move under
    // it. Renaming then would rename whoever is active NOW to a name chosen for
    // somebody else.
    if ((getState()?.avatar ?? null) !== startAvatar) {
        notify('error', STRINGS.common.personaChanged);
        return;
    }
    const result = await applyPersonaName(startAvatar, name, { closeOnDone: false, toChat: true });
    if (!result?.ok) {
        notify('error', result?.reason === 'taken'
            ? STRINGS.manager.localNameTaken
            : STRINGS.manager.localNameApplyFailed);
        scheduleDraw();
        return;
    }
    // A persona changed, so its own record says what and why.
    const persona = getPersona(getRoot(), startAvatar);
    if (persona) {
        addLog(persona, 'name-apply', `${STRINGS.common.languageNames[lang] ?? lang}: ${name}`, Date.now());
        freshContext()?.saveSettingsDebounced?.();
    }
    notify('info', STRINGS.manager.localNameApplied(name));
    scheduleDraw();
}

function namesGroup(s, writable) {
    const box = el('div', 'pm-quickbar-group');
    const open = namesOpen(s);
    box.append(foldHead(STRINGS.quick.headNames, open, toggleNamesOpen));
    if (!open) return box;
    if (!s.persona) {
        box.append(rowOf(STRINGS.quick.adoptRow, writable ? () => { adoptHere(); scheduleDraw(); } : null));
        return box;
    }
    const current = freshContext()?.powerUserSettings?.personas?.[s.avatar] ?? '';
    const names = s.persona.names ?? {};
    const listed = NAME_LANGUAGES
        .map(lang => ({ lang, name: String(names[lang] ?? '').trim() }))
        .filter(entry => entry.name);
    if (!listed.length) {
        box.append(emptyBlock(STRINGS.quick.noLocalNames));
        // The empty state names what is missing and puts the way to fix it under
        // it, rather than describing what would appear here one day.
        box.append(rowOf(STRINGS.quick.localNamesElsewhere, () => {
            const detail = { tab: 'compose', search: false, handled: false };
            document.dispatchEvent(new CustomEvent('pm:open-manager', { detail }));
            if (!detail.handled) notify('info', STRINGS.quick.managerMissing);
        }));
        return box;
    }
    for (const entry of listed) {
        const row = el('div', 'pm-row pm-quickbar-row pm-quickbar-namerow');
        row.append(el('span', 'pm-quickbar-lang', STRINGS.common.languageNames[entry.lang] ?? entry.lang));
        row.append(el('span', 'pm-quickbar-name', entry.name));
        row.append(checkMark(entry.name === current));
        if (writable) makeRowActivatable(row, () => applyLocalName(entry.lang, entry.name));
        else row.classList.add('pm-disabled');
        box.append(row);
    }
    const auto = rowOf(STRINGS.quick.autoNameRow, writable ? () => toggleAutoName() : null);
    auto.append(checkMark(!!s.settings?.autoLocalName));
    box.append(auto);
    return box;
}

// The per section pick selects are gone from this panel. The
// panel is for switching personas and versions fast; swapping one section's
// choice lives in the manager's 편집 tab, where the section is on screen with
// its choices. (This is where sectionGroup used to be.)

function sortSelect(sortBy, writable) {
    const select = el('select', 'pm-quickbar-sort');
    for (const key of SORT_KEYS) {
        const option = el('option', null, sortLabel(key));
        option.value = key;
        select.append(option);
    }
    select.value = SORT_KEYS.includes(sortBy) ? sortBy : 'name';
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.quick.sortCaption);
    select.addEventListener('change', () => setSortBy(select.value));
    return select;
}

// The view mode control, drawn beside the sort select in the same
// native select shape: the Android picker is the one control on this panel that
// should not be a custom row.
function viewSelect(viewMode, writable) {
    const select = el('select', 'pm-quickbar-sort');
    // Three views, not two. The third was once missing from this loop, which left
    // 타일+이름 unreachable by any tap.
    for (const key of ['list', 'tiles', 'tilesNamed']) {
        const option = el('option', null, STRINGS.quick.viewNames[key]);
        option.value = key;
        select.append(option);
    }
    select.value = ['tiles', 'tilesNamed'].includes(viewMode) ? viewMode : 'list';
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.quick.viewCaption);
    select.addEventListener('change', () => setViewMode(select.value));
    return select;
}

function chipButton(label, active, onClick, writable) {
    const chip = el('button', 'pm-quickbar-chip' + (active ? ' pm-quickbar-chip-active' : ''), label);
    chip.type = 'button';
    if (writable) chip.addEventListener('click', onClick);
    else { chip.disabled = true; chip.classList.add('pm-disabled'); }
    return chip;
}

// Hidden entirely when there are no labels at all, never merely
// left empty, so a blank row does not sit there taking up space.
function chipsRow(view, writable) {
    if (!view.chips.length) return null;
    const row = el('div', 'pm-quickbar-chips');
    row.append(chipButton(STRINGS.quick.chipAll, view.activeLabelId == null, () => setActiveLabel(null), writable));
    // A group whose members are all gone from SillyTavern is shown but not
    // tappable: choosing it stored the id, the view fell back to everyone (an
    // empty filter would hide the whole list), and the fallback was saved again -
    // two saves for a tap that changed nothing on screen.
    for (const label of view.chips) {
        row.append(chipButton(label.name ?? '', label.id === view.activeLabelId, () => setActiveLabel(label.id),
            writable && label.members.length > 0));
    }
    return row;
}

// The toggle, shaped like the group-edit one beside it so the two read as the
// same kind of control. Leaving select mode drops the selection: a selection the
// user cannot see is a selection they will act on by accident later.
/* ── Bulk actions (user request) ─────────────────────────────────────────────
   Everything here reads the CURRENT selection at the moment it runs, never a
   snapshot taken when the bar was drawn: a draw can happen between the two, and
   acting on a stale list would edit personas the user had just unpicked.

   Each action re-resolves the root through getRoot() for the same reason every
   other write in this extension does. */
function selectedPersonas(root) {
    const out = [];
    for (const avatar of selectedAvatars) {
        const persona = getPersona(root, avatar);
        if (persona) out.push(persona);
    }
    return out;
}

function bulkWritableRoot() {
    const root = getRoot();
    if (!root) { notify('error', STRINGS.manager.refusalNoRoot); return null; }
    if (root.readOnly) { notify('error', STRINGS.common.readOnly); return null; }
    if (!selectedAvatars.length) { notify('info', STRINGS.quick.bulkNothing); return null; }
    return root;
}

function bulkSave(root) {
    freshContext()?.saveSettingsDebounced?.();
    // refresh() BEFORE the event. pm:changed redraws the panel from getState(),
    // and after bulkDelete that cache still holds the persona object that was just
    // removed from root.personas: the panel would keep offering its versions, and
    // applying one would compose the orphan into the live description and report
    // success. Every other write in this extension reaches refreshWith through
    // commit; this path is the only one that has to say so itself.
    refresh();
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('pm:changed'));
    scheduleDraw();
}

async function bulkAddTag() {
    const root = bulkWritableRoot();
    if (!root) return;
    const tag = await askText(STRINGS.quick.bulkTagPrompt, '');
    if (!tag || !tag.trim()) return;
    const after = getRoot();
    if (!after || after.readOnly) return;
    // adoptFor, NOT ensurePersona. ensurePersona mints an entry whose sections are
    // all empty and whose lastComposed is '', which strands the persona's real
    // description: adopt() early-returns once an entry exists, so 관리 시작
    // disappears and the text can never be brought in. Worse, hasDiverged then
    // reads description !== '' forever, so the panel claims an outside edit that
    // never happened, and one tap on 되돌리기 composes '' straight over the user's
    // description with no snapshot taken. adoptFor seeds the first variant from the
    // existing text, sets lastComposed to match, refuses an avatar SillyTavern does
    // not list, and writes the birth log line.
    const targets = [];
    for (const avatar of selectedAvatars) {
        const persona = adoptFor(avatar);
        if (persona) targets.push(persona);
    }
    const trimmed = tag.trim();
    let n = 0;
    for (const persona of targets) {
        // addTag's own return, not a membership test afterwards: the test is true
        // for the personas that already had the tag, and logging those recorded
        // edits that did not happen.
        if (addTag(persona, trimmed)) {
            n++;
            addLog(persona, 'tag-add', trimmed, Date.now());
        }
    }
    notify('info', n ? STRINGS.quick.bulkTagAdded(n) : STRINGS.quick.bulkTagNoChange);
    bulkSave(after);
}

async function bulkRemoveTag() {
    const root = bulkWritableRoot();
    if (!root) return;
    const present = tagsAcross(selectedPersonas(root));
    if (!present.length) { notify('info', STRINGS.manager.tagGone); return; }
    const tag = await askChoice(STRINGS.quick.bulkTagRemovePrompt, present);
    if (!tag) return;
    const after = getRoot();
    if (!after || after.readOnly) return;
    let n = 0;
    for (const persona of selectedPersonas(after)) {
        if (removeTag(persona, tag)) { n++; addLog(persona, 'tag-remove', tag, Date.now()); }
    }
    notify('info', n ? STRINGS.quick.bulkTagRemoved(n) : STRINGS.quick.bulkTagNoChange);
    bulkSave(after);
}

async function bulkGroup(view) {
    const root = bulkWritableRoot();
    if (!root) return;
    const labels = livingLabels(root.labels, root.personas);
    if (!labels.length) { notify('info', STRINGS.manager.groupsEmpty); return; }
    // Two groups may share a name, so the choice is offered
    // with its position baked in and resolved back by INDEX. Matching on the name
    // afterwards always found the first of a duplicate pair, and the whole
    // selection went into a group the user did not pick.
    /* Answered by position, which is the only thing that separates two groups
       sharing a name, and numbered once rather than twice.

       The list handed over is the one the index counts. askChoiceIndex drops
       entries that are empty strings, so an unnamed group earlier in the list
       shifted every later answer by one and the selection went into the group
       under the one the user read. Filtering here, with the ids alongside, is
       what makes the index mean the same thing on both sides. */
    const named = labels.filter(l => String(l.name ?? '').length);
    if (!named.length) { notify('info', STRINGS.manager.groupsEmpty); return; }
    const picked = await askChoiceIndex(STRINGS.quick.bulkGroupPrompt, named.map(l => l.name));
    if (picked < 0) return;
    const pickedId = named[picked]?.id;
    const after = getRoot();
    if (!after || after.readOnly) return;
    const label = (after.labels ?? []).find(l => l.id === pickedId);
    if (!label) return;
    if (!Array.isArray(label.members)) label.members = [];
    let added = 0;
    for (const avatar of selectedAvatars) {
        if (!label.members.includes(avatar)) { label.members.push(avatar); added++; }
    }
    // Which group, and how many went into it. It used to report the size of the
    // selection, which is the one number the user could already see.
    notify('info', STRINGS.quick.bulkGrouped(label.name ?? '', added));
    bulkSave(after);
}

async function bulkDelete() {
    const root = bulkWritableRoot();
    if (!root) return;
    const count = selectedAvatars.filter(a => getPersona(root, a)).length;
    // Not "nothing selected": the bar directly above says 3개 선택 and means it.
    // What is missing is managed DATA, which is the normal state for a persona
    // nobody has pressed 관리 시작 on, and most of a 30 persona roster is that.
    if (!count) { notify('info', STRINGS.quick.bulkNoManaged(selectedAvatars.length)); return; }
    if (!await askConfirm(STRINGS.quick.confirmBulkDelete(count))) return;
    const after = getRoot();
    if (!after || after.readOnly) return;
    const deleted = [];
    for (const avatar of selectedAvatars) {
        if (!after.personas?.[avatar]) continue;
        delete after.personas[avatar];
        deleted.push(avatar);
    }
    // A deleted persona must not stay a member of a group, or the group count
    // keeps naming rows that no longer exist. Only the ones deleted: a persona
    // nobody adopted can still be in a group (grouping does not adopt), it had no
    // data to delete, and the confirm counted only the managed ones.
    for (const label of after.labels ?? []) {
        if (!Array.isArray(label.members)) continue;
        label.members = label.members.filter(id => !deleted.includes(id));
    }
    selectedAvatars = [];
    selectMode = false;
    notify('info', STRINGS.quick.bulkDeleted(deleted.length));
    bulkSave(after);
}

// Whether every persona currently on screen is already picked. Asked of the list
// as it stands, so the label and the action can never mean different things.
function everyVisiblePicked() {
    return rosterVisible.length > 0 && rosterVisible.every(a => selectedAvatars.includes(a));
}

function bulkBar(view, writable) {
    const bar = el('div', 'pm-quickbar-bulk');
    bar.append(el('div', 'pm-quickbar-bulkcount', STRINGS.quick.selectedCount(selectedAvatars.length)));
    const row = el('div', 'pm-manager-actions');
    const pickAll = el('button', 'pm-quickbar-btn',
        everyVisiblePicked() ? STRINGS.quick.selectNone : STRINGS.quick.selectAll);
    pickAll.type = 'button';
    pickAll.dataset.pmPickall = '1';
    // Nothing on screen is nothing to select. The assignment below would read
    // that as "select none" and clear a selection made on another page.
    if (!rosterVisible.length) { pickAll.disabled = true; pickAll.classList.add('pm-disabled'); }
    pickAll.addEventListener('click', () => {
        /* Scoped to what is on screen, which is what the user can see they are
           choosing: a filter, a search and the page cut are all part of the
           question they asked, and all three are applied by the time the list
           publishes what it drew.

           A union and a difference, not an assignment. The assignment was scoped
           correctly and still wrong in the other direction: it dropped everything
           picked on a page or a search the user had since left, silently, at the
           moment they asked for MORE. Selecting three on page one and pressing
           this on page two left four selected rather than seven. */
        if (!rosterVisible.length) return;
        selectedAvatars = everyVisiblePicked()
            ? selectedAvatars.filter(avatar => !rosterVisible.includes(avatar))
            : [...new Set([...selectedAvatars, ...rosterVisible])];
        scheduleDraw();
    });
    row.append(pickAll);
    for (const [label, run] of [
        [STRINGS.quick.bulkTagAdd, () => bulkAddTag()],
        [STRINGS.quick.bulkTagRemove, () => bulkRemoveTag()],
        [STRINGS.quick.bulkGroup, () => bulkGroup(view)],
    ]) {
        const btn = el('button', 'pm-quickbar-btn', label);
        btn.type = 'button';
        if (writable) btn.addEventListener('click', run);
        else { btn.disabled = true; btn.classList.add('pm-disabled'); }
        row.append(btn);
    }
    const del = el('button', 'pm-quickbar-btn pm-manager-danger', STRINGS.quick.bulkDelete);
    del.type = 'button';
    if (writable) del.addEventListener('click', () => bulkDelete());
    else { del.disabled = true; del.classList.add('pm-disabled'); }
    row.append(del);
    bar.append(row);
    return bar;
}

function selectToggleButton(writable) {
    const btn = el('button', `pm-quickbar-btn${selectMode ? ' pm-manager-primary' : ''}`,
        STRINGS.quick.selectToggle(selectMode));
    btn.type = 'button';
    if (writable) {
        btn.addEventListener('click', () => {
            selectMode = !selectMode;
            if (!selectMode) selectedAvatars = [];
            else { editMode = false; expandedAvatar = null; }
            scheduleDraw();
        });
    } else {
        btn.disabled = true;
        btn.classList.add('pm-disabled');
    }
    return btn;
}

function toggleSelected(avatarId) {
    const i = selectedAvatars.indexOf(avatarId);
    if (i === -1) selectedAvatars.push(avatarId);
    else selectedAvatars.splice(i, 1);
    if (!markSelection(avatarId)) scheduleDraw();
}

function editToggleButton(writable) {
    const btn = el('button', 'pm-quickbar-btn', STRINGS.quick.groupEditToggle(editMode));
    btn.type = 'button';
    if (writable) {
        btn.addEventListener('click', () => {
            editMode = !editMode;
            if (!editMode) expandedAvatar = null;
            // The row tap answers to select mode FIRST, so turning group editing on
            // underneath it produced a button that lit up and changed nothing at
            // all. The two modes are alternatives, and the select toggle beside
            // this one has always said so by turning group editing off; this is
            // the same sentence read the other way.
            else if (selectMode) { selectMode = false; selectedAvatars = []; }
            scheduleDraw();
        });
    } else {
        btn.disabled = true;
        btn.classList.add('pm-disabled');
    }
    return btn;
}

// Makes the label and attaches it to avatarId in one step, via
// createLabel above. Enter is guarded by isComposingKey exactly like every other
// text entry point in this panel, so a hangul composition commit cannot fire it.
function newLabelInput(avatarId, writable) {
    const row = el('div', 'pm-quickbar-newlabel');
    const input = el('input', 'pm-quickbar-newlabel-input');
    input.type = 'text';
    input.placeholder = STRINGS.quick.newGroupPlaceholder;
    input.disabled = !writable;
    const submit = () => {
        if (!input.value.trim()) return;
        // createLabel only schedules the redraw, so this clears the live input the
        // user is still looking at. It used to run one line after a synchronous
        // redraw had already replaced the field, which wrote to a node nobody could
        // see and left the typed name sitting in the new one.
        createLabel(input.value, avatarId);
        input.value = '';
        // Submitting ends the typing session. Without this the redraw waits for a
        // blur that has no reason to come, and the label the user just made would
        // not appear in the list under their finger.
        input.blur();
    };
    input.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    const addBtn = el('button', 'pm-quickbar-btn', STRINGS.common.add);
    addBtn.type = 'button';
    addBtn.disabled = !writable;
    if (writable) addBtn.addEventListener('click', submit);
    row.append(input, addBtn);
    return row;
}

// Reached only through the [편집] toggle plus a tap on the row
// itself. No long press anywhere, per the same section.
function labelEditor(s, avatarId, writable) {
    const box = el('div', 'pm-quickbar-labeleditor');
    const labels = s.root.labels ?? [];
    for (const label of labels) {
        const row = el('label', 'pm-quickbar-labelrow');
        const checkbox = el('input', 'pm-checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = (label.members ?? []).includes(avatarId);
        checkbox.disabled = !writable;
        checkbox.addEventListener('change', () => toggleLabelMembership(label.id, avatarId));
        row.append(checkbox, el('span', 'pm-quickbar-labelname', label.name ?? ''));
        box.append(row);
    }
    box.append(newLabelInput(avatarId, writable));
    return box;
}

// The badge rides the name line and the version names get a line
// of their own, so a row is one line when both toggles are off and two when the
// names are asked for. version comes from rosterVersionLine, which answers null
// for a persona this extension carries no data for.
function personaRow(ctx, entry, s, version) {
    const picked = selectMode && selectedAvatars.includes(entry.avatar);
    const onClick = selectMode
        // In select mode a tap picks rather than switches. Switching persona from
        // here would be the opposite of what the user turned the mode on to do.
        ? () => toggleSelected(entry.avatar)
        : editMode
            ? () => toggleEditRow(entry.avatar)
            // Switching persona stays enabled in the ambiguous state on purpose: it
            // is the action that gets the user out of it, and it writes none of our
            // data.
            : () => switchPersona(entry.avatar, entry.name);
    const row = el('div', `pm-row pm-quickbar-row${picked ? ' pm-picked' : ''}`);
    row.dataset.pmAvatar = entry.avatar;
    if (selectMode) {
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', picked ? 'true' : 'false');
    }
    // Names alone cannot tell two same-named personas apart, which the user hit on
    // the device. The avatar thumbnail is the identity SillyTavern itself uses, so
    // every row carries it. Guarded like paintButton: a build without the helper
    // just shows the text row.
    //
    // The context comes from the one read drawPanel made for this whole draw. A
    // freshContext() per row asked SillyTavern to build thirty objects to answer
    // the same question thirty times, inside a synchronous draw where the answer
    // cannot change between the first row and the last.
    const url = thumbnailUrl(ctx, entry.avatar);
    if (url) row.append(thumbImage('pm-quickbar-rowimg', url));
    const text = el('div', 'pm-quickbar-rowtext');
    const top = el('div', 'pm-quickbar-rowtop');
    top.append(markedText('pm-quickbar-name', entry.name ?? '', rosterSearchOpen ? rosterQuery : ''));
    if (version?.badge) top.append(el('span', 'pm-quickbar-versionbadge', version.badge));
    text.append(top);
    // One line, ellipsised by CSS. A list of thirty personas cannot afford to grow
    // by however many versions each of them happens to have.
    if (version?.line) text.append(el('div', 'pm-quickbar-versionline', version.line));
    row.append(text);
    row.append(checkMark(entry.avatar === s.avatar));
    // The role is already on the row in select mode, and makeRowActivatable
    // leaves whatever it finds.
    if (onClick) makeRowActivatable(row, onClick);
    else row.classList.add('pm-disabled');
    return row;
}

// The tile: the avatar image and nothing else, sized for a thumb. The active
// persona is marked by border AND the check overlay, never colour alone, and a
// persona with no readable thumbnail
// shows its name inside the tile instead, so no tile is ever anonymous. The
// aria-label carries the name either way. Tapping switches persona, exactly
// what tapping the row does; switching stays enabled in the ambiguous state for
// the same reason the row leaves it enabled.
function personaTile(ctx, entry, s, named) {
    const active = entry.avatar === s.avatar;
    // The shape class is on the PANEL, not here: as a per-tile class it reached
    // the tile grid only, so 목록's row avatars kept a hardcoded circle and the
    // setting looked broken from every view but one.
    const picked = selectMode && selectedAvatars.includes(entry.avatar);
    const tile = el('button', `pm-quickbar-tile${named ? ' pm-quickbar-tile-named' : ''}${active ? ' pm-quickbar-tile-active' : ''}${picked ? ' pm-picked' : ''}`);
    tile.dataset.pmAvatar = entry.avatar;
    if (selectMode) {
        tile.setAttribute('role', 'checkbox');
        tile.setAttribute('aria-checked', picked ? 'true' : 'false');
    }
    tile.type = 'button';
    tile.setAttribute('aria-label', entry.name ?? '');
    const imgbox = el('div', 'pm-quickbar-tileimgbox');
    // The name is always in the tile and the image is layered over it: a URL
    // that 404s renders nothing at all (empty alt suppresses the broken icon),
    // and the name simply stays visible underneath, so no tile is anonymous
    // whichever way the thumbnail fails.
    imgbox.append(markedText('pm-quickbar-tilename', entry.name ?? '', rosterSearchOpen ? rosterQuery : ''));
    const url = thumbnailUrl(ctx, entry.avatar);
    if (url) imgbox.append(thumbImage('pm-quickbar-tileimg', url));
    if (active) {
        // No check glyph. The accent ring around the image already says which
        // tile is current, and says it in thickness as well as colour, so it is
        // not a colour-only cue. Drawing both was two marks for one fact, which
        // is what the device reported.
        tile.setAttribute('aria-current', 'true');
    }
    tile.append(imgbox);
    // The 타일+이름: the name gets a strip of its own under the
    // image instead of hiding behind it.
    if (named) tile.append(markedText('pm-quickbar-tilelabel', entry.name ?? '', rosterSearchOpen ? rosterQuery : ''));
    tile.addEventListener('click', () => {
        if (selectMode) { toggleSelected(entry.avatar); return; }
        switchPersona(entry.avatar, entry.name);
    });
    return tile;
}

// The search toggle in the roster head. Closing it clears the
// query, the filters and the page, so leaving search always returns the list
// to what it was.
// Searching writes nothing, so unlike its sort and view neighbours this button
// stays available on a read only root.
// Set when the roster's search is opened, cleared by the draw that acts on it.
// Opening a field and leaving the user to find it is the manager's bug in the
// same shape: the point of pressing 검색 is to type.
let focusRosterSearch = false;

function searchToggleButton() {
    const btn = el('button', 'pm-quickbar-btn', rosterSearchOpen ? STRINGS.common.searchClose : STRINGS.common.search);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', rosterSearchOpen ? 'true' : 'false');
    btn.addEventListener('click', () => {
        rosterSearchOpen = !rosterSearchOpen;
        if (!rosterSearchOpen) { rosterQuery = ''; rosterLang = null; rosterTags = []; rosterPage = 1; }
        else focusRosterSearch = true;
        scheduleDraw();
    });
    return btn;
}

// Repaints only the roster's list container, so typing in the search box never
// rebuilds the box itself: a full redraw mid composition is exactly what the
// draw deferral exists to prevent, and this path does not need one. Everything is
// read fresh at call time.
/* One rebuild per frame, not one per keystroke.

   Typing in the search field rebuilds the rows, and with thirty personas that
   measured 1.9ms typically and 30ms at worst - on a desktop. A phone is several
   times slower and a fast typist outruns it, which is the 글자 입력할 때 버벅임
   the device reported. Keystrokes arrive far faster than frames, and every
   rebuild but the last is thrown away by the next one, so the only one worth
   doing is the last one in the frame.

   The FIELD is untouched by this: it lives outside the repainted container on
   purpose, so the caret and the composition never wait on the
   list. What waits is the list, by at most one frame. */
let rosterListFrame = 0;

function redrawRosterList() {
    if (rosterListFrame) return;
    if (typeof requestAnimationFrame !== 'function') { fillRosterListNow(); return; }
    rosterListFrame = requestAnimationFrame(() => { rosterListFrame = 0; fillRosterListNow(); });
}

function fillRosterListNow() {
    const panel = document.getElementById(PANEL_ID);
    const container = panel?.querySelector('[data-pm-roster-list]');
    if (!container) return;
    harvestThumbs(container);
    fillRosterList(container);
    thumbPool.clear();
}

/* Persona pictures carried across a redraw. Every tap rebuilds the list, and each
   rebuild made twenty new <img> for twenty pictures the panel was already showing:
   each one decoded again, and drew as an empty box until it had (measured: 20 per
   quick panel draw, 31 in the manager's picker). The old element is moved into the
   new row instead, keyed by its class and address, so the picture never leaves
   the screen. An address that changed (a replaced picture bumps its token) finds
   nothing and gets a fresh element, which is the one reload that should happen. */
const thumbPool = new Map();

function harvestThumbs(node) {
    for (const img of node?.querySelectorAll?.('img.pm-quickbar-rowimg, img.pm-quickbar-tileimg') ?? []) {
        const key = `${img.className}|${img.getAttribute('src')}`;
        if (!thumbPool.has(key)) thumbPool.set(key, img);
    }
}

function thumbImage(className, url) {
    const key = `${className}|${url}`;
    const kept = thumbPool.get(key);
    if (kept) { thumbPool.delete(key); return kept; }
    const img = document.createElement('img');
    img.className = className;
    img.loading = 'lazy';
    img.alt = '';
    img.src = url;
    return img;
}

// The persona language, judged from what the prompt actually carries (design
// doc 26). null for personas this extension has no data for. It read the stored
// copy of that text, which is now only a fingerprint; the answer is kept per
// persona record and recomputed when the fingerprint moves, so a draw still does
// not compose thirty personas.
const languageMemo = new WeakMap();

function personaLanguage(root, avatar) {
    const persona = getPersona(root, avatar);
    if (!persona) return null;
    const sig = persona.composedSig ?? null;
    const memo = languageMemo.get(persona);
    if (memo && memo.sig === sig) return memo.language;
    const language = detectLanguage(compose(persona).text);
    languageMemo.set(persona, { sig, language });
    return language;
}

// Everything below the search row: filter chips, the rows or tiles, and the
// pager. Lives in its own container so the search input can repaint it alone.
// prebuilt is the view rosterGroup already built in this same synchronous draw.
// Without it this rebuilt and re-sorted the whole roster a second time from the
// same data. The parameter stays optional because redrawRosterList repaints this
// container alone, with no rosterGroup above it to inherit from.
/* Publishes what the list drew, and puts the bulk bar's label in step with it.

   The bar is built before this runs, and this also runs on its own when only the
   list is repainted (a keystroke, a page step), so the label is settled from here
   rather than from the draw that built the button. */
function publishVisible(avatars) {
    rosterVisible = avatars;
    const pickAll = document.getElementById(PANEL_ID)?.querySelector('[data-pm-pickall]');
    if (!pickAll) return;
    pickAll.textContent = everyVisiblePicked() ? STRINGS.quick.selectNone : STRINGS.quick.selectAll;
    // The dead state travels with the label. A keystroke repaints the LIST alone,
    // so a bar built while rows were on screen kept a live button over an empty
    // one - and the handler behind it is the one that must never run there.
    pickAll.disabled = !rosterVisible.length;
    pickAll.classList.toggle('pm-disabled', !rosterVisible.length);
}

function fillRosterList(container, prebuilt) {
    const ctx = freshContext();
    const s = getState();
    container.replaceChildren();
    publishVisible([]);
    if (!s) return;
    const writable = !s.ambiguous && !s.readOnly;
    const view = prebuilt
        ?? buildRosterView({ personas: personaNames(ctx), name1: ctx?.name1 }, s.root, LIST_COLLATOR);

    // An open label editor belongs to a row. Once a chip filters that row out of the
    // list, the editor has nothing to sit under, and keeping the avatar means it
    // springs open again the moment the user filters that persona back in.
    if (expandedAvatar != null && !view.entries.some(entry => entry.avatar === expandedAvatar)) {
        expandedAvatar = null;
    }

    if (!view.entries.length) {
        container.append(el('div', 'pm-quickbar-note', STRINGS.quick.rosterUnavailable));
        return;
    }

    let entries = view.entries;

    // Language and tag filter chips, drawn only while search is
    // open and built from what actually exists in the list right now.
    if (rosterSearchOpen) {
        // Language answers are computed once per avatar per fill: the chips and
        // the filter below would otherwise compose every persona twice per
        // keystroke. A call-local map, not module state.
        const langCache = new Map();
        const langOf = avatar => {
            if (!langCache.has(avatar)) langCache.set(avatar, personaLanguage(s.root, avatar));
            return langCache.get(avatar);
        };
        // Chip populations come from the WHOLE roster, not the group-filtered
        // view: a filter must only be dropped when its language or tag truly
        // no longer exists anywhere, not whenever the user steps through a
        // group chip that happens to hide its owners.
        const langs = [];
        const tags = [];
        for (const avatar of Object.keys(personaNames(ctx) ?? {})) {
            const lang = langOf(avatar);
            if (lang && !langs.includes(lang)) langs.push(lang);
            for (const tag of getPersona(s.root, avatar)?.tags ?? []) {
                if (!tags.includes(tag)) tags.push(tag);
            }
        }
        if (rosterLang && !langs.includes(rosterLang)) rosterLang = null;
        rosterTags = rosterTags.filter(tag => tags.includes(tag));
        if (langs.length || tags.length) {
            const row = el('div', 'pm-quickbar-chips pm-filter-chips');
            for (const lang of langs) {
                row.append(chipButton(STRINGS.common.languageNames[lang] ?? lang, rosterLang === lang, () => {
                    rosterLang = rosterLang === lang ? null : lang;
                    rosterPage = 1;
                    scheduleDraw();
                }, true));
            }
            for (const tag of tags) {
                row.append(chipButton(tag, rosterTags.includes(tag), () => {
                    rosterTags = rosterTags.includes(tag) ? rosterTags.filter(t => t !== tag) : [...rosterTags, tag];
                    rosterPage = 1;
                    scheduleDraw();
                }, true));
            }
            container.append(row);
        }
        if (rosterLang) entries = entries.filter(entry => langOf(entry.avatar) === rosterLang);
        if (rosterTags.length) {
            entries = entries.filter(entry => {
                const owned = getPersona(s.root, entry.avatar)?.tags ?? [];
                return rosterTags.every(tag => owned.includes(tag));
            });
        }
        if (rosterQuery.trim()) {
            const ranked = [];
            for (const entry of entries) {
                const persona = getPersona(s.root, entry.avatar);
                let rank = rankOf(entry.name ?? '', rosterQuery);
                for (const tag of persona?.tags ?? []) rank = Math.max(rank, rankOf(tag, rosterQuery));
                if (rank > 0) ranked.push({ entry, rank });
            }
            ranked.sort((a, b) => b.rank - a.rank);
            entries = ranked.map(r => r.entry);
        }
    }

    if (!entries.length) {
        container.append(emptyBlock(STRINGS.common.searchNoHits));
        return;
    }

    // In a tile view the page can be expressed as a grid: 열 수 x 행 수. Both have
    // to be set, because an automatic column count is decided by the browser from
    // the panel width and nothing here knows it. Either left at 0 falls back to the
    // plain per-page count, which is the setting that has always been there.
    const settings = s.root?.settings ?? {};
    const viewMode = settings.rosterViewMode;
    const cols = Number(settings.rosterTileColumns ?? 0);
    const rows = Number(settings.rosterTileRows ?? 0);
    // 'grid' shadows nothing here; the tile container below is also called grid and
    // is scoped to its own block.
    const perPage = viewMode !== 'list' && cols >= 2 && rows >= 1
        ? cols * rows
        : (settings.pageSizeRoster ?? 20);
    const paged = pageOf(entries, rosterPage, perPage);
    rosterPage = paged.page;

    // Everything that decides which personas are on screen has been applied by
    // now, which is what makes this the answer [전체 선택] is scoped to.
    publishVisible(paged.slice.map(entry => entry.avatar));

    // The label-filter check above cannot see the query or the page cut. If the
    // expanded row is not on the SCREEN, its editor closes for good instead of
    // springing back when the query is erased (same rationale).
    if (expandedAvatar != null && !paged.slice.some(entry => entry.avatar === expandedAvatar)) {
        expandedAvatar = null;
    }

    // The group edit mode's editor has to unfold under a full
    // width row, so it falls back to the list layout for as long as it is on.
    if ((viewMode === 'tiles' || viewMode === 'tilesNamed') && !editMode) {
        const grid = el('div', 'pm-quickbar-tiles');
        // A fixed column count when the user chose one, the
        // responsive auto fill otherwise.
        const columns = Number(s.root?.settings?.rosterTileColumns ?? 0);
        if (columns >= 2) grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
        for (const entry of paged.slice) grid.append(personaTile(ctx, entry, s, viewMode === 'tilesNamed'));
        container.append(grid);
    } else {
        // The two independent toggles, read once for the whole list.
        const mode = {
            count: s.root?.settings?.rosterShowVersionCount === true,
            names: s.root?.settings?.rosterShowVersionNames === true,
        };
        for (const entry of paged.slice) {
            // getPersona only reads, so drawing the list can never create an entry
            // for a persona the user never adopted.
            const version = (mode.count || mode.names)
                ? rosterVersionLine(getPersona(s.root, entry.avatar), mode)
                : null;
            container.append(personaRow(ctx, entry, s, version));
            if (editMode && expandedAvatar === entry.avatar) container.append(labelEditor(s, entry.avatar, writable));
        }
    }

    const pager = pagerRow(paged.page, paged.pages,
        () => { rosterPage = Math.max(1, rosterPage - 1); redrawRosterList(); },
        () => { rosterPage = rosterPage + 1; redrawRosterList(); });
    if (pager) container.append(pager);
}

function rosterGroup(ctx, s, writable) {
    // A stale edit session must not survive the root becoming unwritable under it,
    // for instance because a second persona with the same name just appeared.
    if (!writable && editMode) { editMode = false; expandedAvatar = null; }
    // Select mode is the more destructive of the two, so it gets the same
    // treatment: a selection nobody can see is one the user acts on by accident.
    if (!writable && selectMode) { selectMode = false; selectedAvatars = []; }

    // The sort uses the browser locale and numeric: true, and nothing
    // else. sensitivity: 'base' was not in it and makes two names that differ only
    // in case or accent compare equal, which is not what a list of proper names
    // wants; roster.js still has an avatar id tie break for the pairs that really
    // are equal.
    const view = buildRosterView({ personas: personaNames(ctx), name1: ctx?.name1 }, s.root, LIST_COLLATOR);

    // The other half: the fallback buildRosterView computed is only
    // persisted when writing is allowed right now. The corrected view still renders
    // this time regardless, so the user is never shown a filter that hides everyone.
    const storedActiveLabelId = s.root?.settings?.activeLabelId ?? null;
    // No save of its own: a filter is a way of looking, and the corrected value
    // goes out with the next save anything makes.
    if (writable && s.root?.settings && view.activeLabelId !== storedActiveLabelId) {
        s.root.settings.activeLabelId = view.activeLabelId;
    }

    const box = el('div', 'pm-quickbar-group');
    // The five controls sit on a line of their own (user request). Sharing the
    // heading's line left them 298px of a 388px panel, which is not enough for
    // five, so 그룹 편집 dropped to a second line by itself and read as though it
    // belonged to something else. On their own line they have the panel's full
    // width and stand in one row, which is what the user asked to see.
    const head = el('div', 'pm-quickbar-head pm-quickbar-rosterhead');
    // The label carries a class of its own so it can refuse to shrink: this is
    // where 페르소나 used to wrap to 페르소/나 on the device.
    head.append(el('span', 'pm-quickbar-headlabel', STRINGS.quick.headPersona));
    box.append(head);
    const controls = el('div', 'pm-quickbar-rosterhead-controls');
    // The two captions are gone from the line and live on as the selects' own
    // accessible names. Five controls plus two captions do not fit in 364px at
    // any padding worth having, and of the two the captions are what the control
    // beside them already says: a dropdown reading 이름순 over a list of personas
    // is a sort order, and 타일+이름 is a view.
    controls.append(sortSelect(s.root?.settings?.sortBy, writable));
    controls.append(viewSelect(s.root?.settings?.rosterViewMode, writable));
    controls.append(searchToggleButton());
    controls.append(selectToggleButton(writable));
    controls.append(editToggleButton(writable));
    box.append(controls);
    // The bar is BUILT after the list, because [전체 선택] is scoped to what the
    // list drew and the list is what works that out. A placeholder holds its
    // place in the order so the bar still stands above the rows.
    const bulkSlot = selectMode ? el('div') : null;
    if (bulkSlot) box.append(bulkSlot);

    const chips = chipsRow(view, writable);
    if (chips) box.append(chips);

    // The search input lives OUTSIDE the repainted container, so typing never
    // rebuilds the field under the composition. Its value is
    // restored from module state on the full draws that do rebuild it.
    if (rosterSearchOpen) {
        const row = el('div', 'pm-search-row');
        const input = el('input', 'pm-search-input');
        input.type = 'search';
        input.value = rosterQuery;
        input.placeholder = STRINGS.common.search;
        input.setAttribute('aria-label', STRINGS.common.search);
        input.autocapitalize = 'none';
        input.spellcheck = false;
        input.addEventListener('input', () => {
            rosterQuery = input.value;
            rosterPage = 1;
            redrawRosterList();
        });
        // The list filters as the user types, so the keyboard's 검색/이동 key has
        // nothing left to submit; it puts the keyboard away instead, which is what
        // a thumb pressing it on a phone is asking for. The blur also releases a
        // redraw drawPanel deferred behind this field.
        input.addEventListener('keydown', e => {
            if (isComposingKey(e) || e.key !== 'Enter') return;
            e.preventDefault();
            input.blur();
        });
        // Marked here, acted on after the panel is assembled: this node is not in
        // the document yet, and focusing a detached input does nothing at all.
        if (focusRosterSearch) input.dataset.pmFocus = '1';
        row.append(input);
        box.append(row);
    }

    const container = el('div');
    container.dataset.pmRosterList = '1';
    box.append(container);
    fillRosterList(container, view);
    if (bulkSlot) bulkSlot.replaceWith(bulkBar(view, writable));
    return box;
}

function footer() {
    const box = el('div', 'pm-quickbar-footer');
    // User request: every manager tab is reachable from here, not
    // only the one the manager happens to open on. 검색 asks for the same tab with
    // its search row already open, so the shortcut lands on a keyboard.
    const SHORTCUTS = [
        [STRINGS.quick.footerCompose, 'compose', false],
        [STRINGS.quick.footerVersions, 'versions', false],
        [STRINGS.quick.footerHistory, 'history', false],
        [STRINGS.quick.footerAssets, 'assets', false],
        [STRINGS.quick.footerGroups, 'labels', false],
        [STRINGS.quick.footerSearch, 'compose', true],
    ];
    for (const [label, tab, search] of SHORTCUTS) {
        const btn = el('button', 'pm-quickbar-btn', label);
        btn.addEventListener('click', () => {
            // The manager screen is Task 11. Dispatch is synchronous, so a listener
            // that exists can mark the event handled; when none does we say so
            // instead of leaving a button that silently does nothing.
            const detail = { tab, search, handled: false };
            document.dispatchEvent(new CustomEvent('pm:open-manager', { detail }));
            if (!detail.handled) notify('info', STRINGS.quick.managerMissing);
        });
        box.append(btn);
    }
    return box;
}

function drawPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    applyShapeClass(panel);
    // A redraw is already waiting for an input to be given up. Registering a second
    // listener on a second input would draw twice for one release.
    if (drawDeferred) return;
    // A background settings save lands some time after a tap, and rebuilding the
    // panel then takes the focused input out of the document mid composition, which
    // loses a half typed hangul label. Wait for the user to leave the field.
    // The listener is one shot and holds no node of its own: it reopens the same
    // scheduler, and the draw that eventually runs reads the state fresh.
    const active = document.activeElement;
    if (active && panel.contains(active) && isTextEntry(active)) {
        drawDeferred = true;
        active.addEventListener('blur', () => { drawDeferred = false; scheduleDraw(); }, { once: true });
        return;
    }

    // One read for the whole draw, handed to the groups that need it. Drawing is
    // synchronous, so this cannot go stale before the last group is built, and no
    // handler the groups attach keeps a reference to it.
    const ctx = freshContext();
    const s = getState();
    // The panel is redrawn with the current persona's content on PERSONA_CHANGED,
    // so from here on this is the persona the panel is for. Leaving the value from
    // openPanel would show one persona and refuse every tap on it as belonging to
    // another. This is not the guard: saveAndCompose resolves the active persona
    // from a live context of its own and refuses there, which is the check that
    // cannot be fooled by anything this file believes.
    panelAvatar = s?.avatar ?? null;

    // The panel is a clipped shell and this wrapper is what
    // scrolls, so the scrollbar is drawn inside the rounded border instead of over
    // it. Everything below reads and writes the wrapper, never the panel.
    //
    // replaceChildren empties it, and an empty box has nothing to scroll, so the
    // browser clamps scrollTop to 0 before the new content arrives. Read the
    // positions first and put them back after.
    const oldScroll = panel.querySelector('.pm-scroll');
    const scrollTop = oldScroll?.scrollTop ?? 0;
    const chipsLeft = panel.querySelector('.pm-quickbar-chips')?.scrollLeft ?? 0;
    // The same save and restore, for what the user has typed. A tap on 추가 blurs the
    // input first, the blur listener releases the deferral and schedules a draw, and
    // the frame that runs before the click arrives rebuilds the field empty, so the
    // hangul that was typed is gone before the button it was aimed at can submit it.
    // The value and the caret are plain numbers and a string, read here and used a
    // few lines below; no node from the old tree is kept.
    const typing = panel.querySelector('.pm-quickbar-newlabel-input');
    const typed = typing
        ? { value: typing.value, start: typing.selectionStart, end: typing.selectionEnd }
        : null;
    /* The scrolling box is kept and only its contents are replaced. A new box per
       draw took the scroller itself out from under the thumb: a fling in progress
       stopped dead, and the delayed redraw after a save landed exactly while the
       user was flinging through the list. Built and swapped in one synchronous
       pass, the new content is in place before the next layout, so the offset is
       never clamped and the restore below has nothing to do. */
    const scroll = oldScroll ?? el('div', 'pm-scroll');
    harvestThumbs(oldScroll);
    if (oldScroll) scroll.replaceChildren();
    else panel.replaceChildren(scroll);

    if (!s) {
        scroll.append(el('div', 'pm-quickbar-note', STRINGS.quick.stateUnread));
    } else {
        // The ambiguous state means ctx.js could not decide which persona is active.
        // Writing anything then would land on a persona we guessed, so every control
        // that writes is disabled until the user resolves it.
        const writable = !s.ambiguous && !s.readOnly;
        if (s.ambiguous) scroll.append(bannerOf('pm-quickbar-warn', STRINGS.quick.ambiguous));
        if (s.readOnly) scroll.append(bannerOf('pm-quickbar-warn', STRINGS.common.readOnly));
        if (s.diverged && !bannerDismissed) scroll.append(divergedBanner(writable));

        // No section group here any more.
        //
        // Each group on its own: one record a hand edit left in a shape a group
        // cannot read threw out of drawPanel after the scroll box had been
        // emptied, and the panel came up blank - persona list included, which is
        // the one thing needed to get away from the broken persona.
        groupNodes.clear();
        for (const [name, build] of [
            ['current', () => currentGroup(ctx, s)], ['version', () => versionGroup(s, writable)],
            ['names', () => namesGroup(s, writable)], ['roster', () => rosterGroup(ctx, s, writable)],
            ['footer', () => footer()],
        ]) {
            try {
                const node = build();
                scroll.append(node);
                if (name === 'version') groupNodes.set(name, { node, build: () => versionGroup(...liveGroupArgs()) });
                if (name === 'names') groupNodes.set(name, { node, build: () => namesGroup(...liveGroupArgs()) });
            } catch (e) { console.error(`[${MODULE_NAME}] quick panel group`, e); }
        }
    }

    // Writing scrollTop makes the browser lay the new content out then and there so
    // it can clamp the value. Zero is where a freshly filled panel already sits, so
    // the write buys nothing, and the openPanel path runs outside a frame where that
    // layout is on the critical path of the panel appearing.
    // Written only when it moved: a programmatic write stops a fling, and on the
    // kept box the offset normally survives the swap untouched.
    if (scrollTop && scroll.scrollTop !== scrollTop) scroll.scrollTop = scrollTop;
    // Whatever was not claimed belongs to rows that are gone.
    thumbPool.clear();
    const chips = panel.querySelector('.pm-quickbar-chips');
    if (chips) chips.scrollLeft = chipsLeft;
    // Restored into the rebuilt field, not the one that was read: that node is gone.
    // Focus is deliberately not restored. The typing that survives here is the typing
    // the keyboard dismissal interrupted, and taking the focus back would reopen the
    // keyboard the user just closed.
    if (typed?.value) {
        const rebuilt = panel.querySelector('.pm-quickbar-newlabel-input');
        if (rebuilt) {
            rebuilt.value = typed.value;
            if (typed.start != null && typed.end != null && typeof rebuilt.setSelectionRange === 'function') {
                rebuilt.setSelectionRange(typed.start, typed.end);
            }
        }
    }
    // The one focus this panel DOES take, and only when the user just asked for a
    // search. The rule above is about not reopening a keyboard the user closed;
    // this is a keyboard they pressed a button to get.
    if (focusRosterSearch) {
        focusRosterSearch = false;
        const field = panel.querySelector('input[data-pm-focus]');
        if (field) {
            delete field.dataset.pmFocus;
            field.scrollIntoView?.({ block: 'center' });
            field.focus?.({ preventScroll: true });
        }
    }
}

/* Lifecycle */

export function mountQuickbar() {
    if (mounted || typeof document === 'undefined') return;
    mounted = true;
    // showQuickBar can be toggled while we run, and SillyTavern can rebuild the send
    // form, so the button is reconciled on every state change rather than once.
    track(cleanups, document, 'pm:changed', () => syncButton());
    syncButton();
}

export function unmountQuickbar() {
    closePanel();
    // A queued rename must not fire into an extension that is being taken apart.
    cancelAutoName();
    runCleanups(cleanups);
    if (typeof document !== 'undefined') document.getElementById(BUTTON_ID)?.remove();
    mounted = false;
    panelAvatar = null;
    bannerDismissed = false;
    editMode = false;
    selectMode = false;
    selectedAvatars = [];
    expandedAvatar = null;
    rosterVisible = [];
    drawDeferred = false;
    lastMissing = null;
    // destroy() has to leave no module state behind, and both of these are
    // measurements of the running SillyTavern. A re-enable can happen after an
    // update that changed either answer, so both are taken again.
    probePromise = null;
    // A fold state that only exists because the root could not be written is
    // module state like any other, and teardown leaves none behind.
    versionOpenOverride = null;
    namesOpenOverride = null;
    focusRosterSearch = false;
    popupNeedsDrop = false;
    thumbBumps.clear();
    // A frame already queued would call drawPanel after teardown. It finds no panel
    // and returns, but the id must not be left looking like a live schedule.
    if (drawFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    // A list rebuild queued for a panel that is going away.
    if (rosterListFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rosterListFrame);
    rosterListFrame = 0;
}
