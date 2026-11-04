// The quick switch bar: one icon in #leftSendForm and a panel on body.
// DOM code only; the testable logic lives in quickbar-pure.js.
import { MODULE_NAME, getPersona, findVersion, liveVariant, TILE_SHAPES, makeId } from './store.js';
import {
    getState, saveAndCompose, adopt, getPreciseApi, getRoot, adoptFor, refresh, KEEP_DESCRIPTION_KINDS,
} from './state.js';
import { freshContext } from './ctx.js';
import { compose, headingLine, closingLine, splitByComposition } from './compose.js';
import { addLog, snapshot, enforceGlobalBudget, expireOldHistory } from './history.js';
import { toggleMember, SORT_KEYS, livingLabels } from './roster.js';
import {
    pickPersonaCommand, quoteArg, describeSelection, waitFor, schedulerTurn, divergedActions,
    buildRosterView, sortLabel, isTextEntry, versionApplicable, versionAlreadyApplied,
    popupVerdict, shouldSelfCorrect, POPUP_STUCK_MS, POPUP_STUCK_CHECKS, rosterVersionLine,
    pickAutoName, nameCollides, conversationLanguage, rosterWritable,
} from './quickbar-pure.js';
import { STRINGS } from './strings.js';
// manager-pure.js holds no DOM; sharing it keeps both screens on the same rules.
import {
    missingSignature, addTag, removeTag, tagsAcross, boundAsset, bindingIsExact, pictureSettled,
    renameVersionIn, duplicateVersionIn, overwriteVersionPicks, dropVersionFrom, moveVersion, addVersion,
    applyVersionPicks,
} from './manager-pure.js';
import { applyBoundImage, withToken } from './assets.js';
import { validCrop, writtenKey } from './framing.js';
import { itemsWithText } from './classify.js';
import { rankOf, matchRanges, srcOf, detectLanguage, pageOf } from './search-pure.js';
import {
    el, track, runCleanups, blockDrawerClose, isComposingKey, makeRowActivatable,
    checkMark, emptyBlock, bannerOf as sharedBanner, groupOf as sharedGroup, afterGesture,
    frameTask, button, disable, imagePool,
} from './dom.js';

// QuickPersona puts its own icon in the same host: our ids and classes carry the pm-
// prefix, and we append to the host instead of rewriting it, so its icon still works.
const BUTTON_ID = 'pm-quickbar';
const PANEL_ID = 'pm-quickbar-panel';
const BACKDROP_ID = 'pm-quickbar-backdrop';
const HOST_ID = 'pm-quickbar-host';

let mounted = false;
let cleanups = [];
let panelCleanups = [];
// Roster search, filters, page: panel-local strings and numbers, reset on close.
let rosterSearchOpen = false;
let rosterQuery = '';
let rosterPage = 1;
let rosterLang = null;
let rosterTags = [];
// The avatar the open panel was drawn for. Writes are checked against it (and again
// in saveAndCompose), so a persona switch mid-panel cannot misdirect an edit.
let panelAvatar = null;
let bannerDismissed = false;
// Edit mode and the row whose label checkboxes are open; panel-local, reset on open.
let editMode = false;
let expandedAvatar = null;
// Multi select has its own button because a long press on a portrait is how Android
// starts a text selection or image save. Strings only, like all module state.
let selectMode = false;
let selectedAvatars = [];
/* What the persona list actually drew, after every chip, the search and the page
   cut. The bulk bar's select-all uses this, not buildRosterView's output (group chip
   only), so it picks only what is visible. Written by fillRosterList, read on tap. */
let rosterVisible = [];
// One redraw per frame, and none at all while the user is typing. See scheduleDraw.
const drawTask = frameTask(() => drawPanel());
let drawDeferred = false;
// The empty-section set last toasted, as a string (see commit).
let lastMissing = null;
// The popup measurement: once per session, reset by unmountQuickbar. Every popup
// awaits the same promise, so none can take the unmeasured path.
let probePromise = null;
let popupNeedsDrop = false;

// No handler closes over a context: a context is only true when read, so handlers
// call freshContext() when they run. Only a single synchronous draw passes ctx down.

// notify, askConfirm, askText and closePanel are shared with manager.js, a second screen
// under the same mobile constraints. No export holds a context or a node.

// toastr is not guaranteed; without it the message still reaches the console, as
// a failure must never be silent.
export function notify(kind, message) {
    const t = globalThis.toastr;
    if (t && typeof t[kind] === 'function') { t[kind](message); liftToasts(); }
    else console.warn(`[${MODULE_NAME}] ${message}`);
}

/* SillyTavern's toast container hangs off body, but our screens are showModal
   dialogs in the top layer, which covers body and makes it inert. The container is
   borrowed while one of our screens is up and handed back before it closes:
   closeManager removes its host, and a container inside would be deleted with it. */
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

// Call before any of our hosts is closed or removed; the next notify lifts the
// container again into whichever of our screens is still open.
export function releaseToasts() {
    const box = toastContainer();
    if (!box) return;
    const home = toastHome;
    toastHome = null;
    if (home) {
        if (box.parentElement !== home) home.append(box);
        return;
    }
    // No home recorded: SillyTavern's fixToastrForDialogs can move the container into
    // our dialog before liftToasts runs, and removing the host would delete it.
    if (box.closest?.('dialog[id^="pm-"]')) document.body.append(box);
}

// getThumbnailUrl's third argument is never passed: SillyTavern builds it as
// &t=Date.now(), which would refetch every picture on every draw.
/* Per-avatar token, bumped only when that persona's picture is replaced. URLs are
   otherwise stable so repaints stay cheap, but the send-box icon is one long-lived
   node whose src never changes, so without a token it keeps the old picture. */
const thumbBumps = new Map();

// Built once: the locale is fixed for the session and fillRosterList runs every
// frame while the user types. No sensitivity: 'base', so case and accents still
// tell names apart.
const LIST_COLLATOR = new Intl.Collator(undefined, { numeric: true });

// A timestamp, not a counter: a counter restarts each session and would reuse an
// address the browser already cached with an older picture.
function bumpThumbnails(avatarId) {
    if (!avatarId) return;
    const previous = thumbBumps.get(avatarId) ?? 0;
    thumbBumps.set(avatarId, Math.max(Date.now(), previous + 1));
}

/* Tells everything that draws this persona's picture (an avatar upload emits no
   SillyTavern event): our icon and panel repaint from the new token, the manager and
   settings drawer hear pm:changed, and SillyTavern's own <img>s are repointed. */
export function personaImageChanged(avatarId) {
    if (!avatarId) return;
    bumpThumbnails(avatarId);
    const ctx = freshContext();
    const btn = document.getElementById(BUTTON_ID);
    if (btn) paintButton(ctx, btn);
    if (document.getElementById(PANEL_ID)) scheduleDraw();
    refreshHostImages(ctx, avatarId, thumbBumps.get(avatarId));
    document.dispatchEvent(new CustomEvent('pm:changed'));
}

function withoutToken(src) {
    return String(src ?? '').replace(/([?&])pmv=\d+(&|$)/, (_, lead, tail) => (tail ? lead : '')).replace(/[?&]$/, '');
}

// SillyTavern's own images of this persona (thumbnail, full-size file), matched with
// our old token stripped so a second replacement finds what the first repointed.
function refreshHostImages(ctx, avatarId, token) {
    if (!token) return;
    let thumb = null;
    try { thumb = ctx?.getThumbnailUrl?.('persona', avatarId) ?? null; } catch { thumb = null; }
    const full = `User Avatars/${avatarId}`;
    for (const img of document.querySelectorAll('img')) {
        // Ours already carry the new token: they were painted from thumbnailUrl.
        if (img.closest('[id^="pm-"], [class*="pm-"]')) continue;
        const src = img.getAttribute('src');
        if (!src) continue;
        const bare = withoutToken(src);
        let decoded = bare;
        try { decoded = decodeURI(bare); } catch { /* compared as written */ }
        if (bare !== thumb && !decoded.endsWith(full)) continue;
        img.setAttribute('src', withToken(bare, token));
    }
}

export function thumbnailUrl(ctx, avatarId) {
    if (!avatarId || typeof ctx?.getThumbnailUrl !== 'function') return null;
    let url;
    try {
        url = ctx.getThumbnailUrl('persona', avatarId);
    } catch { return null; }
    const bump = thumbBumps.get(avatarId);
    if (!url || !bump) return url ?? null;
    return withToken(url, bump);
}

