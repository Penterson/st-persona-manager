// The manager screen: sections, variants, versions, history, assets and labels
// for one persona: 구성, 버전, 이력, 에셋, 페르소나 선택 and 라벨. Opened from the
// quick panel's footer, which
// dispatches pm:open-manager on document and expects a listener to mark the event
// handled. Everything that touches the DOM lives here; the logic worth testing is
// in manager-pure.js, which the node tests import instead.
//
// No handler in this file closes over a context, a getState() snapshot or a node.
// Handlers outlive the draw that created them, and all three of those are only
// true for the instant they were read, so anything that needs one asks again when
// it runs. This is the same rule quickbar.js states at its top, for the same
// reason: it is what stopped one persona's text being written into another.
//
// What this screen writes is pinned by targetAvatar, a plain string chosen when
// the screen opens and changed only by the picker in its header. Writes go through
// state.js's saveAndComposeFor(target), which decides from a live context of its
// own whether the target is also the ACTIVE persona and therefore whether design
// doc 4.2's singular prompt field is written. That is what lets the user edit a
// persona they are not currently playing: a persona switch elsewhere no longer
// invalidates the edit, because it never decided where the edit was going.
import { MODULE_NAME, makeId, getPersona, ensurePersona, HEADING_FORMATS, TILE_SHAPES } from './store.js';
import {
    getState, getRoot, adoptFor, saveAndComposeFor, refreshAssets,
} from './state.js';
import { freshContext } from './ctx.js';
import {
    compose, composePicked, composeFrom, hasDiverged, headingLine,
    readPlacement, writePlacement,
} from './compose.js';
import { addLog, snapshot, enforceGlobalBudget, restore, diffWords, expireOldHistory } from './history.js';
import { livingLabels, toggleMember } from './roster.js';
import {
    isTextEntry, pickApplicable, versionApplicable, quoteArg, waitFor, nameCollides,
    CREATE_WAIT_TURNS,
} from './quickbar-pure.js';
import {
    closePanel, openPanel, isPanelOpen, notify, askConfirm, askChoice, askText, blockDrawerClose,
    isComposingKey, el, thumbnailUrl, markedText, pagerRow, applyShapeClass,
    applyPersonaName, bumpThumbnails, runBoundImageWrite } from './quickbar.js';
// Matching, language detection and paging.
import { rankOf, textContains, detectLanguage, chatLanguage, pageOf } from './search-pure.js';
import {
    resolveFolderKey, claimFolderKey, listAssets, uploadAsset, deleteAsset,
    uploadPersonaAvatar, feedPersonaImage,
} from './assets.js';
import {
    canDeleteSection, removeSection, moveSection, reorderSection, deleteVariant,
    renameLabel, deleteLabel, versionSummary, versionSummaryLine, NO_PICK_LABEL,
    putDraft, peekDraft, takeDraft, clearDrafts, rowKey,
    historyView, hasEvictionNotice, missingSignature, previewText,
    assetSelected, toggleAssetSelection, insertTagText, insertAtCursor,
    applyReplacement, buildReplaceBlocks, makeReplaceVersion,
    addTag, removeTag, missingDefaultSections, fillDefaultSections,
    planFullTextSave, readSelectOptions, parseDepth, copyPersonaOnto,
    setLocalName, localName, countSize,
    boundAsset, bindAsset, versionImageState,
} from './manager-pure.js';
// Every sentence the user reads on this screen comes from there,
// including the tab names and the line under each of them. The stored log kinds,
// the data keys and the class names in this file are deliberately unchanged.
import { STRINGS } from './strings.js';

const HOST_ID = 'pm-manager-host';
const PANEL_ID = 'pm-manager-panel';

// The stored tab identity. The names the user reads are STRINGS.manager.tabs,
// keyed by exactly these, so renaming a tab is a one line change there and
// nothing that was saved has to move.
const TAB_KEYS = Object.freeze(['compose', 'versions', 'history', 'assets', 'labels']);

const LOG_ROWS = 50;

let mounted = false;
let cleanups = [];
let screenCleanups = [];
// The persona this screen writes to, as a plain string. Chosen when the screen
// opens (the active persona, which is what the quick panel's 관리 button means)
// and afterwards only by the picker in the header. Nothing else moves it.
let targetAvatar = null;
let managerTab = 'compose';
// Which variant body is open in the editor, as two plain strings. Nothing here
// holds the variant object: it is looked up again at the moment of the write.
let openVariant = null;
let editorDirty = false;
let closeAsked = false;
let drawFrame = 0;
let drawDeferred = false;
let pickerOpen = false;
// History tab selection: a variant id and an index into that variant's stored
// snapshot list. The index is storage order, which is what restore() takes.
let historyVariant = null;
let historyIndex = null;
let historyMode = 'diff';
// Which single row has its other actions showing, as one
// string from rowKey. Exactly one at a time, and cleared by whichever tab draws
// next if the row it names is no longer in the data. The same shape as the quick
// panel's expandedAvatar, for the same reason: screen local UI state, never a
// node and never an object that could go stale.
let expandedRow = null;
// The asset tab's own listing, for the persona this screen points at, which is
// not necessarily the active one. state.js keeps a listing too, but that one
// belongs to the active persona and feeds the macros, so asking it about a
// background persona would answer with the wrong folder.
let assetState = { avatar: null, list: [], error: null, loading: false };
// The set of empty sections the user has already been told about. See commit.
let lastMissing = null;
// 고쳐서 새 버전. Same rule as everything above: strings,
// numbers and arrays of them, never a node, a context or a persona object.
// reviseBlocks is the original text per block (from buildReplaceBlocks),
// reviseTexts the working copies the user is editing, reviseSteps the applied
// replacements newest last (each holding the block index and the WHOLE previous
// string, which is what makes undo one assignment). reviseSelection is the last
// valid drag as offsets, kept because the tap on the popup collapses the
// selection before the click lands. reviseEditing is the open 수정 칸.
let reviseActive = false;
let reviseBlocks = null;
let reviseTexts = null;
let reviseSteps = [];
let reviseSelection = null;
let reviseEditing = null;
let revisePopupHide = 0;
let revisePopupFrame = 0;
let reviseScrollToBox = false;
// 설명문 전문 (user request). Same rule as the revise screen above and for the
// same reason: plain data only. fullBlocks is buildReplaceBlocks output taken
// when the screen opened, which is what pins each textarea to the body it was
// drawn from; fullTexts the index aligned working copies, refreshed off the live
// fields on every draw so a rebuild cannot roll typing back.
let fullActive = false;
let fullBlocks = null;
let fullTexts = null;
// Which of the two folded blocks at the top of the 편집 tab is open. Booleans of
// their own rather than expandedRow keys: expandedRow is cleared by whichever
// tab draws next, and these two belong to the tab itself rather than to a row in
// its list.
let placementOpen = false;
let namesOpen = false;
let personaOpen = false;
// What tapping a row in the persona picker does: move this screen's target, or
// copy the current persona's composition onto that row. One string, and the
// picker closing puts it back.
let pickerMode = 'target';
// SillyTavern's position and role option lists, held for the length of one draw.
// Plain {value, label} data read off its selects, never a node, and cleared at the
// top of every draw so a rename or a reload cannot leave a stale list on screen.
let enumCache = null;
// The trailing timer behind the size lines. A token count is SillyTavern's own
// function and its cost is not ours to predict, so it is not run per keystroke.
// The callback holds no node: it asks the panel for the line when it fires.
let sizeTimer = 0;
// Each searchable list's search state, screen local and
// plain data only (strings, numbers, string arrays). Keyed by the list ids the
// containers carry in data-pm-list.
const emptyListUi = () => ({ open: false, query: '', page: 1, lang: null, tags: [] });
let listUi = {
    picker: emptyListUi(),
    compose: emptyListUi(),
    versions: emptyListUi(),
    assets: emptyListUi(),
    groups: emptyListUi(),
};
function resetListUi() {
    // In place, never by replacing the objects: the search and pager handlers
    // hold these objects, and swapping them out would leave a one-frame window
    // where a tap writes into an orphan nothing reads.
    for (const ui of Object.values(listUi)) Object.assign(ui, emptyListUi());
}
// Whether the quick panel was on screen when this screen opened. The return trip
// is conditional on it: the settings drawer's [관리자 열기]
// path arrives with no panel open, and reopening one there would drop a modal
// on top of the drawer the user is standing in. Captured before closePanel()
// takes the panel down, cleared on every close.
let fromQuickPanel = false;

function track(list, target, type, fn, options) {
    target.addEventListener(type, fn, options);
    list.push(() => target.removeEventListener(type, fn, options));
}

function runCleanups(list) {
    for (const off of list.splice(0)) {
        try { off(); } catch (e) { console.warn(`[${MODULE_NAME}] cleanup failed`, e); }
    }
}

// One redraw per frame, and none at all while the user is typing. Same scheduler
// as the quick panel's, and it matters more here: this screen has a textarea, and
// a rebuild mid composition throws away the syllable being assembled.
function scheduleDraw() {
    if (drawFrame) return;
    if (typeof requestAnimationFrame !== 'function') { drawManager(); return; }
    drawFrame = requestAnimationFrame(() => { drawFrame = 0; drawManager(); });
}

/* Shell */

// One geometry write per frame (device jank): visualViewport fires
// scroll continuously while the keyboard pans the page, and writing height and
// top per event forced a layout each time. The frame reads the final position.
let sizeFrame = 0;
function scheduleSize() {
    if (sizeFrame) return;
    if (typeof requestAnimationFrame !== 'function') { sizeToViewport(); return; }
    sizeFrame = requestAnimationFrame(() => { sizeFrame = 0; sizeToViewport(); });
}

/* The same rule the quick panel states: an unchanged value is not written again.
   Each style write invalidates layout and this runs on every visualViewport event,
   which on Android arrives per frame while a list is being flung. */
let sizedHeight = null;
let sizedTop = null;

function forgetSizing() {
    sizedHeight = null;
    sizedTop = null;
}

function sizeToViewport() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    // CSS vh does not shrink when the on screen keyboard opens, and
    // this screen is full height with a textarea in it, so a vh sized panel puts
    // the save button under the keyboard exactly when it is needed.
    const vv = globalThis.visualViewport;
    const height = vv?.height ?? globalThis.innerHeight ?? 0;
    if (!height) return;
    const px = Math.round(height);
    if (px !== sizedHeight) {
        sizedHeight = px;
        panel.style.height = `${px}px`;
        // The history tab's text boxes cap themselves at 40% of the same measured
        // height. In CSS that cap was 40vh, the one vh box left after 22.5, and vh
        // ignores the keyboard exactly as the shell's own height did.
        panel.style.setProperty('--pm-history-cap', `${Math.round(height * 0.4)}px`);
    }
    // Zero on Android while the keyboard is up (the visual viewport shrinks rather
    // than moves), non zero when the page is pinch zoomed or when a focused field
    // is panned into view. Reading it costs nothing and covers all three.
    const top = Math.max(0, Math.round(vv?.offsetTop ?? 0));
    if (top !== sizedTop) {
        sizedTop = top;
        panel.style.top = `${top}px`;
    }
}

function openManager(tab) {
    const wanted = TAB_KEYS.includes(tab) ? tab : 'compose';
    if (document.getElementById(HOST_ID)) { managerTab = wanted; scheduleDraw(); return; }
    // The quick panel is a modal dialog of its own, and two of them in the top
    // layer would leave the user tapping through the wrong one. Whether it was
    // up is what decides where closing this screen returns to, so it is read
    // before the close erases the evidence.
    fromQuickPanel = isPanelOpen();
    closePanel();

    managerTab = wanted;
    // A new panel element carries none of the inline geometry the old one had.
    forgetSizing();
    openVariant = null;
    editorDirty = false;
    closeAsked = false;
    drawDeferred = false;
    pickerOpen = false;
    historyVariant = null;
    historyIndex = null;
    historyMode = 'diff';
    expandedRow = null;
    lastMissing = null;
    pickerMode = 'target';
    placementOpen = false;
    namesOpen = false;
    personaOpen = false;
    resetFullText();
    // What the quick panel's 관리 button has always meant: the
    // screen opens on the persona the user is playing. The picker moves it after.
    targetAvatar = getState()?.avatar ?? null;

    // pm-grain paints the reference's paper tooth as a fixed overlay on the
    // panel, not on the scrolling content, so it composites once (style.css).
    const panel = el('div', 'pm-panel pm-manager-panel pm-grain');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', STRINGS.manager.screenAria);

    // Measured on the device (아이콘 진단): one of the installed themes decorates an
    // ancestor with a transform, which makes that ancestor the containing block for
    // position fixed, so a viewport anchored panel lands off screen. A modal dialog
    // renders in the top layer, which the spec pins to the viewport regardless of
    // ancestor transforms. Every overlay this extension draws has to ride one.
    const host = document.createElement('dialog');
    host.id = HOST_ID;
    host.className = 'pm-manager-host';
    host.tabIndex = -1;
    blockDrawerClose(host);
    blockDrawerClose(panel);
    // Native ESC, and the Android back gesture, fire cancel on the dialog. Routed
    // through our own path so an unsaved edit gets its one question first.
    host.addEventListener('cancel', e => { e.preventDefault(); requestClose(); });
    host.append(panel);
    document.body.append(host);
    let modal = false;
    if (typeof host.showModal === 'function') {
        try { host.showModal(); modal = true; } catch { host.setAttribute('open', ''); }
    } else {
        host.setAttribute('open', '');
    }
    try { host.focus(); } catch { /* focus is best effort */ }
    drawManager();
    sizeToViewport();

    if (globalThis.visualViewport) {
        track(screenCleanups, globalThis.visualViewport, 'resize', scheduleSize);
        // Android fires scroll rather than resize when the visual viewport is
        // panned, which is what happens when a focused textarea is scrolled above
        // the keyboard. Without this the screen keeps its old offset and the field
        // the user is typing into ends up outside the visible area.
        track(screenCleanups, globalThis.visualViewport, 'scroll', scheduleSize);
    }
    // The [수정] popup follows the live selection. Registered for
    // the screen's whole life and a cheap no-op whenever the revise screen is not
    // up; selection events have no per-node target to scope to.
    track(screenCleanups, document, 'selectionchange', onReviseSelectionChange);
    // The cancel handler above already covers ESC and the Android back gesture for
    // a dialog opened with showModal. A document level Escape listener on top of it
    // also fired for the ESC that dismissed a SillyTavern popup drawn over this
    // screen, which closed the manager underneath the user. It is kept only for the
    // fallback path, where no cancel event will ever come, and even there only
    // while the focus is still inside our own host, so it cannot reach past a popup
    // that has taken the focus.
    //
    // The composition guard still applies: a hangul composition commits with an
    // Enter whose keyCode is 229, and the guard is on every keydown this extension
    // listens to.
    if (!modal) {
        track(screenCleanups, document, 'keydown', e => {
            if (isComposingKey(e)) return;
            if (e.key !== 'Escape') return;
            const open = document.getElementById(HOST_ID);
            if (!open || !open.contains(document.activeElement)) return;
            requestClose();
        });
    }
}

// Closing is the one path that can lose something the user typed, because the
// editor saves on a button and not on every keystroke. The rule
// against silent failure applies to silent loss too. The draft store means the
// text survives the close as well, and the question says so rather than implying
// it is about to be thrown away.
async function requestClose() {
    if (closeAsked) return;
    const revising = reviseDirtyCount();
    const fullDirty = fullDirtyCount();
    if (editorDirty || revising > 0 || fullDirty > 0) {
        closeAsked = true;
        stashDraft();
        // The two working screens win over the editor when they apply: the
        // editor's typing is stashed by the line above and survives the close,
        // but their working copies are gone with the screen, so they are what the
        // user has to be asked about. Between those two, the one on the tab the
        // user is standing on is the one they can see, and it asks first.
        const onVersions = managerTab === 'versions';
        const first = onVersions ? revising : fullDirty;
        const second = onVersions ? fullDirty : revising;
        const askFirst = onVersions ? STRINGS.manager.reviseConfirmLeave : STRINGS.manager.fullTextConfirmLeave;
        const askSecond = onVersions ? STRINGS.manager.fullTextConfirmLeave : STRINGS.manager.reviseConfirmLeave;
        const message = first > 0 ? askFirst(first)
            : second > 0 ? askSecond(second)
                : STRINGS.manager.confirmCloseDirty;
        const ok = await askConfirm(message);
        closeAsked = false;
        // Re-checked rather than assumed: the screen may have been closed while
        // the question was on screen.
        if (!ok || !document.getElementById(HOST_ID)) return;
    }
    closeManager();
}