// Every redraw goes through here. One tap fires two or three (PERSONA_UPDATED, the
// commit path, a debounced SETTINGS_UPDATED), and each rebuild would reset the list's
// scroll and focus. One frame absorbs the burst.
function scheduleDraw() {
    drawTask.schedule();
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
    const img = el('img', 'pm-quickbar-img');
    img.alt = '';
    /* Shown when there is no picture: with the label hidden by style.css, the icon
       would otherwise collapse and vanish from the send row. Uses SillyTavern's
       FontAwesome; without it the min-size rule still reserves the box. */
    const fallback = el('span', 'pm-quickbar-fallback fa-solid fa-user');
    fallback.setAttribute('aria-hidden', 'true');
    btn.append(img, fallback, el('span', 'pm-quickbar-label'));
    host.append(btn);

    // Click only: opening on touchstart lets the synthesized click land on whatever
    // the panel just put under the finger.
    btn.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });
    btn.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        // SillyTavern's document keydown turns Enter on an .interactable into a
        // click, which would close the panel again.
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); togglePanel(); }
    });
    return btn;
}

// The avatar shape as a class on a node; shared by the panel, manager and icon.
export function applyShapeClass(node) {
    if (!node) return;
    const stored = getRoot()?.settings?.rosterTileShape;
    const shape = TILE_SHAPES.includes(stored) ? stored : 'circle';
    for (const known of TILE_SHAPES) node.classList.toggle(`pm-tileshape-${known}`, known === shape);
}

function paintButton(ctx, btn) {
    const s = getState();
    // The icon sits outside both panels, so it cannot inherit --pm-avatar-radius.
    applyShapeClass(btn);
    const img = btn.querySelector('.pm-quickbar-img');
    const label = btn.querySelector('.pm-quickbar-label');
    const avatar = s?.avatar ?? null;
    const url = thumbnailUrl(ctx, avatar);
    // Assigned only when it differs: this repaints on every pm:changed, mostly
    // with the same URL.
    const fallback = btn.querySelector('.pm-quickbar-fallback');
    if (url) {
        if (img.getAttribute('src') !== url) img.src = url;
        img.hidden = false;
        if (fallback) fallback.hidden = true;
    } else {
        img.removeAttribute('src');
        img.hidden = true;
        if (fallback) fallback.hidden = false;
    }
    const title = describeSelection(s?.persona ?? null);
    label.textContent = title;
    // The phone's send row gives this a 28px slot, so style.css hides the label; the
    // text rides on the tooltip and accessible name instead.
    btn.title = title;
    btn.setAttribute('aria-label', STRINGS.quick.iconAria(title));
}

function syncButton() {
    const ctx = freshContext();
    const s = getState();
    const existing = document.getElementById(BUTTON_ID);
    if (s && s.settings?.showQuickBar === false) {
        // Only an open panel: closePanel releases the toast container, which
        // would pull it out of an open manager on every state change.
        if (isPanelOpen()) closePanel();
        existing?.remove();
        return;
    }
    const host = document.getElementById('leftSendForm');
    if (!host) return;
    const btn = existing ?? buildButton(host);
    paintButton(ctx, btn);
    if (document.getElementById(PANEL_ID)) scheduleDraw();
}

/* Panel shell */

// Gap between the panel and the visible bottom edge; matches the bottom in style.css,
// which applies until this runs.
const PANEL_GAP_PX = 12;

// One geometry write per frame: visualViewport fires scroll continuously while the
// keyboard pans the page, and each write forces a layout.
const sizeTask = frameTask(() => sizeToViewport());
function scheduleSize() {
    sizeTask.schedule();
}

/* Last values written to the panel, so unchanged ones are skipped: each style write
   invalidates layout and the following clientHeight read then reflows the whole chat,
   on every visualViewport scroll and resize. */
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
    // Same for the position: a fixed element sits against the layout viewport, which
    // ignores the keyboard. The visible bottom is offsetTop + height below the layout
    // top, so we offset by its distance from the layout bottom.
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

// Exported so closing the manager steps back to this panel, not a copy of its own.
export function openPanel() {
    if (document.getElementById(PANEL_ID)) return;
    // A new panel element has none of the old one's inline geometry.
    forgetSizing();
    bannerDismissed = false;
    // A fold opened while the data was unwritable belongs to that panel, not the
    // stored choice.
    versionOpenOverride = null;
    namesOpenOverride = null;
    editMode = false;
    selectMode = false;
    selectedAvatars = [];
    expandedAvatar = null;
    // A new panel may repeat the empty-section toast once.
    lastMissing = null;
    // A deferral left from the previous panel would swallow this one's first redraw.
    drawDeferred = false;
    panelAvatar = getState()?.avatar ?? null;

    const backdrop = el('div', 'pm-quickbar-backdrop');
    backdrop.id = BACKDROP_ID;
    // pm-grain is a fixed overlay on the panel, not on the scrolling content, so it
    // composites once.
    const panel = el('div', 'pm-panel pm-quickbar-panel pm-grain');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');

    blockDrawerClose(backdrop);
    blockDrawerClose(panel);
    // blockDrawerClose only stops propagation; this same-node listener still runs.
    backdrop.addEventListener('click', () => closePanel());

    // A modal dialog: some themes put a transform on an ancestor, which makes it the
    // containing block for position:fixed and pushes the panel off screen. The top
    // layer ignores ancestor transforms; style.css places backdrop and panel inside.
    const host = document.createElement('dialog');
    host.id = HOST_ID;
    host.className = 'pm-quickbar-host';
    host.tabIndex = -1;
    blockDrawerClose(host);
    // Native ESC fires cancel; route it through closePanel so cleanup has one path.
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
        // Android fires scroll, not resize, when the visual viewport pans to bring a
        // focused field above the keyboard.
        track(panelCleanups, globalThis.visualViewport, 'scroll', scheduleSize);
    }
    // Non-modal fallback only: a modal dialog gets cancel for ESC and Android back,
    // and a document listener would also catch the ESC that dismisses a SillyTavern
    // popup over us. Even here, only while focus is inside our host.
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

// Text with its match against `query` marked, drawn in the NFC form matchRanges
// indexes so decomposed names cannot skew it. Text nodes only, never innerHTML.
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

// The one pager every paged list draws.
export function pagerRow(page, pages, onPrev, onNext) {
    if (pages <= 1) return null;
    const row = el('div', 'pm-pager');
    row.append(
        button('pm-quickbar-btn', STRINGS.common.pagePrev, onPrev, page > 1),
        el('span', 'pm-pager-count', STRINGS.common.pageOf(page, pages)),
        button('pm-quickbar-btn', STRINGS.common.pageNext, onNext, page < pages));
    return row;
}

// The manager asks when it opens: it returns to this panel only if it replaced it.
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
    sizeTask.cancel();
    panelAvatar = null;
    // Panel local UI state, gone with the panel.
    rosterSearchOpen = false;
    rosterQuery = '';
    rosterPage = 1;
    rosterLang = null;
    rosterTags = [];
    rosterVisible = [];
    versionToolsAt = null;
    // Removing a focused input does not reliably fire blur, so the deferral's
    // one-shot listener may never run to clear this.
    drawDeferred = false;
    // A queued frame would find no panel anyway, but a stale one would block the next
    // scheduleDraw.
    drawTask.cancel();
    rosterListTask.cancel();
}

/* Writes */

// Every action starts here: if the active persona is no longer the expected one, stop
// before touching anything. Across an await, callers pass the avatar they read before
// it, because a redraw during a popup re-adopts panelAvatar to the new persona.
function guardAvatar(expected = panelAvatar) {
    const s = getState();
    if (!s || s.avatar !== expected) {
        notify('error', STRINGS.common.personaChanged);
        closePanel();
        return null;
    }
    return writableOrSay(s);
}

/* Buttons are disabled when the persona is ambiguous or the data is from a newer
   build, but a draw can be deferred and a stale button tapped. Writers mutate the
   persona before commit, whose refusal would not undo it, so the guards ask too. */
function writableOrSay(s) {
    if (rosterWritable(s)) return s;
    notify('error', s.readOnly ? STRINGS.common.readOnly : STRINGS.quick.ambiguous);
    scheduleDraw();
    return null;
}

// force defaults on for a version apply: with an outside edit pending, state.js keeps
// SillyTavern's text when the composition is unchanged, but this tap must write it.
function commit(kind, detail, { outside, force } = {}) {
    // Read before the save; the log line is added only once the write is accepted.
    const persona = getState()?.persona ?? null;
    const result = saveAndCompose(panelAvatar, {
        write: !KEEP_DESCRIPTION_KINDS.has(kind),
        outside,
        force: force ?? kind === 'version-apply',
    });
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
    if (result.keptOutside) notify('warning', STRINGS.common.outsideKept(result.keptOutside.section));
    // A kept description emits no PERSONA_UPDATED, so the icon, which shows the
    // version name, needs its pm:changed from here.
    if (result.kept && typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('pm:changed'));
    // The banner always shows empty sections; the toast fires only when the set
    // changes, so a section left empty on purpose does not toast on every tap.
    const signature = missingSignature(result.missing);
    if (signature !== lastMissing) {
        if (result.missing?.length) notify('warning', STRINGS.common.emptyItems(result.missing.length));
        lastMissing = signature;
    }
    scheduleDraw();
    return true;
}

/* SillyTavern popups */