// The user got here through the quick panel's 관리 button, so
// closing is a step back up to that panel rather than an exit from everything.
// The step back only exists when the panel is where they came from: fromQuickPanel
// is false on the settings drawer's [관리자 열기] path, and a panel opened there
// would sit modal over the drawer and disable it. Two more cases skip the reopen,
// and both are silent about it because neither is a failure: the icon and the
// panel are turned off in the settings, or there is no persona for a panel to be
// about. The insert-then-close path passes false for a reason of its own (see
// insertIntoSendBox).
function closeManager(reopenPanel = true) {
    const returnToPanel = reopenPanel && fromQuickPanel;
    fromQuickPanel = false;
    runCleanups(screenCleanups);
    const host = document.getElementById(HOST_ID);
    if (host) {
        try { if (typeof host.close === 'function') host.close(); } catch { /* already closed */ }
        host.remove();
    }
    targetAvatar = null;
    openVariant = null;
    editorDirty = false;
    closeAsked = false;
    drawDeferred = false;
    pickerOpen = false;
    historyVariant = null;
    historyIndex = null;
    expandedRow = null;
    lastMissing = null;
    // Two full description bodies, so it does not get to outlive the screen.
    diffMemo = null;
    clearDragState();
    assetState = { avatar: null, list: [], error: null, loading: false };
    // Unlike drafts, applied replacements do not survive a close: requestClose
    // asked the one question about them before this line could run. The 전문
    // window's working copies go the same way, for the same reason.
    resetRevise();
    resetFullText();
    pickerMode = 'target';
    // A focus request nobody consumed dies with the screen it was made on.
    focusSearch = null;
    clearListFrames();
    placementOpen = false;
    namesOpen = false;
    personaOpen = false;
    // Read from SillyTavern's document, so it belongs to the screen that read it.
    enumCache = null;
    resetListUi();
    // Drafts deliberately survive a close: reopening the screen on the same
    // variant puts the text back. unmountManager is what clears them, because
    // that is teardown rather than a screen the user stepped out of.
    //
    // A frame already queued would call drawManager after the screen is gone. It
    // finds no panel and returns, but the id must not look like a live schedule.
    if (drawFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    if (sizeFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sizeFrame);
    sizeFrame = 0;

    // Last, and only after this screen is fully torn down: openPanel builds a
    // modal dialog of its own, and two of them in the top layer would leave the
    // user tapping through the wrong one.
    if (!returnToPanel) return;
    const s = getState();
    if (!s || s.settings?.showQuickBar === false || !s.avatar) return;
    openPanel();
}

/* Target and guards */

// What this screen is editing, read fresh. Nothing here is kept: the caller uses
// it within one synchronous stretch and asks again on the other side of an await.
function targetState() {
    const root = getRoot();
    if (!root) return null;
    return {
        root,
        settings: root.settings,
        avatar: targetAvatar,
        persona: targetAvatar ? getPersona(root, targetAvatar) : null,
        readOnly: !!root.readOnly,
        // With two personas sharing a name and no precise path,
        // which persona is ACTIVE is unknowable, and saveAndComposeFor refuses
        // for exactly that reason. It is not about the target, so it is read from
        // the shared state rather than recomputed here.
        ambiguous: !!getState()?.ambiguous,
    };
}

// The guard every write starts and resumes with. The target is a string that only
// the picker moves, so an await cannot change it behind our back; what an await
// CAN do is let the user pick a different persona while a popup is open, or let
// the entry be pruned. Both are caught by asking again rather than by trusting the
// object read before the await. Unlike the quick panel's guard this never closes
// the screen: a persona switch elsewhere is no longer a reason to, because it
// cannot move where the write lands.
function guardTarget(expected) {
    if (expected !== undefined && expected !== targetAvatar) {
        notify('error', STRINGS.manager.targetMovedNotSaved);
        return null;
    }
    const s = targetState();
    if (!s) { notify('error', STRINGS.manager.noSettings); return null; }
    if (!s.persona) { notify('error', STRINGS.manager.notAdopted); scheduleDraw(); return null; }
    return s;
}

// saveAndComposeFor answers every refusal with null, and the user has to be told
// which one it was. A refusal that says nothing is the failure mode
// this project exists to avoid.
function refusalMessage(avatar) {
    const root = getRoot();
    if (!root) return STRINGS.manager.refusalNoRoot;
    if (root.readOnly) return STRINGS.manager.refusalReadOnly;
    if (getState()?.ambiguous) return STRINGS.manager.refusalAmbiguous;
    const personas = freshContext()?.powerUserSettings?.personas ?? {};
    if (!avatar || !Object.hasOwn(personas, avatar)) return STRINGS.manager.refusalUnknownPersona;
    if (!getPersona(root, avatar)) return STRINGS.manager.notAdopted;
    return STRINGS.common.cannotSaveNow;
}

// A persona built by store.js always has these four containers, but a record hand
// edited in settings.json may not, and a missing one would turn a single bad
// record into a thrown exception that takes the whole screen down.
function ensureShape(persona) {
    if (!Array.isArray(persona.sections)) persona.sections = [];
    if (!persona.variants || typeof persona.variants !== 'object') persona.variants = {};
    if (!persona.activePicks || typeof persona.activePicks !== 'object') persona.activePicks = {};
    if (!Array.isArray(persona.versions)) persona.versions = [];
    return persona;
}

/* Writes */

// kind is null for the writes whose log line was already written by the helper
// that performed them (removeSection, deleteVariant and restore all log, because
// what they did is not visible from out here). A second line for the same act
// would make the log read as two operations.
function commit(kind, detail, expectedAvatar) {
    const avatar = expectedAvatar ?? targetAvatar;
    // Read before the save, used after it. The log line describes an accepted
    // write, so writing it first grows persona.log by one line every time state.js
    // refuses, and a refused write is exactly the case with nothing to record.
    const persona = getPersona(getRoot(), avatar);
    const result = saveAndComposeFor(avatar);
    if (!result) { notify('error', refusalMessage(avatar)); scheduleDraw(); return false; }
    if (persona) {
        if (kind) addLog(persona, kind, detail, Date.now());
        // writeDescription already saved, so this line needs a save of its own.
        freshContext()?.saveSettingsDebounced?.();
    }
    // A section that fell out of the prompt must be said out loud.
    // The banner at the top of the screen carries the names permanently; the toast
    // is only for the moment the set CHANGES, because a section the user has
    // decided to leave empty otherwise produced one toast per tap, which is how a
    // real warning gets trained away.
    const signature = missingSignature(result.missing);
    if (signature !== lastMissing) {
        if (result.missing?.length) notify('warning', STRINGS.common.emptyItems(result.missing.length));
        lastMissing = signature;
    }
    scheduleDraw();
    return true;
}

/* Writes: sections */

async function addSection() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const name = await askText(STRINGS.manager.newItemName, '');
    if (!name || !name.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const persona = ensureShape(after.persona);
    const uuid = freshContext()?.uuidv4;
    const sectionId = makeId(uuid);
    const variantId = makeId(uuid);
    persona.sections.push({ id: sectionId, name: name.trim() });
    persona.variants[sectionId] = [{ id: variantId, label: STRINGS.manager.defaultChoiceLabel, text: '', updatedAt: Date.now() }];
    persona.activePicks[sectionId] = variantId;
    commit('section-add', name.trim(), startAvatar);
}

async function renameSection(sectionId, current) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const name = await askText(STRINGS.manager.itemName, current);
    if (!name || !name.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // Found again on the persona this screen points at now, never carried across
    // the await: the object read before it may belong to a different persona.
    const section = (after.persona.sections ?? []).find(entry => entry.id === sectionId);
    if (!section) { notify('error', STRINGS.manager.itemGone); scheduleDraw(); return; }
    section.name = name.trim();
    commit('section-rename', name.trim(), startAvatar);
}

function shiftSection(sectionId, delta) {
    const s = guardTarget();
    if (!s) return;
    if (!moveSection(s.persona, sectionId, delta)) return;
    commit('section-move', sectionId, s.avatar);
}

async function dropSection(sectionId, name) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    // The last section is never deleted. Asked before the question
    // so the user is not walked through a confirmation that ends in a refusal.
    if (!canDeleteSection(s.persona, sectionId)) {
        notify('error', STRINGS.manager.lastItemKept);
        return;
    }
    if (!(await askConfirm(STRINGS.manager.confirmDropItem(name)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const gone = removeSection(after.persona, sectionId, Date.now());
    if (!gone) { notify('error', STRINGS.manager.lastItemKept); scheduleDraw(); return; }
    if (openVariant?.sectionId === sectionId) { openVariant = null; editorDirty = false; }
    // The drafts belonged to bodies that no longer exist, exactly as in dropVariant.
    // Left behind they are unreachable text that nothing on any screen can show or
    // clear, and they survive until teardown.
    for (const variantId of gone.variantIds) takeDraft(startAvatar, sectionId, variantId);
    // removeSection wrote its own log line, so this call only has to save.
    commit(null, gone.name, startAvatar);
}

/* Writes: variants */

function pickVariant(sectionId, variantId) {
    const s = guardTarget();
    if (!s) return;
    // A change event can outlive the select that produced it: the native Android
    // picker stays open across a redraw, and the node it reports is then detached.
    // Nothing is said about it, because it is not an act on the screen the user is
    // looking at; the check is here so the stray key never reaches activePicks.
    if (!pickApplicable(s.persona, sectionId, variantId)) return;
    s.persona.activePicks = { ...(s.persona.activePicks ?? {}), [sectionId]: variantId };
    commit('pick', sectionId, s.avatar);
}

async function addVariant(sectionId) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const label = await askText(STRINGS.manager.newChoiceName, '');
    if (!label || !label.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const persona = ensureShape(after.persona);
    if (!Array.isArray(persona.variants[sectionId])) { notify('error', STRINGS.manager.itemGone); scheduleDraw(); return; }
    const variant = { id: makeId(freshContext()?.uuidv4), label: label.trim(), text: '', updatedAt: Date.now() };
    persona.variants[sectionId].push(variant);
    commit('variant-add', label.trim(), startAvatar);
}

async function renameVariant(sectionId, variantId, current) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const label = await askText(STRINGS.manager.choiceName, current);
    if (!label || !label.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const variant = (after.persona.variants?.[sectionId] ?? []).find(entry => entry.id === variantId);
    if (!variant) { notify('error', STRINGS.manager.choiceGone); scheduleDraw(); return; }
    variant.label = label.trim();
    commit('variant-rename', label.trim(), startAvatar);
}

function duplicateVariant(sectionId, variantId) {
    const s = guardTarget();
    if (!s) return;
    const list = s.persona.variants?.[sectionId];
    const source = (list ?? []).find(entry => entry.id === variantId);
    if (!Array.isArray(list) || !source) return;
    // The copy carries the text and nothing else. History belongs to the variant
    // it was taken from, and a copy that inherited it would offer to restore text
    // this variant never had.
    const copy = {
        id: makeId(freshContext()?.uuidv4),
        label: STRINGS.common.copySuffix(source.label ?? ''),
        text: source.text ?? '',
        updatedAt: Date.now(),
    };
    list.splice(list.indexOf(source) + 1, 0, copy);
    commit('variant-duplicate', copy.label, s.avatar);
}

async function dropVariant(sectionId, variantId, label) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const list = s.persona.variants?.[sectionId] ?? [];
    if (list.length <= 1) { notify('error', STRINGS.manager.lastChoiceKept); return; }
    if (!(await askConfirm(STRINGS.manager.confirmDropChoice(label)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const result = deleteVariant(after.persona, sectionId, variantId, Date.now());
    if (!result) { notify('error', STRINGS.manager.choiceUndeletable); scheduleDraw(); return; }
    if (openVariant?.variantId === variantId) { openVariant = null; editorDirty = false; }
    // The draft belonged to a body that no longer exists.
    takeDraft(startAvatar, sectionId, variantId);
    if (historyVariant === variantId) { historyVariant = null; historyIndex = null; }
    // The move is logged by deleteVariant, and said out loud here
    // as well, because the combination changed under the user without a tap.
    if (result.movedTo) notify('info', STRINGS.manager.pickMovedToFirst);
    // deleteVariant wrote its own log lines, so this call only has to save.
    commit(null, result.label, startAvatar);
}

// The one path that writes a variant body. The text being replaced
// goes into history first, so saving is never the operation that loses something.
function saveVariantText(sectionId, variantId, text) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const variant = (s.persona.variants?.[sectionId] ?? []).find(entry => entry.id === variantId);
    if (!variant) { notify('error', STRINGS.manager.choiceGone); editorDirty = false; scheduleDraw(); return; }
    const previous = variant.text ?? '';
    if (previous === text) {
        editorDirty = false;
        takeDraft(startAvatar, sectionId, variantId);
        notify('info', STRINGS.manager.nothingChanged);
        scheduleDraw();
        return;
    }
    const now = Date.now();
    snapshot(s.persona, variantId, previous, now, s.settings);
    variant.text = text;
    variant.updatedAt = now;
    // The per variant cap does not bound the total, and the
    // total is what fills settings.json. A snapshot is the only moment the total
    // can grow, so it is the moment to enforce the cap.
    // historyIndex is a POSITION into a variant's list and both passes drop
    // entries from the FRONT, so a tick left on "3일 전" silently comes to mean a
    // different snapshot. The bounds check downstream only catches an index that
    // fell off the end, not one that shifted under it.
    if (expireOldHistory(s.root, s.settings, now) + enforceGlobalBudget(s.root, s.settings, now)) {
        historyIndex = null;
    }
    editorDirty = false;
    // The text is on the variant now. A draft left behind would be restored over
    // the saved text the next time this body is opened.
    takeDraft(startAvatar, sectionId, variantId);
    commit('variant-edit', variant.label ?? '', startAvatar);
}

/* Writes: versions */

// The version id is a string the row was drawn with, and the version itself is
// looked up again on the persona this screen points at when the write happens.
async function applyVersion(versionId) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!versionApplicable(s.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    // Switching version on top of an outside edit throws that edit
    // away, so ask once more instead of doing it quietly. Divergence is asked of
    // the persona being written to, not of whoever happens to be active.
    const ctx = freshContext();
    const diverged = ctx ? hasDiverged(ctx, s.avatar, s.persona) : false;
    if (diverged && !(await askConfirm(STRINGS.common.confirmVersionOverOutsideEdit))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // Asked again of the persona being written to. Matching avatars is necessary
    // and not sufficient: our own data for it can have been rewritten meanwhile.
    if (!versionApplicable(after.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    const version = (after.persona.versions ?? []).find(entry => entry.id === versionId);
    after.persona.activeVersionId = version.id;
    after.persona.activePicks = { ...(version.picks ?? {}) };
    commit('version-apply', version.name ?? '', startAvatar);
    // The prompt is applied and saved above; the picture follows on its own. A
    // version that cannot move its picture is still an applied version, so this
    // is never awaited into the tap and never undoes what commit just wrote.
    void runBoundImage(startAvatar, versionId, false);
}

async function saveAsVersion() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const name = await askText(STRINGS.common.newVersionName, '');
    if (!name || !name.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const persona = ensureShape(after.persona);
    const version = {
        id: makeId(freshContext()?.uuidv4),
        name: name.trim(),
        picks: { ...(persona.activePicks ?? {}) },
        // Null is 전체, and a version made today should keep using
        // every file including ones uploaded tomorrow.
        assetSelection: null,
        avatarAsset: null,
        updatedAt: Date.now(),
    };
    persona.versions.push(version);
    persona.activeVersionId = version.id;
    commit('version-create', version.name, startAvatar);
}

async function renameVersion(versionId, current) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const name = await askText(STRINGS.manager.versionName, current);
    if (!name || !name.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const version = (after.persona.versions ?? []).find(entry => entry.id === versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    version.name = name.trim();
    commit('version-rename', name.trim(), startAvatar);
}

function duplicateVersion(versionId) {
    const s = guardTarget();
    if (!s) return;
    const persona = ensureShape(s.persona);
    const source = persona.versions.find(entry => entry.id === versionId);
    if (!source) return;
    const copy = {
        id: makeId(freshContext()?.uuidv4),
        name: STRINGS.common.copySuffix(source.name ?? ''),
        // Copied by value. Sharing the object would make editing one version's
        // combination silently edit the other's.
        picks: { ...(source.picks ?? {}) },
        assetSelection: Array.isArray(source.assetSelection) ? [...source.assetSelection] : null,
        updatedAt: Date.now(),
    };
    // Next to the original, not at the end: a copy made to be edited is easier to
    // find beside what it came from. activeVersionId is deliberately left alone.
    persona.versions.splice(persona.versions.indexOf(source) + 1, 0, copy);
    commit('version-duplicate', copy.name, s.avatar);
}

// The repair path for a version whose picks went stale, and the only way to
// change a saved combination without deleting it. Nothing is snapshotted: history
// covers variant text, and a version holds no text of its own.
async function overwriteVersion(versionId, name) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmOverwriteVersion(name)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const version = (after.persona.versions ?? []).find(entry => entry.id === versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    version.picks = { ...(after.persona.activePicks ?? {}) };
    version.updatedAt = Date.now();
    commit('version-overwrite', version.name ?? '', startAvatar);
}

// A dead slot is shown as 없음 and the user is made to CHOOSE.
// Reporting it and offering no way to fill it in place left 고르게 한다 unimplemented:
// the only repair was to make the whole combination live and overwrite the version
// with it, which is a different act. This writes one slot, through the same guard
// and the same commit as everything else.
function setVersionPick(versionId, sectionId, variantId) {
    const s = guardTarget();
    if (!s) return;
    // The same stray-event check pickVariant makes, for the same reason.
    if (!pickApplicable(s.persona, sectionId, variantId)) return;
    const version = (s.persona.versions ?? []).find(entry => entry.id === versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    version.picks = { ...(version.picks ?? {}), [sectionId]: variantId };
    version.updatedAt = Date.now();
    commit('version-repick', version.name ?? '', s.avatar);
}

async function dropVersion(versionId, name) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmDropVersion(name)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const versions = after.persona.versions ?? [];
    const index = versions.findIndex(entry => entry.id === versionId);
    if (index === -1) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    versions.splice(index, 1);
    // The picks are the live combination and belong to the
    // persona, not to the version. Deleting the version drops the label, and the
    // combination the user is actually running stays exactly as it is.
    if (after.persona.activeVersionId === versionId) after.persona.activeVersionId = null;
    commit('version-delete', name, startAvatar);
}

/* Writes: history */

async function restoreSnapshot(variantId, index) {
    // The button only exists while a snapshot is selected, but the selection is
    // module state and the handler runs later, so the index is checked rather
    // than assumed: restore() would read list[null] and throw.
    if (!Number.isInteger(index)) return;
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmRestore))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const now = Date.now();
    try {
        restore(after.persona, variantId, index, now, after.settings);
    } catch {
        // The snapshot list can have been trimmed by an eviction while the
        // question was on screen, and restore refuses an index it cannot reach.
        notify('error', STRINGS.manager.snapshotGone);
        historyIndex = null;
        scheduleDraw();
        return;
    }
    // Restoring writes a snapshot of its own, which is the one
    // moment the total can grow, so it is the moment to enforce the cap.
    if (expireOldHistory(after.root, after.settings, now) + enforceGlobalBudget(after.root, after.settings, now)) {
        historyIndex = null;
    }
    historyIndex = null;
    // The editor may be sitting on the body that just changed underneath it.
    if (openVariant?.variantId === variantId) { openVariant = null; editorDirty = false; }
    // restore wrote its own log line, so this call only has to save.
    commit(null, '', startAvatar);
}

/* Writes: assets */

async function loadAssets(avatar) {
    const root = getRoot();
    if (!root || !avatar) return;
    assetState = { avatar, list: [], error: null, loading: true };
    // resolveFolderKey never creates an entry and never stores anything, so
    // listing works for a persona that has not been adopted. claimFolderKey, which
    // does store, is only reached from the upload path where the entry exists.
    const key = resolveFolderKey(root, avatar);
    try {
        const ctx = freshContext();
        if (!ctx) throw new Error(STRINGS.manager.noContext);
        const list = await listAssets(ctx, key);
        // The user may have moved the screen to another persona while this was in
        // flight. Publishing then would file one persona's pictures under another
        // persona's name, which is the exact confusion the folder key prevents.
        if (assetState.avatar !== avatar) return;
        assetState = { avatar, list, error: null, loading: false };
    } catch (e) {
        if (assetState.avatar !== avatar) return;
        // A sprites listing failure disables the tab and puts the
        // status on screen. Swallowing it leaves a tab that merely looks empty.
        assetState = { avatar, list: [], error: String(e?.message ?? e), loading: false };
    }
    scheduleDraw();
}

async function uploadAssets(files) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', refusalMessage(targetAvatar)); return; }
    const startAvatar = targetAvatar;
    // The key is claimed once and never recomputed, and claiming
    // needs the entry, which guardTarget just proved exists.
    const key = claimFolderKey(s.root, startAvatar, () => freshContext()?.saveSettingsDebounced?.());
    let ok = 0;
    for (const file of files) {
        try {
            const ctx = freshContext();
            if (!ctx) throw new Error(STRINGS.manager.noContext);
            await uploadAsset(ctx, key, file);
            ok++;
        } catch (e) {
            // The status code goes on screen with the file name.
            // One toast per failure, because each file failed for its own reason.
            notify('error', STRINGS.manager.assetUploadFailed(file?.name ?? STRINGS.manager.assetFileFallback, String(e?.message ?? e)));
        }
    }
    if (ok) {
        const after = getPersona(getRoot(), startAvatar);
        if (after) {
            addLog(after, 'asset-upload', STRINGS.manager.assetUploadedLog(ok), Date.now());
            freshContext()?.saveSettingsDebounced?.();
        }
        notify('success', STRINGS.manager.assetUploaded(ok));
    }
    await refreshAssetViews(startAvatar);
}

async function dropAsset(label) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', refusalMessage(targetAvatar)); return; }
    const startAvatar = targetAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmDropAsset(label)))) return;
    if (startAvatar !== targetAvatar) { notify('error', STRINGS.manager.targetMovedNotDeleted); return; }
    const root = getRoot();
    if (!root) { notify('error', refusalMessage(startAvatar)); return; }
    const key = resolveFolderKey(root, startAvatar);
    try {
        const ctx = freshContext();
        if (!ctx) throw new Error(STRINGS.manager.noContext);
        await deleteAsset(ctx, key, label);
    } catch (e) {
        notify('error', STRINGS.manager.assetDeleteFailed(String(e?.message ?? e)));
        return;
    }
    const persona = getPersona(getRoot(), startAvatar);
    if (persona) {
        addLog(persona, 'asset-delete', label, Date.now());
        freshContext()?.saveSettingsDebounced?.();
    }
    await refreshAssetViews(startAvatar);
}

// Both listings, because they answer different questions: ours draws this tab,
// and state.js's feeds the {{persona_assets}} macro for the persona actually
// being played. The second one is only worth refetching when they are the same
// persona, since that is the only case our change touched it.
async function refreshAssetViews(avatar) {
    await loadAssets(avatar);
    if (getState()?.avatar === avatar) await refreshAssets();
}

function toggleVersionAsset(versionId, filename) {
    const s = guardTarget();
    if (!s) return;
    const version = (s.persona.versions ?? []).find(entry => entry.id === versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    // The full file list is what makes 전체 expressible: see toggleAssetSelection.
    toggleAssetSelection(version, filename, assetLabels());
    version.updatedAt = Date.now();
    commit('asset-select', version.name ?? '', s.avatar);
}

/* Writes: labels */

// These write labels, not persona content, so they check
// ambiguous and readOnly directly rather than go through the target guard: a label
// is not tied to whichever persona this screen is pointed at, so which persona
// that is does not bear on whether they may proceed.
function rosterWritable(s) {
    return !!s && !s.ambiguous && !s.readOnly;
}

// A refusal that says nothing is the failure mode this project
// exists to avoid, and these four used to return in silence. The label tab draws
// its buttons from rosterWritable(getState()) too, so a refusal here is normally
// unreachable; normally is not never, because the state can turn under a handler
// that is waiting on a popup.
function rosterRefusal() {
    const s = getState();
    if (!s) return STRINGS.manager.groupRefusalNoState;
    if (s.readOnly) return STRINGS.manager.groupRefusalReadOnly;
    if (s.ambiguous) return STRINGS.manager.groupRefusalAmbiguous;
    return STRINGS.manager.groupRefusalOther;
}

function refuseRoster() {
    notify('error', rosterRefusal());
    scheduleDraw();
    return false;
}

async function editLabel(labelId, current) {
    if (!rosterWritable(getState())) return refuseRoster();
    const name = await askText(STRINGS.manager.groupName, current);
    if (!name || !name.trim()) return;
    // Re-read after the await, and the label found again by id: the state object
    // from before it may already have been replaced by an event.
    const after = getState();
    if (!rosterWritable(after)) return refuseRoster();
    if (!renameLabel(after.root?.labels, labelId, name)) { notify('error', STRINGS.manager.groupGone); scheduleDraw(); return; }
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

async function dropLabel(labelId, name) {
    if (!rosterWritable(getState())) return refuseRoster();
    if (!(await askConfirm(STRINGS.manager.confirmDropGroup(name)))) return;
    const after = getState();
    if (!rosterWritable(after)) return refuseRoster();
    if (!deleteLabel(after.root?.labels, labelId)) { notify('error', STRINGS.manager.groupGone); scheduleDraw(); return; }
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

// Creating a label stays in the quick panel too, where it is
// attached to the row it was made from. Here there is no row, so the label is made
// empty and the user ticks members in the panel. Making it in only one of the two
// places is what sent the user back to the panel to do half the job.
function addLabel(name) {
    const s = getState();
    if (!rosterWritable(s)) return refuseRoster();
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return false;
    const uuid = freshContext()?.uuidv4;
    if (!Array.isArray(s.root.labels)) s.root.labels = [];
    s.root.labels.push({ id: makeId(uuid), name: trimmed, members: [] });
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
    return true;
}

function toggleLabelMembership(labelId, avatarId) {
    const s = getState();
    if (!rosterWritable(s)) return refuseRoster();
    if (!Array.isArray(s.root.labels)) s.root.labels = [];
    toggleMember(s.root.labels, labelId, avatarId);
    freshContext()?.saveSettingsDebounced?.();
    scheduleDraw();
}

/* Target selection */

async function selectTarget(avatar) {
    if (avatar === targetAvatar) { pickerOpen = false; scheduleDraw(); return; }
    // The revise screen's working copies belong to the persona being left, and
    // every way out of them gets the one question: without this, a save after the
    // switch dropped a junk version on the new persona and quietly lost every
    // revision.
    if (reviseDirtyCount() > 0) {
        const ok = await askConfirm(STRINGS.manager.reviseConfirmLeave(reviseDirtyCount()));
        // Re-checked like requestClose: the screen, or the moment, may be gone.
        if (!ok || !document.getElementById(HOST_ID)) return;
        if (avatar === targetAvatar) { pickerOpen = false; scheduleDraw(); return; }
    }
    // The 전문 window's working copies are the same case, and worse if unasked:
    // its bodies are edits to text that EXISTS, so carrying them to another
    // persona would write one persona's paragraphs over another's.
    if (fullDirtyCount() > 0) {
        const ok = await askConfirm(STRINGS.manager.fullTextConfirmLeave(fullDirtyCount()));
        if (!ok || !document.getElementById(HOST_ID)) return;
        if (avatar === targetAvatar) { pickerOpen = false; scheduleDraw(); return; }
    }
    resetFullText();
    placementOpen = false;
    namesOpen = false;
    personaOpen = false;
    resetRevise();
    // Search, filters and pages describe the persona being left.
    resetListUi();
    // What is in the editor belongs to the persona we are leaving, so it is put
    // away under THAT persona's key before the target moves.
    stashDraft();
    targetAvatar = avatar;
    openVariant = null;
    editorDirty = false;
    pickerOpen = false;
    historyVariant = null;
    historyIndex = null;
    expandedRow = null;
    lastMissing = null;
    scheduleDraw();
}

// An entry is created only when the user asks for
// one, and never by merely looking at a persona. adoptFor seeds the first variant
// from the existing description byte for byte.
async function adoptTarget() {
    const avatar = targetAvatar;
    if (!avatar) return;
    if (!(await askConfirm(STRINGS.manager.confirmAdopt))) return;
    if (avatar !== targetAvatar) { notify('error', STRINGS.manager.targetMovedNotAdopted); return; }
    if (!adoptFor(avatar)) { notify('error', refusalMessage(avatar)); return; }
    scheduleDraw();
}

/* Drafts (review findings R2 and R3) */

// What is in the editor right now, found in the document rather than captured.
// A tap blurs the textarea first, that blur releases the deferred redraw, and the
// frame can land before the click does, so the node the editor was built with may
// already be detached by the time the button runs. The rebuilt one carries the
// typing across (see drawManager), and this reads whichever one is really there.
function readEditorText() {
    const area = document.getElementById(PANEL_ID)?.querySelector('.pm-manager-editor-text');
    return area ? area.value : null;
}

// Called by every path that takes the editor off the screen without saving. The
// text goes into the draft store under the body it belongs to and comes back when
// that body is opened again, which is why changing tab or opening a second
// variant no longer has to ask a question or throw the typing away.
function stashDraft() {
    if (!editorDirty || !openVariant || !targetAvatar) return;
    const text = readEditorText();
    if (text === null) return;
    putDraft(targetAvatar, openVariant.sectionId, openVariant.variantId, text);
}

/* Content */

// Every button is at least 40px through .pm-manager-btn, and the
// disabled form keeps the same box so the layout does not shift when the root
// turns read only under the user.
//
// reason is why the button is disabled. It rides the tooltip like title does, and
// unlike title it is also drawn as text by actionsRow, because a tooltip needs a
// hover to appear and a touch screen has none: a reason that lives only in title
// is a reason the user on the phone can never read.
function actionButton(label, onClick, enabled, title, reason) {
    const btn = el('button', 'pm-manager-btn', label);
    btn.type = 'button';
    const tip = (!enabled && reason) ? reason : title;
    if (tip) { btn.title = tip; btn.setAttribute('aria-label', `${label}: ${tip}`); }
    // Selection and every action react to click only. Opening on
    // touchstart lets the synthesized click land on whatever the redraw just put
    // under the finger.
    if (enabled) btn.addEventListener('click', onClick);
    else {
        btn.disabled = true;
        btn.classList.add('pm-disabled');
        if (reason) btn.dataset.pmReason = reason;
    }
    return btn;
}

function actionsRow(buttons) {
    const box = el('div', 'pm-manager-actions');
    const reasons = [];
    for (const btn of buttons) {
        box.append(btn);
        const reason = btn.dataset?.pmReason;
        if (reason && !reasons.includes(reason)) reasons.push(reason);
    }
    if (!reasons.length) return box;
    const wrap = el('div', 'pm-manager-actionswrap');
    wrap.append(box);
    for (const reason of reasons) wrap.append(el('div', 'pm-manager-hint', reason));
    return wrap;
}

function noteOf(text) {
    return el('div', 'pm-manager-note', text);
}

// An empty list is the one place this panel has room, and the reference fills its
// empty space with something big rather than with a sentence in the corner. The
// asterisk is that reference's own divider glyph; here it marks the hole where
// content will be. The word stays the plain negation the writing rule asks for.
function emptyOf(text) {
    const box = el('div', 'pm-empty');
    const mark = el('div', 'pm-empty-mark', '✳');
    // The word underneath carries the meaning; the glyph is the reference's
    // divider doing duty as a graphic, so it is not announced.
    mark.setAttribute('aria-hidden', 'true');
    box.append(mark);
    box.append(el('div', 'pm-empty-text', text));
    return box;
}

/* Rows that keep their extra actions folded away */

// Rule 6, as one sentence rather than as a guess per button. The wording is the
// same one the write path answers with, so a control cannot promise something
// the guard would then refuse. An empty string means nothing is blocking.
function writeReason(s) {
    if (!s) return STRINGS.manager.refusalNoRoot;
    if (s.readOnly) return STRINGS.manager.refusalReadOnly;
    if (s.ambiguous) return STRINGS.manager.refusalAmbiguous;
    return '';
}

function toggleExpanded(key) {
    expandedRow = expandedRow === key ? null : key;
    scheduleDraw();
}

// The identity half of a row, and the large target that opens the rest of its
// actions. A button rather than a handler on the whole row: the row also carries
// its one primary action, and a row level handler would fire for that button's
// taps too, so the two would fight over one finger.
//
// parts are the nodes of the first line. summary is an optional second line, kept
// to one ellipsised row because a list cannot afford to grow by however much each
// entry happens to contain.
function rowName(key, parts, summary) {
    const open = expandedRow === key;
    const btn = el('button', 'pm-manager-rowname');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const top = el('div', 'pm-manager-rowtop');
    for (const part of parts) top.append(part);
    btn.append(top);
    if (summary) btn.append(el('div', 'pm-manager-rowsummary', summary));
    // Click only. Opening on touchstart lets the synthesized click
    // land on whatever the redraw just put under the finger.
    btn.addEventListener('click', () => toggleExpanded(key));
    return btn;
}

// Which row is open is drawn, never hovered, so the mark changes
// with the state instead of appearing on a hover a touch screen cannot make.
function foldMark(open, onToggle) {
    const btn = actionButton(open ? '↑' : '↗', onToggle, true, STRINGS.common.more);
    btn.classList.add('pm-manager-more');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    return btn;
}

function moreButton(key) {
    return foldMark(expandedRow === key, () => toggleExpanded(key));
}

// A block that folds away, for the things that sit above a tab's list rather than
// inside it. The same head shape as a row (name, one line summary, the mark on
// the right) so the tap target and the cue read identically, but its open state
// is a boolean of the tab's own: expandedRow belongs to the list underneath and
// is cleared by whichever tab draws next.
function foldBox(className, title, summary, open, onToggle) {
    const box = el('div', `${className}${open ? ' pm-manager-rowopen' : ''}`);
    const btn = el('button', 'pm-manager-rowname');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const top = el('div', 'pm-manager-rowtop');
    top.append(el('span', 'pm-manager-name', title));
    btn.append(top);
    if (summary) btn.append(el('div', 'pm-manager-rowsummary', summary));
    btn.addEventListener('click', onToggle);
    const head = rowHead();
    head.append(btn);
    head.append(foldMark(open, onToggle));
    box.append(head);
    return box;
}

// Buttons stacked one per line at 40px each, with the reason for any disabled one
// written underneath it. Rule 6: a tooltip needs a hover, so a reason that lives
// only in title is a reason the user on the phone can never read.
function buttonStack(buttons, extraClass) {
    const box = el('div', `pm-manager-stack${extraClass ? ` ${extraClass}` : ''}`);
    for (const btn of buttons) {
        box.append(btn);
        const reason = btn.dataset?.pmReason;
        if (reason) box.append(el('div', 'pm-manager-hint pm-manager-hint-left', reason));
    }
    return box;
}

// The drawer under an open row. Rule 5: the destructive button is last and sits
// in a block of its own, so the tap that deletes cannot be the tap that missed
// 복제 by six pixels. The gap is in style.css, where it can be seen.
function expansionOf(buttons, dangerButtons) {
    const box = el('div', 'pm-manager-expand');
    if (buttons?.length) box.append(buttonStack(buttons));
    if (dangerButtons?.length) box.append(buttonStack(dangerButtons, 'pm-manager-danger'));
    return box;
}

function rowHead() {
    return el('div', 'pm-manager-rowhead');
}

function bannerOf(className, message) {
    const box = el('div', `pm-manager-banner ${className}`);
    box.append(el('div', 'pm-manager-banner-text', message));
    return box;
}

function groupOf(title) {
    const box = el('div', 'pm-manager-group');
    box.append(el('div', 'pm-manager-head', title));
    return box;
}

function checkMark(active) {
    // Hover carries no meaning on a touch screen, so the mark is
    // always drawn and only its content changes.
    return el('span', 'pm-check', active ? '✓' : '');
}

function formatTime(at) {
    if (!at) return '';
    try { return new Date(at).toLocaleString(); } catch { return String(at); }
}

// The active pick control, identical in behaviour to the quick panel's section
// group: a native select, because it opens the Android picker, and a pick left
// naming a deleted variant is shown as such rather than snapping to the first
// option, which would display a combination the prompt does not contain.
function pickSelect(persona, section, writable) {
    const select = el('select', 'pm-manager-select');
    const variants = persona.variants?.[section.id] ?? [];
    const picked = persona.activePicks?.[section.id] ?? '';
    if (picked && !variants.some(variant => variant.id === picked)) {
        const dead = el('option', null, STRINGS.common.deletedChoiceOption);
        dead.value = picked;
        select.append(dead);
    }
    for (const variant of variants) {
        const option = el('option', null, variant.label ?? '');
        option.value = variant.id;
        select.append(option);
    }
    select.value = picked;
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.manager.activeChoiceAria(section.name ?? ''));
    select.addEventListener('change', () => pickVariant(section.id, select.value));
    return select;
}

// Whether this body has an unsaved edit worth reporting. A draft that matches what
// is stored is not one: the user typed something and typed it back, and drawing a
// badge for it puts a claim on screen that no control anywhere can clear. One rule,
// asked by the row and by the editor, so the badge and the discard button can never
// disagree about what exists.
function pendingDraft(sectionId, variant) {
    const draft = peekDraft(targetAvatar, sectionId, variant.id);
    return (draft !== null && draft !== (variant.text ?? '')) ? draft : null;
}

// The body the editor is open on, found on the persona this screen points at
// right now. openVariant holds two plain strings and nothing else, so a body that
// was deleted while its editor was open resolves to null here and the list comes
// back rather than the screen going blank.
function openBody(persona) {
    if (!openVariant) return null;
    const section = (persona?.sections ?? []).find(entry => entry.id === openVariant.sectionId);
    if (!section) return null;
    const variant = (persona?.variants?.[section.id] ?? []).find(entry => entry.id === openVariant.variantId);
    return variant ? { section, variant } : null;
}

// The body editor, filling the tab on its own. One screen,
// one task, so the item list is gone while this is up and comes back when it
// closes. Everything about drafts below is the machinery that was already here,
// only laid out differently: the editor still saves on a button, still restores a
// draft that differs from what is stored, and still puts its text away under this
// body's key on every path that takes it off the screen.
//
// There is deliberately no keydown handler on the textarea: Enter has to insert a
// newline here, so there is nothing for a hangul composition commit to fire by
// accident.
function variantEditor(section, variant, writable, reason) {
    const sectionId = section.id;
    const box = el('div', 'pm-manager-editorscreen');
    box.append(el('div', 'pm-manager-editorhead',
        STRINGS.manager.editorHeading(section.name ?? '', variant.label ?? '')));
    const stored = variant.text ?? '';
    const draft = peekDraft(targetAvatar, sectionId, variant.id);
    // Opening the body is the moment to settle a draft that says nothing. Dropped
    // silently, because there is nothing to tell the user: the text they get is the
    // text they would have got either way.
    if (draft !== null && draft === stored) takeDraft(targetAvatar, sectionId, variant.id);
    const restored = draft !== null && draft !== stored;
    if (restored) {
        // The screen has unsaved text in it again, so closing has to ask again.
        // Derived from the draft rather than remembered separately: the flag and
        // the draft would otherwise be two records of one fact.
        editorDirty = true;
        box.append(noteOf(STRINGS.manager.editorRestored));
    }
    const area = el('textarea', 'pm-manager-editor-text');
    area.value = restored ? draft : stored;
    area.rows = 12;
    area.disabled = !writable;
    area.setAttribute('aria-label', STRINGS.manager.editorAria(variant.label ?? ''));
    area.addEventListener('input', () => { editorDirty = true; scheduleSizeUpdate(); });
    box.append(area);
    // The size of what is in the box right now (user request), under the box it
    // measures. Updated by a trailing timer that rewrites this one line, never by
    // a redraw: a rebuild here would take the field out of the document in the
    // middle of a hangul composition.
    box.append(el('div', 'pm-manager-size pm-size-editor', sizeTextOf(area.value)));

    const buttons = [
        actionButton(STRINGS.common.save, () => {
            const text = readEditorText();
            if (text === null) return;
            saveVariantText(sectionId, variant.id, text);
        }, writable, '', reason),
    ];
    // Only offered when there is something to discard. A button that is always
    // there and almost always disabled is a control the user has to read twice.
    if (restored) {
        buttons.push(actionButton(STRINGS.manager.editorDiscard, () => {
            takeDraft(targetAvatar, sectionId, variant.id);
            editorDirty = false;
            scheduleDraw();
        }, true, STRINGS.manager.editorDiscardTitle));
    }
    // 목록으로, not 닫기: the header's 닫기 (whole screen) is on screen at the same
    // time, and two buttons with one word and two meanings ask the user to guess
    // which one loses more.
    buttons.push(actionButton(STRINGS.manager.editorBackToList, () => {
        stashDraft();
        openVariant = null;
        editorDirty = false;
        scheduleDraw();
    }, true, STRINGS.manager.editorCloseTitle));
    // Rule 3: [저장] and [닫기] stay at the bottom of the panel. Sticky is relative
    // to the scroll container, which is .pm-scroll, so the footer has to be inside
    // it, and it is: this whole screen is drawn into the scrolling body.
    const foot = el('div', 'pm-manager-editorfoot');
    foot.append(actionsRow(buttons));
    box.append(foot);
    return box;
}

// One 선택지. The row shows its name and the one action it
// exists for, which is opening the body, and the rest waits behind the row tap.
function variantRow(persona, section, variant, writable, reason) {
    const key = rowKey('choice', section.id, variant.id);
    const open = expandedRow === key;
    const row = el('div', `pm-manager-variantrow${open ? ' pm-manager-rowopen' : ''}`);
    const parts = [
        checkMark(persona.activePicks?.[section.id] === variant.id),
        markedText('pm-manager-name', variant.label ?? '', listUi.compose.open ? listUi.compose.query : ''),
    ];
    if (pendingDraft(section.id, variant) !== null) {
        parts.push(el('span', 'pm-manager-count', STRINGS.manager.pendingDraft));
    }
    const head = rowHead();
    head.append(rowName(key, parts));
    head.append(actionButton(STRINGS.manager.editorOpen, () => {
        // R3: the editor that is about to be replaced keeps its typing.
        stashDraft();
        openVariant = { sectionId: section.id, variantId: variant.id };
        editorDirty = false;
        // The list is about to be replaced by the editor, so an open drawer on it
        // has nothing left to sit under.
        expandedRow = null;
        scheduleDraw();
    }, true));
    head.append(moreButton(key));
    row.append(head);
    if (!open) return row;

    const last = (persona.variants?.[section.id] ?? []).length <= 1;
    row.append(expansionOf([
        actionButton(STRINGS.common.rename, () => renameVariant(section.id, variant.id, variant.label ?? ''), writable, '', reason),
        actionButton(STRINGS.common.duplicate, () => duplicateVariant(section.id, variant.id), writable, '', reason),
    ], [
        // A section always keeps one variant, and the control says
        // so by being disabled rather than by failing after the tap.
        actionButton(STRINGS.common.remove, () => dropVariant(section.id, variant.id, variant.label ?? ''), writable && !last,
            '', last ? STRINGS.manager.lastChoiceKept : reason),
    ]));
    return row;
}

function sectionBlock(persona, section, index, writable, reason) {
    const key = rowKey('section', section.id);
    const open = expandedRow === key;
    const box = el('div', `pm-manager-section${open ? ' pm-manager-rowopen' : ''}`);
    const variants = persona.variants?.[section.id] ?? [];

    const head = rowHead();
    // The name goes in its own span: only an element child can be given the
    // ellipsis that keeps a long item name from pushing the buttons off screen.
    head.append(rowName(key, [
        markedText('pm-manager-name', section.name ?? '', listUi.compose.open ? listUi.compose.query : ''),
        el('span', 'pm-manager-count', STRINGS.manager.choiceCount(variants.length)),
    ]));
    head.append(dragHandle(section.id, writable, reason));
    head.append(moreButton(key));
    box.append(head);
    // dropTargetAt reads this id off the row under the finger. The id and not a
    // position, because fillComposeList filters the list when a search is open and
    // a rendered position is then not an index into persona.sections.
    box.dataset.pmSection = section.id;

    if (open) {
        const canDelete = canDeleteSection(persona, section.id);
        const atTop = index <= 0;
        const atEnd = index >= (persona.sections?.length ?? 0) - 1;
        box.append(expansionOf([
            actionButton(STRINGS.manager.moveUp, () => shiftSection(section.id, -1), writable && !atTop, '', atTop ? '' : reason),
            actionButton(STRINGS.manager.moveDown, () => shiftSection(section.id, 1), writable && !atEnd, '', atEnd ? '' : reason),
            actionButton(STRINGS.common.rename, () => renameSection(section.id, section.name ?? ''), writable, '', reason),
        ], [
            actionButton(STRINGS.common.remove, () => dropSection(section.id, section.name ?? ''), writable && canDelete,
                '', canDelete ? reason : STRINGS.manager.lastItemKept),
        ]));
    }

    const pick = el('div', 'pm-manager-pickrow');
    pick.append(el('span', 'pm-manager-picklabel', STRINGS.manager.activeChoice));
    pick.append(pickSelect(persona, section, writable));
    box.append(pick);

    for (const variant of variants) box.append(variantRow(persona, section, variant, writable, reason));
    box.append(actionsRow([actionButton(STRINGS.manager.addChoice, () => addVariant(section.id), writable, '', reason)]));
    return box;
}

/* List search, filters and paging */

// The search toggle for one list. Searching writes nothing, so it never goes
// dead with the write controls. Closing it clears the query, filters and page.
/* Which search field, if any, the next draw has to put the user on.

   Opening a search used to mean the row APPEARED and nothing else, and the row
   for the 편집 tab sits under the tags, the persona, the language names and the
   item-title select: on a phone the user pressed 검색, landed at the top of the
   tab, and saw a screen with no search on it. From the quick panel's 검색
   shortcut it looked worse still, because that one opens this tab on purpose and
   all the user could see was the tab. 검색 눌러도 편집탭으로 간다고, in their
   words, 최소한 검색창으로 가야지.

   A key rather than a boolean, so a draw that rebuilds a different tab cannot
   steal the focus, and cleared by whoever consumes it so it happens exactly once. */
let focusSearch = null;

function listSearchButton(key) {
    const ui = listUi[key];
    const btn = el('button', 'pm-manager-btn', ui.open ? STRINGS.common.searchClose : STRINGS.common.search);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', ui.open ? 'true' : 'false');
    btn.addEventListener('click', () => {
        ui.open = !ui.open;
        if (!ui.open) { ui.query = ''; ui.lang = null; ui.tags = []; ui.page = 1; }
        else focusSearch = key;
        scheduleDraw();
    });
    return btn;
}

// The input row. Typing repaints ONLY the list container below it, so the
// field itself is never rebuilt mid composition; full draws rebuild it with
// the value restored from module state.
function listSearchRow(key) {
    const ui = listUi[key];
    const row = el('div', 'pm-search-row');
    const input = el('input', 'pm-search-input');
    input.type = 'search';
    input.value = ui.query;
    input.placeholder = STRINGS.common.search;
    input.setAttribute('aria-label', STRINGS.common.search);
    input.autocapitalize = 'none';
    input.spellcheck = false;
    // Marked, not focused: this node is not in the document yet. drawManager
    // takes it from here once the panel has been put together.
    if (focusSearch === key) input.dataset.pmFocus = '1';
    input.addEventListener('input', () => {
        ui.query = input.value;
        ui.page = 1;
        redrawManagerList(key);
    });
    row.append(input);
    return row;
}

// Puts the user on the search field that was just opened: the caret in it, the
// row on screen, and on a phone the keyboard up. Runs at the end of a draw, when
// the node exists and has a size, and only for the field the flag names.
function takeSearchFocus() {
    focusSearch = null;
    const panel = document.getElementById(PANEL_ID);
    const input = panel?.querySelector('input[data-pm-focus]');
    if (!input) return;
    delete input.dataset.pmFocus;
    // Centred rather than merely "in view": the row is a strip in a long list and
    // the ends of the scroller are exactly where "in view" leaves it half hidden
    // behind the sticky header or the footer.
    input.scrollIntoView?.({ block: 'center' });
    input.focus?.({ preventScroll: true });
}

/* One rebuild per frame per list, for the reason redrawRosterList states: a
   keystroke arrives far faster than a frame and every rebuild but the last is
   discarded by the next one. Keyed, because two lists can be waiting at once and
   a single flag would drop one of them. The search FIELD is outside the container
   being rebuilt, so nothing the user is typing into ever waits. */
const listFrames = new Map();

function redrawManagerList(key) {
    if (listFrames.has(key)) return;
    if (typeof requestAnimationFrame !== 'function') { redrawManagerListNow(key); return; }
    listFrames.set(key, requestAnimationFrame(() => {
        listFrames.delete(key);
        redrawManagerListNow(key);
    }));
}

// Cancels whatever was waiting. A frame that fires after the screen is gone finds
// no container and returns, but a live-looking schedule must not outlive it.
function clearListFrames() {
    if (typeof cancelAnimationFrame === 'function') {
        for (const id of listFrames.values()) cancelAnimationFrame(id);
    }
    listFrames.clear();
}

// Repaints one list container in place. Everything is read fresh at call time,
// exactly like drawManager, and a container that is not on screen is a no-op.
function redrawManagerListNow(key) {
    const panel = document.getElementById(PANEL_ID);
    const container = panel?.querySelector(`[data-pm-list="${key}"]`);
    if (!container) return;
    const ctx = freshContext();
    if (key === 'picker') { fillPickerList(container, ctx); return; }
    const s = targetState();
    if (!s) return;
    const writable = !s.ambiguous && !s.readOnly;
    const reason = writeReason(s);
    if (key === 'versions') fillVersionList(container, s, writable, reason);
    else if (key === 'assets') fillAssetList(container, s, writable, reason);
    else if (key === 'compose') fillComposeList(container, s, writable, reason);
    else if (key === 'groups') fillGroupList(container, ctx, s);
}

// One version's language, judged from the text ITS picks compose, not from the
// live combination.
function versionLanguage(persona, version) {
    return detectLanguage(composePicked(persona, version?.picks).text);
}

/* Tags */

async function addTagTo(kindLabel, getOwner) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const tag = await askText(STRINGS.manager.tagAddPrompt, '');
    if (!tag || !tag.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const owner = getOwner(ensureShape(after.persona));
    // The version can be deleted while the name popup is up; the user who just
    // typed a tag hears about it, same as renameVersion.
    if (!owner) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    const stored = addTag(owner, tag);
    if (!stored) { notify('info', STRINGS.manager.tagDuplicate); return; }
    commit('tag-add', kindLabel ? `${kindLabel}: ${stored}` : stored, startAvatar);
}

async function removeTagFrom(kindLabel, tag, getOwner) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmDropTag(tag)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const owner = getOwner(ensureShape(after.persona));
    if (!owner) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    if (!removeTag(owner, tag)) { notify('info', STRINGS.manager.tagGone); scheduleDraw(); return; }
    commit('tag-remove', kindLabel ? `${kindLabel}: ${tag}` : tag, startAvatar);
}

// A filter chip. Filtering writes nothing, so it is always live; the active
// state is colour AND the pressed attribute.
function filterChip(label, active, onClick) {
    const chip = el('button', `pm-quickbar-chip${active ? ' pm-quickbar-chip-active' : ''}`, label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    chip.addEventListener('click', onClick);
    return chip;
}

// A row of tag chips plus the add button. getOwner re-resolves the tag carrier
// from a fresh persona at tap time, so no handler holds a persona or version.
function tagChipsRow(tags, writable, reason, kindLabel, getOwner) {
    const row = el('div', 'pm-quickbar-chips pm-tag-chips');
    for (const tag of tags) {
        const chip = el('button', 'pm-quickbar-chip', tag);
        chip.type = 'button';
        if (writable) chip.addEventListener('click', () => removeTagFrom(kindLabel, tag, getOwner));
        else { chip.disabled = true; chip.classList.add('pm-disabled'); }
        row.append(chip);
    }
    row.append(actionButton(STRINGS.manager.tagAdd, () => addTagTo(kindLabel, getOwner), writable, '', reason));
    return row;
}

// Whether a section answers the compose tab's search: by its
// own name, by any choice's name, or by any choice's body. Names take the full
// grade ladder; bodies take textContains, because the sparse and typo tiers
// match almost any long prose and would make the filter a no-op (measured: a
// two-syllable query hit a 4,000-character body through the typo tier whenever
// either syllable appeared anywhere).
function sectionMatchesQuery(persona, section, query) {
    if (rankOf(section.name ?? '', query) > 0) return true;
    for (const variant of persona.variants?.[section.id] ?? []) {
        if (rankOf(variant.label ?? '', query) > 0) return true;
        if (textContains(variant.text ?? '', query)) return true;
    }
    return false;
}

function fillComposeList(container, s, writable, reason) {
    container.replaceChildren();
    const persona = s.persona;
    if (!persona) return;

    // Rule 1's other half: the open row is one string, and a string naming a row
    // that is no longer in the data has to stop claiming a drawer. Same shape as
    // the quick panel's check on expandedAvatar.
    const live = new Set();
    for (const section of persona.sections ?? []) {
        live.add(rowKey('section', section.id));
        for (const variant of persona.variants?.[section.id] ?? []) {
            live.add(rowKey('choice', section.id, variant.id));
        }
    }
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;

    // Rule 4: an empty state names the next action, and the button that does it is
    // the one right underneath.
    if (!(persona.sections ?? []).length) { container.append(emptyOf(STRINGS.manager.noItems)); return; }

    const query = listUi.compose.open ? listUi.compose.query.trim() : '';
    let sections = persona.sections ?? [];
    if (query) sections = sections.filter(section => sectionMatchesQuery(persona, section, query));
    if (!sections.length) { container.append(emptyOf(STRINGS.common.searchNoHits)); return; }
    for (const section of sections) {
        // The index is the section's place in the FULL list: the move arrows
        // reorder the real array, not the filtered view.
        container.append(sectionBlock(persona, section, persona.sections.indexOf(section), writable, reason));
    }
}

async function doFillDefaults() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const missing = missingDefaultSections(s.persona);
    if (!missing.length) { notify('info', STRINGS.manager.fillDefaultsNothing); return; }
    if (!(await askConfirm(STRINGS.manager.confirmFillDefaults(missing.length)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const added = fillDefaultSections(ensureShape(after.persona), freshContext()?.uuidv4, Date.now());
    // Everything got filled while the question was up: nothing to save, and a
    // "0개를 추가했다" toast would read as a malfunction.
    if (!added.length) { notify('info', STRINGS.manager.fillDefaultsNothing); scheduleDraw(); return; }
    // fillDefaultSections wrote one section-add line per section; commit only
    // saves and composes here.
    if (commit(null, '', startAvatar)) notify('info', STRINGS.manager.fillDefaultsDone(added.length));
}

/* ── Size (user request) ─────────────────────────────────────────────────────
   Characters and bytes are ours to count. Tokens are not: the number that
   matters is whatever tokenizer the user's model uses, and this project has
   already shipped three values it guessed at (a depth, a field, a slash command)
   and been wrong three times. So the counter is SillyTavern's own, the NAME of
   it is treated as unverified, and the line simply omits tokens when the probe
   does not answer a number. */
function tokenCounter() {
    const probeCtx = freshContext();
    if (typeof probeCtx?.getTokenCount !== 'function') return null;
    try {
        const probe = probeCtx.getTokenCount('a');
        if (!Number.isFinite(probe) || probe < 0) return null;
    } catch { return null; }
    // Asked again per call rather than closed over: a context is only true for
    // the instant it was read, which is the rule at the top of this file. The
    // count is optional either way, so a call that stops answering just drops
    // the number rather than breaking the line.
    return text => freshContext()?.getTokenCount?.(text);
}

function sizeTextOf(text) {
    const size = countSize(text, tokenCounter());
    return size.tokens === null
        ? STRINGS.manager.sizeLine(size.chars, size.bytes)
        : STRINGS.manager.sizeLineTokens(size.chars, size.bytes, size.tokens);
}

// A trailing timer, not a redraw. Two reasons: a redraw mid composition throws
// away the syllable being assembled, and the token counter is
// SillyTavern's function at a cost this file cannot predict, so it must not run
// once per keystroke on a four thousand character body.
/* Trailing, and long enough that a sentence typed at speed costs one count.

   The line under the box reports characters, bytes and TOKENS, and the token
   figure comes from SillyTavern's own counter over the WHOLE body - a few
   thousand characters, on a phone, every time this fires. At 250ms a continuous
   typist paid for that four times a second while the answer was obsolete before
   it was drawn. Half a second still updates the moment they pause, which is when
   anybody actually reads it, and does less than half the work while they do not.

   Trailing rather than throttled on purpose: what matters is the number for the
   text as it stands, not a running commentary on the way there. */
const SIZE_LINE_DELAY_MS = 500;

function scheduleSizeUpdate() {
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => { sizeTimer = 0; refreshSizeLines(); }, SIZE_LINE_DELAY_MS);
}

function refreshSizeLines() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const editorLine = panel.querySelector('.pm-size-editor');
    const editorField = panel.querySelector('.pm-manager-editor-text');
    if (editorLine && editorField) editorLine.textContent = sizeTextOf(editorField.value);
    const fullLine = panel.querySelector('.pm-size-full');
    if (!fullLine || !fullActive) return;
    harvestFullTexts();
    const s = targetState();
    if (s?.persona) fullLine.textContent = sizeTextOf(composeFrom(s.persona, fullBlocks, fullTexts));
}

/* ── 설명문 전문 확인·수정 (user request) ───────────────────────────────────
   One screen carrying the whole composed description in prompt order, each body
   editable where it stands. The revise screen next door never writes over
   anything (it adds choices and a version); this one writes the bodies
   themselves, which is why it snapshots each one into the history first. */

function resetFullText() {
    fullActive = false;
    fullBlocks = null;
    fullTexts = null;
    if (sizeTimer) { clearTimeout(sizeTimer); sizeTimer = 0; }
}

// The live fields into the working copies. Called before every draw and before
// every read of them, so a rebuild (a background save, a tab step) can never be
// the moment the typing stopped existing anywhere.
function harvestFullTexts() {
    if (!fullActive || !Array.isArray(fullTexts)) return;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    for (const area of panel.querySelectorAll('.pm-full-text')) {
        const index = Number(area.dataset.pmBlock);
        if (Number.isInteger(index) && index >= 0 && index < fullTexts.length) fullTexts[index] = area.value;
    }
}

// How many bodies leaving would discard, measured against what the screen was
// opened with rather than against what is stored: a body edited and typed back
// is not a change, and asking about it would be a question with no answer that
// does anything.
function fullDirtyCount() {
    if (!fullActive || !Array.isArray(fullBlocks)) return 0;
    harvestFullTexts();
    let count = 0;
    fullBlocks.forEach((block, index) => {
        if ((fullTexts?.[index] ?? block.text) !== block.text) count++;
    });
    return count;
}

function openFullText() {
    const s = guardTarget();
    if (!s) return;
    // Every item, including the empty ones: this screen is where a description
    // is written, so the items waiting to be filled are exactly what it must show.
    const blocks = buildReplaceBlocks(s.persona, true);
    // Now reachable only when the persona has no items at all, which is a
    // different sentence from the one that used to stand here.
    if (!blocks.length) { notify('info', STRINGS.manager.fullTextNoSections); return; }
    resetFullText();
    fullActive = true;
    fullBlocks = blocks;
    fullTexts = blocks.map(block => block.text);
    expandedRow = null;
    scheduleDraw();
}

async function leaveFullText() {
    // The same one-question-at-a-time flag requestClose uses.
    if (closeAsked) return;
    const dirty = fullDirtyCount();
    if (dirty > 0) {
        closeAsked = true;
        const ok = await askConfirm(STRINGS.manager.fullTextConfirmLeave(dirty));
        closeAsked = false;
        if (!ok || !document.getElementById(HOST_ID)) return;
    }
    resetFullText();
    scheduleDraw();
}

function saveFullText() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    harvestFullTexts();
    // The plan is taken against the persona being written to, and it decides on
    // its own which bodies are still the ones the screen drew.
    const plan = planFullTextSave(s.persona, fullBlocks, fullTexts);
    if (plan.skipped.length) notify('warning', STRINGS.manager.fullTextSkipped(plan.skipped.join(', ')));
    if (!plan.writes.length) { notify('info', STRINGS.manager.nothingChanged); return; }
    const now = Date.now();
    for (const write of plan.writes) {
        const variant = (s.persona.variants?.[write.sectionId] ?? []).find(entry => entry.id === write.variantId);
        // Planned one statement ago against this same object, so this can only
        // fail if something reordered the persona in between, which nothing here
        // can do. Checked anyway: the alternative is a thrown exception that
        // takes half a save with it.
        if (!variant) continue;
        snapshot(s.persona, write.variantId, write.before, now, s.settings);
        variant.text = write.after;
        variant.updatedAt = now;
        addLog(s.persona, 'variant-edit', variant.label ?? '', now);
        // A draft left under this body would be restored over the text that was
        // just saved, the same reason saveVariantText clears one.
        takeDraft(startAvatar, write.sectionId, write.variantId);
    }
    if (expireOldHistory(s.root, s.settings, now) + enforceGlobalBudget(s.root, s.settings, now)) {
        historyIndex = null;
    }
    // The variant-edit lines are written above, where the loop is, so commit only
    // saves and composes.
    if (!commit(null, '', startAvatar)) return;
    notify('info', STRINGS.manager.fullTextSaved(plan.writes.length));
    // The screen's baseline is what is now stored. Without this the dirty count
    // would keep asking about edits that have already been saved, and a body that
    // was emptied would keep a textarea that the prompt no longer carries.
    const after = getPersona(getRoot(), startAvatar);
    if (after) {
        fullBlocks = buildReplaceBlocks(after, true);
        fullTexts = fullBlocks.map(block => block.text);
    }
}

// The bodies, in prompt order, under the line each one is printed with. When the
// heading format adds nothing the caption falls back to naming the item and its
// active choice, which is a caption rather than prompt text; the note under the
// guide says which of the two is on screen.
function fullTextScreen(s, writable, reason) {
    const wrap = el('div', 'pm-full');
    wrap.append(noteOf(STRINGS.manager.fullTextGuide));
    const persona = s.persona;
    const blocks = fullBlocks ?? [];
    const line = el('div', 'pm-manager-size pm-size-full', sizeTextOf(composeFrom(persona, blocks, fullTexts)));
    wrap.append(line);
    const format = persona.headingFormat;
    if (headingLine(format, 'x')) wrap.append(noteOf(STRINGS.manager.fullTextHeadingNote));
    blocks.forEach((block, index) => {
        const head = headingLine(format, block.sectionName);
        const variant = (persona.variants?.[block.sectionId] ?? []).find(entry => entry.id === block.variantId);
        const caption = head || STRINGS.manager.editorHeading(block.sectionName, variant?.label ?? '');
        wrap.append(el('div', `pm-revise-caption${head ? ' pm-full-heading' : ''}`, caption));
        const area = el('textarea', 'pm-full-text');
        area.dataset.pmBlock = String(index);
        const value = fullTexts?.[index] ?? block.text;
        area.value = value;
        // Sized to what it holds, so a one line item does not get the same box as
        // a four thousand character one and the screen stays scannable.
        area.rows = Math.min(20, Math.max(4, value.split('\n').length + Math.floor(value.length / 44)));
        area.disabled = !writable;
        area.setAttribute('aria-label', STRINGS.manager.fullTextAria(block.sectionName));
        // No keydown handler: Enter inserts a newline here, so there is nothing
        // for a hangul composition commit to fire by accident.
        area.addEventListener('input', () => scheduleSizeUpdate());
        wrap.append(area);
    });
    const foot = el('div', 'pm-manager-editorfoot');
    foot.append(actionsRow([
        actionButton(STRINGS.manager.fullTextSave, () => saveFullText(), writable, '', reason),
        actionButton(STRINGS.manager.editorBackToList, () => leaveFullText(), true),
    ]));
    wrap.append(foot);
    return wrap;
}

/* ── 프롬프트 배치 (user request) ────────────────────────────────────────────
   position, depth, role and lorebook on SillyTavern's own persona descriptor,
   next to the description this extension composes. See compose.js: the values of
   position and role are SillyTavern's enums and have never been measured, so no
   number is written here. The lists come from SillyTavern's own selects, which
   carry each value together with its label and therefore cannot pair them
   wrongly, and when no such select can be read the control says so instead of
   offering a choice built out of guesses. */
// Measured on the device (접점 진단 5, 2026-08-27). position is what its name
// says; the role select is persona_depth_role, NOT persona_description_role,
// which is what this file guessed first. The shape scan below found it anyway,
// which is the only reason the control worked at all before it was measured.
const PLACEMENT_SELECTS = Object.freeze({
    position: { ids: ['persona_description_position'], match: /position/i },
    role: { ids: ['persona_depth_role', 'persona_description_role'], match: /role/i },
});

// The option LIST, never the option that is selected: SillyTavern's select shows
// whichever persona SillyTavern itself has selected, which is not necessarily the
// persona this screen is pointed at. What this screen shows comes from
// readPlacement, which reads the descriptor of its own target.
function enumOptions(field) {
    // One answer per draw. The summary line, the control and the note under it all
    // ask, and the fallback below is a document wide query; three of those per
    // frame is a cost with no new information in it. Plain data, never a node, and
    // dropped at the top of every draw.
    if (enumCache && Object.hasOwn(enumCache, field)) return enumCache[field];
    const answer = readEnumOptions(field);
    if (!enumCache) enumCache = {};
    enumCache[field] = answer;
    return answer;
}

function readEnumOptions(field) {
    if (typeof document === 'undefined') return null;
    const spec = PLACEMENT_SELECTS[field];
    if (!spec) return null;
    for (const id of spec.ids) {
        const byId = readSelectOptions(document.getElementById(id));
        if (byId) return byId;
    }
    // The id above is the one this build appeared to use and was never measured,
    // so a rename would take the control away silently. A shape scan over
    // SillyTavern's own persona controls covers that at the cost of one query.
    for (const select of document.querySelectorAll('select[id*="persona"]')) {
        if (!spec.match.test(select.id ?? '')) continue;
        const options = readSelectOptions(select);
        if (options) return options;
    }
    return null;
}

function placementLabel(field, value) {
    if (value === null || value === undefined || value === '') return STRINGS.manager.placementUnset;
    const found = (enumOptions(field) ?? []).find(option => option.value === value);
    // A stored number no option carries is shown as the number. The user can see
    // that it is unrecognised, which is the outcome to prefer over a label that
    // claims to know what it means.
    return found ? found.label : STRINGS.manager.placementRaw(value);
}

// Every placement write. Not commit(): these are SillyTavern's fields and not our
// composition, so there is nothing to recompose, and running the description
// through writeDescription for a depth change would be a write nobody asked for.
function applyPlacement(patch, kind, detail) {
    const s = guardTarget();
    if (!s) return false;
    // The controls are drawn disabled in both states, so this is the second half
    // of rule 6 rather than the first: a path that reached here anyway must not
    // write where the screen said it would not.
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return false; }
    const ctx = freshContext();
    if (!ctx) { notify('error', STRINGS.manager.noContext); return false; }
    // The ACTIVE persona, resolved the way everything else resolves it, not the
    // one this screen is editing: they are different questions and the singular
    // prompt keys belong to the first.
    if (!writePlacement(ctx, s.avatar, patch, getState()?.avatar ?? null)) {
        notify('error', STRINGS.manager.placementFailed);
        scheduleDraw();
        return false;
    }
    addLog(s.persona, kind, detail, Date.now());
    ctx.saveSettingsDebounced();
    scheduleDraw();
    return true;
}

function pickPlacementEnum(field, raw) {
    const value = Number(raw);
    if (!Number.isInteger(value)) return;
    // Re-resolved rather than trusted from the draw: the header can move the
    // target between the draw and the change event.
    const label = placementLabel(field, value);
    const head = field === 'position' ? STRINGS.manager.placementPosition : STRINGS.manager.placementRole;
    if (applyPlacement({ [field]: value }, 'placement', `${head}: ${label}`)) {
        notify('info', STRINGS.manager.placementSaved);
    }
}

// SillyTavern's own depth input carries min=0 max=9999 (접점 진단 5). Read from
// it rather than written here: it is their number, and a build that changes it
// changes this with no edit. No ceiling at all when the input cannot be found.
function measuredDepthMax() {
    const input = typeof document === 'undefined' ? null : document.getElementById('persona_depth_value');
    const max = Number(input?.max);
    return Number.isSafeInteger(max) && max > 0 ? max : null;
}

async function editDepth(current) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const answer = await askText(STRINGS.manager.placementDepthPrompt, current === null ? '' : String(current));
    if (answer === null) return;
    const depth = parseDepth(answer);
    if (depth === null) { notify('error', STRINGS.manager.placementDepthInvalid); return; }
    const max = measuredDepthMax();
    if (max !== null && depth > max) { notify('error', STRINGS.manager.placementDepthOver(max)); return; }
    if (!guardTarget(startAvatar)) return;
    if (applyPlacement({ depth }, 'placement', `${STRINGS.manager.placementDepth}: ${depth}`)) {
        notify('info', STRINGS.manager.placementSaved);
    }
}

/* The world info list, if this build puts one somewhere this extension can read.
   Never assumed: every candidate is checked for the shape it would have to have,
   and the button falls back to typing the name, which is what the field stores
   either way. */
function worldNames() {
    const ctx = freshContext();
    for (const candidate of [ctx?.world_names, globalThis.world_names]) {
        if (!Array.isArray(candidate) || !candidate.length) continue;
        const names = candidate.filter(name => typeof name === 'string' && name.trim());
        if (names.length === candidate.length) return names;
    }
    // Neither exists on this build (접점 진단 5: both undefined). The list is in
    // SillyTavern's own selects, #world_info and #world_editor_select, 214 books
    // between them. Read the option TEXT, which is the book's name, and drop the
    // editor select's placeholder row along with anything else carrying no value.
    if (typeof document === 'undefined') return null;
    let best = null;
    for (const select of document.querySelectorAll('select[id*="world" i]')) {
        // Not every world select is a list of books: the sort order and the
        // strategy selects live under the same prefix. A list of books is the
        // long one, and taking the longest is what tells them apart without
        // hardcoding which id is which.
        const names = [...(select.options ?? [])]
            .filter(option => String(option.value ?? '').trim() !== '')
            .map(option => String(option.textContent ?? '').trim())
            .filter(name => name && !name.startsWith('---'));
        if (names.length > (best?.length ?? 0)) best = names;
    }
    return best && best.length ? best : null;
}