// Our screens are top-layer modal dialogs. A SillyTavern popup drawn as a <dialog>
// joins the top layer above us; one drawn as a div sits inert under our host and its
// await never settles. So the first popup is probed: unless a foreign dialog[open]
// appears and stays open, our host is closed while each popup (that one too) is up.
// Our own hosts are told apart by the pm- id prefix.
const POPUP_PROBE_TURNS = 3;

// A sentinel, since a popup may legitimately resolve with undefined or false.
const POPUP_STUCK = Symbol('popup-stuck');

function openDialogs(ours) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
    const all = [...document.querySelectorAll('dialog[open]')];
    return all.filter(node => String(node.id ?? '').startsWith('pm-') === ours);
}

// The topmost of our open hosts: the manager opens over the quick panel, so the
// last one in document order is the one covering the popup.
function ourOpenHost() {
    const hosts = openDialogs(true);
    return hosts[hosts.length - 1] ?? null;
}

function dropHost(host) {
    // Closing lifts the top layer's inertness so a div popup can be tapped. Toasts go
    // back to body first, or they would sit in a dialog that is no longer painted.
    releaseToasts();
    if (!host || !host.isConnected || typeof host.close !== 'function') return false;
    // Marked, so the manager's close listener can tell this close from one that
    // means the screen is gone (manager.js); raiseHost takes the mark off.
    host.dataset.pmDropped = '1';
    try { host.close(); return true; } catch { delete host.dataset.pmDropped; return false; }
}

function raiseHost(host) {
    // Only if still in the document: the screen may have closed during the popup.
    if (host) delete host.dataset.pmDropped;
    if (!host || !host.isConnected || host.open || typeof host.showModal !== 'function') return;
    try { host.showModal(); } catch { host.setAttribute('open', ''); }
}

// Waits for a popup believed to need no drop. Unanswered past POPUP_STUCK_MS with
// no foreign dialog open means the verdict was wrong: drop our host once and keep
// waiting. Checked over POPUP_STUCK_CHECKS windows, as a foreign dialog defers it.
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
                // Kept for the session, so later popups drop at once.
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
    if (probePromise) {
        await probePromise;
        return runMeasuredPopup(start);
    }

    const host = ourOpenHost();
    // Dialogs already open (another extension's) must not count as the popup.
    const before = new Set(openDialogs(false));
    const pending = start();
    // Published before the first await, so a caller one turn behind waits for this
    // measurement instead of starting a second one.
    let measured;
    probePromise = new Promise(resolve => { measured = resolve; });
    try {
        // Several scheduler turns, so a build that renders its dialog a frame late
        // is not recorded as a div build.
        const during = new Set();
        for (let turn = 0; turn <= POPUP_PROBE_TURNS; turn++) {
            for (const dialog of openDialogs(false)) during.add(dialog);
            if (turn < POPUP_PROBE_TURNS) await new Promise(resolve => schedulerTurn(resolve));
        }
        popupNeedsDrop = !popupVerdict({ before, during, openAtEnd: new Set(openDialogs(false)) });
    } finally {
        // Released even if the probe throws, or later popups would wait forever.
        measured();
    }

    if (!popupNeedsDrop) return awaitPopup(pending, host);

    // Applied to the popup already in flight too, or the first one would hang.
    const dropped = dropHost(host);
    try { return await pending; }
    finally { if (dropped) raiseHost(host); }
}

// Only without callGenericPopup: a browser that blocks dialogs answers prompt with
// null and confirm with false, indistinguishable from a no, so the user is told.
function fallbackBlocked() {
    notify('info', STRINGS.common.popupBlocked);
}

/* SillyTavern's popup inserts a string with innerHTML (a name holding <...> becomes
   markup) and .popup-content collapses line breaks; a text element keeps both. */
function popupContent(message) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return message;
    const box = document.createElement('div');
    box.style.whiteSpace = 'pre-line';
    box.textContent = String(message ?? '');
    return box;
}

export async function askConfirm(message) {
    // POPUP_TYPE's member names are not guaranteed, so they are checked at runtime.
    const ctx = freshContext();
    if (typeof ctx?.callGenericPopup === 'function' && ctx.POPUP_TYPE?.CONFIRM !== undefined) {
        return !!(await runPopup(() => ctx.callGenericPopup(popupContent(message), ctx.POPUP_TYPE.CONFIRM)));
    }
    if (typeof globalThis.confirm !== 'function') { fallbackBlocked(); return false; }
    const answer = globalThis.confirm(message);
    if (!answer) fallbackBlocked();
    return !!answer;
}

// Picks from a known list via the text popup (there is no picker type). Options are
// numbered: a number is easier to type than an exact Korean name. Answers by position,
// as two groups may share a name; -1 means cancel or no match. Empty options are dropped.
async function askChoiceIndex(message, options) {
    const list = (options ?? []).filter(o => typeof o === 'string' && o.length);
    if (!list.length) return -1;
    const menu = list.map((o, i) => `${i + 1}. ${o}`).join('\n');
    const answer = await askText(`${message}\n${menu}`, '1');
    if (answer === null) return -1;
    const trimmed = String(answer).trim();
    // The exact name first: a tag literally named 3 must not be read as position 3,
    // and a bulk tag removal has no undo.
    const named = list.indexOf(trimmed);
    if (named !== -1) return named;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return n - 1;
    // Neither: without a notice this would look like a cancel to the user.
    notify('info', STRINGS.quick.choiceNoMatch);
    return -1;
}

// askChoiceIndex answering with the option itself, or null.
export async function askChoice(message, options) {
    const list = (options ?? []).filter(o => typeof o === 'string' && o.length);
    const index = await askChoiceIndex(message, list);
    return index === -1 ? null : list[index];
}

export async function askText(message, initial) {
    const ctx = freshContext();
    if (typeof ctx?.callGenericPopup === 'function' && ctx.POPUP_TYPE?.INPUT !== undefined) {
        const value = await runPopup(() => ctx.callGenericPopup(popupContent(message), ctx.POPUP_TYPE.INPUT, initial ?? ''));
        return typeof value === 'string' ? value : null;
    }
    if (typeof globalThis.prompt !== 'function') { fallbackBlocked(); return null; }
    const value = globalThis.prompt(message, initial ?? '');
    if (value === null) fallbackBlocked();
    return value;
}