async function editLorebook(current) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const names = worldNames();
    let answer;
    if (names) {
        const chosen = await askChoice(STRINGS.manager.lorebookChoose,
            [STRINGS.manager.lorebookDetachOption, ...names]);
        if (chosen === null) return;
        answer = chosen === STRINGS.manager.lorebookDetachOption ? '' : chosen;
    } else {
        answer = await askText(STRINGS.manager.lorebookPrompt, current ?? '');
        if (answer === null) return;
    }
    if (!guardTarget(startAvatar)) return;
    const lorebook = String(answer).trim();
    if (lorebook === (current ?? '')) { notify('info', STRINGS.manager.nothingChanged); return; }
    if (applyPlacement({ lorebook }, 'lorebook', lorebook || STRINGS.manager.lorebookDetachOption)) {
        notify('info', lorebook ? STRINGS.manager.lorebookSaved : STRINGS.manager.lorebookDetached);
    }
}

// One label, one value and the control that changes it, on a line the thumb can
// reach. Used for the two placement fields that are not enums.
function valueRow(label, value, buttonLabel, onClick, enabled, reason) {
    const row = el('div', 'pm-row pm-manager-valuerow');
    row.append(el('span', 'pm-manager-picklabel', label));
    row.append(el('span', 'pm-manager-value', value));
    row.append(actionButton(buttonLabel, onClick, enabled, '', reason));
    return row;
}

function enumRow(field, label, aria, current, writable) {
    const options = enumOptions(field);
    if (!options) {
        // Rule 6: the control explains itself rather than disappearing, and it
        // still shows what the persona currently carries.
        const row = el('div', 'pm-row pm-manager-valuerow');
        row.append(el('span', 'pm-manager-picklabel', label));
        row.append(el('span', 'pm-manager-value', placementLabel(field, current)));
        const box = el('div', 'pm-manager-fieldbox');
        box.append(row);
        box.append(el('div', 'pm-manager-hint', STRINGS.manager.placementUnknownList));
        return box;
    }
    const row = el('div', 'pm-row pm-manager-valuerow');
    row.append(el('span', 'pm-manager-picklabel', label));
    const select = el('select', 'pm-manager-select');
    // A stored value none of the options carries keeps its own entry rather than
    // snapping to the first one, the same rule pickSelect follows for a deleted
    // choice: the control has to show the state it is in.
    if (current !== null && current !== undefined && !options.some(option => option.value === current)) {
        const stray = el('option', null, STRINGS.manager.placementRaw(current));
        stray.value = String(current);
        select.append(stray);
    }
    for (const option of options) {
        const node = el('option', null, option.label);
        node.value = String(option.value);
        select.append(node);
    }
    select.value = current === null || current === undefined ? '' : String(current);
    select.disabled = !writable;
    select.setAttribute('aria-label', aria);
    select.addEventListener('change', () => pickPlacementEnum(field, select.value));
    row.append(select);
    return row;
}

function placementBox(s, writable, reason) {
    const ctx = freshContext();
    const placement = ctx ? readPlacement(ctx, s.avatar) : null;
    const summary = placement
        ? [
            placementLabel('position', placement.position),
            placement.depth === null ? null : `${STRINGS.manager.placementDepth} ${placement.depth}`,
            placement.lorebook || null,
        ].filter(Boolean).join(STRINGS.common.dotSeparator)
        : STRINGS.manager.placementNoRecord;
    const box = foldBox('pm-manager-fold', STRINGS.manager.placementHead, summary, placementOpen,
        () => { placementOpen = !placementOpen; scheduleDraw(); });
    if (!placementOpen) return box;
    if (!placement) {
        box.append(noteOf(STRINGS.manager.placementNoRecord));
        return box;
    }
    box.append(enumRow('position', STRINGS.manager.placementPosition, STRINGS.manager.placementPositionAria,
        placement.position, writable));
    box.append(valueRow(STRINGS.manager.placementDepth,
        placement.depth === null ? STRINGS.manager.placementUnset : String(placement.depth),
        STRINGS.manager.editValue, () => editDepth(placement.depth), writable, reason));
    box.append(enumRow('role', STRINGS.manager.placementRole, STRINGS.manager.placementRoleAria,
        placement.role, writable));
    box.append(valueRow(STRINGS.manager.placementLorebook,
        placement.lorebook || STRINGS.manager.placementUnset,
        STRINGS.manager.connectValue, () => editLorebook(placement.lorebook), writable, reason));
    box.append(noteOf(STRINGS.manager.placementHint));
    if (enumOptions('position')) box.append(noteOf(STRINGS.manager.placementSource));
    // Rule 6, once for the block rather than once per control: a value row is not
    // a button stack, so a reason parked on a disabled button in one would live
    // only in a title attribute, where a phone can never read it.
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* ── 언어별 이름 (user request) ──────────────────────────────────────────────
   The same persona under a different chat language wants a different NAME. The
   alternates live on our record only: SillyTavern's personas map is what the
   rest of it identifies a persona by, so writing a name into that map because a
   chat changed language would rename the persona everywhere at once. */
const NAME_LANGUAGES = Object.freeze(['ko', 'ja', 'zh', 'en']);

async function editLocalName(lang) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const langName = STRINGS.common.languageNames[lang] ?? lang;
    const answer = await askText(STRINGS.manager.localNamePrompt(langName), localName(s.persona, lang, ''));
    if (answer === null) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    if (!setLocalName(ensureShape(after.persona), lang, answer)) {
        notify('info', STRINGS.manager.nothingChanged);
        return;
    }
    const stored = localName(after.persona, lang, '');
    addLog(after.persona, 'name-local', `${langName}: ${stored || STRINGS.manager.placementUnset}`, Date.now());
    freshContext()?.saveSettingsDebounced?.();
    notify('info', stored ? STRINGS.manager.localNameSaved : STRINGS.manager.localNameRemoved);
    scheduleDraw();
}

/* [적용]: the alternate name reaches the chat, or nothing happened.
   Storing a name changes nothing by itself, which is exactly what the user
   reported (채팅에 적용되지 않음). What the chat and {{user}} read is
   SillyTavern's own personas map plus name1, so applying means renaming there
   and then making SillyTavern re-read it.

   Deliberately a button and not automatic. Renaming on a language guess would
   rename the persona everywhere the moment somebody typed one English line, and
   the roster, the chat lock and every other extension identify a persona by that
   name. The user says when. */
async function applyLocalName(lang, toChat) {
    const name = localName(guardTarget()?.persona, lang, '');
    if (!name) { notify('info', STRINGS.manager.localNameNone); return; }
    await applyNameWithScope(name, toChat, `${STRINGS.common.languageNames[lang] ?? lang}: ${name}`);
}

/* One write behind both name buttons and behind 이름 수정, because the only
   difference between them is one boolean and every guard around it is shared.

   toChat false writes SillyTavern's persona map and stops: {{user}} and the chat
   are untouched. toChat true also re-selects the persona, which is what carries
   the name into name1, and therefore into {{user}} and the sender line of new
   messages. Neither one rewrites a character of past chat text. Nothing in this
   extension does; the risk the user named is a collision, not a substitution. */
async function applyNameWithScope(name, toChat, detail) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    // Which scope is legal depends on whether this persona is the one being
    // played, and that can change between the draw that enabled the button and
    // the tap that fires it: SillyTavern's own persona switch is one tap away and
    // the redraw is deferred while a field has focus. Asked again here, because a
    // list-only rename of the ACTIVE persona breaks the invariant ctx.js
    // identifies it by, and a chat rename of a background one would switch the
    // user onto it. Both are exactly what the two buttons promise not to do.
    // Asked as a function rather than once, because there is an await below it.
    const scopeIsLegal = () => {
        const isActive = (getState()?.avatar ?? null) === startAvatar;
        if (toChat && !isActive) { notify('error', STRINGS.manager.applyChatOnlyActive); scheduleDraw(); return false; }
        // List-only on the persona being played is legal exactly when the
        // extension does not need the name to know who that is.
        if (!toChat && isActive && !identifiedDirectly()) {
            notify('error', STRINGS.manager.applyListOnlyActive); scheduleDraw(); return false;
        }
        return true;
    };
    if (!scopeIsLegal()) return;
    const ctx = freshContext();
    const personas = ctx?.powerUserSettings?.personas ?? {};
    if (!Object.hasOwn(personas, startAvatar)) { notify('error', STRINGS.manager.refusalUnknownPersona); return; }
    const current = personas[startAvatar] ?? '';
    if (current === name) { notify('info', STRINGS.manager.nothingChanged); return; }
    // Two personas sharing a name make the active one unknowable,
    // and every write in this extension refuses from then on. Walking the user
    // into that state on purpose is worse than refusing the rename.
    if (Object.entries(personas).some(([avatar, other]) => avatar !== startAvatar && other === name)) {
        notify('error', STRINGS.manager.localNameTaken);
        return;
    }
    // The user's own concern, and it exists only for the chat scope: {{user}} is
    // what the model reads as the user's name, so a chat that already has
    // somebody called that ends up with two. Said in the confirmation rather than
    // refused, because it is their chat and they may mean it.
    const clash = toChat ? nameCollides({ name, characterName: ctx?.name2, chat: ctx?.chat }) : null;
    const question = !toChat
        ? STRINGS.manager.confirmApplyNameList(current, name)
        : (clash
            ? STRINGS.manager.confirmApplyNameClash(name, clash)
            : STRINGS.manager.confirmApplyNameChat(current, name));
    if (!(await askConfirm(question))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // guardTarget answers whether the MANAGER still points at this persona. It
    // cannot answer whether this persona is still the one being played, and the
    // confirmation above is an await: a persona change during it would let a chat
    // scope rename reach applyPersonaName, whose chat half ends in a switch. That
    // is the persona hijack 0.6.0 removed from the draw and 0.6.1 removed from the
    // tap, still reachable through the one window neither of them covered.
    if (!scopeIsLegal()) return;
    const result = await applyPersonaName(startAvatar, name, { toChat });
    if (!result.ok) {
        notify('error', result.reason === 'taken'
            ? STRINGS.manager.localNameTaken
            : (result.reason === 'unknown' ? STRINGS.manager.refusalUnknownPersona : STRINGS.manager.localNameApplyFailed));
        scheduleDraw();
        return;
    }
    const persona = getPersona(getRoot(), startAvatar);
    if (persona) addLog(persona, 'name-apply', detail ?? name, Date.now());
    freshContext()?.saveSettingsDebounced?.();
    notify('info', toChat
        ? STRINGS.manager.localNameApplied(name)
        : STRINGS.manager.listNameApplied(name));
    scheduleDraw();
}

/* 이름 수정 (user request). The same rename, with the name typed instead of
   chosen from the language list. It is the persona's SillyTavern name, so it is
   the same write and the same guards; only where the string comes from differs. */
async function renameTargetPersona(toChat) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const personas = freshContext()?.powerUserSettings?.personas ?? {};
    if (!Object.hasOwn(personas, startAvatar)) { notify('error', STRINGS.manager.refusalUnknownPersona); return; }
    const answer = await askText(STRINGS.manager.renamePersonaPrompt, personas[startAvatar] ?? '');
    if (answer === null) return;
    const name = String(answer).trim();
    if (!name) { notify('info', STRINGS.manager.nothingChanged); return; }
    if (!guardTarget(startAvatar)) return;
    await applyNameWithScope(name, toChat, name);
}

/* The persona itself: its name, its picture, and making another one from it.
   Folded like the other two, and grouped because all three write SillyTavern's
   own record rather than ours, which is why every one of them asks first. */
// The two name buttons, and the one rule that decides which of them is live.
//
// The user asked to separate 채팅에 나오는 이름 from {{user}}. In SillyTavern
// those two ARE one value (name1), so that split does not exist to be built. The
// split that does exist is the one below: the persona map, which is the list and
// our own screens, and the chat, which is name1 and therefore {{user}} and the
// sender line of new messages.
//
// For the persona being played, the two must stay equal: ctx.js identifies the
// active persona by personas[avatar] === name1, so renaming the
// list alone would leave the extension unable to say which persona is active,
// and every write would start refusing. For a persona that is NOT being played,
// the chat scope is not available at all: reaching it would mean switching the
// user onto that persona, which is not what a rename button should do.
// Whether the extension knows WHICH persona is active without deducing it from
// the name. When it does, the list entry and the chat name are free to differ.
function identifiedDirectly() {
    const source = getState()?.source;
    return source === 'precise' || source === 'dom';
}