// The version is looked up on the persona written to, never carried over: its picks
// on another persona would replace that one's variant ids and empty its text.
async function applyVersion(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const startAvatar = s.avatar;
    if (!versionApplicable(s.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    // A repeat tap on the applied row does nothing (its picture may be uploading),
    // unless an outside edit is pending: applying puts the version's text back.
    if (!s.diverged && versionAlreadyApplied(s.persona, versionId) && pictureSettled(s.persona, versionId)) return;
    const after = guardAvatar(startAvatar);
    if (!after?.persona) return;
    // Asked of the persona actually written to; a matching avatar is not enough.
    if (!versionApplicable(after.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    const version = findVersion(after.persona, versionId);
    // The picture follows only an accepted write: otherwise the avatar would show a
    // combination the prompt lacks, and the one pre-overwrite backup would be spent.
    if (!applyVersionPicks(after.persona, version, () => commit('version-apply', version.name ?? ''))) return;
    // The picture follows on its own; a failed picture never undoes the version.
    void runBoundImageFromPanel(startAvatar, versionId);
}

/* The per-version image write, shared by both screens; only the messages live in the
   callers. Everything is re-read after the await: applyBoundImage makes three round
   trips, and a settings import meanwhile installs a whole new root. */
export async function runBoundImageWrite(avatarId, versionId, force, known) {
    const before = getRoot();
    if (!before || before.readOnly) return null;
    const first = getPersona(before, avatarId);
    const version = findVersion(first, versionId);
    const label = boundAsset(version);
    if (!label) return null;
    // The crop goes with the picture: the server cuts it, and avatarWritten
    // records the label and the crop.
    const crop = validCrop(version?.avatarCrop);
    const ctx = freshContext();
    if (!ctx) return null;
    const now = Date.now();
    const result = await applyBoundImage({
        ctx, root: before, persona: first, avatarId, label, exact: bindingIsExact(version), crop, force, known, now,
    });
    if (!result.ok) {
        /* A failure after the backup step left that backup on the server, so it is
           recorded or it becomes unreachable. avatarWritten is untouched: the avatar
           file was not written, and saying so would make the next apply skip. */
        const failed = getRoot();
        const kept = failed && !failed.readOnly ? getPersona(failed, avatarId) : null;
        if (result.backup && kept && !kept.avatarBackup) {
            kept.avatarBackup = result.backup;
            addLog(kept, 'image-apply', result.backup.label, Date.now());
            freshContext()?.saveSettingsDebounced?.();
        }
        return result;
    }
    // The picture changed either way: tell every screen before any early return.
    personaImageChanged(avatarId);
    const root = getRoot();
    const persona = root && !root.readOnly ? getPersona(root, avatarId) : null;
    if (!persona) {
        // Written but unrecordable: reported, since a backup may be spent and
        // the next apply will take another.
        return { ...result, backedUp: !!result.backup, unrecorded: true };
    }
    // The backup record stops the next apply taking another, which would hold this
    // replacement instead of the original picture.
    if (result.backup && !persona.avatarBackup) persona.avatarBackup = result.backup;
    persona.avatarWritten = writtenKey(label, crop);
    // Stamped when the write finished, so it sorts after edits made meanwhile.
    addLog(persona, 'image-apply', label, Date.now());
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
    return { ...result, backedUp: !!result.backup };
}

// The panel's half: this screen closes on apply, so only failures get a message.
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
    const startAvatar = s.avatar;
    const name = await askText(STRINGS.common.newVersionName, '');
    if (!name || !name.trim()) return;
    const after = guardAvatar(startAvatar);
    if (!after?.persona) return;
    const version = addVersion(after.persona, name.trim(), freshContext()?.uuidv4, Date.now());
    commit('version-create', version.name);
}

function revertOutsideEdit() {
    const s = guardAvatar();
    if (!s?.persona) return;
    // Rewrites the composed text, which resets the diverged baseline. The outside
    // text is kept first as a choice (state.js keepOutsideText). Forced, as the
    // composition did not change.
    commit('diverge-revert', '', { outside: 'keep', force: true });
}

// The own-format closing line at the very end, stripped like the leading heading.
function stripTrailingLine(text, closing) {
    const source = String(text ?? '');
    if (!closing) return source;
    const trimmed = source.replace(/\s+$/, '');
    if (!trimmed.endsWith(closing)) return source;
    const rest = trimmed.slice(0, -closing.length);
    if (rest && !/\n[ \t]*$/.test(rest)) return source;
    return rest.replace(/\s+$/, '');
}

function stripLeadingHeading(text, heading) {
    const source = String(text ?? '');
    if (!heading) return source;
    const trimmed = source.replace(/^\s+/, '');
    if (!trimmed.startsWith(heading)) return source;
    const rest = trimmed.slice(heading.length);
    // Whole lines only, so a heading never eats the start of text beginning with it.
    if (rest && !/^[ \t]*(\r?\n|$)/.test(rest)) return source;
    return rest.replace(/^[ \t]*\r?\n/, '');
}

function absorbOutsideEdit() {
    const s = guardAvatar();
    if (!s?.persona) return;
    const text = freshContext()?.powerUserSettings?.persona_descriptions?.[s.avatar]?.description ?? '';
    const sections = s.persona.sections ?? [];
    /* The outside edit goes back into the items. With several filled items it is
       split along the composed title lines (splitByComposition), refused if one is
       missing or out of order; otherwise it all goes into the filled item, or the
       first, as import does. */
    const liveBody = sec => liveVariant(s.persona, sec);
    const filled = sections.filter(sec => !!(liveBody(sec)?.text ?? '').trim());
    if (filled.length > 1) {
        // With no titles printed (the default) there is nothing to divide along.
        if (!headingLine(s.persona.headingFormat, 'x', s.persona.headingTemplate)) {
            notify('warning', STRINGS.quick.absorbNoTitles);
            return;
        }
        const parts = splitByComposition(s.persona, text);
        if (!parts) { notify('warning', STRINGS.quick.absorbNoMatch); return; }
        const now = Date.now();
        const changed = [];
        for (const part of parts) {
            const section = sections.find(sec => sec.id === part.sectionId);
            const variant = section ? liveBody(section) : null;
            if (!variant || (variant.text ?? '') === part.text) continue;
            // Into history first, forced past the merge window, as below.
            snapshot(s.persona, variant.id, variant.text ?? '', now, s.settings, { force: true });
            variant.text = part.text;
            variant.updatedAt = now;
            changed.push(section.name ?? '');
        }
        expireOldHistory(s.root, s.settings, now);
        enforceGlobalBudget(s.root, s.settings, now);
        commit('diverge-absorb', changed.join(', '), { outside: 'discard' });
        return;
    }
    const target = filled[0] ?? sections[0] ?? null;
    const variant = target ? liveBody(target) : null;
    if (!target || !variant) { notify('error', STRINGS.quick.absorbNoItem); return; }
    const now = Date.now();
    // The overwritten text goes into history first; forced, because inside the merge
    // window a plain snapshot is skipped.
    snapshot(s.persona, variant.id, variant.text ?? '', now, s.settings, { force: true });
    // The per-variant cap does not bound the total in settings.json, and a
    // snapshot is the only time it grows, so the global cap is enforced here.
    expireOldHistory(s.root, s.settings, now);
    enforceGlobalBudget(s.root, s.settings, now);
    // The outside text is composed, so it carries this item's heading; stored as is,
    // every absorb would stack one more.
    const format = s.persona.headingFormat;
    const name = target.name ?? '';
    variant.text = target.untitled ? text : stripTrailingLine(
        stripLeadingHeading(text, headingLine(format, name, s.persona.headingTemplate)),
        closingLine(format, name, s.persona.headingTemplate));
    variant.updatedAt = now;
    commit('diverge-absorb', target.name ?? '', { outside: 'discard' });
}

// Label and settings writes are not tied to the persona the panel opened on, so they
// skip guardAvatar and check only rosterWritable.
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
    /* The checkbox already shows the change. Redraw only under a group filter (the
       persona may leave the list) or when the group's chip appears or disappears. */
    const filtering = (s.root.settings?.activeLabelId ?? null) !== null;
    if (filtering || (before === 0) !== (living(label) === 0)) scheduleDraw();
}

/* Group edit: a row tap opens that persona's group ticks under it, moved in place.
   Text in the closing editor's new-group field forces a full draw, which keeps it. */
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
    const id = makeId(freshContext()?.uuidv4);
    if (!Array.isArray(s.root.labels)) s.root.labels = [];
    s.root.labels.push({ id, name: trimmed, members: [] });
    // A label made in a row's editor joins that persona at once, so none is empty.
    toggleMember(s.root.labels, id, avatarId);
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

// Bumped by every switchPersona call; an older number means that call was overtaken.
let switchSeq = 0;

/* Also how a rename reaches the chat: name1, read by the chat and {{user}}, keeps the
   old name until the persona is re-selected. The automatic rename passes closeOnDone
   false, since the user may be reading the panel, and quiet, which silences toasts
   but still returns the result. */
async function switchPersona(avatar, name, { closeOnDone = true, quiet = false } = {}) {
    /* Who started last wins: a slow switch gets tapped again, and the first call's
       retry would pull the user back. A superseded call stops: no retry, no report,
       no closing the panel. */
    const my = ++switchSeq;
    const current = () => my === switchSeq;
    const say = (kind, message) => { if (!quiet) notify(kind, message); };
    // Read now: the row's name is from its draw, which a rename can outdate. The
    // argument is only the fallback for a persona the map has forgotten.
    const wanted = freshContext()?.powerUserSettings?.personas?.[avatar] ?? name;
    if (freshContext()?.name1 === wanted && (getState()?.avatar ?? null) === avatar) {
        if (closeOnDone) closePanel();
        return true;
    }

    const finish = () => {
        // Verified by name only, so duplicate names get a warning. A superseded
        // call still landed, but must not talk or close the newer switch's panel.
        if (!current()) return true;
        if ((getState()?.duplicateNames ?? []).includes(wanted)) {
            say('warning', STRINGS.quick.switchAmbiguous(wanted));
        }
        if (closeOnDone) closePanel();
        return true;
    };

    // Every attempt is judged by this poll: SillyTavern finishes the swap after the
    // command resolves, so name1 read right after the await gives false failures.
    const landed = () => waitFor(() => freshContext()?.name1 === wanted);

    // Tried first: it switches by file, while the commands below resolve by name,
    // which fails before a rename reaches SillyTavern. Without it, fall through.
    const api = getPreciseApi();
    if (api && typeof api.setUserAvatar === 'function') {
        try { await api.setUserAvatar(avatar); } catch (e) { console.warn(`[${MODULE_NAME}] setUserAvatar failed`, e); }
        if (await landed()) return finish();
        if (!current()) return false;
    }

    // Discovered, never hardcoded: command names differ between builds.
    const command = pickPersonaCommand(freshContext()?.SlashCommandParser?.commands);
    if (!command) {
        say('error', STRINGS.quick.noSwitchCommand);
        return false;
    }
    const run = async text => {
        try { await freshContext()?.executeSlashCommandsWithOptions(text); }
        catch (e) { console.warn(`[${MODULE_NAME}] ${text} failed`, e); }
    };

    // The mode argument's allowed values are unknown, so the first attempt omits it.
    await run(`/${command} ${quoteArg(wanted)}`);
    if (await landed()) return finish();
    if (!current()) return false;
    await run(`/${command} mode=lookup ${quoteArg(wanted)}`);
    if (await landed()) return finish();
    if (!current()) return false;

    // Reported only once both waits have expired.
    say('error', STRINGS.quick.switchFailed(wanted));
    return false;
}

/* ── Persona names ───────────────────────────────────────────────────────────
   One rename path for the manager and the automatic rule. Both halves matter: the
   map is what the roster and other extensions read, name1 what the chat and {{user}}
   use. Answers {ok, reason} instead of toasting, so each caller words the failure. */
/* SillyTavern's own rename (/persona-update persona= name=), so all that SillyTavern
   does on a rename happens. Verified: the map must carry the new name, and name1
   must follow for the persona being played. */
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
    // Polled: SillyTavern finishes after the command resolves, as with a switch.
    const renamed = await waitFor(
        () => freshContext()?.powerUserSettings?.personas?.[avatar] === to);
    if (!renamed) return { ok: false, reason: 'not-renamed' };
    if (!toChat) return { ok: true, reason: 'listed' };
    // The rename should carry name1 for the persona being played; switch only if not.
    if (await waitFor(() => freshContext()?.name1 === to)) return { ok: true, reason: 'applied' };
    // Only a switch can make the chat follow now, so never for a persona the user
    // has since left: the automatic rename gets here by itself and would switch back.
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
    // The duplicate-name rule, checked here too: a button reaches this as well.
    for (const [key, other] of Object.entries(personas)) {
        if (key !== avatar && other === name) return { ok: false, reason: 'taken' };
    }
    // SillyTavern's rename also moves name1: right for the chat scope, wrong for the
    // list scope, which writes only the map entry below.
    if (toChat) {
        const own = await renameThroughSillyTavern(avatar, previous, name, toChat, quiet);
        if (own.ok) return { ...own, previous };
        if (own.reason === 'switch-failed') return { ok: false, reason: 'switch-failed', previous };
    }

    // List scope, or the fallback when /persona-update did nothing: write the map.
    personas[avatar] = name;
    ctx.saveSettingsDebounced();
    // The list scope stops here: re-selecting would switch the user to this persona.
    if (!toChat) return { ok: true, reason: 'listed', previous };
    // As in renameThroughSillyTavern: no switch for a persona the user has left.
    if ((getState()?.avatar ?? null) !== avatar) return { ok: true, reason: 'listed', previous };
    const landed = await switchPersona(avatar, name, { closeOnDone, quiet });
    if (landed) return { ok: true, reason: 'applied', previous };
    // Put it back: a map that disagrees with the chat is worse than no rename.
    const back = freshContext()?.powerUserSettings?.personas;
    if (back && back[avatar] === name) back[avatar] = previous;
    freshContext()?.saveSettingsDebounced?.();
    return { ok: false, reason: 'switch-failed', previous };
}

/* Automatic per-language name: the chat's language decides, via pure pickAutoName.
   Debounced, since a rendered message, a settings save and a persona update arrive
   together and this ends in a persona switch. Off unless the user turned it on. */
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
    // Also calls off a run already inside its command: that cannot be recalled,
    // but its log line, save and toast are skipped.
    autoNameGen += 1;
}