function nameScopeButtons(name, writable, reason, onList, onChat) {
    const isActive = (getState()?.avatar ?? null) === targetAvatar;
    const has = !!name;
    // [목록] used to be closed on the persona being played, because renaming the
    // list alone broke the name lookup that identified it. That is no longer how
    // it is identified when SillyTavern hands over the avatar itself, so the
    // button opens - which is the user's report that it does nothing.
    const listAllowed = !isActive || identifiedDirectly();
    const list = actionButton(STRINGS.manager.applyToList, onList,
        writable && has && listAllowed, '',
        listAllowed ? reason : STRINGS.manager.applyListOnlyActive);
    const chat = actionButton(STRINGS.manager.applyToChat, onChat,
        writable && has && isActive, '', isActive ? reason : STRINGS.manager.applyChatOnlyActive);
    return [list, chat];
}

function personaBox(ctx, s, writable, reason) {
    const name = ctx?.powerUserSettings?.personas?.[s.avatar] ?? s.avatar ?? '';
    const box = foldBox('pm-manager-fold', STRINGS.manager.personaHead, name, personaOpen,
        () => { personaOpen = !personaOpen; scheduleDraw(); });
    if (!personaOpen) return box;

    const nameRow = el('div', 'pm-row pm-manager-valuerow');
    nameRow.append(el('span', 'pm-manager-picklabel', STRINGS.manager.renamePersona));
    nameRow.append(el('span', 'pm-manager-value', name));
    // Both buttons ask for the new name first; they differ only in how far it
    // reaches. The dead one carries the reason, which is how this screen teaches
    // the difference instead of explaining it in a paragraph.
    for (const button of nameScopeButtons(name, writable, reason,
        () => renameTargetPersona(false), () => renameTargetPersona(true))) {
        nameRow.append(button);
    }
    box.append(nameRow);

    // The file input lives in the tree rather than being made on demand, the same
    // way the asset uploader's does, so syncing can take it dead with everything
    // else instead of leaving a second unexplained button behind.
    const imageRow = el('div', 'pm-row pm-manager-valuerow');
    const input = el('input', 'pm-manager-file pm-hidden');
    input.type = 'file';
    input.accept = 'image/*';
    input.disabled = !writable;
    input.setAttribute('aria-label', STRINGS.manager.changeImageAria);
    input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null;
        // Cleared before the upload so the same file can be picked again after a
        // failure; an input still holding it fires no change event.
        input.value = '';
        if (file) changeTargetImage(file);
    });
    imageRow.append(el('span', 'pm-manager-picklabel', STRINGS.manager.imageLabel));
    const url = thumbnailUrl(ctx, s.avatar);
    if (url) {
        const img = el('img', 'pm-manager-targetimg');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        imageRow.append(img);
    }
    imageRow.append(el('span', 'pm-manager-value', ''));
    imageRow.append(actionButton(STRINGS.manager.imageButton, () => input.click(), writable,
        STRINGS.manager.changeImage, reason));
    box.append(imageRow, input);

    box.append(actionsRow([
        actionButton(STRINGS.manager.createPersona, () => createTargetPersona(), writable, '', reason),
        actionButton(STRINGS.manager.duplicatePersona, () => duplicateTargetPersona(), writable, '', reason),
        actionButton(STRINGS.manager.copyOpen, () => openCopyPicker(), writable, '', reason),
    ]));
    box.append(noteOf(STRINGS.manager.applyScopeHint));
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

// The same setting the drawer's checkbox writes, flipped from where the names
// live. Re-read at tap time like every other handler on this screen.
function toggleAutoName() {
    const root = getRoot();
    if (!root || root.readOnly) { notify('error', STRINGS.manager.refusalReadOnly); return; }
    root.settings.autoLocalName = !root.settings.autoLocalName;
    freshContext()?.saveSettingsDebounced?.();
    // The settings drawer keeps a checkbox for the same value, and it syncs on
    // this event rather than on a redraw of its own.
    document.dispatchEvent(new CustomEvent('pm:changed'));
    scheduleDraw();
}

function localNamesBox(ctx, s, writable, reason) {
    const persona = s.persona;
    const stored = persona.names ?? {};
    const parts = NAME_LANGUAGES
        .filter(lang => stored[lang])
        .map(lang => `${STRINGS.common.languageNames[lang]} ${stored[lang]}`);
    const summary = parts.length ? parts.join(STRINGS.common.dotSeparator) : STRINGS.manager.localNamesEmpty;
    const box = foldBox('pm-manager-fold', STRINGS.manager.localNamesHead, summary, namesOpen,
        () => { namesOpen = !namesOpen; scheduleDraw(); });
    if (!namesOpen) return box;
    const base = ctx?.powerUserSettings?.personas?.[s.avatar] ?? '';
    if (base) box.append(noteOf(STRINGS.manager.localNameBase(base)));
    // The CHAT's language, not the description's: that is what the automatic rule
    // acts on, so the check has to mark the row that rule would use. The mark is
    // the same one every other current-state row on this screen uses, so it is a
    // glyph and not a colour (no colour-only state).
    const current = chatLanguage(freshContext()?.chat);
    for (const lang of NAME_LANGUAGES) {
        const row = el('div', 'pm-row pm-manager-valuerow');
        row.append(checkMark(lang === current));
        // The language and its name are one button, the way every other row on
        // this screen puts its identity in one: three buttons do not fit a 411px
        // row and the third would have been 수정, which edits OUR record rather
        // than applying anything. A real button rather than a role on the row,
        // because the row also holds two buttons and nesting the roles is a thing
        // a screen reader has to guess at.
        const edit = el('button', 'pm-manager-rowname pm-manager-nameedit');
        edit.type = 'button';
        edit.disabled = !writable;
        edit.setAttribute('aria-label', STRINGS.manager.localNamePrompt(STRINGS.common.languageNames[lang] ?? lang));
        const top = el('div', 'pm-manager-rowtop');
        top.append(el('span', 'pm-manager-picklabel', STRINGS.common.languageNames[lang] ?? lang));
        top.append(el('span', 'pm-manager-value', stored[lang] || STRINGS.manager.placementUnset));
        edit.append(top);
        // Click only. A button needs no keydown of its own.
        if (writable) edit.addEventListener('click', () => editLocalName(lang));
        row.append(edit);
        for (const button of nameScopeButtons(stored[lang], writable, reason,
            () => applyLocalName(lang, false), () => applyLocalName(lang, true))) {
            row.append(button);
        }
        box.append(row);
    }
    // Always drawn, including when it answers nothing: an automatic rule that did
    // not fire is indistinguishable from one that is broken unless the screen
    // says what it read.
    box.append(noteOf(`${STRINGS.manager.localNameCurrent}: ${current
        ? (STRINGS.common.languageNames[current] ?? current)
        : STRINGS.manager.localNameNoChat}`));
    // The switch belongs where the names are, not only in the settings drawer:
    // registering an alternate and having it used are one intention, and the user
    // should not have to go looking in another screen for the half that acts.
    const auto = getRoot()?.settings?.autoLocalName === true;
    const autoRow = el('div', 'pm-row pm-manager-valuerow');
    // The state is the check, the way every other state on this screen is said.
    // 켜짐 and 꺼짐 are verbs bent into nouns, which the writing rule refuses, and
    // a mark the eye already knows beats a word invented to satisfy a rule.
    autoRow.append(checkMark(auto));
    autoRow.append(el('span', 'pm-manager-picklabel', STRINGS.manager.autoNameRow));
    autoRow.append(el('span', 'pm-manager-value', ''));
    autoRow.append(actionButton(auto ? STRINGS.manager.autoNameTurnOff : STRINGS.manager.autoNameTurnOn,
        () => toggleAutoName(), writable, '', reason));
    box.append(autoRow);
    // Why the automatic rule is sitting still, when it is: the name it would
    // apply is already somebody else's in this chat. Drawn only when it is true.
    const wanted = current ? (stored[current] ?? '') : '';
    const clash = wanted
        ? nameCollides({ name: wanted, characterName: ctx?.name2, chat: ctx?.chat })
        : null;
    if (clash) box.append(noteOf(STRINGS.manager.autoNameClashSkipped(wanted, clash)));
    box.append(noteOf(STRINGS.manager.autoNameHint));
    box.append(noteOf(STRINGS.manager.localNameEditHint));
    box.append(noteOf(STRINGS.manager.applyScopeHint));
    // Same as the placement block: one reason for the block, where it can be read.
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* ── 페르소나 이미지 교체 (user request) ─────────────────────────────────────
   SillyTavern's own avatar file, not one of our assets. The endpoints have never
   been measured on this build, so the listing is asked for FIRST and has to come
   back as an array of strings containing this persona's own filename. That is
   three things proven before anything is written: the API is there, it speaks
   the shape we expect, and the id we hold is the one it knows. A build where any
   of that is false gets a sentence naming what failed, not a silent no-op. */
async function changeTargetImage(file) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const ctx = freshContext();
    if (!ctx) { notify('error', STRINGS.manager.noContext); return; }
    const personas = ctx.powerUserSettings?.personas ?? {};
    const label = personas[startAvatar] ?? startAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmChangeImage(label)))) return;
    if (!guardTarget(startAvatar)) return;
    const result = await uploadPersonaAvatar(freshContext(), startAvatar, file);
    /* The token is a cache buster, not a claim, so it is bumped whatever
       happened: the address holds a different picture on success, and on failure
       the redraw is what stops the screen from showing a stale one and inviting
       the retry that used to make this popup repeat. */
    bumpThumbnails(startAvatar);
    scheduleDraw();
    if (result.ok) { notify('info', STRINGS.manager.changeImageDone); return; }
    /* A build without that endpoint falls back to the path this used to take:
       SillyTavern's own file input, which finishes inside SillyTavern's crop
       dialog. Nothing is measured afterwards, because there is nothing of ours
       left to measure - the user is answering a dialog. Saying so is the honest
       report; the old code guessed here and guessed wrong. */
    if (result.status === 404) {
        const missing = feedPersonaImage(document, startAvatar, file);
        if (missing) { notify('error', STRINGS.manager.changeImageNoControl(missing)); return; }
        notify('info', STRINGS.manager.changeImageHandedOver);
        return;
    }
    notify('error', STRINGS.manager.changeImageFailed(result.detail ?? result.reason));
}

/* ── 버전별 페르소나 이미지 (user request) ───────────────────────────────────
   The write itself lives in assets.js. What is here is the part that belongs to
   a screen: which persona and version were tapped, and what the user is told
   about each way it can end. A picture that failed to move never rolls back the
   version that was already applied, so every branch below reports and stops. */
async function runBoundImage(avatarId, versionId, force) {
    // The listing this screen already holds, when it is the right persona's.
    // Saves one of the three round trips a version tap would otherwise make.
    const known = (assetState.avatar === avatarId && !assetState.error) ? assetState.list : null;
    const result = await runBoundImageWrite(avatarId, versionId, force, known);
    if (!result || result.skipped) return;
    if (result.ok) {
        if (result.backedUp) notify('info', STRINGS.manager.imageBackupMade);
        return;
    }
    if (result.error === 'listing') { notify('warning', STRINGS.manager.imageListingFailed(result.detail)); return; }
    if (result.error === 'missing') { notify('warning', STRINGS.manager.imageAssetMissing(result.detail)); return; }
    if (result.error === 'backup') { notify('error', STRINGS.manager.imageBackupFailed(result.detail)); return; }
    notify('error', STRINGS.manager.imageApplyFailed(result.detail ?? result.error));
}

async function pickBoundAsset(versionId) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (assetState.avatar !== targetAvatar || assetState.error) { notify('warning', STRINGS.manager.assetOpenTabFirst); return; }
    const labels = assetLabels();
    if (!labels.length) { notify('info', STRINGS.manager.assetNoneForPersona); return; }
    const choice = await askChoice(STRINGS.manager.versionImagePick, labels);
    if (!choice) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const version = (after.persona?.versions ?? []).find(entry => entry.id === versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    if (bindAsset(version, choice, Date.now())) commit('image-bind', `${version.name ?? ''} / ${choice}`, startAvatar);
}