// One run at a time: two renames racing over one persona would let the loser's
// rollback undo the winner's write.
let autoNameRunning = false;

async function runAutoName() {
    if (autoNameRunning) return;
    const root = getRoot();
    if (!root || root.readOnly || !root.settings?.autoLocalName) return;
    const s = getState();
    // ambiguous: the active persona is unknowable, so any rename would be a guess.
    if (!s || s.ambiguous || !s.avatar || !s.persona) return;
    const ctx = freshContext();
    const lang = conversationLanguage(ctx);
    const name = pickAutoName({
        persona: s.persona,
        lang,
        avatar: s.avatar,
        personas: ctx?.powerUserSettings?.personas,
    });
    if (!name) return;
    // A name clash with the character: a button can warn, but an automatic rule has
    // nobody to ask, so it declines.
    if (nameCollides({ name, characterName: ctx?.name2, chat: ctx?.chat })) return;
    const avatar = s.avatar;
    const gen = autoNameGen;
    autoNameRunning = true;
    let result;
    try {
        result = await applyPersonaName(avatar, name, { closeOnDone: false, quiet: true });
    } finally {
        // In a finally, or a throw would leave the feature off for the session.
        autoNameRunning = false;
    }
    if (!result?.ok) return;
    // Called off while the command was out. See cancelAutoName.
    if (gen !== autoNameGen) return;
    // Logged, since nobody asked for this rename.
    const persona = getPersona(getRoot(), avatar);
    if (persona) {
        addLog(persona, 'name-auto', `${STRINGS.common.languageNames[lang] ?? lang}: ${name}`, Date.now());
        freshContext()?.saveSettingsDebounced?.();
    }
    notify('info', STRINGS.quick.autoNameApplied(name));
}

/* Panel content */

// Start managing from this panel. A split into several items is announced, since this
// panel shows no items.
function adoptHere() {
    // A repeat or stale tap finds it managed already: nothing imported or announced.
    if (getState()?.persona) { scheduleDraw(); return; }
    const s = adopt();
    const count = itemsWithText(s?.persona);
    if (count > 1) notify('success', STRINGS.common.adoptSplit(count));
}

function groupOf(title) { return sharedGroup('pm-quickbar', title); }

function rowOf(text, onClick) {
    const row = el('div', 'pm-row pm-quickbar-row');
    row.append(el('span', 'pm-quickbar-name', text));
    if (onClick) makeRowActivatable(row, onClick);
    else row.classList.add('pm-disabled');
    return row;
}

function bannerOf(className, message) { return sharedBanner('pm-quickbar', className, message); }

function divergedBanner(writable) {
    const box = bannerOf('pm-quickbar-warn', STRINGS.quick.divergedBanner);
    const actions = el('div', 'pm-quickbar-actions');
    const handlers = {
        revert: () => revertOutsideEdit(),
        absorb: () => absorbOutsideEdit(),
        later: () => { bannerDismissed = true; scheduleDraw(); },
    };
    // Gated here: absorb overwrites the variant text before commit, whose refusal
    // would not undo it.
    for (const action of divergedActions(writable)) {
        const btn = el('button', 'pm-quickbar-btn', action.label);
        if (action.enabled) btn.addEventListener('click', handlers[action.key]);
        else disable(btn);
        actions.append(btn);
    }
    box.append(actions);
    return box;
}

function currentGroup(ctx, s) {
    // One solid shape, like the manager header (style.css, The liquid edge).
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

/* The version group folds; its open state is a stored preference. The override lets a
   read-only root still fold, since folding changes no data. */
let versionOpenOverride = null;

function versionOpen(s) {
    if (versionOpenOverride !== null) return versionOpenOverride;
    return !!s?.root?.settings?.quickVersionOpen;
}

/* ── One group or one row, redrawn in place ──────────────────────────────────
   A fold, a version's [⋯] and a select-mode tick rebuild only their own group or row.
   A queued full draw, a field being typed in, or a persona change since the draw
   take the full draw instead. */
const groupNodes = new Map();

function liveGroupArgs() {
    const s = getState();
    return [s, rosterWritable(s)];
}

function inPlaceAllowed() {
    if (drawTask.pending() || drawDeferred) return false;
    const s = getState();
    return !!s && s.avatar === panelAvatar;
}

// Controls a keyboard can land on, in document order.
const focusablesIn = node => [...node.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')];

function redrawGroup(name) {
    if (!inPlaceAllowed()) return false;
    const entry = groupNodes.get(name);
    if (!entry || !entry.node.isConnected) return false;
    // Focus moves to the same control in the new group, or replaceWith would drop it.
    const focused = typeof document !== 'undefined' && entry.node.contains(document.activeElement) ? document.activeElement : null;
    const at = focused ? focusablesIn(entry.node).indexOf(focused) : -1;
    const fresh = entry.build();
    entry.node.replaceWith(fresh);
    entry.node = fresh;
    if (at !== -1) focusablesIn(fresh)[at]?.focus?.({ preventScroll: true });
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
    // The select-all / clear label follows what is picked on screen.
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
        // No save of its own: a save posts all extensions' settings (several MB),
        // and the value rides along with the next one.
    } else {
        versionOpenOverride = next;
    }
    if (!redrawGroup('version')) scheduleDraw();
}

/* Folds like the manager. The head itself is the control, not a button around the
   title: a button's own box pushed the title out of line with the roster head's. */
function foldHead(title, open, onToggle) {
    const head = el('div', 'pm-quickbar-head pm-quickbar-foldhead');
    head.append(el('span', 'pm-quickbar-headlabel', title));
    head.append(el('span', 'pm-quickbar-foldmark', open ? '↑' : '↓'));
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.addEventListener('click', onToggle);
    // A div needs its own keys; preventDefault stops Space from scrolling the page.
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
        // Row and [⋯] are siblings: nested, a keypress on [⋯] would bubble into
        // the row's Enter handler and apply the version.
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

/* ── Version tools ───────────────────────────────────────────────────────────
   [⋯] opens a row's tools in place as real buttons, since a typed digit is slow on
   a phone. One row at a time, and only on the persona it was opened for. */
let versionToolsAt = null;

/* Duplicate and move redraw the list, putting another version's row under the finger,
   so a row tap this soon after a tool counts as the tool's double tap. Android's
   double-tap timeout is 300ms; 500 covers a slow one. */
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
    const btn = button('pm-quickbar-btn pm-quickbar-vmore', '⋯', () => toggleVersionTools(version.id), writable);
    btn.setAttribute('aria-label', STRINGS.quick.versionToolsAria(version.name ?? ''));
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
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
        const run = () => { toolTappedAt = Date.now(); action(); };
        bar.append(button(`pm-quickbar-btn${danger ? ' pm-manager-danger' : ''}`, label, run, writable && enabled));
    }
    return bar;
}