function clearBoundAsset(versionId) {
    const s = guardTarget();
    if (!s) return;
    const version = (s.persona?.versions ?? []).find(entry => entry.id === versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    if (bindAsset(version, null, Date.now())) commit('image-bind', version.name ?? '', targetAvatar);
}

/* The picture block on an open version row. One thumbnail at a time: expandedRow
   holds a single key, so however many versions a persona has, this draws at most
   one image. */
function versionImageBlock(version, writable, reason) {
    const box = el('div', 'pm-manager-assetsel');
    const listingOk = assetState.avatar === targetAvatar && !assetState.error;
    const view = versionImageState(version, assetLabels(), listingOk);
    const head = view.state === 'none' ? STRINGS.manager.versionImageNone
        : view.state === 'ok' ? view.label
        : view.state === 'missing' ? STRINGS.manager.versionImageMissing(view.label)
        : STRINGS.manager.versionImageUnknown(view.label);
    box.append(el('div', 'pm-manager-picklabel', STRINGS.manager.versionImageHead));
    box.append(el('div', 'pm-manager-value', head));
    if (view.state === 'ok') {
        const path = assetState.list.find(asset => asset?.label === view.label)?.path;
        if (path) {
            const img = el('img', 'pm-manager-targetimg');
            img.src = path;
            img.alt = '';
            img.loading = 'lazy';
            box.append(img);
        }
    }
    box.append(actionsRow([
        actionButton(STRINGS.manager.versionImagePickButton, () => pickBoundAsset(version.id), writable, '', reason),
        actionButton(STRINGS.manager.versionImageNow, () => runBoundImage(targetAvatar, version.id, true),
            writable && view.state === 'ok', '', view.state === 'ok' ? reason : STRINGS.manager.versionImageNoBinding),
        actionButton(STRINGS.manager.versionImageClear, () => clearBoundAsset(version.id),
            writable && view.state !== 'none', '', reason),
    ]));
    return box;
}

/* ── 새 페르소나로 복제 (user request) ───────────────────────────────────────
   The plan, which is the only honest one available: SillyTavern owns
   creating a persona, /persona-duplicate is measured present on the device and
   its arguments are not, so the command is run and the RESULT is measured by
   diffing the persona map. Exactly one new key is the copy; anything else is
   reported rather than guessed at. */
const DUPLICATE_COMMANDS = Object.freeze(['persona-duplicate']);

// The browser locale and numeric: true, and nothing else. Built once per load:
// the picker sorts thirty rows on every draw, and the locale cannot change
// inside a session.
const PICKER_COLLATOR = new Intl.Collator(undefined, { numeric: true });

// The two flows below mint through the same measured command and verify the
// result the same way, and all three flows under this line end on the same
// screen reset. Shared, because this file has already had one duplicated block
// drift; the third copy of each was the warning.
function landOnPersona(avatar) {
    pickerMode = 'target';
    pickerOpen = false;
    targetAvatar = avatar;
    openVariant = null;
    editorDirty = false;
    expandedRow = null;
    historyVariant = null;
    historyIndex = null;
    lastMissing = null;
    placementOpen = false;
    namesOpen = false;
    personaOpen = false;
    resetRevise();
    resetFullText();
    resetListUi();
}

// Runs the discovered duplicate command and answers with the ONE new key in the
// persona map, or null after reporting why. The many-found sentence is the
// caller's, because what gets cancelled differs (구성 복사 vs 기본 구성).
async function mintPersona(command, label, manyFoundMessage) {
    const before = new Set(Object.keys(freshContext()?.powerUserSettings?.personas ?? {}));
    try {
        await freshContext()?.executeSlashCommandsWithOptions(`/${command} ${quoteArg(label)}`);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] ${command} failed`, e);
    }
    // SillyTavern finishes after the command resolves, exactly as it does for a
    // switch, so the answer is waited for rather than read on the next line.
    const added = [];
    // No scheduler argument: waitFor's own turn is the only shape there is now.
    // The local one that used to be passed here took no resolve, so this await
    // never returned and the whole duplicate hung with nothing on screen.
    await waitFor(() => {
        added.length = 0;
        for (const key of Object.keys(freshContext()?.powerUserSettings?.personas ?? {})) {
            if (!before.has(key)) added.push(key);
        }
        return added.length > 0;
    }, undefined, CREATE_WAIT_TURNS);
    if (!added.length) { notify('error', STRINGS.manager.duplicateNotFound); scheduleDraw(); return null; }
    if (added.length > 1) { notify('warning', manyFoundMessage); scheduleDraw(); return null; }
    return added[0];
}


async function duplicateTargetPersona() {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const commands = freshContext()?.SlashCommandParser?.commands;
    // Discovered, never hardcoded into a call: the same rule the persona switch
    // follows, and the reason that one survived a SillyTavern rename.
    const command = DUPLICATE_COMMANDS.find(name => commands && Object.hasOwn(commands, name) && commands[name]);
    if (!command) { notify('error', STRINGS.manager.duplicateNoCommand); return; }
    const personas = freshContext()?.powerUserSettings?.personas ?? {};
    const label = personas[startAvatar] ?? startAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmDuplicatePersona(label)))) return;
    if (!guardTarget(startAvatar)) return;
    const destAvatar = await mintPersona(command, label, STRINGS.manager.duplicateManyFound);
    if (!destAvatar) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // The new persona is SillyTavern's; the composition on it is ours to put
    // there, through the same copy the picker's 복사 uses.
    const copy = copyPersonaOnto(after.root, startAvatar, destAvatar,
        freshContext()?.uuidv4, Date.now(), STRINGS.manager.copyLogDetail(label));
    if (copy) saveAndComposeFor(destAvatar);
    freshContext()?.saveSettingsDebounced?.();
    const newName = freshContext()?.powerUserSettings?.personas?.[destAvatar] ?? destAvatar;
    // Onto the copy, which is what the user made and what they will edit next.
    landOnPersona(destAvatar);
    notify('info', STRINGS.manager.duplicateDone(newName));
    scheduleDraw();
}

/* ── 새 페르소나 생성 (user request) ─────────────────────────────────────────
   SillyTavern owns creating a persona and no dedicated creation path has been
   measured on this build, so the one measured mint is reused: /persona-duplicate
   makes the entry and the result is verified by diffing the persona map, exactly
   as the duplicate above does. What makes the result NEW instead of a copy is
   done by us afterwards, in this order: the typed name goes on first (one map
   entry, applyPersonaName's list scope), because saveAndComposeFor refuses while
   any two personas share a name and SillyTavern may have named the copy exactly
   like its source. Then a blank default composition replaces the description
   SillyTavern copied over. The avatar image stays inherited: replacing an image
   is its own measured control ([이미지 변경], right above this button), and the
   confirm popup says so before anything runs. */
async function createTargetPersona() {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const commands = freshContext()?.SlashCommandParser?.commands;
    // Discovered, never hardcoded into a call: the same rule the duplicate follows.
    const command = DUPLICATE_COMMANDS.find(name => commands && Object.hasOwn(commands, name) && commands[name]);
    if (!command) { notify('error', STRINGS.manager.createNoCommand); return; }
    const name = (await askText(STRINGS.manager.createNamePrompt, ''))?.trim();
    if (!name) return;
    // Refused before SillyTavern is asked for anything: renaming INTO a duplicate
    // name is the one outcome the name machinery must never produce, and finding
    // out only after the persona exists would leave it stuck under whatever name
    // SillyTavern gave it.
    const taken = Object.values(freshContext()?.powerUserSettings?.personas ?? {}).includes(name);
    if (taken) { notify('error', STRINGS.manager.createNameTaken(name)); return; }
    if (!(await askConfirm(STRINGS.manager.confirmCreatePersona(name)))) return;
    if (!guardTarget(startAvatar)) return;
    const label = freshContext()?.powerUserSettings?.personas?.[startAvatar] ?? startAvatar;
    const destAvatar = await mintPersona(command, label, STRINGS.manager.createManyFound);
    if (!destAvatar) return;
    // The typed name, list scope only: nothing here touches the chat. A refusal
    // is not rolled back by deleting the persona, because no deletion path has
    // been measured; the persona exists either way and the toast says under
    // which name.
    const renamed = await applyPersonaName(destAvatar, name, { toChat: false });
    /* Deliberately NOT guardTarget(startAvatar): the persona already exists in
       SillyTavern, so bailing because the SOURCE moved (the manager closed during
       the wait, the record vanished) would leave the copy carrying the source's
       description while claiming to be new. The blank composition is owed to the
       persona that now exists, whatever happened to the one it was minted from. */
    const root = getRoot();
    const seeded = !!root && !root.readOnly;
    if (seeded) {
        // A blank default composition, not a copy: that is the difference between
        // this button and the one beside it. The birth log line is what keeps the
        // pruner off an entry whose variants are all deliberately empty.
        const persona = ensurePersona(root, destAvatar, freshContext()?.uuidv4);
        addLog(persona, 'persona-create', name, Date.now());
        // Overwrites the description SillyTavern copied with the (empty) composition.
        saveAndComposeFor(destAvatar);
    }
    freshContext()?.saveSettingsDebounced?.();
    // Onto the new persona, exactly as the duplicate lands on its copy.
    landOnPersona(destAvatar);
    if (!seeded) {
        // The root went away or turned read only between the confirm and now. The
        // persona exists but still carries the copied description, and a refusal
        // that says nothing is the failure mode this project exists to avoid.
        notify('warning', refusalMessage(destAvatar));
    } else if (renamed?.ok) {
        notify('info', STRINGS.manager.createDone(name));
    } else {
        const stName = freshContext()?.powerUserSettings?.personas?.[destAvatar] ?? destAvatar;
        notify('warning', STRINGS.manager.createRenameFailed(stName));
    }
    scheduleDraw();
}

/* ── 페르소나 복사 (user request) ────────────────────────────────────────────
   SillyTavern owns making a persona and the path for it has not been measured on
   this build, so the destination is one it already lists and what gets replaced
   is our record for it. The picker is where the destination is chosen, because it
   already carries thumbnails, search and paging for the same thirty rows. */
function openCopyPicker() {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    stashDraft();
    pickerMode = 'copy';
    pickerOpen = true;
    expandedRow = null;
    scheduleDraw();
}

function closeCopyPicker() {
    pickerMode = 'target';
    pickerOpen = false;
    scheduleDraw();
}

async function copyOnto(destAvatar) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    if (destAvatar === startAvatar) { notify('info', STRINGS.manager.copySameTarget); return; }
    const personas = freshContext()?.powerUserSettings?.personas ?? {};
    if (!Object.hasOwn(personas, destAvatar)) { notify('error', STRINGS.manager.refusalUnknownPersona); return; }
    const fromName = personas[startAvatar] ?? startAvatar;
    const toName = personas[destAvatar] ?? destAvatar;
    if (!(await askConfirm(STRINGS.manager.copyConfirm(fromName, toName)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // Kept so the destination can be put back. saveAndComposeFor is the step that
    // can still refuse, and a refusal after the record was replaced would leave
    // the user with a persona whose data was overwritten and whose description
    // was not, which is the one outcome worse than a plain failure.
    const previous = after.root.personas?.[destAvatar] ?? null;
    const copy = copyPersonaOnto(after.root, startAvatar, destAvatar,
        freshContext()?.uuidv4, Date.now(), STRINGS.manager.copyLogDetail(fromName));
    if (!copy) { notify('error', STRINGS.manager.copyFailed); scheduleDraw(); return; }
    const result = saveAndComposeFor(destAvatar);
    if (!result) {
        if (previous) after.root.personas[destAvatar] = previous;
        else delete after.root.personas[destAvatar];
        notify('error', refusalMessage(destAvatar));
        scheduleDraw();
        return;
    }
    freshContext()?.saveSettingsDebounced?.();
    // The copy is what the user made and what they are about to work on, so the
    // screen moves onto it. Everything screen local belongs to the persona being
    // left, exactly as selectTarget clears it.
    landOnPersona(destAvatar);
    notify('info', STRINGS.manager.copyDone(toName));
    scheduleDraw();
}

function composeTab(s, writable, reason) {
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;

    // The same rule the revise screen follows on the
    // 버전 tab: one screen, one task. While the 전문 window is up the tab body IS
    // that window, and the item list comes back when it closes.
    if (fullActive) { box.append(fullTextScreen(s, writable, reason)); return box; }

    // A body that vanished under its own editor drops the
    // selection and falls through to the list below.
    if (openVariant) {
        const body = openBody(persona);
        if (body) {
            box.append(variantEditor(body.section, body.variant, writable, reason));
            return box;
        }
        openVariant = null;
        editorDirty = false;
    }

    // Persona tags: a chips row at the top of the tab, the one
    // place every adopted persona passes through.
    box.append(el('div', 'pm-manager-tagshead', STRINGS.manager.personaTagsHead));
    box.append(tagChipsRow(persona.tags ?? [], writable, reason, '', p => p));

    // The per persona blocks sit next to the tags, folded. Principle 4: thirty
    // personas means the item list is what this tab is for, and four more open
    // rows above it would push that list off the first screen.
    const live = freshContext();
    box.append(personaBox(live, s, writable, reason));
    box.append(localNamesBox(live, s, writable, reason));

    // The heading format, per persona. It sits here rather than in the
    // settings drawer because the value lives on the persona: a global switch
    // would leave every persona already adopted on 없음 and read as a control that
    // does nothing. The drawer keeps the default for personas made from now on.
    box.append(headingFormatRow(persona, writable, reason));

    box.append(actionsRow([
        listSearchButton('compose'),
        actionButton(STRINGS.manager.fullTextOpen, () => openFullText(), true),
        actionButton(STRINGS.manager.fillDefaults, () => doFillDefaults(), writable, '', reason),
    ]));
    if (listUi.compose.open) box.append(listSearchRow('compose'));

    const list = el('div');
    list.dataset.pmList = 'compose';
    fillComposeList(list, s, writable, reason);
    box.append(list);

    box.append(actionsRow([actionButton(STRINGS.manager.addItem, () => addSection(), writable, '', reason)]));
    // 프롬프트 배치 goes last, under the items (user request). It is SillyTavern's
    // setting for where the finished description lands, so it belongs after the
    // thing it places rather than above it, and it is the row on this tab that
    // gets touched least often.
    box.append(placementBox(s, writable, reason));
    return box;
}

// Changing this rewrites the prompt, so it goes through commit like
// every other composition change: the log records it and the description is
// recomposed on the spot rather than at some later save.
function headingFormatRow(persona, writable, reason) {
    const row = el('div', 'pm-row pm-manager-headingrow');
    row.append(el('span', 'pm-manager-name', STRINGS.manager.headingFormatLabel));
    const select = el('select', 'pm-manager-select');
    for (const key of HEADING_FORMATS) {
        const option = el('option', null, STRINGS.manager.headingFormatNames[key]);
        option.value = key;
        select.append(option);
    }
    select.value = HEADING_FORMATS.includes(persona.headingFormat) ? persona.headingFormat : 'none';
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.manager.headingFormatAria);
    select.addEventListener('change', () => {
        const wanted = select.value;
        if (!HEADING_FORMATS.includes(wanted)) return;
        // Re-resolved rather than written through the persona this row was drawn
        // from: the header can move the target between the draw and the tap, and
        // this write changes what the prompt says.
        const after = guardTarget();
        if (!after) return;
        ensureShape(after.persona).headingFormat = wanted;
        commit('heading-format', STRINGS.manager.headingFormatNames[wanted]);
    });
    row.append(select);
    const box = el('div', 'pm-manager-headingbox');
    box.append(row);
    box.append(noteOf(STRINGS.manager.headingFormatHint));
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* Versions tab */

// The 고르게 한다, in the row where the dead slot is reported. The
// options are the section's living variants, and 없음 stays selectable so the
// control shows the state it is in rather than pretending a choice was made.
function deadPickSelect(persona, version, row, writable) {
    const select = el('select', 'pm-manager-select');
    const none = el('option', null, NO_PICK_LABEL);
    none.value = '';
    select.append(none);
    for (const variant of persona.variants?.[row.sectionId] ?? []) {
        const option = el('option', null, variant.label ?? '');
        option.value = variant.id;
        select.append(option);
    }
    select.value = '';
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.manager.pickChoiceAria(row.sectionName));
    select.addEventListener('change', () => {
        if (!select.value) return;
        setVersionPick(version.id, row.sectionId, select.value);
    });
    return select;
}

// The row the user complained about: five buttons on
// one line became a name, the combination as one line, and [적용]. The per section
// detail, the repair select for a dead slot and the other four actions all live in
// the drawer the row tap opens.
function versionRow(persona, version, writable, reason) {
    const key = rowKey('version', version.id);
    const open = expandedRow === key;
    const box = el('div', `pm-manager-version${open ? ' pm-manager-rowopen' : ''}`);

    const head = rowHead();
    head.append(rowName(key, [
        checkMark(version.id === persona.activeVersionId),
        markedText('pm-manager-name', version.name ?? '', listUi.versions.open ? listUi.versions.query : ''),
    ], versionSummaryLine(persona, version)));
    // A version whose picks name something that is gone cannot be
    // applied, because applying it would drop that section out of the prompt. The
    // button goes disabled with a reason instead of failing after the tap, and the
    // reason says where the repair is.
    const applicable = versionApplicable(persona, version.id);
    // A word, never an image: a page of twenty rows would otherwise fetch twenty
    // pictures to say one thing each. The picture itself is in the open row.
    if (boundAsset(version)) head.append(el('span', 'pm-manager-value', STRINGS.manager.versionImageMark));
    head.append(actionsRow([
        actionButton(STRINGS.common.apply, () => applyVersion(version.id), writable && applicable,
            '', applicable ? reason : STRINGS.manager.versionNotApplicableReason),
    ]));
    head.append(moreButton(key));
    box.append(head);
    if (!open) return box;

    const picks = el('div', 'pm-manager-picks');
    for (const row of versionSummary(persona, version)) {
        const line = el('div', `pm-manager-pick${row.dead ? ' pm-manager-dead' : ''}`);
        line.append(el('span', 'pm-manager-pickname', row.sectionName));
        if (row.dead) line.append(deadPickSelect(persona, version, row, writable));
        else line.append(el('span', 'pm-manager-pickvalue', row.label));
        picks.append(line);
    }
    if (!picks.childElementCount) picks.append(noteOf(STRINGS.manager.noItemsInVersion));
    box.append(picks);
    box.append(versionImageBlock(version, writable, reason));
    box.append(versionAssetBlock(version, writable));
    // Version tags. getOwner re-resolves the version from a
    // fresh persona at tap time by reading version.id when it runs, the same
    // idiom every other row action here uses.
    box.append(el('div', 'pm-manager-tagshead', STRINGS.manager.personaTagsHead));
    box.append(tagChipsRow(version.tags ?? [], writable, reason, version.name ?? '',
        p => (p.versions ?? []).find(entry => entry.id === version.id)));
    box.append(expansionOf([
        actionButton(STRINGS.common.rename, () => renameVersion(version.id, version.name ?? ''), writable, '', reason),
        actionButton(STRINGS.common.duplicate, () => duplicateVersion(version.id), writable, '', reason),
        actionButton(STRINGS.manager.overwrite, () => overwriteVersion(version.id, version.name ?? ''), writable,
            STRINGS.manager.overwriteTitle, reason),
    ], [
        actionButton(STRINGS.common.remove, () => dropVersion(version.id, version.name ?? ''), writable, '', reason),
    ]));
    return box;
}

/* 고쳐서 새 버전 */

function resetRevise() {
    reviseActive = false;
    reviseBlocks = null;
    reviseTexts = null;
    reviseSteps = [];
    reviseSelection = null;
    reviseEditing = null;
    reviseScrollToBox = false;
    if (revisePopupHide) { clearTimeout(revisePopupHide); revisePopupHide = 0; }
    if (revisePopupFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(revisePopupFrame);
    revisePopupFrame = 0;
}

// How many unsaved revisions leaving would discard: the applied steps, plus an
// open 수정 칸 whose text has moved off the selection it started from. The box
// is read from the live field first, because typing since the last draw exists
// nowhere else yet; the stored copy covers the box being off screen (a tab away).
function reviseDirtyCount() {
    if (!reviseActive) return 0;
    let count = reviseSteps.length;
    if (reviseEditing) {
        const input = document.getElementById(PANEL_ID)?.querySelector('.pm-revise-input');
        const current = input ? input.value : (reviseEditing.typed ?? reviseEditing.original);
        if (current !== reviseEditing.original) count++;
    }
    return count;
}

function openRevise() {
    // guardTarget rather than a bare read: the persona can vanish between the
    // draw that offered the button and the tap, and that has to be said, not
    // swallowed.
    const s = guardTarget();
    if (!s) return;
    const blocks = buildReplaceBlocks(s.persona);
    // An empty state is a sentence, not a blank screen, and this
    // one names where the text is written.
    if (!blocks.length) { notify('info', STRINGS.manager.reviseNothing); return; }
    resetRevise();
    reviseActive = true;
    reviseBlocks = blocks;
    reviseTexts = blocks.map(block => block.text);
    expandedRow = null;
    scheduleDraw();
}

async function leaveRevise() {
    // The same one-question-at-a-time flag requestClose uses: a double tap on
    // [목록으로] must not stack two confirmations.
    if (closeAsked) return;
    const dirty = reviseDirtyCount();
    if (dirty > 0) {
        closeAsked = true;
        const ok = await askConfirm(STRINGS.manager.reviseConfirmLeave(dirty));
        closeAsked = false;
        // Re-checked like requestClose: the screen may be gone by now.
        if (!ok || !document.getElementById(HOST_ID)) return;
    }
    resetRevise();
    scheduleDraw();
}

// One selection boundary, resolved to a block element and a string offset. The
// blocks draw each working text as a single text node, so a boundary inside
// that node maps one to one; a drag to the very edge of a block can instead
// land the boundary on the block ELEMENT (browser dependent), where the offset
// counts children: 0 is before the text, anything past it is after, and both
// are still within-block positions worth normalising rather than refusing.
function reviseBoundary(node, offset) {
    if (node?.nodeType === 3) {
        const host = node.parentElement;
        if (!host?.classList?.contains('pm-revise-text')) return null;
        return { host, offset };
    }
    if (node?.nodeType === 1 && node.classList?.contains('pm-revise-text')) {
        return { host: node, offset: offset >= 1 ? (node.textContent ?? '').length : 0 };
    }
    return null;
}

// The last valid drag, as offsets into one block's text. Boundaries in two
// different blocks answer null: no popup across an item boundary.
function readReviseSelection() {
    const sel = document.getSelection?.();
    if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const start = reviseBoundary(range.startContainer, range.startOffset);
    const end = reviseBoundary(range.endContainer, range.endOffset);
    if (!start || !end || start.host !== end.host) return null;
    const block = Number(start.host.dataset.pmBlock);
    if (!Number.isInteger(block)) return null;
    const from = Math.min(start.offset, end.offset);
    const to = Math.max(start.offset, end.offset);
    if (from === to) return null;
    return { block, start: from, end: to, rect: range.getBoundingClientRect() };
}

// Shows the popup beside the selection. Absolute inside .pm-revise, which is
// position relative, so it scrolls with the text and needs no scroll listener:
// both rects are viewport based and their difference is the offset inside the
// wrapper wherever the scroller happens to be.
function positionRevisePopup(rect) {
    const panel = document.getElementById(PANEL_ID);
    const wrap = panel?.querySelector('.pm-revise');
    const popup = panel?.querySelector('.pm-revise-popup');
    if (!wrap || !popup) return;
    popup.classList.remove('pm-hidden');
    const wrapRect = wrap.getBoundingClientRect();
    // Below the selection first: Android's own selection toolbar
    // sits above the selection, and two controls on the same spot leave ours
    // covered. Below is also where the eye already is when a drag ends. Above
    // is the fallback for a selection at the very end of the content, where
    // below would land outside the wrapper.
    const below = rect.bottom - wrapRect.top + 6;
    const top = below + popup.offsetHeight <= wrap.clientHeight
        ? below
        : Math.max(0, rect.top - wrapRect.top - popup.offsetHeight - 6);
    const left = Math.min(
        Math.max(0, rect.left - wrapRect.left),
        Math.max(0, wrap.clientWidth - popup.offsetWidth),
    );
    popup.style.top = `${Math.round(top)}px`;
    popup.style.left = `${Math.round(left)}px`;
}

function hideRevisePopup() {
    document.getElementById(PANEL_ID)?.querySelector('.pm-revise-popup')?.classList.add('pm-hidden');
}

function onReviseSelectionChange() {
    if (!reviseActive || reviseEditing) return;
    const info = readReviseSelection();
    if (info) {
        if (revisePopupHide) { clearTimeout(revisePopupHide); revisePopupHide = 0; }
        reviseSelection = { block: info.block, start: info.start, end: info.end };
        // One position write per frame: during a handle drag this
        // event fires faster than paint, and every write-then-measure pair
        // forced a layout of the whole dialog. The frame re-reads the live
        // selection so the popup lands where the drag ended up, not where it
        // began; if the selection died in between, the collapse fired its own
        // event and the grace path below owns the hiding.
        if (revisePopupFrame) return;
        if (typeof requestAnimationFrame !== 'function') { positionRevisePopup(info.rect); return; }
        revisePopupFrame = requestAnimationFrame(() => {
            revisePopupFrame = 0;
            const live = readReviseSelection();
            if (!live) return;
            reviseSelection = { block: live.block, start: live.start, end: live.end };
            positionRevisePopup(live.rect);
        });
        return;
    }
    // The selection is gone, but the popup waits a moment before following it:
    // on Android the tap that presses the popup collapses the selection first,
    // and hiding here would take the target away in the middle of that tap. The
    // stored offsets are what the click acts on, so the grace loses nothing.
    if (revisePopupHide) return;
    revisePopupHide = setTimeout(() => {
        revisePopupHide = 0;
        hideRevisePopup();
    }, 300);
}

function openReviseBox() {
    if (!reviseActive || !reviseSelection) return;
    const text = reviseTexts?.[reviseSelection.block];
    if (typeof text !== 'string') return;
    // Clamped like applyReplacement clamps: the offsets came from a selection on
    // the drawn text, but a redraw between then and this click makes them stale,
    // and a smaller edit beats a crash.
    const start = Math.max(0, Math.min(reviseSelection.start, text.length));
    const end = Math.max(start, Math.min(reviseSelection.end, text.length));
    if (start === end) return;
    reviseEditing = { block: reviseSelection.block, start, end, original: text.slice(start, end) };
    reviseSelection = null;
    // The box opens below the whole block, which for a long body can be a
    // screenful away from the selection; the draw scrolls it into view so the
    // tap visibly did something.
    reviseScrollToBox = true;
    try { document.getSelection()?.removeAllRanges(); } catch { /* best effort */ }
    hideRevisePopup();
    scheduleDraw();
}

function applyReviseBox() {
    if (!reviseEditing) return;
    const input = document.getElementById(PANEL_ID)?.querySelector('.pm-revise-input');
    if (!input) return;
    const { block, start, end, original } = reviseEditing;
    // Typing nothing new is a cancel, not a step: a no-op entry in the list
    // would offer an undo that undoes nothing.
    if (input.value === original) { reviseEditing = null; scheduleDraw(); return; }
    const prev = reviseTexts[block];
    reviseTexts[block] = applyReplacement(prev, start, end, input.value);
    reviseSteps.push({ block, prevText: prev, from: original, to: input.value });
    reviseEditing = null;
    // The stored drag described the text that just changed; nothing may act on
    // those offsets again.
    reviseSelection = null;
    scheduleDraw();
}

function undoRevise() {
    const step = reviseSteps.pop();
    if (!step) return;
    reviseTexts[step.block] = step.prevText;
    reviseSelection = null;
    scheduleDraw();
}

async function saveRevise() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const name = await askText(STRINGS.common.newVersionName, '');
    if (!name || !name.trim()) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const persona = ensureShape(after.persona);
    const result = makeReplaceVersion(persona, reviseBlocks, reviseTexts, name, freshContext()?.uuidv4, Date.now());
    if (!result) return;
    // A section that vanished between opening and saving is said
    // out loud, never silently dropped. The manager is modal, so normally none.
    if (result.skipped.length) notify('warning', STRINGS.manager.reviseSkipped(result.skipped.join(', ')));
    // commit writes the version-create line; the variant-add lines were written
    // inside makeReplaceVersion, where the loop is. The reset only happens on an
    // accepted write: a refusal redraws this screen with the working
    // copies intact instead of discarding every revision along with the save.
    if (commit('version-create', result.version.name, startAvatar)) resetRevise();
}

function reviseBox() {
    const box = el('div', 'pm-revise-box');
    const area = el('textarea', 'pm-revise-input');
    area.rows = 4;
    // typed first: a draw that happened while the box was off screen (a tab
    // away) parked the typing there, and rebuilding from the original would
    // silently roll it back.
    area.value = reviseEditing?.typed ?? reviseEditing?.original ?? '';
    area.setAttribute('aria-label', STRINGS.manager.reviseBoxAria);
    // No keydown handler: Enter has to insert a newline here, same as the body
    // editor: the composition guard has nothing to do in a textarea.
    box.append(area);
    box.append(actionsRow([
        // 적용 edits only this screen's working copy; the guarded write is
        // [버전으로 저장], which re-checks the target like every other save.
        actionButton(STRINGS.common.apply, () => applyReviseBox(), true),
        actionButton(STRINGS.common.cancel, () => { reviseEditing = null; scheduleDraw(); }, true),
    ]));
    return box;
}

function reviseScreen(writable, reason) {
    const wrap = el('div', 'pm-revise');
    wrap.append(noteOf(STRINGS.manager.reviseGuide));
    const blocks = reviseBlocks ?? [];
    if (blocks.length > 1) wrap.append(noteOf(STRINGS.manager.reviseOneItemOnly));
    blocks.forEach((block, index) => {
        // The caption only exists when there is more than one item, because with
        // one there is no boundary to explain.
        if (blocks.length > 1) wrap.append(el('div', 'pm-revise-caption', block.sectionName));
        const body = el('div', 'pm-revise-text');
        body.dataset.pmBlock = String(index);
        body.textContent = reviseTexts?.[index] ?? '';
        wrap.append(body);
        if (reviseEditing && reviseEditing.block === index) wrap.append(reviseBox());
    });
    if (reviseSteps.length) {
        const list = el('div', 'pm-revise-steps');
        list.append(el('div', 'pm-revise-stepshead', STRINGS.manager.reviseListHead));
        for (const step of reviseSteps) {
            const to = step.to === '' ? STRINGS.manager.reviseDeleted : previewText(step.to);
            list.append(el('div', 'pm-revise-step', STRINGS.manager.reviseRow(previewText(step.from), to)));
        }
        wrap.append(list);
    }
    // Hidden until a selection positions it. Click only; the stored offsets carry
    // it past the selection collapsing.
    const popup = el('button', 'pm-revise-popup pm-hidden', STRINGS.manager.revisePopup);
    popup.type = 'button';
    popup.addEventListener('click', () => openReviseBox());
    wrap.append(popup);
    const foot = el('div', 'pm-manager-editorfoot');
    foot.append(actionsRow([
        actionButton(STRINGS.manager.reviseUndo, () => undoRevise(), reviseSteps.length > 0 && !reviseEditing),
        actionButton(STRINGS.manager.reviseSaveVersion, () => saveRevise(), writable && !reviseEditing, '', reason),
        actionButton(STRINGS.manager.editorBackToList, () => leaveRevise(), true),
    ]));
    wrap.append(foot);
    return wrap;
}

function fillVersionList(container, s, writable, reason) {
    container.replaceChildren();
    const persona = s.persona;
    if (!persona) return;
    const versions = persona.versions ?? [];
    const live = new Set(versions.map(version => rowKey('version', version.id)));
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;
    // Not "버전 없음" but what to do about it, with the
    // button that does it standing directly underneath.
    if (!versions.length) { container.append(emptyOf(STRINGS.manager.noVersionsHere)); return; }

    const ui = listUi.versions;
    let list = versions;
    if (ui.open) {
        // Language answers computed once per version per fill: the chips and
        // the filter below would otherwise compose every version twice per
        // keystroke. A call-local map, not module state.
        const langCache = new Map();
        const langOf = version => {
            if (!langCache.has(version.id)) langCache.set(version.id, versionLanguage(persona, version));
            return langCache.get(version.id);
        };
        // Language and tag filter chips, from what the versions
        // actually carry right now. A filter naming something gone is dropped
        // rather than silently emptying the list.
        const langs = [];
        const tags = [];
        for (const version of versions) {
            const lang = langOf(version);
            if (lang && !langs.includes(lang)) langs.push(lang);
            for (const tag of version.tags ?? []) if (!tags.includes(tag)) tags.push(tag);
        }
        if (ui.lang && !langs.includes(ui.lang)) ui.lang = null;
        ui.tags = ui.tags.filter(tag => tags.includes(tag));
        if (langs.length || tags.length) {
            const row = el('div', 'pm-quickbar-chips pm-filter-chips');
            for (const lang of langs) {
                row.append(filterChip(STRINGS.common.languageNames[lang] ?? lang, ui.lang === lang, () => {
                    ui.lang = ui.lang === lang ? null : lang;
                    ui.page = 1;
                    scheduleDraw();
                }));
            }
            for (const tag of tags) {
                row.append(filterChip(tag, ui.tags.includes(tag), () => {
                    ui.tags = ui.tags.includes(tag) ? ui.tags.filter(t => t !== tag) : [...ui.tags, tag];
                    ui.page = 1;
                    scheduleDraw();
                }));
            }
            container.append(row);
        }
        if (ui.lang) list = list.filter(version => langOf(version) === ui.lang);
        if (ui.tags.length) list = list.filter(version => ui.tags.every(tag => (version.tags ?? []).includes(tag)));
        const query = ui.query.trim();
        if (query) {
            const ranked = [];
            for (const version of list) {
                let rank = rankOf(version.name ?? '', query);
                for (const tag of version.tags ?? []) rank = Math.max(rank, rankOf(tag, query));
                if (rank > 0) ranked.push({ version, rank });
            }
            ranked.sort((a, b) => b.rank - a.rank);
            list = ranked.map(entry => entry.version);
        }
        if (!list.length) { container.append(emptyOf(STRINGS.common.searchNoHits)); return; }
    }

    const paged = pageOf(list, ui.page, s.root?.settings?.pageSizeVersions ?? 20);
    ui.page = paged.page;
    /* A binding can only be described honestly once the asset list is loaded, and
       this tab never loaded it. Asked for once per persona, and only when a
       binding actually exists to describe, so a persona with none pays nothing.
       loadAssets sets assetState.avatar synchronously before its await, so this
       cannot fan out into one request per frame. */
    if (assetState.avatar !== targetAvatar && !assetState.loading
        && (persona.versions ?? []).some(version => boundAsset(version))) {
        void loadAssets(targetAvatar);
    }
    for (const version of paged.slice) container.append(versionRow(persona, version, writable, reason));
    const pager = pagerRow(paged.page, paged.pages,
        () => { ui.page = Math.max(1, ui.page - 1); redrawManagerList('versions'); },
        () => { ui.page = ui.page + 1; redrawManagerList('versions'); });
    if (pager) container.append(pager);
}

function versionsTab(s, writable, reason) {
    // One screen, one task. While a revision is in progress the
    // tab body IS the revise screen; the state lives in module variables, so
    // stepping to another tab and back resumes it rather than losing it.
    if (reviseActive) return reviseScreen(writable, reason);
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;
    // The way into the revise screen sits at the TOP of this
    // tab, where a long version list cannot scroll it out of reach.
    box.append(actionsRow([
        actionButton(STRINGS.manager.reviseOpen, () => openRevise(), writable, '', reason),
        listSearchButton('versions'),
    ]));
    if (listUi.versions.open) box.append(listSearchRow('versions'));
    const list = el('div');
    list.dataset.pmList = 'versions';
    fillVersionList(list, s, writable, reason);
    box.append(list);
    box.append(actionsRow([actionButton(STRINGS.manager.saveCurrentAsVersion, () => saveAsVersion(), writable, '', reason)]));
    return box;
}

/* History tab */

// 변경 기록 일괄 삭제 (user request). The structure log only ever grows, and on a
// persona that has been edited for weeks it is fifty rows of noise between the
// user and the one line they are looking for.
//
// Nothing is written afterwards. The first version left a line saying how many
// rows had gone, reasoning from the expiry rule, where history that vanishes
// without a trace is indistinguishable from data loss. That rule is about
// records the extension dropped on its own; this is the user asking for an empty
// list, and answering with a row is refusing the request. 기록 삭제 기록을 또
// 남기면 의도에 어긋난다, in their words.
async function clearLog() {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const count = (s.persona.log ?? []).length;
    if (!count) { notify('info', STRINGS.manager.logEmpty); return; }
    if (!(await askConfirm(STRINGS.manager.confirmClearLog(count)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // Counted again on the persona being written to: the question was on screen
    // for as long as the user took, and a save can have added lines meanwhile.
    const cleared = (after.persona.log ?? []).length;
    after.persona.log = [];
    freshContext()?.saveSettingsDebounced?.();
    notify('info', STRINGS.manager.logCleared(cleared));
    scheduleDraw();
}

function findVariant(persona, variantId) {
    for (const section of persona?.sections ?? []) {
        const variant = (persona.variants?.[section.id] ?? []).find(entry => entry.id === variantId);
        if (variant) return { section, variant };
    }
    return null;
}

function historyVariantSelect(persona) {
    const select = el('select', 'pm-manager-select');
    const none = el('option', null, STRINGS.manager.historyChoicePlaceholder);
    none.value = '';
    select.append(none);
    // Grouped by section, which is how the user thinks of a variant: 외형의 40대,
    // not a bare label that two sections could both carry.
    // Counts only: the option label is `${label} (${count})` and no preview from
    // this call is ever rendered.
    for (const group of historyView(persona, null, null)) {
        const optgroup = el('optgroup');
        optgroup.label = group.sectionName;
        for (const entry of group.variants) {
            const option = el('option', null, `${entry.label} (${entry.count})`);
            option.value = entry.variantId;
            optgroup.append(option);
        }
        select.append(optgroup);
    }
    select.value = historyVariant ?? '';
    select.setAttribute('aria-label', STRINGS.manager.historyChoiceAria);
    select.addEventListener('change', () => {
        historyVariant = select.value || null;
        historyIndex = null;
        scheduleDraw();
    });
    return select;
}

// One column, three toggles. Two columns side by side do not fit
// on a phone, and a diff that only uses colour is unreadable to a part of the
// people who need it, so deletions are struck through and additions are underlined
// with a background as well.
// The panel shell rule applied to the history tab's text boxes: the shell keeps the
// border and clips, the inner wrapper scrolls, so the box's own scrollbar stays
// inside its rounded edge exactly as the panel's does.
function textBox(extraClass) {
    const box = el('div', `pm-manager-text${extraClass ? ` ${extraClass}` : ''}`);
    const inner = el('div', 'pm-manager-textscroll');
    box.append(inner);
    return { box, inner };
}

// One diff, kept until its inputs move. diffWords builds an LCS table over both
// bodies: history.js documents 14ms and a transient 7.5MB Uint32Array at 2,800
// characters a side, which is the size of this user's real descriptions. Nothing
// above diffBlock checked whether anything had changed, so every pm:changed while
// a snapshot sat selected in 차이 mode paid it again. Keyed by the two bodies
// themselves rather than by (variantId, index, updatedAt), because that is what
// the answer actually depends on and it cannot go stale behind a missed field.
// Holds plain {type, text} records and two strings, so module state stays data.
let diffMemo = null;

function diffPartsFor(before, after) {
    if (diffMemo && diffMemo.before === before && diffMemo.after === after) return diffMemo.parts;
    const parts = diffWords(before, after);
    diffMemo = { before, after, parts };
    return parts;
}

function diffBlock(before, after) {
    const parts = diffPartsFor(before, after);
    const { box, inner } = textBox('pm-manager-diff');
    for (const part of parts) {
        // Only the changed runs carry a class. Unchanged text used to be wrapped in
        // a pm-diff-same span that no rule ever matched, which on a 3,000 character
        // body is hundreds of elements built to look exactly like the text node
        // underneath them.
        if (part.type === 'del' || part.type === 'add') {
            inner.append(el('span', part.type === 'del' ? 'pm-diff-del' : 'pm-diff-add', part.text));
        } else {
            inner.append(document.createTextNode(part.text));
        }
    }
    if (!parts.truncated) return box;
    // The no-silent-failure rule applied to a comparison: a diff that quietly stopped
    // being a word diff looks exactly like a body that really was replaced whole,
    // and the user has no way to tell which they are reading. So it says which.
    const wrap = el('div');
    wrap.append(
        noteOf(parts.truncated === 'line'
            ? STRINGS.manager.diffLineOnly
            : STRINGS.manager.diffWholeOnly),
        box,
    );
    return wrap;
}

function historyDetail(persona, variantId, snapshotText, writable, reason) {
    const box = el('div', 'pm-manager-historydetail');
    const found = findVariant(persona, variantId);
    const current = found?.variant?.text ?? '';

    const toggles = el('div', 'pm-manager-actions');
    for (const [key, label] of [
        ['before', STRINGS.manager.historyModeBefore],
        ['now', STRINGS.manager.historyModeNow],
        ['diff', STRINGS.manager.historyModeDiff],
    ]) {
        const active = historyMode === key;
        const btn = el('button', `pm-manager-btn${active ? ' pm-manager-tab-active' : ''}`, label);
        btn.type = 'button';
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.addEventListener('click', () => { historyMode = key; scheduleDraw(); });
        toggles.append(btn);
    }
    box.append(toggles);

    if (historyMode === 'before' || historyMode === 'now') {
        const plain = textBox();
        plain.inner.textContent = historyMode === 'before' ? snapshotText : current;
        box.append(plain.box);
    } else {
        box.append(diffBlock(snapshotText, current));
    }

    box.append(actionsRow([
        actionButton(STRINGS.manager.historyRestore, () => restoreSnapshot(variantId, historyIndex), writable, '', reason),
    ]));
    // Restoring snapshots the current text first, so it is itself
    // undoable. Saying so is what makes the button safe to press.
    box.append(noteOf(STRINGS.manager.historyRestoreNote));
    return box;
}

function historyTab(s, writable, reason) {
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;

    if (hasEvictionNotice(persona)) {
        // The user has to be able to find out why their history
        // got shorter, and this screen is where they come looking.
        box.append(bannerOf('pm-manager-warn', STRINGS.manager.evictionNotice));
    }

    const picker = el('div', 'pm-manager-pickrow');
    picker.append(el('span', 'pm-manager-picklabel', STRINGS.manager.historyChoiceLabel));
    picker.append(historyVariantSelect(persona));
    box.append(picker);

    if (!historyVariant) {
        box.append(emptyOf(STRINGS.manager.historyPickFirst));
    } else {
        const list = persona.history?.[historyVariant] ?? [];
        if (!list.length) {
            box.append(emptyOf(STRINGS.manager.historyEmpty));
        } else {
            // historyView is asked for the whole persona and the one group we want
            // is picked out of it, so the ordering and the preview rule live in one
            // place rather than being repeated here.
            const entry = historyView(persona, null, historyVariant)
                .flatMap(group => group.variants)
                .find(item => item.variantId === historyVariant);
            for (const snap of entry?.snapshots ?? []) {
                const row = el('div', 'pm-row pm-manager-historyrow');
                row.append(el('span', 'pm-manager-historytime', formatTime(snap.at)));
                row.append(el('span', 'pm-manager-name', snap.preview));
                row.append(checkMark(historyIndex === snap.index));
                row.addEventListener('click', () => {
                    historyIndex = historyIndex === snap.index ? null : snap.index;
                    scheduleDraw();
                });
                box.append(row);
            }
            if (historyIndex !== null && list[historyIndex]) {
                box.append(historyDetail(persona, historyVariant, list[historyIndex].text ?? '', writable, reason));
            }
        }
    }

    // The other half: the structure log. Newest first, and capped on
    // screen rather than in storage, because the cap here is about how much a phone
    // can usefully show at once.
    const logBox = el('div', 'pm-manager-logbox');
    const logHead = rowHead();
    logHead.append(el('div', 'pm-manager-head pm-manager-loghead', STRINGS.manager.logHead));
    const log = [...(persona.log ?? [])].reverse().slice(0, LOG_ROWS);
    // At the top of the list, not under fifty rows of it: the whole point of the
    // button is that the list has grown past the point of being read.
    logHead.append(actionButton(STRINGS.manager.logClear, () => clearLog(),
        writable && log.length > 0, '', log.length ? reason : ''));
    logBox.append(logHead);
    if (!log.length) logBox.append(noteOf(STRINGS.manager.logEmpty));
    for (const line of log) {
        const row = el('div', 'pm-manager-logrow');
        row.append(el('span', 'pm-manager-historytime', formatTime(line.at)));
        // Anything the map does not name falls back to the raw stored kind rather
        // than to a blank cell, so a line written by a newer build stays legible.
        // Own properties only: a stored kind of 'constructor' out of a hand
        // edited settings.json must fall back, not render an inherited member.
        row.append(el('span', 'pm-manager-logkind',
            Object.hasOwn(STRINGS.manager.logKinds, line.kind) ? STRINGS.manager.logKinds[line.kind] : String(line.kind ?? '')));
        row.append(el('span', 'pm-manager-name', previewText(line.detail, 30)));
        logBox.append(row);
    }
    box.append(logBox);
    return box;
}

/* Assets tab */

function assetLabels() {
    return assetState.list.map(item => item.label);
}

function assetStyleClass() {
    const style = getRoot()?.settings?.assetStyle ?? 'plain';
    // Not quite the folding buildImgHtml does: that one applies the default first
    // and strips after, this one strips first and defaults if nothing survived, so
    // a style name made only of digits reads as a bare pm-asset- there and as
    // pm-asset-plain here. What matters is the same in both, and is the reason the
    // strip exists at all: a style name out of settings.json is user controlled and
    // it is going into a class attribute.
    return `pm-asset pm-asset-${String(style).replace(/[^a-z]/gi, '') || 'plain'}`;
}

// Insert, then close. This screen is a modal dialog, which makes the rest of the
// document inert: the send box behind it cannot take focus, its caret cannot move,
// and the user watching a full screen manager sees nothing happen at all. So the
// value is built from the caret the field still carries from BEFORE this screen
// opened, which is where the user actually was, and everything that needs the
// field to be live is done once the screen is gone.
function insertIntoSendBox(text) {
    const boxEl = document.getElementById('send_textarea');
    if (!boxEl) { notify('error', STRINGS.manager.sendBoxMissing); return; }
    const next = insertAtCursor(boxEl.value, boxEl.selectionStart, boxEl.selectionEnd, text);
    boxEl.value = next.value;
    // Closed straight through rather than through requestClose: that one asks a
    // question when the editor is dirty, and the question is another popup. The
    // editor's text is put away under its own key first, exactly as a tab switch
    // does, so nothing is lost by not asking.
    stashDraft();
    // The one exception to the reopen rule. The whole point of this action is to
    // leave the user looking at the send box with the caret in it, and reopening
    // the quick panel over that would undo exactly what the tap was for.
    closeManager(false);
    // Only now, with the document no longer inert. A focus call against an inert
    // element is dropped and the caret would then sit wherever the browser left it.
    try { boxEl.focus(); } catch { /* focus is best effort */ }
    if (typeof boxEl.setSelectionRange === 'function') {
        try { boxEl.setSelectionRange(next.caret, next.caret); } catch { /* best effort */ }
    }
    // SillyTavern watches this field for its own auto resize and draft keeping, and
    // a value assigned from script fires nothing by itself. Never measured on this
    // build: if nothing listens, dispatching costs one synchronous no-op.
    boxEl.dispatchEvent(new Event('input', { bubbles: true }));
    notify('success', STRINGS.manager.sendBoxInserted);
}

// styleClass is resolved once by the caller and handed down: assetStyleClass goes
// through getRoot(), which builds a fresh context and runs migrate() over every
// persona and version, and it cannot change part way through one repaint. Calling
// it per row meant a 20 row page paid 20 of each, on every keystroke in the asset
// search.
function assetRow(item, key, writable, reason, styleClass) {
    const rowId = rowKey('asset', item.label);
    const open = expandedRow === rowId;
    const row = el('div', `pm-manager-assetrow${open ? ' pm-manager-rowopen' : ''}`);
    const head = rowHead();
    // Built as an element rather than through buildImgHtml, which returns an HTML
    // string and therefore needs DOMPurify. There is no string to sanitise here:
    // the path is the one the server handed back and it is assigned as a property.
    const img = el('img', styleClass);
    img.src = item.path;
    img.alt = '';
    img.loading = 'lazy';
    head.append(img);
    head.append(rowName(rowId, [markedText('pm-manager-name', item.label, listUi.assets.open ? listUi.assets.query : '')]));
    // This row exists to put the picture in the chat, so
    // that is the button on it, and 삭제 waits in the drawer (rule 5).
    head.append(actionButton(STRINGS.manager.assetInsert, () => insertIntoSendBox(insertTagText(key, item.label)), true,
        STRINGS.manager.assetInsertTitle));
    head.append(moreButton(rowId));
    row.append(head);
    if (open) {
        row.append(expansionOf([], [
            actionButton(STRINGS.common.remove, () => dropAsset(item.label), writable, '', reason),
        ]));
    }
    return row;
}

// The per version asset selection, drawn on the version it belongs to. null means
// 전체, so every box is ticked and unticking one is what materialises the list.
function versionAssetBlock(version, writable) {
    const box = el('div', 'pm-manager-assetsel');
    const labels = assetLabels();
    const all = !Array.isArray(version.assetSelection);
    box.append(el('div', 'pm-manager-picklabel',
        all ? STRINGS.manager.assetSelectionAll : STRINGS.manager.assetSelectionSome(version.assetSelection.length)));
    if (assetState.avatar !== targetAvatar || assetState.error) {
        box.append(noteOf(STRINGS.manager.assetOpenTabFirst));
        return box;
    }
    if (!labels.length) {
        box.append(noteOf(STRINGS.manager.assetNoneForPersona));
        return box;
    }
    for (const label of labels) {
        const row = el('label', 'pm-quickbar-labelrow');
        const checkbox = el('input', 'pm-checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = assetSelected(version, label);
        checkbox.disabled = !writable;
        checkbox.addEventListener('change', () => toggleVersionAsset(version.id, label));
        row.append(checkbox, el('span', 'pm-quickbar-labelname', label));
        box.append(row);
    }
    return box;
}

// The empty state carries the button that fills it, and a bare file input is not
// a button: the phone draws it as a second control
// with a label of the browser's choosing. So the button is ours and the input
// behind it is display none, exactly as the settings screen's import control does.
function uploadRow(writable, reason) {
    const row = el('div', 'pm-manager-upload');
    const input = el('input', 'pm-manager-file pm-hidden');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*';
    input.disabled = !writable;
    input.setAttribute('aria-label', STRINGS.manager.assetUploadAria);
    input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        // Cleared before the upload so the same file can be picked again after a
        // failure; a file input holding the previous choice fires no change event.
        input.value = '';
        if (files.length) uploadAssets(files);
    });
    row.append(actionsRow([actionButton(STRINGS.manager.assetUpload, () => input.click(), writable, '', reason)]), input);
    return row;
}

function assetsTab(s, writable, reason) {
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;

    // Lazily, and only for the persona this screen points at. loadAssets sets its
    // avatar synchronously before it awaits, so the next draw sees a match and this
    // cannot turn into a request per frame. A listing already in flight for another
    // persona is not waited for: it publishes nothing once this line has moved the
    // avatar out from under it.
    if (assetState.avatar !== targetAvatar) {
        loadAssets(targetAvatar);
        box.append(noteOf(STRINGS.manager.assetLoading));
        return box;
    }
    if (assetState.loading) { box.append(noteOf(STRINGS.manager.assetLoading)); return box; }

    // A listing failure disables this tab and says why, with the
    // status the server gave. The rest of the screen keeps working.
    const shared = getState();
    const sharedError = (shared?.avatar === targetAvatar) ? shared.assetError : null;
    const error = assetState.error ?? sharedError;
    if (error) {
        box.append(bannerOf('pm-manager-warn', STRINGS.manager.assetListFailed(error)));
        box.append(actionsRow([actionButton(STRINGS.manager.assetRetry, () => loadAssets(targetAvatar), true)]));
        return box;
    }

    const key = resolveFolderKey(s.root, targetAvatar);
    box.append(noteOf(STRINGS.manager.assetFolder(key)));
    // The sentence says what to do and the upload button
    // is the next thing under it.
    if (!assetState.list.length) box.append(emptyOf(STRINGS.manager.assetNone));
    box.append(uploadRow(writable, reason));
    if (assetState.list.length) {
        box.append(actionsRow([listSearchButton('assets')]));
        if (listUi.assets.open) box.append(listSearchRow('assets'));
    }
    const list = el('div');
    list.dataset.pmList = 'assets';
    fillAssetList(list, s, writable, reason);
    box.append(list);
    box.append(actionsRow([actionButton(STRINGS.manager.assetRefresh, () => loadAssets(targetAvatar), true)]));
    box.append(noteOf(STRINGS.manager.assetVersionNote));
    return box;
}

function fillAssetList(container, s, writable, reason) {
    container.replaceChildren();
    const live = new Set(assetState.list.map(item => rowKey('asset', item.label)));
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;
    const folderKey = resolveFolderKey(s.root, targetAvatar);
    const ui = listUi.assets;
    // Deleting the last asset hides the search controls but used to leave the
    // query behind, showing "맞는 것이 없다" under "에셋 없음" with nothing on
    // screen to clear it. An empty listing resets the search.
    if (!assetState.list.length) { Object.assign(ui, emptyListUi()); return; }
    let list = assetState.list;
    const query = ui.open ? ui.query.trim() : '';
    if (query) {
        const ranked = list
            .map(item => ({ item, rank: rankOf(item.label ?? '', query) }))
            .filter(entry => entry.rank > 0)
            .sort((a, b) => b.rank - a.rank);
        list = ranked.map(entry => entry.item);
        if (!list.length) { container.append(emptyOf(STRINGS.common.searchNoHits)); return; }
    }
    const paged = pageOf(list, ui.page, s.root?.settings?.pageSizeAssets ?? 20);
    ui.page = paged.page;
    const styleClass = assetStyleClass();
    for (const item of paged.slice) container.append(assetRow(item, folderKey, writable, reason, styleClass));
    const pager = pagerRow(paged.page, paged.pages,
        () => { ui.page = Math.max(1, ui.page - 1); redrawManagerList('assets'); },
        () => { ui.page = ui.page + 1; redrawManagerList('assets'); });
    if (pager) container.append(pager);
}

/* Labels tab */

// Making a label lives in both screens now. Enter is guarded by
// isComposingKey exactly like every other text entry point here, so a hangul
// composition commit cannot fire it.
function newLabelRow(writable) {
    const row = el('div', 'pm-quickbar-newlabel');
    const input = el('input', 'pm-quickbar-newlabel-input');
    input.type = 'text';
    input.placeholder = STRINGS.manager.newGroupPlaceholder;
    input.disabled = !writable;
    input.setAttribute('aria-label', STRINGS.manager.newGroupAria);
    const submit = () => {
        if (!input.value.trim()) return;
        // addLabel only schedules the redraw, so this clears the live field the
        // user is still looking at rather than one that has been replaced.
        if (!addLabel(input.value)) return;
        input.value = '';
        // Submitting ends the typing session. Without this the redraw waits for a
        // blur that has no reason to come, and the label just made would not show
        // up under the user's finger.
        input.blur();
    };
    input.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    const addBtn = el('button', 'pm-manager-btn', STRINGS.common.create);
    addBtn.type = 'button';
    addBtn.disabled = !writable;
    if (writable) addBtn.addEventListener('click', submit);
    row.append(input, addBtn);
    return row;
}

function labelsTab(ctx, s) {
    const box = el('div', 'pm-manager-tabbody');
    box.append(actionsRow([listSearchButton('groups')]));
    if (listUi.groups.open) box.append(listSearchRow('groups'));
    const list = el('div');
    list.dataset.pmList = 'groups';
    fillGroupList(list, ctx, s);
    box.append(list);
    box.append(newLabelRow(rosterWritable(getState())));
    return box;
}

function fillGroupList(container, ctx, s) {
    container.replaceChildren();
    // Enabled from EXACTLY what the four handlers gate on. The screen wide flag is
    // computed from targetState(), whose readOnly comes from getRoot() rather than
    // from the shared cache, so a cache
    // that has not been built yet left every button here live and every tap on one
    // silent. One source, one answer.
    const writable = rosterWritable(getState());
    const labels = s.root?.labels ?? [];
    // A member id whose persona SillyTavern no longer has is
    // filtered out of the count but never deleted, because a persona removed by
    // mistake is sometimes restored.
    const living = livingLabels(labels, ctx?.powerUserSettings?.personas ?? {});
    const counts = new Map(living.map(label => [label.id, (label.members ?? []).length]));
    const live = new Set(labels.map(label => rowKey('group', label.id)));
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;
    // The empty state says what to type and which button
    // makes it, and newLabelRow below is where both of those are.
    if (!labels.length) { container.append(emptyOf(STRINGS.manager.groupsEmpty)); return; }
    let list = labels;
    const query = listUi.groups.open ? listUi.groups.query.trim() : '';
    if (query) {
        const ranked = labels
            .map(label => ({ label, rank: rankOf(label.name ?? '', query) }))
            .filter(entry => entry.rank > 0)
            .sort((a, b) => b.rank - a.rank);
        list = ranked.map(entry => entry.label);
        if (!list.length) { container.append(emptyOf(STRINGS.common.searchNoHits)); return; }
    }
    for (const label of list) {
        const key = rowKey('group', label.id);
        const open = expandedRow === key;
        const block = el('div', `pm-manager-grouprow${open ? ' pm-manager-rowopen' : ''}`);
        const head = rowHead();
        head.append(rowName(key, [
            markedText('pm-manager-name', label.name ?? '', query),
            el('span', 'pm-manager-count', STRINGS.manager.groupMemberCount(counts.get(label.id) ?? 0)),
        ]));
        const member = (label.members ?? []).includes(targetAvatar);
        // The other half of the same rule, as actionButton states it: a disabled control
        // carries its reason as text, because a tooltip needs a hover and a touch
        // screen has none.
        const reason = targetAvatar ? (writable ? '' : rosterRefusal()) : STRINGS.manager.groupPickPersonaFirst;
        head.append(actionsRow([
            actionButton(member ? STRINGS.manager.groupDetach : STRINGS.manager.groupAttach,
                () => toggleLabelMembership(label.id, targetAvatar), writable && !!targetAvatar,
                STRINGS.manager.groupAttachTitle, reason),
        ]));
        head.append(moreButton(key));
        block.append(head);
        if (open) {
            block.append(expansionOf([
                actionButton(STRINGS.common.rename, () => editLabel(label.id, label.name ?? ''), writable,
                    '', writable ? '' : rosterRefusal()),
            ], [
                actionButton(STRINGS.common.remove, () => dropLabel(label.id, label.name ?? ''), writable,
                    '', writable ? '' : rosterRefusal()),
            ]));
        }
        container.append(block);
    }
}

/* Header and persona picker */

function personaPickerButton(ctx) {
    const btn = el('button', 'pm-manager-target');
    btn.type = 'button';
    const url = thumbnailUrl(ctx, targetAvatar);
    if (url) {
        const img = el('img', 'pm-manager-targetimg');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        btn.append(img);
    }
    const name = (targetAvatar && ctx?.powerUserSettings?.personas?.[targetAvatar]) || targetAvatar || STRINGS.manager.noPersona;
    btn.append(el('span', 'pm-manager-name', name));
    // The open state is drawn, not hovered.
    btn.append(el('span', 'pm-manager-caret', pickerOpen ? '▲' : '▼'));
    btn.title = STRINGS.manager.pickerTitle;
    btn.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false');
    btn.addEventListener('click', () => {
        // Opening the picker replaces the whole body, editor included, so what is
        // in it is put away first exactly as a tab switch does.
        stashDraft();
        pickerOpen = !pickerOpen;
        // This button always means the picker's own job, in both directions.
        // Leaving it in copy mode would make the next tap on a row overwrite a
        // persona for somebody who came here to switch which one they are editing.
        pickerMode = 'target';
        // The row whose drawer was open is about to leave the screen with it.
        expandedRow = null;
        scheduleDraw();
    });
    return btn;
}

/* The picker's own view control (user request). Thirty personas told apart by a
   face rather than by a name is why the quick panel has tiles, and the picker is
   the same thirty rows. It writes the SAME setting the quick panel does: two
   settings for one question would let the two lists disagree about how this user
   wants their personas shown, and there is no reason they should. */
function pickerViewSelect() {
    const select = el('select', 'pm-manager-select');
    for (const key of ['list', 'tiles', 'tilesNamed']) {
        const option = el('option', null, STRINGS.quick.viewNames[key]);
        option.value = key;
        select.append(option);
    }
    // The picker's own setting, not the quick panel's (user request). Sharing one
    // meant choosing tiles in one place changed the other, and there was no way to
    // have a list here and tiles there.
    const stored = getRoot()?.settings?.pickerViewMode;
    select.value = ['tiles', 'tilesNamed'].includes(stored) ? stored : 'list';
    select.setAttribute('aria-label', STRINGS.quick.viewCaption);
    select.addEventListener('change', () => {
        // Re-resolved at tap time like every other handler here, and refused on a
        // read only root rather than written and lost.
        const root = getRoot();
        if (!root || root.readOnly) { scheduleDraw(); return; }
        root.settings.pickerViewMode = select.value;
        freshContext()?.saveSettingsDebounced?.();
        scheduleDraw();
    });
    return select;
}

// One persona as a tile. The quick panel's own tile carries its select mode and
// its switch behaviour, neither of which belongs here, so this is the same
// markup and the same classes with this screen's one action on it.
function pickerTile(ctx, avatar, name, query, named) {
    const current = avatar === targetAvatar;
    const tile = el('button', `pm-quickbar-tile${named ? ' pm-quickbar-tile-named' : ''}${current ? ' pm-quickbar-tile-active' : ''}`);
    tile.type = 'button';
    tile.setAttribute('aria-label', name);
    if (current) tile.setAttribute('aria-current', 'true');
    const imgbox = el('div', 'pm-quickbar-tileimgbox');
    // The name sits under the image as well as inside it, for the same reason the
    // quick panel does it: a thumbnail that fails to load leaves the name showing
    // rather than an anonymous square.
    imgbox.append(markedText('pm-quickbar-tilename', name, query));
    const url = thumbnailUrl(ctx, avatar);
    if (url) {
        const img = document.createElement('img');
        img.className = 'pm-quickbar-tileimg';
        img.loading = 'lazy';
        img.alt = '';
        img.src = url;
        imgbox.append(img);
    }
    tile.append(imgbox);
    if (named) tile.append(markedText('pm-quickbar-tilelabel', name, query));
    tile.addEventListener('click', () => {
        if (pickerMode === 'copy') copyOnto(avatar);
        else selectTarget(avatar);
    });
    return tile;
}

function personaPicker(ctx) {
    const box = el('div', 'pm-manager-picker');
    // The picker does two jobs now, and which one a tap does is the thing the
    // user has to know before their finger lands. So the copy job says so at the
    // top, in a band, and carries its own way out.
    if (pickerMode === 'copy') {
        box.append(bannerOf('pm-manager-warn', STRINGS.manager.copyHead));
        box.append(noteOf(STRINGS.manager.copyGuide));
        box.append(actionsRow([actionButton(STRINGS.manager.copyCancel, () => closeCopyPicker(), true)]));
    }
    box.append(actionsRow([listSearchButton('picker')]));
    if (listUi.picker.open) box.append(listSearchRow('picker'));
    const viewRow = el('div', 'pm-manager-pickrow');
    viewRow.append(el('span', 'pm-manager-picklabel', STRINGS.quick.viewCaption));
    viewRow.append(pickerViewSelect());
    box.append(viewRow);
    const list = el('div');
    list.dataset.pmList = 'picker';
    fillPickerList(list, ctx);
    box.append(list);
    return box;
}

function fillPickerList(container, ctx) {
    container.replaceChildren();
    const personas = ctx?.powerUserSettings?.personas ?? {};
    let entries = Object.entries(personas);
    if (!entries.length) {
        container.append(noteOf(STRINGS.manager.personasUnavailable));
        return;
    }
    // The collator, same arguments as the quick panel's list. The
    // avatar id breaks the ties so two same named personas do not swap places
    // between draws.
    entries.sort((a, b) => {
        const byName = PICKER_COLLATOR.compare(String(a[1] ?? ''), String(b[1] ?? ''));
        if (byName !== 0) return byName;
        return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
    });
    const root = getRoot();
    const ui = listUi.picker;
    const query = ui.open ? ui.query.trim() : '';
    if (query) {
        const ranked = [];
        for (const [avatar, name] of entries) {
            let rank = rankOf(String(name ?? ''), query);
            for (const tag of getPersona(root, avatar)?.tags ?? []) rank = Math.max(rank, rankOf(tag, query));
            if (rank > 0) ranked.push({ entry: [avatar, name], rank });
        }
        ranked.sort((a, b) => b.rank - a.rank);
        entries = ranked.map(r => r.entry);
        if (!entries.length) { container.append(emptyOf(STRINGS.common.searchNoHits)); return; }
    }
    // The picker shares the roster's page size.
    const paged = pageOf(entries, ui.page, root?.settings?.pageSizeRoster ?? 20);
    ui.page = paged.page;
    const viewMode = root?.settings?.pickerViewMode;
    if (viewMode === 'tiles' || viewMode === 'tilesNamed') {
        const grid = el('div', 'pm-quickbar-tiles');
        // Same rule as the quick panel: a chosen column count wins, otherwise the
        // responsive auto fill decides.
        const columns = Number(root?.settings?.rosterTileColumns ?? 0);
        if (columns >= 2) grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
        for (const [avatar, name] of paged.slice) {
            grid.append(pickerTile(ctx, avatar, String(name ?? ''), query, viewMode === 'tilesNamed'));
        }
        container.append(grid);
        const tilePager = pagerRow(paged.page, paged.pages,
            () => { ui.page = Math.max(1, ui.page - 1); redrawManagerList('picker'); },
            () => { ui.page = ui.page + 1; redrawManagerList('picker'); });
        if (tilePager) container.append(tilePager);
        return;
    }
    for (const [avatar, name] of paged.slice) {
        const row = el('div', 'pm-row pm-manager-personarow');
        const url = thumbnailUrl(ctx, avatar);
        if (url) {
            const img = el('img', 'pm-quickbar-rowimg');
            img.src = url;
            img.alt = '';
            img.loading = 'lazy';
            row.append(img);
        }
        row.append(markedText('pm-manager-name', String(name ?? ''), query));
        // Reading the list must not create an entry for
        // anybody. getPersona only reads, and the label is how the user learns
        // which personas this extension is actually carrying data for.
        if (!getPersona(root, avatar)) row.append(el('span', 'pm-manager-count', STRINGS.manager.notAdoptedTag));
        row.append(checkMark(avatar === targetAvatar));
        // Which job the tap does is read at tap time, not baked in at draw time:
        // pickerMode is one string and the handler outlives the draw that made it.
        row.addEventListener('click', () => {
            if (pickerMode === 'copy') copyOnto(avatar);
            else selectTarget(avatar);
        });
        container.append(row);
    }
    const pager = pagerRow(paged.page, paged.pages,
        () => { ui.page = Math.max(1, ui.page - 1); redrawManagerList('picker'); },
        () => { ui.page = ui.page + 1; redrawManagerList('picker'); });
    if (pager) container.append(pager);
}

// The reference's identity move: the section word set large and repeated across a
// band, with the outer copies reduced to an outline. The ghosts are aria-hidden so
// the word is announced once, and they are the first thing dropped on a narrow
// screen (style.css, "Display type").
/* ── Drag to reorder items (user request) ────────────────────────────────────
   Pointer events rather than HTML5 drag and drop: dragstart never fires on
   Android Chromium for a touch, so the native API is desktop only, while pointer
   events cover both from one code path.

   The drag is armed by a handle, never by the row, because the row is already a
   tap target that opens its drawer and a list of items is also something the user
   scrolls through with a finger. A handle means a scroll gesture that starts on a
   row is still a scroll.

   Module state holds an id and numbers only, per the project rule: no node is
   retained, and every frame re-queries what it needs from the id. */
let dragSectionId = null;
let dragOverSection = null;
let dragAutoScroll = 0;

// Called on every teardown as well as on a normal drop. drawManager replaces the
// panel's children, which destroys the capturing handle, and a destroyed handle
// never fires pointerup: without this the drag stayed armed, the auto-scroll rAF
// kept running against a frozen coordinate from a dead node (a retained node, and
// a scroll the user could not hold), and a later plain TAP on any handle reached
// finish() with the stale target and silently moved a section.
function clearDragState() {
    dragSectionId = null;
    dragOverSection = null;
    if (dragAutoScroll) { cancelAnimationFrame(dragAutoScroll); dragAutoScroll = 0; }
    const host = document.getElementById(PANEL_ID);
    for (const node of host?.querySelectorAll('.pm-dragging, .pm-dragover') ?? []) {
        node.classList.remove('pm-dragging', 'pm-dragover');
    }
}

// Which row the pointer is over, measured from the rows rather than listened for
// on them: a pointer capture sends every move to the handle, so the rows never
// see the pointer at all.
//
// Returns the row's SECTION ID, not its position. fillComposeList filters the
// list when a search is open, so the rendered rows are a subset and their
// positions are not indices into persona.sections. Returning a position and
// handing it to reorderSection put a dragged item at the wrong place whenever a
// search was active. The id survives the filter; dropSectionAt converts it.
function dropTargetAt(clientY) {
    const host = document.getElementById(PANEL_ID);
    const rows = [...(host?.querySelectorAll('[data-pm-section]') ?? [])];
    if (!rows.length) return null;
    for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return row.dataset.pmSection ?? null;
    }
    return rows[rows.length - 1].dataset.pmSection ?? null;
}

function paintDragOver(sectionId) {
    const host = document.getElementById(PANEL_ID);
    for (const row of host?.querySelectorAll('[data-pm-section]') ?? []) {
        row.classList.toggle('pm-dragover', dragSectionId !== null && row.dataset.pmSection === sectionId);
    }
}

// A drag that reaches the edge of the scroller has to keep going, or a 13 item
// list cannot be reordered end to end on a phone that shows six of them.
//
// One geometry pass per frame (device jank), the same rule the visualViewport
// handler and the revise popup follow: pointermove only records the finger, and
// this frame does the row rects, the highlight and the scroll together, reads
// before writes. It also keeps the drop target honest while the list scrolls
// under a stationary finger, which per-move handling never saw.
function startAutoScroll(getY) {
    if (dragAutoScroll) return;
    const step = () => {
        const host = document.getElementById(PANEL_ID);
        const scroller = host?.querySelector('.pm-scroll');
        if (!scroller || dragSectionId === null) { dragAutoScroll = 0; return; }
        const y = getY();
        // Reads first: every row rect, then the scroller's own box.
        dragOverSection = dropTargetAt(y);
        const r = scroller.getBoundingClientRect();
        // Writes after: the highlight classes, then the scroll position.
        paintDragOver(dragOverSection);
        const margin = 48;
        if (y < r.top + margin) scroller.scrollTop -= Math.ceil((r.top + margin - y) / 4);
        else if (y > r.bottom - margin) scroller.scrollTop += Math.ceil((y - (r.bottom - margin)) / 4);
        dragAutoScroll = requestAnimationFrame(step);
    };
    dragAutoScroll = requestAnimationFrame(step);
}

function dragHandle(sectionId, writable, reason) {
    const handle = el('button', 'pm-manager-btn pm-draghandle', '⠿');
    handle.type = 'button';
    handle.setAttribute('aria-label', STRINGS.manager.dragHandle);
    if (!writable) {
        handle.disabled = true;
        handle.classList.add('pm-disabled');
        if (reason) handle.dataset.pmReason = reason;
        return handle;
    }
    let lastY = 0;
    // Whether any pointermove fired this drag. The frame loop computes a target
    // even under a stationary finger (the row the handle itself is in), so
    // without this a plain press-and-release would reach dropSectionAt, fail the
    // same-index check and redraw the whole panel for a tap that moved nothing.
    let moved = false;
    handle.addEventListener('pointerdown', e => {
        // Left button or touch only, and the capture keeps every later move on
        // this element even as the rows move under the finger.
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        // Cleared here too: a tap with no movement fires no pointermove, so a
        // leftover target from an interrupted drag would be used as this one's.
        dragOverSection = null;
        dragSectionId = sectionId;
        moved = false;
        lastY = e.clientY;
        handle.setPointerCapture?.(e.pointerId);
        handle.closest('[data-pm-section]')?.classList.add('pm-dragging');
        startAutoScroll(() => lastY);
    });
    handle.addEventListener('pointermove', e => {
        if (dragSectionId === null) return;
        e.preventDefault();
        // Only the finger position. pointermove outruns frames on the device, and
        // the row rects it used to read here forced a layout per event against
        // the classes and scrollTop being written around it; startAutoScroll's
        // frame owns the per-frame work now, in read-then-write order.
        moved = true;
        lastY = e.clientY;
    });
    const finish = () => {
        if (dragSectionId === null) return;
        const id = dragSectionId;
        // Measured at release, from the finger's final position: the frame loop's
        // copy exists for the highlight and can be a frame behind, or not exist
        // at all when the release beats the first frame. A drag that never moved
        // stays a tap and drops nothing.
        const onto = moved ? dropTargetAt(lastY) : null;
        clearDragState();
        if (onto) dropSectionAt(id, onto);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', () => clearDragState());
    // The browser drops the capture when the node leaves the document, which is
    // the one teardown the handlers above cannot see.
    handle.addEventListener('lostpointercapture', () => clearDragState());
    return handle;
}

// The write, guarded the same way every other write on this screen is: the header
// can move the target between the gesture starting and it ending.
function dropSectionAt(sectionId, ontoSectionId) {
    const after = guardTarget();
    if (!after) return;
    const persona = ensureShape(after.persona);
    // The drop target is named, so the index is resolved against the data that
    // exists NOW rather than against whatever the list looked like when the drag
    // started. A section deleted mid-drag simply has no index and nothing moves.
    const sections = persona.sections ?? [];
    const onto = sections.findIndex(sec => sec.id === ontoSectionId);
    const from = sections.findIndex(sec => sec.id === sectionId);
    if (onto === -1 || from === -1) { scheduleDraw(); return; }
    // dropTargetAt names the row whose TOP HALF the finger is in, and .pm-dragover
    // draws the rule across that row's top edge, so the promise on screen is
    // "insert ABOVE this row". reorderSection splices the item OUT first, which
    // shifts every index after it down by one, so a downward drag landed one slot
    // past the line the user was looking at: A dropped above C gave B,C,A,D where
    // the rule promised B,A,C,D. Upward drags were already right, which is why it
    // looked like it worked. Neither unit test caught it: both sides were
    // self-consistent and the seam between them was the wrong part.
    const toIndex = onto > from ? onto - 1 : onto;
    if (!reorderSection(persona, sectionId, toIndex)) { scheduleDraw(); return; }
    const name = (persona.sections ?? []).find(sec => sec.id === sectionId)?.name ?? '';
    commit('section-move', name);
}

function bandRow(word) {
    const band = el('div', 'pm-band');
    for (const ghost of [true, false, true]) {
        const span = el('span', `pm-band-word${ghost ? ' pm-band-ghost' : ''}`, word);
        if (ghost) span.setAttribute('aria-hidden', 'true');
        band.append(span);
    }
    return band;
}

function headerRow(ctx) {
    // pm-mass makes this block the panel's one solid shape, with the drip edge and
    // the detached droplet hanging out of its bottom (style.css, "The liquid
    // edge"). Both are pseudo-elements, so nothing operable lives in the
    // decoration and the row's own children are unaffected.
    const head = el('div', 'pm-manager-header pm-mass');
    head.append(personaPickerButton(ctx));
    head.append(actionButton(STRINGS.common.close, () => requestClose(), true));
    return head;
}

function tabsRow() {
    const row = el('div', 'pm-manager-tabs');
    row.setAttribute('role', 'tablist');
    for (const key of TAB_KEYS) {
        const active = key === managerTab;
        const btn = el('button', `pm-manager-tab${active ? ' pm-manager-tab-active' : ''}`, STRINGS.manager.tabs[key]);
        btn.type = 'button';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        btn.addEventListener('click', () => {
            if (managerTab === key) return;
            // R2: the editor is about to leave the screen, and what is in it is
            // kept under this variant's key rather than dropped. A confirmation
            // here would be a question the user has to answer to change tab.
            stashDraft();
            managerTab = key;
            // The open row belongs to the tab being left, and every tab keys its
            // rows differently, so it has nothing to reopen on the new one.
            expandedRow = null;
            scheduleDraw();
        });
        row.append(btn);
    }
    return row;
}

function drawManager() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    // Read once per draw, from SillyTavern's own controls, and not carried across
    // frames: the list belongs to whatever SillyTavern has in the document now.
    enumCache = null;
    applyShapeClass(panel);
    // A redraw destroys the capturing handle, so any drag in flight is over
    // whether the pointer knows it or not.
    clearDragState();
    // A redraw is already waiting for an input to be given up. Registering a
    // second listener on a second input would draw twice for one release.
    if (drawDeferred) return;
    // A background settings save lands some time after a tap, and rebuilding then
    // takes the focused textarea out of the document mid composition, which loses
    // a half typed hangul syllable. Wait for the user to leave the field. The
    // listener is one shot and holds no node of its own.
    const active = document.activeElement;
    if (active && panel.contains(active) && isTextEntry(active)) {
        drawDeferred = true;
        active.addEventListener('blur', () => { drawDeferred = false; scheduleDraw(); }, { once: true });
        return;
    }

    // One read for the whole draw. Drawing is synchronous, so neither can go stale
    // before the last group is built, and no handler keeps a reference to either.
    const ctx = freshContext();
    const s = targetState();

    // The panel is a clipped shell and .pm-scroll is what
    // scrolls, so the scrollbar is drawn inside the rounded border rather than
    // over it. Everything below reads and writes the wrapper.
    //
    // replaceChildren empties it, and an empty box has nothing to scroll, so the
    // browser clamps scrollTop to 0 before the new content arrives. The same save
    // and restore is applied to what the user has typed into the editor: a blur
    // releases the deferral and schedules a draw, and that draw would otherwise
    // rebuild the textarea from the stored text with the typing gone.
    const oldScroll = panel.querySelector('.pm-scroll');
    const scrollTop = oldScroll?.scrollTop ?? 0;
    const editing = panel.querySelector('.pm-manager-editor-text');
    const typed = (editing && editorDirty)
        ? { value: editing.value, start: editing.selectionStart, end: editing.selectionEnd }
        : null;
    // The 수정 칸 gets the same treatment for the same race: a tap on [적용]
    // blurs the field, the blur releases the draw deferral, and the rebuilt
    // textarea would hand the click the original text instead of the typing.
    const reviseField = panel.querySelector('.pm-revise-input');
    const reviseTyped = reviseField
        ? { value: reviseField.value, start: reviseField.selectionStart, end: reviseField.selectionEnd }
        : null;
    // Parked on the module state as well, because the caret-preserving restore
    // below only bridges two consecutive draws with the box in both. A draw
    // that leaves the box out (tab switch, picker) would otherwise be the last
    // time the typing existed anywhere. A plain string, per the rule
    // at the top of this file.
    if (reviseEditing && reviseField) reviseEditing.typed = reviseField.value;
    // The 전문 window has one field per body and no single one to restore, so its
    // typing is parked on the working copies instead, which is what the rebuild
    // draws from. Same race as the two above: a draw is the moment the fields
    // stop existing, and it must not also be the moment the typing does.
    harvestFullTexts();

    panel.replaceChildren();
    // The tab bar stays at the top, so changing tab never
    // means scrolling back up first. The persona picker rides with it, because
    // the 닫기 button lives there and a close that can scroll out of reach is the
    // same complaint one level up. The bar sits OUTSIDE .pm-scroll, as a flex row
    // of the panel above it: a sticky bar inside the scroller had content passing
    // underneath, and the theme's translucent tint let that content show through.
    // Out here nothing ever passes under it, at no compositing cost.
    const sticky = el('div', 'pm-manager-sticky');
    // The band names the tab the user is on, in the reference's repeated-word
    // form. It sits under the tab strip rather than replacing it: the strip is how
    // you move between tabs, the band is what tells you where you landed.
    sticky.append(headerRow(ctx), tabsRow(), bandRow(STRINGS.manager.tabs[managerTab]));
    const scroll = el('div', 'pm-scroll');
    panel.append(sticky, scroll);

    const body = el('div', 'pm-manager-body');
    scroll.append(body);

    if (pickerOpen) {
        body.append(personaPicker(ctx));
        if (scrollTop) scroll.scrollTop = scrollTop;
        return;
    }

    if (!s) {
        body.append(noteOf(STRINGS.manager.stateUnread));
        return;
    }
    // ambiguous means ctx.js could not decide which persona is ACTIVE, which is
    // what saveAndComposeFor refuses on, and readOnly means a newer build owns
    // this data. Writing in either case would land somewhere we cannot vouch for,
    // so every control that writes is disabled and the reason is on screen.
    const writable = !s.ambiguous && !s.readOnly;
    // Computed once and handed to every tab, so a disabled
    // button anywhere on this screen can say why in the same words.
    const reason = writeReason(s);
    if (s.ambiguous) body.append(bannerOf('pm-manager-warn', STRINGS.manager.ambiguous));
    if (s.readOnly) body.append(bannerOf('pm-manager-warn', STRINGS.common.readOnly));

    if (!s.avatar) {
        // No persona selected is a message, never a blank screen.
        body.append(noteOf(STRINGS.manager.pickPersonaHere));
        return;
    }
    if (!Object.hasOwn(ctx?.powerUserSettings?.personas ?? {}, s.avatar)) {
        body.append(bannerOf('pm-manager-warn', STRINGS.manager.personaGone));
    }

    if (!s.persona) {
        // adoptFor seeds the first variant from the existing
        // description, losslessly, and creates nothing until the user asks.
        body.append(noteOf(STRINGS.manager.notAdopted));
        body.append(actionsRow([actionButton(STRINGS.manager.adoptButton, () => adoptTarget(), writable, '', reason)]));
        return;
    }

    // An outside edit on the persona being edited has to be visible
    // here, because switching version on top of it throws it away.
    if (ctx && hasDiverged(ctx, s.avatar, s.persona)) {
        body.append(bannerOf('pm-manager-warn', STRINGS.manager.divergedBanner));
    }

    // A section that fell out of the prompt has to be visible, with
    // its name, on every tab. Silence is the worst outcome available here.
    const missing = compose(s.persona).missing;
    if (missing.length) {
        body.append(bannerOf('pm-manager-warn', STRINGS.manager.missingBanner(missing.length, missing.join(', '))));
    }

    const group = groupOf(STRINGS.manager.tabs[managerTab] ?? '');
    // One line under the tab name saying what the
    // tab is for, always drawn. It used to be nowhere at all, and a title attribute
    // would have put it somewhere a phone cannot reach.
    group.append(el('div', 'pm-manager-tabdesc', STRINGS.manager.tabDescriptions[managerTab] ?? ''));
    if (managerTab === 'versions') group.append(versionsTab(s, writable, reason));
    else if (managerTab === 'history') group.append(historyTab(s, writable, reason));
    else if (managerTab === 'assets') group.append(assetsTab(s, writable, reason));
    else if (managerTab === 'labels') group.append(labelsTab(ctx, s));
    else group.append(composeTab(s, writable, reason));
    body.append(group);

    if (scrollTop) scroll.scrollTop = scrollTop;
    // Restored into the rebuilt field, not the one that was read: that node is
    // gone. Focus is deliberately not restored, because taking it back would
    // reopen the keyboard the user just closed.
    if (typed) {
        const rebuilt = panel.querySelector('.pm-manager-editor-text');
        if (rebuilt) {
            rebuilt.value = typed.value;
            if (typed.start != null && typed.end != null && typeof rebuilt.setSelectionRange === 'function') {
                rebuilt.setSelectionRange(typed.start, typed.end);
            }
        }
    }
    if (reviseTyped) {
        const rebuilt = panel.querySelector('.pm-revise-input');
        if (rebuilt) {
            rebuilt.value = reviseTyped.value;
            if (reviseTyped.start != null && reviseTyped.end != null && typeof rebuilt.setSelectionRange === 'function') {
                rebuilt.setSelectionRange(reviseTyped.start, reviseTyped.end);
            }
        }
    }
    if (reviseScrollToBox) {
        reviseScrollToBox = false;
        try { panel.querySelector('.pm-revise-box')?.scrollIntoView({ block: 'nearest' }); } catch { /* best effort */ }
    }
    // Last, so it moves the finished panel rather than one still being built.
    if (focusSearch) takeSearchFocus();
}

/* Lifecycle */

function onOpenRequest(e) {
    const detail = e?.detail;
    if (!detail || !TAB_KEYS.includes(detail.tab)) return;
    // Set before anything else: the dispatch is synchronous and the quick panel
    // reads this flag on the line after it.
    detail.handled = true;
    openManager(detail.tab);
    // The quick panel's 검색 shortcut asks for the tab AND its search row open, so
    // the user lands on a keyboard rather than on a list they then have to open
    // search on. Set after openManager, which resets listUi.
    if (detail.search && listUi[detail.tab]) {
        listUi[detail.tab].open = true;
        // And LAND on it. Opening the row without this put the user at the top of
        // the tab with the search somewhere below the fold, which is the whole of
        // what the device reported about this button.
        focusSearch = detail.tab;
        scheduleDraw();
    }
}

// Called by the settings screen after 설정 가져오기 replaces the whole root. The
// asset listing and the drafts both describe the tree that just went away: a
// stale listing would offer files under the old folder key, and a draft would
// resurface pre-import text as "저장하지 않았던 편집" on top of the imported body
// whenever the file reuses the same ids, which re-importing an old export of the
// same data always does. The manager is modal, so it cannot be open while the
// drawer's import button is reachable; the redraw is belt and braces for any
// path that ever changes that.
export function invalidateManagerCaches() {
    assetState = { avatar: null, list: [], error: null, loading: false };
    // An import replaces every body under us, so a diff keyed on the old ones is
    // an answer about data that no longer exists.
    diffMemo = null;
    clearDrafts();
    if (typeof document !== 'undefined' && document.getElementById(HOST_ID)) scheduleDraw();
}

export function mountManager() {
    if (mounted || typeof document === 'undefined') return;
    mounted = true;
    track(cleanups, document, 'pm:open-manager', onOpenRequest);
    // The screen does not follow the active persona any more, because it writes to
    // a target of its own. It still redraws on every state change: whether writing
    // is allowed at all can change under it, and so can the data itself.
    track(cleanups, document, 'pm:changed', () => {
        if (document.getElementById(HOST_ID)) scheduleDraw();
    });
}

export function unmountManager() {
    // Teardown, not a close the user asked for: the usual reopen would put
    // a quick panel on screen for an extension that is being taken apart.
    closeManager(false);
    runCleanups(cleanups);
    // Teardown, not a screen the user stepped out of: nothing may survive it.
    clearDrafts();
    mounted = false;
    managerTab = 'compose';
    historyMode = 'diff';
}