async function renameVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const startAvatar = s.avatar;
    const name = await askText(STRINGS.manager.versionName, findVersion(s.persona, versionId)?.name ?? '');
    if (!name || !name.trim()) return;
    const after = guardAvatar(startAvatar);
    if (!after?.persona) return;
    const version = renameVersionIn(after.persona, versionId, name, Date.now());
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-rename', version.name);
}

async function overwriteVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const startAvatar = s.avatar;
    const name = findVersion(s.persona, versionId)?.name ?? '';
    if (!(await askConfirm(STRINGS.manager.confirmOverwriteVersion(name)))) return;
    const after = guardAvatar(startAvatar);
    if (!after?.persona) return;
    const version = overwriteVersionPicks(after.persona, versionId, Date.now());
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-overwrite', version.name ?? '');
}

function duplicateVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const uuid = freshContext()?.uuidv4;
    const copy = duplicateVersionIn(s.persona, versionId, uuid, Date.now());
    if (!copy) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    // The tools move to the copy, which is usually renamed or changed next.
    versionToolsAt = { avatar: s.avatar, id: copy.id };
    commit('version-duplicate', copy.name);
}

function shiftVersionFromPanel(versionId, delta) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const name = findVersion(s.persona, versionId)?.name ?? '';
    if (!moveVersion(s.persona, versionId, delta)) return;
    commit('version-move', name);
}

async function dropVersionFromPanel(versionId) {
    const s = guardAvatar();
    if (!s?.persona) return;
    const startAvatar = s.avatar;
    const name = findVersion(s.persona, versionId)?.name ?? '';
    if (!(await askConfirm(STRINGS.manager.confirmDropVersion(name)))) return;
    const after = guardAvatar(startAvatar);
    if (!after?.persona) return;
    if (!dropVersionFrom(after.persona, versionId)) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    versionToolsAt = null;
    commit('version-delete', name);
}

/* ── Per-language names ──────────────────────────────────────────────────────
   No scope choice, unlike the manager: this panel only shows the persona being
   played, and renaming just its list entry would break personas[avatar] === name1,
   which identifies the active persona. */
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
        // No save of its own, as in toggleVersionOpen.
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
    // On acts on the current chat right away; off cancels whatever was queued.
    if (s.root.settings.autoLocalName) scheduleAutoName();
    else cancelAutoName();
    scheduleDraw();
}

/* One tap applies (undone by tapping another language, and logged); only a name the
   chat already uses asks first. One at a time, like runAutoName: the flag also covers
   that question's await, and a finally keeps a throw from disabling the rows. */
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
    // The persona being played may have changed during the question.
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

// A native select like the sort control: the Android picker beats a custom row here.
function viewSelect(viewMode, writable) {
    const select = el('select', 'pm-quickbar-sort');
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
    return button('pm-quickbar-chip' + (active ? ' pm-quickbar-chip-active' : ''), label, onClick, writable);
}

function chipsRow(view, writable) {
    if (!view.chips.length) return null;
    const row = el('div', 'pm-quickbar-chips');
    row.append(chipButton(STRINGS.quick.chipAll, view.activeLabelId == null, () => setActiveLabel(null), writable));
    // A group with no living members is shown but not tappable: the view would fall
    // back to everyone, so the tap would only cost two saves.
    for (const label of view.chips) {
        row.append(chipButton(label.name ?? '', label.id === view.activeLabelId, () => setActiveLabel(label.id),
            writable && label.members.length > 0));
    }
    return row;
}

/* ── Bulk actions ────────────────────────────────────────────────────────────
   Each action reads the selection and the root when it runs, never from the draw:
   a stale list would edit personas the user had just unpicked. */
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

function bulkSave() {
    freshContext()?.saveSettingsDebounced?.();
    // refresh() before the event: pm:changed redraws from getState(), whose cache
    // would still hold a just-deleted persona. Other writes refresh through commit.
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
    // adoptFor, not ensurePersona: an empty entry would strand the real description
    // (adopt() skips existing entries) and look diverged, so revert would write ''
    // over it. adoptFor seeds from the existing text and refuses unlisted avatars.
    const targets = [];
    for (const avatar of selectedAvatars) {
        const persona = adoptFor(avatar);
        if (persona) targets.push(persona);
    }
    const trimmed = tag.trim();
    let n = 0;
    for (const persona of targets) {
        // addTag's own answer, so personas that already had the tag are not logged.
        if (addTag(persona, trimmed)) {
            n++;
            addLog(persona, 'tag-add', trimmed, Date.now());
        }
    }
    notify('info', n ? STRINGS.quick.bulkTagAdded(n) : STRINGS.quick.bulkTagNoChange);
    bulkSave();
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
    bulkSave();
}

async function bulkGroup() {
    const root = bulkWritableRoot();
    if (!root) return;
    const labels = livingLabels(root.labels, root.personas);
    if (!labels.length) { notify('info', STRINGS.manager.groupsEmpty); return; }
    // Resolved by index, since two groups may share a name. Unnamed groups are
    // filtered here: askChoiceIndex drops empty strings, which would shift indexes.
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
    notify('info', STRINGS.quick.bulkGrouped(label.name ?? '', added));
    bulkSave();
}

async function bulkDelete() {
    const root = bulkWritableRoot();
    if (!root) return;
    const count = selectedAvatars.filter(a => getPersona(root, a)).length;
    // Selected, but none has managed data: the usual state for most of a roster.
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
    // Deleted personas leave their groups. Only those: unmanaged personas can be
    // grouped too (grouping does not adopt) and were not deleted.
    for (const label of after.labels ?? []) {
        if (!Array.isArray(label.members)) continue;
        label.members = label.members.filter(id => !deleted.includes(id));
    }
    selectedAvatars = [];
    selectMode = false;
    notify('info', STRINGS.quick.bulkDeleted(deleted.length));
    bulkSave();
}

// Shared by the select-all label and its action, so the two never disagree.
function everyVisiblePicked() {
    return rosterVisible.length > 0 && rosterVisible.every(a => selectedAvatars.includes(a));
}

function bulkBar(writable) {
    const bar = el('div', 'pm-quickbar-bulk');
    bar.append(el('div', 'pm-quickbar-bulkcount', STRINGS.quick.selectedCount(selectedAvatars.length)));
    const row = el('div', 'pm-manager-actions');
    const pickAll = el('button', 'pm-quickbar-btn',
        everyVisiblePicked() ? STRINGS.quick.selectNone : STRINGS.quick.selectAll);
    pickAll.type = 'button';
    pickAll.dataset.pmPickall = '1';
    // Nothing on screen means nothing to select.
    if (!rosterVisible.length) disable(pickAll);
    pickAll.addEventListener('click', () => {
        // Scoped to what is on screen; a union or a difference, not an assignment, so
        // picks made on other pages or searches survive.
        if (!rosterVisible.length) return;
        selectedAvatars = everyVisiblePicked()
            ? selectedAvatars.filter(avatar => !rosterVisible.includes(avatar))
            : [...new Set([...selectedAvatars, ...rosterVisible])];
        scheduleDraw();
    });
    row.append(pickAll);
    row.append(
        button('pm-quickbar-btn', STRINGS.quick.bulkTagAdd, () => bulkAddTag(), writable),
        button('pm-quickbar-btn', STRINGS.quick.bulkTagRemove, () => bulkRemoveTag(), writable),
        button('pm-quickbar-btn', STRINGS.quick.bulkGroup, () => bulkGroup(), writable),
        button('pm-quickbar-btn pm-manager-danger', STRINGS.quick.bulkDelete, () => bulkDelete(), writable));
    bar.append(row);
    return bar;
}

function selectToggleButton(writable) {
    // A longer label squeezed the selects, so state shows in fill and aria-pressed.
    // Leaving select mode drops the selection, so nothing unseen is acted on.
    const btn = button(`pm-quickbar-btn${selectMode ? ' pm-manager-primary' : ''}`, STRINGS.quick.selectToggle, () => {
        selectMode = !selectMode;
        if (!selectMode) selectedAvatars = [];
        else { editMode = false; expandedAvatar = null; }
        scheduleDraw();
    }, writable);
    btn.setAttribute('aria-pressed', selectMode ? 'true' : 'false');
    return btn;
}

function toggleSelected(avatarId) {
    const i = selectedAvatars.indexOf(avatarId);
    if (i === -1) selectedAvatars.push(avatarId);
    else selectedAvatars.splice(i, 1);
    if (!markSelection(avatarId)) scheduleDraw();
}

function editToggleButton(writable) {
    const btn = button('pm-quickbar-btn', STRINGS.quick.groupEditToggle, () => {
        editMode = !editMode;
        if (!editMode) expandedAvatar = null;
        // The modes exclude each other: a row tap answers select mode first.
        else if (selectMode) { selectMode = false; selectedAvatars = []; }
        scheduleDraw();
    }, writable);
    btn.setAttribute('aria-pressed', editMode ? 'true' : 'false');
    return btn;
}

function newLabelInput(avatarId, writable) {
    const row = el('div', 'pm-quickbar-newlabel');
    const input = el('input', 'pm-quickbar-newlabel-input');
    input.type = 'text';
    input.placeholder = STRINGS.quick.newGroupPlaceholder;
    input.disabled = !writable;
    const submit = () => {
        if (!input.value.trim()) return;
        // createLabel only schedules the redraw, so this still clears the live field.
        createLabel(input.value, avatarId);
        input.value = '';
        // Ends typing, or the deferred redraw would wait for a blur that never comes.
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

// Opened by edit mode plus a row tap, never by a long press.
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

// version is rosterVersionLine's answer, null for a persona with no data here.
function personaRow(ctx, entry, s, version) {
    const picked = selectMode && selectedAvatars.includes(entry.avatar);
    const onClick = selectMode
        ? () => toggleSelected(entry.avatar)
        : editMode
            ? () => toggleEditRow(entry.avatar)
            // Enabled even when ambiguous: switching is the way out and writes
            // none of our data.
            : () => switchPersona(entry.avatar, entry.name);
    const row = el('div', `pm-row pm-quickbar-row${picked ? ' pm-picked' : ''}`);
    row.dataset.pmAvatar = entry.avatar;
    if (selectMode) {
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', picked ? 'true' : 'false');
    }
    // Every row carries the thumbnail: names cannot tell same-named personas apart.
    const url = thumbnailUrl(ctx, entry.avatar);
    if (url) row.append(thumbPool.take('pm-quickbar-rowimg', url));
    const text = el('div', 'pm-quickbar-rowtext');
    const top = el('div', 'pm-quickbar-rowtop');
    top.append(markedText('pm-quickbar-name', entry.name ?? '', rosterSearchOpen ? rosterQuery : ''));
    if (version?.badge) top.append(el('span', 'pm-quickbar-versionbadge', version.badge));
    text.append(top);
    // One line, ellipsised by CSS, so rows do not grow with the version count.
    if (version?.line) text.append(el('div', 'pm-quickbar-versionline', version.line));
    row.append(text);
    row.append(checkMark(entry.avatar === s.avatar));
    // makeRowActivatable keeps the checkbox role set above in select mode.
    if (onClick) makeRowActivatable(row, onClick);
    else row.classList.add('pm-disabled');
    return row;
}

// The tile: the avatar image sized for a thumb, the name in aria-label. Tapping
// switches, as the row does, and stays enabled when ambiguous.
function personaTile(ctx, entry, s, named) {
    const active = entry.avatar === s.avatar;
    // The shape class is on the panel, so list rows and tiles both follow it.
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
    // The image is layered over the name: a 404 renders nothing (empty alt), so the
    // name stays visible and no tile is anonymous.
    imgbox.append(markedText('pm-quickbar-tilename', entry.name ?? '', rosterSearchOpen ? rosterQuery : ''));
    const url = thumbnailUrl(ctx, entry.avatar);
    if (url) imgbox.append(thumbPool.take('pm-quickbar-tileimg', url));
    if (active) {
        // No check glyph: the accent ring marks it, in thickness as well as colour.
        tile.setAttribute('aria-current', 'true');
    }
    tile.append(imgbox);
    // The named-tile view: the name gets its own strip under the image.
    if (named) tile.append(markedText('pm-quickbar-tilelabel', entry.name ?? '', rosterSearchOpen ? rosterQuery : ''));
    tile.addEventListener('click', () => {
        if (selectMode) { toggleSelected(entry.avatar); return; }
        switchPersona(entry.avatar, entry.name);
    });
    return tile;
}

// Set when the roster's search opens, cleared by the draw that focuses the field.
let focusRosterSearch = false;

// Closing search clears the query, filters and page. Searching writes nothing, so
// unlike the sort and view controls this stays enabled on a read-only root.
function searchToggleButton() {
    const btn = button('pm-quickbar-btn', STRINGS.common.search, () => {
        rosterSearchOpen = !rosterSearchOpen;
        if (!rosterSearchOpen) { rosterQuery = ''; rosterLang = null; rosterTags = []; rosterPage = 1; }
        else focusRosterSearch = true;
        scheduleDraw();
    });
    btn.setAttribute('aria-pressed', rosterSearchOpen ? 'true' : 'false');
    return btn;
}

// Repaints only the list container, at most once per frame. The search field lives
// outside it, so the caret and IME composition are never rebuilt or kept waiting.
const rosterListTask = frameTask(() => fillRosterListNow());

function redrawRosterList() {
    rosterListTask.schedule();
}

function fillRosterListNow() {
    const panel = document.getElementById(PANEL_ID);
    const container = panel?.querySelector('[data-pm-roster-list]');
    if (!container) return;
    // A group name typed in a row's editor survives the rebuild, as in drawPanel.
    const typed = typedGroupName(container);
    thumbPool.harvest(container);
    fillRosterList(container);
    thumbPool.clear();
    restoreGroupName(container, typed);
}

// The new-group field's text and selection, carried across a rebuild of node.
function typedGroupName(node) {
    const input = node.querySelector('.pm-quickbar-newlabel-input');
    return input?.value ? { value: input.value, start: input.selectionStart, end: input.selectionEnd } : null;
}

function restoreGroupName(node, typed) {
    const input = typed ? node.querySelector('.pm-quickbar-newlabel-input') : null;
    if (!input) return;
    input.value = typed.value;
    if (typed.start != null && typed.end != null && typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(typed.start, typed.end);
    }
}

// Persona thumbnails reused across redraws; a replaced picture's new address gets a
// fresh element.
const thumbPool = imagePool('img.pm-quickbar-rowimg, img.pm-quickbar-tileimg');

// A persona's language, from its composed text (null without data here). Memoized per
// record by composedSig, so a draw does not compose thirty personas.
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

// Publishes what the list drew and brings the bulk bar's select-all in step, since a
// list-only repaint (keystroke, page step) does not rebuild the bar.
function publishVisible(avatars) {
    rosterVisible = avatars;
    const pickAll = document.getElementById(PANEL_ID)?.querySelector('[data-pm-pickall]');
    if (!pickAll) return;
    pickAll.textContent = everyVisiblePicked() ? STRINGS.quick.selectNone : STRINGS.quick.selectAll;
    pickAll.disabled = !rosterVisible.length;
    pickAll.classList.toggle('pm-disabled', !rosterVisible.length);
}

// Everything below the search row, in its own container so search can repaint it
// alone. prebuilt is rosterGroup's view from the same draw, absent when only the
// list repaints.
function fillRosterList(container, prebuilt) {
    const ctx = freshContext();
    const s = getState();
    container.replaceChildren();
    publishVisible([]);
    if (!s) return;
    const writable = !s.ambiguous && !s.readOnly;
    const view = prebuilt
        ?? buildRosterView({ personas: personaNames(ctx) }, s.root, LIST_COLLATOR);

    // An editor whose row is filtered out closes for good, not to spring back later.
    if (expandedAvatar != null && !view.entries.some(entry => entry.avatar === expandedAvatar)) {
        expandedAvatar = null;
    }

    if (!view.entries.length) {
        container.append(el('div', 'pm-quickbar-note', STRINGS.quick.rosterUnavailable));
        return;
    }

    let entries = view.entries;

    // Language and tag filter chips, only while search is open.
    if (rosterSearchOpen) {
        // Cached per fill, or chips and filter would compose each persona twice.
        const langCache = new Map();
        const langOf = avatar => {
            if (!langCache.has(avatar)) langCache.set(avatar, personaLanguage(s.root, avatar));
            return langCache.get(avatar);
        };
        // From the whole roster, not the group-filtered view, so a filter is dropped
        // only when its language or tag exists nowhere.
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

    // A tile page is columns x rows only when both are set: an automatic column
    // count depends on the panel width, unknown here. Otherwise the plain per-page
    // count applies.
    const settings = s.root?.settings ?? {};
    const viewMode = settings.rosterViewMode;
    const cols = Number(settings.rosterTileColumns ?? 0);
    const rows = Number(settings.rosterTileRows ?? 0);
    const perPage = viewMode !== 'list' && cols >= 2 && rows >= 1
        ? cols * rows
        : (settings.pageSizeRoster ?? 20);
    const paged = pageOf(entries, rosterPage, perPage);
    rosterPage = paged.page;

    // Every filter and the page cut are applied now: this is what select-all covers.
    publishVisible(paged.slice.map(entry => entry.avatar));

    // Same for an editor whose row the query or the page cut hides.
    if (expandedAvatar != null && !paged.slice.some(entry => entry.avatar === expandedAvatar)) {
        expandedAvatar = null;
    }

    // Edit mode uses the list layout: the editor unfolds under a full-width row.
    if ((viewMode === 'tiles' || viewMode === 'tilesNamed') && !editMode) {
        const grid = el('div', 'pm-quickbar-tiles');
        const columns = Number(s.root?.settings?.rosterTileColumns ?? 0);
        if (columns >= 2) grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
        for (const entry of paged.slice) grid.append(personaTile(ctx, entry, s, viewMode === 'tilesNamed'));
        container.append(grid);
    } else {
        const mode = {
            count: s.root?.settings?.rosterShowVersionCount === true,
            names: s.root?.settings?.rosterShowVersionNames === true,
        };
        for (const entry of paged.slice) {
            // getPersona only reads, so drawing never adopts a persona.
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
    // Edit and select modes end when the root turns unwritable (e.g. a duplicate name
    // appears), so no hidden selection is acted on later.
    if (!writable && editMode) { editMode = false; expandedAvatar = null; }
    if (!writable && selectMode) { selectMode = false; selectedAvatars = []; }

    const view = buildRosterView({ personas: personaNames(ctx) }, s.root, LIST_COLLATOR);

    // buildRosterView's fallback for a dead group filter is stored only when
    // writable, but renders either way, so a filter never hides everyone.
    const storedActiveLabelId = s.root?.settings?.activeLabelId ?? null;
    // No save of its own, as with folds.
    if (writable && s.root?.settings && view.activeLabelId !== storedActiveLabelId) {
        s.root.settings.activeLabelId = view.activeLabelId;
    }

    const box = el('div', 'pm-quickbar-group');
    // The five controls get their own line: beside the heading they do not fit.
    const head = el('div', 'pm-quickbar-head pm-quickbar-rosterhead');
    // Its own class lets the label refuse to shrink (it wrapped mid-word on phones).
    head.append(el('span', 'pm-quickbar-headlabel', STRINGS.quick.headPersona));
    box.append(head);
    const controls = el('div', 'pm-quickbar-rosterhead-controls');
    // No visible captions (they do not fit); the selects carry them as aria labels.
    controls.append(sortSelect(s.root?.settings?.sortBy, writable));
    controls.append(viewSelect(s.root?.settings?.rosterViewMode, writable));
    controls.append(searchToggleButton());
    controls.append(selectToggleButton(writable));
    controls.append(editToggleButton(writable));
    box.append(controls);
    // The bulk bar is built after the list, which works out what select-all covers; a
    // placeholder keeps its place above the rows.
    const bulkSlot = selectMode ? el('div') : null;
    if (bulkSlot) box.append(bulkSlot);

    const chips = chipsRow(view, writable);
    if (chips) box.append(chips);

    // Outside the repainted list (redrawRosterList); full draws restore its value.
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
        // The list filters as the user types, so Enter just puts the keyboard
        // away; the blur also releases a redraw deferred behind this field.
        input.addEventListener('keydown', e => {
            if (isComposingKey(e) || e.key !== 'Enter') return;
            e.preventDefault();
            input.blur();
        });
        // Focused once the panel is assembled: a detached input cannot take focus.
        if (focusRosterSearch) input.dataset.pmFocus = '1';
        row.append(input);
        box.append(row);
    }

    const container = el('div');
    container.dataset.pmRosterList = '1';
    box.append(container);
    fillRosterList(container, view);
    if (bulkSlot) bulkSlot.replaceWith(bulkBar(writable));
    return box;
}

function footer() {
    const box = el('div', 'pm-quickbar-footer');
    // One shortcut per manager tab; search opens compose with its search row open.
    const SHORTCUTS = [
        [STRINGS.quick.footerCompose, 'compose', false],
        [STRINGS.quick.footerVersions, 'versions', false],
        [STRINGS.quick.footerHistory, 'history', false],
        [STRINGS.quick.footerAssets, 'assets', false],
        [STRINGS.quick.footerGroups, 'labels', false],
        [STRINGS.quick.footerSearch, 'compose', true],
    ];
    for (const [label, tab, search] of SHORTCUTS) {
        box.append(button('pm-quickbar-btn', label, () => {
            // Dispatch is synchronous: an existing listener has marked it handled.
            const detail = { tab, search, handled: false };
            document.dispatchEvent(new CustomEvent('pm:open-manager', { detail }));
            if (!detail.handled) notify('info', STRINGS.quick.managerMissing);
        }));
    }
    return box;
}

function drawPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    applyShapeClass(panel);
    // A redraw already waits for an input's blur; a second listener would draw twice.
    if (drawDeferred) return;
    // A rebuild (e.g. after a late settings save) would pull a focused input out mid
    // IME composition and lose half-typed hangul, so wait for the user to leave it.
    const active = document.activeElement;
    if (active && panel.contains(active) && isTextEntry(active)) {
        drawDeferred = true;
        // Released after the blurring gesture ends: the blur comes from a tap's
        // mousedown, and a rebuild before its mouseup would lose the click.
        active.addEventListener('blur', () => afterGesture(() => { drawDeferred = false; scheduleDraw(); }), { once: true });
        return;
    }

    // One context for this whole synchronous draw; no handler keeps it.
    const ctx = freshContext();
    const s = getState();
    // The redraw shows the current persona, so taps are now checked against it.
    // The real guard is saveAndCompose's own live check.
    panelAvatar = s?.avatar ?? null;

    // The panel is a clipped shell and .pm-scroll scrolls, keeping the scrollbar
    // inside the rounded border. Emptying it clamps scrollTop to 0, so positions are
    // read first.
    const oldScroll = panel.querySelector('.pm-scroll');
    const scrollTop = oldScroll?.scrollTop ?? 0;
    const chipsLeft = panel.querySelector('.pm-quickbar-chips')?.scrollLeft ?? 0;
    // Same for typed text: a tap on Add blurs the field, and the released redraw can
    // rebuild it empty before the click submits it.
    const typed = typedGroupName(panel);
    // The scrolling box is kept and only its contents replaced, so a fling in
    // progress survives the redraw and the offset is normally never clamped.
    const scroll = oldScroll ?? el('div', 'pm-scroll');
    thumbPool.harvest(oldScroll);
    if (oldScroll) scroll.replaceChildren();
    else panel.replaceChildren(scroll);

    if (!s) {
        scroll.append(el('div', 'pm-quickbar-note', STRINGS.quick.stateUnread));
    } else {
        // Ambiguous: ctx.js cannot tell which persona is active, so writing is off.
        const writable = !s.ambiguous && !s.readOnly;
        if (s.ambiguous) scroll.append(bannerOf('pm-quickbar-warn', STRINGS.quick.ambiguous));
        if (s.readOnly) scroll.append(bannerOf('pm-quickbar-warn', STRINGS.common.readOnly));
        if (s.diverged && !bannerDismissed) scroll.append(divergedBanner(writable));

        // Each group is built on its own, so one malformed record cannot blank the
        // whole panel, persona list included.
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

    // Written only when it moved: the write forces a layout and stops a fling.
    if (scrollTop && scroll.scrollTop !== scrollTop) scroll.scrollTop = scrollTop;
    // Whatever was not claimed belongs to rows that are gone.
    thumbPool.clear();
    const chips = panel.querySelector('.pm-quickbar-chips');
    if (chips) chips.scrollLeft = chipsLeft;
    // Focus is not restored: it would reopen the keyboard the user just closed.
    restoreGroupName(panel, typed);
    // The one focus this panel takes: the user just asked for the search keyboard.
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
    // showQuickBar can change and SillyTavern can rebuild the send form, so the
    // button is reconciled on every state change.
    track(cleanups, document, 'pm:changed', () => syncButton());
    syncButton();
}

export function unmountQuickbar() {
    // closePanel also drops the panel-local state and every queued frame.
    closePanel();
    // A queued rename must not fire after teardown.
    cancelAutoName();
    runCleanups(cleanups);
    if (typeof document !== 'undefined') document.getElementById(BUTTON_ID)?.remove();
    mounted = false;
    bannerDismissed = false;
    editMode = false;
    selectMode = false;
    selectedAvatars = [];
    expandedAvatar = null;
    lastMissing = null;
    // No module state survives teardown; the popup measurement is taken again on
    // re-enable, since SillyTavern may have been updated.
    probePromise = null;
    versionOpenOverride = null;
    namesOpenOverride = null;
    focusRosterSearch = false;
    popupNeedsDrop = false;
    thumbBumps.clear();
}
