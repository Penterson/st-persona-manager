// The manager screen: sections, variants, versions, history, assets and labels for one
// persona. Opened by pm:open-manager on document; the quick panel, which sends it,
// expects detail.handled to be set. Testable logic lives in manager-pure.js.
//
// Handlers outlive the draw that made them, so none closes over a context, a getState()
// snapshot or a node; each reads again when it runs, or one persona's text can land in
// another.
//
// Writes go to targetAvatar via saveAndComposeFor(target), which decides from its own
// live context whether the target is the active persona, and so whether SillyTavern's
// prompt field is written. That lets the user edit a persona they are not playing.
import { MODULE_NAME, makeId, appendSection, getPersona, findVersion, liveVariant, ensurePersona, HEADING_FORMATS } from './store.js';
import {
    getState, getRoot, adoptFor, saveAndComposeFor, refreshAssets, KEEP_DESCRIPTION_KINDS,
} from './state.js';
import { freshContext } from './ctx.js';
import {
    compose, composePicked, composeFrom, hasDiverged, headingLine, validTemplate,
    readPlacement, writePlacement,
} from './compose.js';
import { addLog, snapshot, enforceGlobalBudget, restore, diffWords, expireOldHistory } from './history.js';
import { toggleMember, modifiedAt } from './roster.js';
import { itemsWithText, planResplit, applyResplit, splitOwnSections, seedOwnSections, sameText } from './classify.js';
import {
    validCrop, clampView, cropFromView, viewFromCrop, previewBox, cropPixels, MAX_ZOOM as MAX_FRAMING_ZOOM,
} from './framing.js';
import {
    isTextEntry, pickApplicable, versionApplicable, versionAlreadyApplied, quoteArg, waitFor, nameCollides, rosterWritable,
    CREATE_WAIT_TURNS, conversationLanguage,
} from './quickbar-pure.js';
import {
    closePanel, openPanel, isPanelOpen, notify, askConfirm, askChoice, askText,
    thumbnailUrl, markedText, pagerRow, applyShapeClass,
    applyPersonaName, personaImageChanged, runBoundImageWrite,
    scheduleAutoName, cancelAutoName, releaseToasts,
} from './quickbar.js';
import {
    el, track, runCleanups, blockDrawerClose, isComposingKey, makeRowActivatable,
    checkMark, emptyBlock, bannerOf as sharedBanner, afterGesture, frameTask, button, disable, imagePool,
} from './dom.js';
import { rankOf, textContains, detectLanguage, pageOf } from './search-pure.js';
import {
    resolveFolderKey, claimFolderKey, listAssets, uploadAsset, deleteAsset, withoutBackups,
    replacePersonaAvatar, feedPersonaImage, restoreAvatarBackup, findAsset, imageSize,
} from './assets.js';
import {
    canDeleteSection, removeSection, moveSection, reorderSection, deleteVariant,
    renameLabel, deleteLabel, versionSummary, versionSummaryLine, NO_PICK_LABEL,
    putDraft, peekDraft, takeDraft, clearDrafts, rowKey,
    historyView, hasEvictionNotice, missingSignature, previewText,
    assetSelected, toggleAssetSelection, insertTagText, insertAtCursor,
    applyReplacement, buildReplaceBlocks, makeReplaceVersion, replaceVersionUndo, undoReplaceVersion,
    addTag, removeTag, missingDefaultSections, fillDefaultSections,
    planFullTextSave, readSelectOptions, parseDepth, copyPersonaOnto,
    setLocalName, localName, countSize,
    boundAsset, bindingIsExact, bindAsset, versionImageState, versionsBindingAsset, pictureSettled, pickInEveryVersion,
    renameVersionIn, duplicateVersionIn, overwriteVersionPicks, dropVersionFrom, moveVersion, addVersion,
    applyVersionPicks,
} from './manager-pure.js';
// Every sentence the user reads comes from STRINGS. Stored log kinds, data keys and
// class names here are not copy and keep their spelling.
import { STRINGS } from './strings.js';

const HOST_ID = 'pm-manager-host';
const PANEL_ID = 'pm-manager-panel';

// Stored tab ids; the visible names are STRINGS.manager.tabs, keyed by these.
const TAB_KEYS = Object.freeze(['compose', 'versions', 'history', 'assets', 'labels']);

const LOG_ROWS = 50;

let mounted = false;
let cleanups = [];
let screenCleanups = [];
// Set to the active persona on open; afterwards only the header picker moves it.
let targetAvatar = null;
let managerTab = 'compose';
// The variant open in the body editor, as ids; the object is looked up at write time.
let openVariant = null;
let editorDirty = false;
let closeAsked = false;
// Scroll offset per screenKey(), restored by drawManager.
let lastScreen = null;
const scrollByScreen = new Map();

// The screen a draw shows, for scroll restore: the picker, or a persona's tab with
// the body editor, the revise screen or the full text open over it.
function screenKey() {
    if (pickerOpen) return 'picker';
    const over = openVariant ? ['editor', openVariant.sectionId, openVariant.variantId]
        : reviseActive ? ['revise'] : fullTexts ? ['fulltext'] : [];
    return JSON.stringify([targetAvatar, managerTab, ...over]);
}
const drawTask = frameTask(() => drawManager());
let drawDeferred = false;
let pickerOpen = false;
// History tab selection: a variant id and an index in storage order, as restore() takes.
let historyVariant = null;
let historyIndex = null;
let historyMode = 'diff';
// The one row showing its other actions, as a rowKey string. The next tab draw
// clears it if that row is gone.
let expandedRow = null;
// The asset listing for targetAvatar. state.js keeps one only for the active persona
// (it feeds the macros), which is the wrong folder for any other target.
let assetState = { avatar: null, list: [], error: null, loading: false };
// The set of empty sections the user has already been told about. See commit.
let lastMissing = null;
// Revise screen: reviseBlocks are the original blocks, reviseTexts the working copies.
// Each reviseSteps entry holds the block index and the whole previous string, so undo
// is one assignment. reviseSelection keeps the last valid drag as offsets because
// tapping the popup collapses the selection before the click lands.
let reviseActive = false;
let reviseBlocks = null;
let reviseTexts = null;
let reviseSteps = [];
let reviseSelection = null;
let reviseEditing = null;
let revisePopupHide = 0;
let revisePopupFrame = 0;
let reviseScrollToBox = false;
// Full-text screen: fullBlocks, taken on open, pins each textarea to the body it was
// drawn from; fullTexts are working copies re-read from the fields on every draw so a
// rebuild cannot roll typing back.
let fullActive = false;
let fullBlocks = null;
let fullTexts = null;
// 'items': one box per item. 'raw': the composed text as SillyTavern receives it, read
// only; the working copies stay the item boxes', so switching back loses nothing.
let fullView = 'items';
// Folded blocks at the top of the compose tab. Not expandedRow keys, which the next
// tab draw clears.
let placementOpen = false;
let namesOpen = false;
let personaOpen = false;
// What a picker row tap does: 'target' moves this screen's target, 'copy' copies the
// current composition onto that row. Reset when the picker closes.
let pickerMode = 'target';
// SillyTavern's position and role options as {value, label}, read off its selects and
// dropped at the top of every draw so a rename or reload cannot leave a stale list.
let enumCache = null;
// Debounce for the size lines: SillyTavern's token count has an unpredictable cost,
// so it does not run per keystroke.
let sizeTimer = 0;
// Search state per searchable list, keyed by the containers' data-pm-list ids.
const emptyListUi = () => ({ open: false, query: '', page: 1, lang: null, tags: [] });
let listUi = {
    picker: emptyListUi(),
    compose: emptyListUi(),
    versions: emptyListUi(),
    assets: emptyListUi(),
    groups: emptyListUi(),
};
function resetListUi() {
    // In place: the search and pager handlers hold these objects, and replacing them
    // would let a tap before the next draw write into an orphan.
    for (const ui of Object.values(listUi)) Object.assign(ui, emptyListUi());
}
// Whether the quick panel was open when this screen opened (read before closePanel()).
// Only then is it reopened on close; from the settings drawer it would cover the drawer.
let fromQuickPanel = false;

// Every redraw goes through here: at most one per frame. drawManager also holds it
// while a text field in the panel has focus.
function scheduleDraw() {
    drawTask.schedule();
}

/* Shell */

// One geometry write per frame: visualViewport fires scroll continuously while the
// keyboard pans the page.
const sizeTask = frameTask(() => sizeToViewport());
function scheduleSize() {
    sizeTask.schedule();
}

// Last written geometry. An unchanged value is not rewritten: every style write
// invalidates layout, and Android fires visualViewport events per frame during a fling.
let sizedHeight = null;
let sizedTop = null;

function forgetSizing() {
    sizedHeight = null;
    sizedTop = null;
}

function sizeToViewport() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    // visualViewport, not vh: vh ignores the on-screen keyboard and would put the save
    // button under it.
    const vv = globalThis.visualViewport;
    const height = vv?.height ?? globalThis.innerHeight ?? 0;
    if (!height) return;
    const px = Math.round(height);
    if (px !== sizedHeight) {
        sizedHeight = px;
        panel.style.height = `${px}px`;
        // Cap for the history tab's text boxes: 40% of the measured height, since a vh
        // cap would ignore the keyboard too.
        panel.style.setProperty('--pm-history-cap', `${Math.round(height * 0.4)}px`);
    }
    // Zero on Android while the keyboard is up (the visual viewport shrinks), non-zero
    // when the page is pinch zoomed or a focused field is panned into view.
    const top = Math.max(0, Math.round(vv?.offsetTop ?? 0));
    if (top !== sizedTop) {
        sizedTop = top;
        panel.style.top = `${top}px`;
    }
}

function openManager(tab) {
    const wanted = TAB_KEYS.includes(tab) ? tab : 'compose';
    if (document.getElementById(HOST_ID)) { managerTab = wanted; scheduleDraw(); return; }
    // The quick panel is a modal dialog too, and two in the top layer leave the user
    // tapping the wrong one. Whether it was up is read before closing it.
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
    targetAvatar = getState()?.avatar ?? null;

    // pm-grain sits on the panel, not the scrolling content, so it composites once.
    const panel = el('div', 'pm-panel pm-manager-panel pm-grain');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', STRINGS.manager.screenAria);

    // Every overlay rides a modal dialog: some themes put a transform on an ancestor,
    // which breaks position: fixed, and the top layer ignores ancestor transforms.
    const host = document.createElement('dialog');
    host.id = HOST_ID;
    host.className = 'pm-manager-host';
    host.tabIndex = -1;
    blockDrawerClose(host);
    blockDrawerClose(panel);
    // ESC and the Android back gesture fire cancel; requestClose asks about unsaved work.
    host.addEventListener('cancel', e => { e.preventDefault(); requestClose(); });
    // Chromium's close watcher lets a second back gesture close the dialog natively when
    // no tap happened since the last prevented cancel, so a close we did not start runs
    // our teardown (a host left behind blocks reopening until reload).
    host.addEventListener('close', () => {
        if (document.getElementById(HOST_ID) !== host) return;
        // quickbar.js dropHost closes this host so a non-dialog SillyTavern popup can be
        // answered, then raises it again; the screen must survive that.
        if (host.dataset.pmDropped === '1') return;
        // Working copies the draft store does not keep: reopen and ask first.
        if (hasWorkingCopies()) {
            try { host.showModal(); } catch { host.setAttribute('open', ''); }
            void requestClose();
            return;
        }
        stashDraft();
        closeManager(false);
    });
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
        // Android fires scroll, not resize, when the visual viewport pans to keep a
        // focused field above the keyboard.
        track(screenCleanups, globalThis.visualViewport, 'scroll', scheduleSize);
    }
    // The revise screen's edit popup follows the selection. selectionchange has no
    // per-node target, so it listens for the screen's life and no-ops elsewhere.
    track(screenCleanups, document, 'selectionchange', onReviseSelectionChange);
    // Fallback for no showModal, where no cancel event comes. Only while focus is in our
    // host, so the ESC that dismisses a SillyTavern popup over this screen does not also
    // close it.
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

// One close question at a time. The flag comes down even if the popup throws: left
// up, every close path would return early and the screen could not be closed.
async function askOnce(message) {
    closeAsked = true;
    try { return await askConfirm(message); } finally { closeAsked = false; }
}

// Asks, one question per dirty screen, before the revise steps or full-text bodies
// are dropped; neither survives leaving the persona or the screen. Answers whether
// to go on.
async function confirmDropWorking() {
    if (closeAsked) return false;
    const revising = reviseDirtyCount();
    if (revising > 0 && !(await askOnce(STRINGS.manager.reviseConfirmLeave(revising)))) return false;
    const fullDirty = fullDirtyCount();
    if (fullDirty > 0 && !(await askOnce(STRINGS.manager.fullTextConfirmLeave(fullDirty)))) return false;
    return !!document.getElementById(HOST_ID);
}

// What a close would lose that the draft store does not keep.
function hasWorkingCopies() {
    return reviseDirtyCount() > 0 || fullDirtyCount() > 0 || (framing?.mode === 'upload' && !framingBusy);
}

async function requestClose() {
    if (closeAsked) return;
    // A picked replacement image not yet applied. Not asked once uploading: closing
    // does not stop an upload.
    if (framing?.mode === 'upload' && !framingBusy) {
        const ok = await askOnce(STRINGS.manager.framingConfirmLeave);
        if (!ok || !document.getElementById(HOST_ID)) return;
    }
    const revising = reviseDirtyCount();
    const fullDirty = fullDirtyCount();
    if (editorDirty || revising > 0 || fullDirty > 0) {
        stashDraft();
        // The editor's text is stashed above and survives; the revise and full-text copies
        // do not, so they are what to ask about, the one on the current tab first.
        const onVersions = managerTab === 'versions';
        const first = onVersions ? revising : fullDirty;
        const second = onVersions ? fullDirty : revising;
        const askFirst = onVersions ? STRINGS.manager.reviseConfirmLeave : STRINGS.manager.fullTextConfirmLeave;
        const askSecond = onVersions ? STRINGS.manager.fullTextConfirmLeave : STRINGS.manager.reviseConfirmLeave;
        const message = first > 0 ? askFirst(first)
            : second > 0 ? askSecond(second)
                : STRINGS.manager.confirmCloseDirty;
        const ok = await askOnce(message);
        if (!ok || !document.getElementById(HOST_ID)) return;
        // Both can be dirty and closeManager drops both, so the second gets its own question.
        if (first > 0 && second > 0) {
            const okSecond = await askOnce(askSecond(second));
            if (!okSecond || !document.getElementById(HOST_ID)) return;
        }
    }
    closeManager();
}

// Closing steps back to the quick panel when that is where the user came from,
// unless the panel is turned off or there is no persona. The insert-then-close path
// passes false (see insertIntoSendBox).
function closeManager(reopenPanel = true) {
    const returnToPanel = reopenPanel && fromQuickPanel;
    fromQuickPanel = false;
    runCleanups(screenCleanups);
    // Before the host goes: it holds SillyTavern's toast container while open, and
    // removing it with the container inside would take every toast down with it.
    releaseToasts();
    const host = document.getElementById(HOST_ID);
    if (host) {
        try { if (typeof host.close === 'function') host.close(); } catch { /* already closed */ }
        host.remove();
    }
    targetAvatar = null;
    openVariant = null;
    editorDirty = false;
    closeAsked = false;
    lastScreen = null;
    scrollByScreen.clear();
    // Otherwise detached rows, thumbnails and their closures live until the next open.
    rowNodes.clear();
    pickerThumbs.clear();
    dropFraming();
    gestureHeld = false;
    drawWaitingOnGesture = false;
    drawDeferred = false;
    pickerOpen = false;
    historyVariant = null;
    historyIndex = null;
    expandedRow = null;
    lastMissing = null;
    // Two full description bodies, so it does not get to outlive the screen.
    diffMemo = null;
    languageMemo.clear();
    clearDragState();
    assetState = { avatar: null, list: [], error: null, loading: false };
    // Unlike drafts, revise steps and full-text copies do not survive a close;
    // requestClose has already asked about them.
    resetRevise();
    resetFullText();
    pickerMode = 'target';
    // A focus request nobody consumed dies with the screen it was made on.
    focusSearch = null;
    clearListFrames();
    placementOpen = false;
    namesOpen = false;
    personaOpen = false;
    enumCache = null;
    resetListUi();
    // Drafts survive a close on purpose; unmountManager clears them.
    // A stale frame would make the schedulers skip every later draw.
    drawTask.cancel();
    sizeTask.cancel();

    // Last, after full teardown: openPanel opens a modal dialog of its own.
    if (!returnToPanel) return;
    const s = getState();
    if (!s || s.settings?.showQuickBar === false || !s.avatar) return;
    openPanel();
}

/* Target and guards */

// What this screen edits, read fresh; use it within one synchronous stretch.
function targetState() {
    const root = getRoot();
    if (!root) return null;
    return {
        root,
        settings: root.settings,
        avatar: targetAvatar,
        persona: targetAvatar ? getPersona(root, targetAvatar) : null,
        readOnly: !!root.readOnly,
        // False once deleted in SillyTavern behind this screen: a write would be refused
        // at commit, after the record had already changed.
        listed: !targetAvatar || Object.hasOwn(freshContext()?.powerUserSettings?.personas ?? {}, targetAvatar),
        // Two personas share a name and no precise path, so the active one is unknowable
        // and saveAndComposeFor refuses. Shared state, not about the target.
        ambiguous: !!getState()?.ambiguous,
    };
}

// Every write starts and resumes here. Across an await the picker may move the target
// or the entry may be pruned, so writes pass the avatar they started on and re-read
// state. Unlike the quick panel's guard this never closes the screen.
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

// saveAndComposeFor answers every refusal with null; this tells the user which one,
// because a silent refusal is the failure this project exists to avoid.
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

// store.js always builds these containers, but a hand-edited settings.json may lack
// one, and a throw would take the whole screen down.
function ensureShape(persona) {
    if (!Array.isArray(persona.sections)) persona.sections = [];
    if (!persona.variants || typeof persona.variants !== 'object') persona.variants = {};
    if (!persona.activePicks || typeof persona.activePicks !== 'object') persona.activePicks = {};
    if (!Array.isArray(persona.versions)) persona.versions = [];
    return persona;
}

/* Writes */

// detail is shown to the user, so it carries names, never ids. kind is null when the
// helper already logged (removeSection, deleteVariant, restore); write overrides what
// the kind implies. version-apply forces the write: with an outside edit pending,
// state.js leaves SillyTavern's text alone if the composition is unchanged.
function commit(kind, detail, expectedAvatar, { write } = {}) {
    const avatar = expectedAvatar ?? targetAvatar;
    // Read before the save, logged only after it: a refused write has nothing to record.
    const persona = getPersona(getRoot(), avatar);
    const result = saveAndComposeFor(avatar, {
        write: write ?? !KEEP_DESCRIPTION_KINDS.has(kind),
        force: kind === 'version-apply',
    });
    if (!result) { notify('error', refusalMessage(avatar)); scheduleDraw(); return false; }
    if (persona) {
        if (kind) addLog(persona, kind, detail, Date.now());
        // writeDescription already saved, so this line needs a save of its own.
        freshContext()?.saveSettingsDebounced?.();
    }
    if (result.keptOutside) notify('warning', STRINGS.common.outsideKept(result.keptOutside.section));
    // Only the stored copy was written (see state.js); the prompt keeps the old text
    // until the persona is selected again.
    if (result.activeUnknown && !result.kept) notify('warning', STRINGS.common.savedActiveUnknown);
    // No PERSONA_UPDATED fires for a kept description, so the icon and an open quick
    // panel hear about it from here.
    if (result.kept) document.dispatchEvent(new CustomEvent('pm:changed'));
    // Empty sections: the banner names them permanently; the toast fires only when the
    // set changes, so a section left empty on purpose does not toast on every tap.
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
    const { sectionId, variantId } = appendSection(persona, { name: name.trim() }, freshContext()?.uuidv4, '', Date.now());
    pickInEveryVersion(persona, sectionId, variantId);
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
    const section = (after.persona.sections ?? []).find(entry => entry.id === sectionId);
    if (!section) { notify('error', STRINGS.manager.itemGone); scheduleDraw(); return; }
    section.name = name.trim();
    commit('section-rename', name.trim(), startAvatar);
}

function shiftSection(sectionId, delta) {
    const s = guardTarget();
    if (!s) return;
    const name = (s.persona.sections ?? []).find(entry => entry.id === sectionId)?.name ?? '';
    if (!moveSection(s.persona, sectionId, delta)) return;
    commit('section-move', name, s.avatar);
}

async function dropSection(sectionId, name) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    // Checked before the question, so a confirmation never ends in a refusal.
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
    // The history tab may be on one of the removed bodies.
    if (gone.variantIds.includes(historyVariant)) { historyVariant = null; historyIndex = null; }
    // Drafts of removed bodies would be unreachable text until teardown.
    for (const variantId of gone.variantIds) takeDraft(startAvatar, sectionId, variantId);
    commit(null, gone.name, startAvatar);
}

/* Writes: variants */

function pickVariant(sectionId, variantId) {
    const s = guardTarget();
    if (!s) return;
    // The native Android picker stays open across a redraw, so a change event can come
    // from a detached select; it is dropped silently.
    if (!pickApplicable(s.persona, sectionId, variantId)) return;
    s.persona.activePicks = { ...(s.persona.activePicks ?? {}), [sectionId]: variantId };
    const section = (s.persona.sections ?? []).find(entry => entry?.id === sectionId);
    const variant = (s.persona.variants?.[sectionId] ?? []).find(entry => entry?.id === variantId);
    commit('pick', `${section?.name ?? ''}: ${variant?.label ?? ''}`, s.avatar);
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
    // Text only: inherited history would offer to restore text the copy never had.
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
    takeDraft(startAvatar, sectionId, variantId);
    if (historyVariant === variantId) { historyVariant = null; historyIndex = null; }
    // The pick moved without a tap, so say so (deleteVariant logs it too).
    if (result.movedTo) notify('info', STRINGS.manager.pickMovedToFirst);
    commit(null, result.label, startAvatar);
}

// snapshot(), clearing historyIndex when the per-variant cap drops from the front:
// the index is a position, so it would silently point at a different snapshot.
// Answers whether a snapshot was kept (none is when the history count is 0).
function snapshotKeepingIndex(persona, variantId, previous, now, settings, options) {
    const first = persona.history?.[variantId]?.[0];
    const kept = snapshot(persona, variantId, previous, now, settings, options);
    if (historyVariant === variantId && persona.history?.[variantId]?.[0] !== first) historyIndex = null;
    return kept;
}

// Applies the history caps after snapshots are written; any trim clears historyIndex.
function trimHistory(root, settings, now) {
    if (expireOldHistory(root, settings, now) + enforceGlobalBudget(root, settings, now)) historyIndex = null;
}

// The one path that writes a variant body; the old text goes into history first.
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
    snapshotKeepingIndex(s.persona, variantId, previous, now, s.settings);
    variant.text = text;
    variant.updatedAt = now;
    // The per-variant cap does not bound the total in settings.json, and a snapshot is
    // the only moment the total grows.
    trimHistory(s.root, s.settings, now);
    editorDirty = false;
    // A leftover draft would be restored over the saved text on next open.
    takeDraft(startAvatar, sectionId, variantId);
    commit('variant-edit', variant.label ?? '', startAvatar);
}

/* Writes: versions */

async function applyVersion(versionId) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!versionApplicable(s.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    // Checked so a repeat tap over an outside edit is not skipped as already applied
    // (the write itself keeps the outside text as a choice).
    const ctx = freshContext();
    const diverged = ctx ? hasDiverged(ctx, s.avatar, s.persona) : false;
    // A repeat tap on the applied version writes nothing and queues no second upload.
    if (!diverged && versionAlreadyApplied(s.persona, versionId) && pictureSettled(s.persona, versionId)) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // A matching avatar is not enough: the persona's data may have changed meanwhile.
    if (!versionApplicable(after.persona, versionId)) {
        notify('error', STRINGS.common.versionNotApplicable);
        return;
    }
    const version = findVersion(after.persona, versionId);
    // A refused write did not apply the version, so the picture must not follow: it would
    // mismatch the prompt and use up the one backup taken before the first overwrite.
    if (!applyVersionPicks(after.persona, version, () => commit('version-apply', version.name ?? '', startAvatar))) return;
    // Not awaited: a version whose picture fails to move is still applied.
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
    const version = addVersion(ensureShape(after.persona), name.trim(), freshContext()?.uuidv4, Date.now());
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
    const version = renameVersionIn(after.persona, versionId, name, Date.now());
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-rename', version.name, startAvatar);
}

function duplicateVersion(versionId) {
    versionToolAt = Date.now();
    const s = guardTarget();
    if (!s) return;
    const persona = ensureShape(s.persona);
    const uuid = freshContext()?.uuidv4;
    const copy = duplicateVersionIn(persona, versionId, uuid, Date.now());
    if (!copy) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-duplicate', copy.name, s.avatar);
}

// After a duplicate or move the row under the finger is another version's, so its
// apply button ignores taps this long (TOOL_SETTLE_MS in quickbar.js).
const VERSION_TOOL_SETTLE_MS = 500;
let versionToolAt = 0;

// List order only; no prompt reads it.
function shiftVersion(versionId, delta) {
    versionToolAt = Date.now();
    const s = guardTarget();
    if (!s) return;
    const version = findVersion(s.persona, versionId);
    if (!moveVersion(s.persona, versionId, delta)) return;
    commit('version-move', version?.name ?? '', s.avatar);
}

// Rewrites a version's picks from the live ones. Nothing is snapshotted: history
// covers variant text, and a version holds none.
async function overwriteVersion(versionId, name) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!(await askConfirm(STRINGS.manager.confirmOverwriteVersion(name)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const version = overwriteVersionPicks(after.persona, versionId, Date.now());
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-overwrite', version.name ?? '', startAvatar);
}

// Fills one slot of a version in place, e.g. a dead slot shown as empty.
function setVersionPick(versionId, sectionId, variantId) {
    const s = guardTarget();
    if (!s) return;
    // The same stray-event check pickVariant makes, for the same reason.
    if (!pickApplicable(s.persona, sectionId, variantId)) return;
    const version = findVersion(s.persona, versionId);
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
    if (!dropVersionFrom(after.persona, versionId)) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    commit('version-delete', name, startAvatar);
}

/* Writes: history */

async function restoreSnapshot(variantId, index) {
    // The selection may have been cleared since the draw; restore() would throw on null.
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
        // An eviction may have trimmed the list while the question was up.
        notify('error', STRINGS.manager.snapshotGone);
        historyIndex = null;
        scheduleDraw();
        return;
    }
    // Restoring snapshots the current text, so the caps apply; the selection clears
    // either way, as its snapshot is now the live text.
    expireOldHistory(after.root, after.settings, now);
    enforceGlobalBudget(after.root, after.settings, now);
    historyIndex = null;
    // The editor may be open on the restored body.
    if (openVariant?.variantId === variantId) { openVariant = null; editorDirty = false; }
    // And a draft would be restored over the restored text (as in saveVariantText).
    const found = findVariant(after.persona, variantId);
    if (found) takeDraft(startAvatar, found.section.id, variantId);
    commit(null, '', startAvatar);
}

/* Writes: assets */

async function loadAssets(avatar) {
    const root = getRoot();
    if (!root || !avatar) return;
    assetState = { avatar, list: [], error: null, loading: true };
    // resolveFolderKey stores nothing, so listing works for a persona not yet adopted;
    // claimFolderKey stores and is only used on upload, where the entry exists.
    const key = resolveFolderKey(root, avatar);
    try {
        const ctx = freshContext();
        if (!ctx) throw new Error(STRINGS.manager.noContext);
        const list = await listAssets(ctx, key);
        // The screen may have moved to another persona meanwhile; do not show these there.
        if (assetState.avatar !== avatar) return;
        assetState = { avatar, list, error: null, loading: false };
    } catch (e) {
        if (assetState.avatar !== avatar) return;
        // Shown, not swallowed, or the tab would merely look empty.
        assetState = { avatar, list: [], error: String(e?.message ?? e), loading: false };
    }
    scheduleDraw();
}

async function uploadAssets(files) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', refusalMessage(targetAvatar)); return; }
    const startAvatar = targetAvatar;
    // Claimed once for the whole batch; claiming needs the entry, which guardTarget proved.
    const key = claimFolderKey(s.root, startAvatar, () => freshContext()?.saveSettingsDebounced?.());
    let ok = 0;
    // Shared by this selection's files (see uploadAsset).
    const batch = {};
    for (const file of files) {
        try {
            const ctx = freshContext();
            if (!ctx) throw new Error(STRINGS.manager.noContext);
            await uploadAsset(ctx, key, file, batch);
            ok++;
        } catch (e) {
            // One toast per file: each failed for its own reason.
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
    // The question names the versions showing this file, since they lose their picture.
    // The listing is passed so 0.2.0's lowercased labels count too.
    const bound = versionsBindingAsset(s.persona, label, assetLabels());
    const boundIds = new Set(bound.map(version => version.id));
    const question = bound.length
        ? STRINGS.manager.confirmDropAssetBound(label, bound.length)
        : STRINGS.manager.confirmDropAsset(label);
    if (!(await askConfirm(question))) return;
    if (startAvatar !== targetAvatar) { notify('error', STRINGS.manager.targetMovedNotDeleted); return; }
    const root = getRoot();
    if (!root) { notify('error', refusalMessage(startAvatar)); return; }
    const key = resolveFolderKey(root, startAvatar);
    try {
        const ctx = freshContext();
        if (!ctx) throw new Error(STRINGS.manager.noContext);
        await deleteAsset(ctx, key, label);
        // A backup record naming a deleted file keeps the backup guard closed, and every
        // later overwrite would keep nothing.
        const persona = getPersona(root, startAvatar);
        if (persona?.avatarBackup?.label === label) persona.avatarBackup = null;
        // Bound versions keep naming the file, now exactly: a loose match would move on to
        // another file under the same server label (pose.png to pose-1.png).
        for (const version of persona?.versions ?? []) {
            if (!version || !boundIds.has(version.id)) continue;
            version.avatarAsset = label;
            version.avatarAssetExact = true;
        }
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

// Ours draws this tab; state.js's feeds {{persona_assets}} for the active persona and
// is refetched only when that is the same persona.
async function refreshAssetViews(avatar) {
    await loadAssets(avatar);
    if (getState()?.avatar !== avatar) return;
    await refreshAssets();
    // Again: the failure banner also reads state.js's listing, which arrived after
    // loadAssets drew.
    scheduleDraw();
    // index.js re-points chat pictures whose file was just replaced.
    document.dispatchEvent(new CustomEvent('pm:assets-changed'));
}

function toggleVersionAsset(versionId, filename) {
    const s = guardTarget();
    if (!s) return;
    const version = findVersion(s.persona, versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    // The full file list lets the selection express all files (see toggleAssetSelection).
    toggleAssetSelection(version, filename, assetLabels());
    version.updatedAt = Date.now();
    commit('asset-select', version.name ?? '', s.avatar);
}

/* Writes: labels */

// Label writes are not about the target persona, so they check rosterWritable instead
// of going through guardTarget.
// The label tab already disables its buttons by rosterWritable, but the state can
// turn under a handler waiting on a popup, so refusals still get named.
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

// Made empty: unlike the quick panel's, there is no row here to attach.
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
    // The group's own row carries its count and the attach/detach button.
    if (!redrawRows([rowKey('group', labelId)])) scheduleDraw();
}

/* Target selection */

async function selectTarget(avatar) {
    if (avatar === targetAvatar) { pickerOpen = false; scheduleDraw(); return; }
    // The revise and full-text working copies belong to the persona being left;
    // carried over, a save would write them onto the new one.
    if (!(await confirmDropWorking())) return;
    if (avatar === targetAvatar) { pickerOpen = false; scheduleDraw(); return; }
    resetFullText();
    placementOpen = false;
    namesOpen = false;
    personaOpen = false;
    resetRevise();
    // Search, filters and pages describe the persona being left.
    resetListUi();
    // Before the target moves, so the draft is stored under the persona being left.
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

// An entry is created only on request, never by viewing a persona. adoptFor seeds it
// from the existing description verbatim, or split by its titles (classify.js).
async function adoptTarget() {
    const avatar = targetAvatar;
    if (!avatar) return;
    if (!(await askConfirm(STRINGS.manager.confirmAdopt))) return;
    if (avatar !== targetAvatar) { notify('error', STRINGS.manager.targetMovedNotAdopted); return; }
    // adoptFor returns the existing record for a managed persona, whose items are not
    // a split.
    const existed = !!getPersona(getRoot(), avatar);
    const persona = adoptFor(avatar);
    if (!persona) { notify('error', refusalMessage(avatar)); return; }
    const count = existed ? 0 : itemsWithText(persona);
    if (count > 1) notify('success', STRINGS.common.adoptSplit(count));
    scheduleDraw();
}

/* Drafts */

// Read from the document, not a captured node: the tap's blur releases the deferred
// redraw, which can land before the click and detach the node the editor was built with.
function readEditorText() {
    const area = document.getElementById(PANEL_ID)?.querySelector('.pm-manager-editor-text');
    return area ? area.value : null;
}

// Every path that takes the editor off screen without saving stashes the text under
// its body; it comes back when that body is opened again.
function stashDraft() {
    if (!editorDirty || !openVariant || !targetAvatar) return;
    const text = readEditorText();
    if (text === null) return;
    // Typed and taken back: nothing to keep, and a kept draft would make the resplit
    // refuse over an edit no badge shows.
    const stored = getPersona(getRoot(), targetAvatar)?.variants?.[openVariant.sectionId]
        ?.find(variant => variant?.id === openVariant.variantId)?.text ?? '';
    if (text === stored) { takeDraft(targetAvatar, openVariant.sectionId, openVariant.variantId); return; }
    putDraft(targetAvatar, openVariant.sectionId, openVariant.variantId, text);
}

/* Content */

// reason explains a disabled button. actionsRow also draws it as text, because touch
// screens never show a title tooltip.
function actionButton(label, onClick, enabled, title, reason) {
    // Click only: acting on touchstart lets the synthesized click land on whatever the
    // redraw just put under the finger.
    const btn = button('pm-manager-btn', label, onClick, enabled);
    const tip = (!enabled && reason) ? reason : title;
    if (tip) { btn.title = tip; btn.setAttribute('aria-label', `${label}: ${tip}`); }
    if (!enabled && reason) btn.dataset.pmReason = reason;
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

function emptyOf(text) { return emptyBlock(text); }

/* Rows that keep their extra actions folded away */

// Why writes are blocked, in the write path's own wording so a control cannot
// promise what the guard would refuse. Empty when nothing blocks.
function writeReason(s) {
    if (!s) return STRINGS.manager.refusalNoRoot;
    if (s.readOnly) return STRINGS.manager.refusalReadOnly;
    if (s.ambiguous) return STRINGS.manager.refusalAmbiguous;
    if (s.listed === false) return STRINGS.manager.refusalUnknownPersona;
    return '';
}

/* Rows redrawn in place */

// Each row registers how to rebuild itself, so a toggle rebuilds only the rows it
// touches; a choice is rebuilt through its item. Anything else (a draw queued or
// held, a field being typed in, a row from replaced data) takes the full draw.
const rowNodes = new Map();

// The picker's thumbnails, reused across redraws (as thumbPool in quickbar.js). A full
// draw starts the pool afresh; a list-only repaint (a search keystroke) adds what its
// own container held to whatever the draw left.
const pickerThumbs = imagePool('img.pm-quickbar-rowimg, img.pm-quickbar-tileimg');

function registerRow(key, node, build, { persona = null, parent = null } = {}) {
    rowNodes.set(key, { node, build, persona, parent });
}

function redrawRows(keys) {
    if (drawTask.pending() || drawDeferred || gestureHeld || dragSectionId !== null) return false;
    const wanted = new Set();
    for (const key of keys) {
        if (key === null || key === undefined) continue;
        const entry = rowNodes.get(key);
        if (!entry) return false;
        wanted.add(entry.parent ?? key);
    }
    const entries = [];
    const persona = targetState()?.persona ?? null;
    for (const key of wanted) {
        const entry = rowNodes.get(key);
        if (!entry || !entry.node.isConnected) return false;
        if (entry.persona && entry.persona !== persona) return false;
        entries.push(entry);
    }
    const active = document.activeElement;
    if (active && isTextEntry(active) && entries.some(entry => entry.node.contains(active))) return false;
    // Outer rows first: an item holds its choices and rebuilds them with itself.
    entries.sort((a, b) => (a.node.contains(b.node) ? -1 : b.node.contains(a.node) ? 1 : 0));
    let refocus = null;
    for (const entry of entries) {
        if (!entry.node.isConnected) continue;
        const hadFocus = !!active && entry.node.contains(active);
        const old = entry.node;
        // build() registers the new node (and any rows inside it) under the same keys.
        const fresh = entry.build();
        old.replaceWith(fresh);
        if (hadFocus) refocus = fresh;
    }
    // The tapped button went with its row; the keyboard user lands on the new one.
    refocus?.querySelector('.pm-manager-rowname')?.focus?.({ preventScroll: true });
    return true;
}

function toggleExpanded(key) {
    const before = expandedRow;
    expandedRow = expandedRow === key ? null : key;
    if (!redrawRows([before, expandedRow])) scheduleDraw();
}

// A row's name, as the button that opens its other actions. Not a row-level handler:
// that would also fire for the row's primary action button. summary is an optional
// second line, ellipsised to one row.
function rowName(key, parts, summary) {
    const open = expandedRow === key;
    const btn = el('button', 'pm-manager-rowname');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const top = el('div', 'pm-manager-rowtop');
    for (const part of parts) top.append(part);
    btn.append(top);
    if (summary) btn.append(el('div', 'pm-manager-rowsummary', summary));
    btn.addEventListener('click', () => toggleExpanded(key));
    return btn;
}

function foldMark(open, onToggle) {
    const btn = actionButton('⋯', onToggle, true, STRINGS.common.more);
    btn.classList.add('pm-manager-more');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    return btn;
}

function moreButton(key) {
    return foldMark(expandedRow === key, () => toggleExpanded(key));
}

// A folding block above a tab's list, shaped like a row. Its open state is the tab's
// own boolean (see placementOpen), not expandedRow.
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

// One button per line, each disabled one's reason written under it (see actionButton).
function buttonStack(buttons, extraClass) {
    const box = el('div', `pm-manager-stack${extraClass ? ` ${extraClass}` : ''}`);
    for (const btn of buttons) {
        box.append(btn);
        const reason = btn.dataset?.pmReason;
        if (reason) box.append(el('div', 'pm-manager-hint pm-manager-hint-left', reason));
    }
    return box;
}

// The drawer under an open row. Destructive buttons go last in a block of their own
// (spaced in style.css), so a near miss cannot delete.
function expansionOf(buttons, dangerButtons) {
    const box = el('div', 'pm-manager-expand');
    if (buttons?.length) box.append(buttonStack(buttons));
    if (dangerButtons?.length) box.append(buttonStack(dangerButtons, 'pm-manager-danger'));
    return box;
}

function rowHead() {
    return el('div', 'pm-manager-rowhead');
}

function bannerOf(className, message) { return sharedBanner('pm-manager', className, message); }

// Fixed locale, as in strings.js: the browser default can put an English date beside
// Korean captions.
function formatTime(at) {
    if (!at) return '';
    try { return new Date(at).toLocaleString('ko-KR'); } catch { return String(at); }
}

// A native select, for the Android picker. A pick naming a deleted variant is shown as
// such; snapping to the first option would show a combination the prompt lacks.
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

// The unsaved draft worth a badge, or null: one that matches the stored text is not.
// The editor applies the same rule, so the badge and its discard button agree.
function pendingDraft(sectionId, variant) {
    const draft = peekDraft(targetAvatar, sectionId, variant.id);
    return (draft !== null && draft !== (variant.text ?? '')) ? draft : null;
}

// The body the editor is open on, or null if it was deleted meanwhile (the list
// comes back).
function openBody(persona) {
    if (!openVariant) return null;
    const section = (persona?.sections ?? []).find(entry => entry.id === openVariant.sectionId);
    if (!section) return null;
    const variant = (persona?.variants?.[section.id] ?? []).find(entry => entry.id === openVariant.variantId);
    return variant ? { section, variant } : null;
}

// The body editor, replacing the item list while open. No keydown handler on purpose:
// Enter inserts a newline, so a hangul IME commit cannot trigger anything.
function variantEditor(section, variant, writable, reason) {
    const sectionId = section.id;
    const box = el('div', 'pm-manager-editorscreen');
    box.append(el('div', 'pm-manager-editorhead',
        STRINGS.manager.editorHeading(section.name ?? '', variant.label ?? '')));
    const stored = variant.text ?? '';
    const draft = peekDraft(targetAvatar, sectionId, variant.id);
    // A draft equal to the stored text is dropped silently; it changes nothing.
    if (draft !== null && draft === stored) takeDraft(targetAvatar, sectionId, variant.id);
    const restored = draft !== null && draft !== stored;
    if (restored) {
        // Unsaved text again, so closing asks; derived from the draft, not kept separately.
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
    // Updated by sizeTimer rewriting this line, never by a redraw, which would pull the
    // field out mid IME composition.
    box.append(el('div', 'pm-manager-size pm-size-editor', sizeTextOf(area.value)));

    const buttons = [
        actionButton(STRINGS.common.save, () => {
            const text = readEditorText();
            if (text === null) return;
            saveVariantText(sectionId, variant.id, text);
        }, writable, '', reason),
    ];
    if (restored) {
        buttons.push(actionButton(STRINGS.manager.editorDiscard, () => {
            takeDraft(targetAvatar, sectionId, variant.id);
            editorDirty = false;
            scheduleDraw();
        }, true, STRINGS.manager.editorDiscardTitle));
    }
    buttons.push(actionButton(STRINGS.manager.editorBackToList, () => {
        stashDraft();
        // Reopen the edited item so the row the user came from is visible.
        if (openVariant) expandedRow = rowKey('section', openVariant.sectionId);
        openVariant = null;
        editorDirty = false;
        scheduleDraw();
    }, true, STRINGS.manager.editorCloseTitle));
    // Sticky is relative to the scroll container, .pm-scroll, which this screen is
    // drawn inside.
    const foot = el('div', 'pm-manager-editorfoot');
    foot.append(actionsRow(buttons));
    box.append(foot);
    return box;
}

// One choice: its name and the open-body action; the rest waits behind the row tap.
function variantRow(persona, section, variant, writable, reason) {
    const key = rowKey('choice', section.id, variant.id);
    const open = expandedRow === key;
    const row = el('div', `pm-manager-variantrow${open ? ' pm-manager-rowopen' : ''}`);
    const registered = node => {
        registerRow(key, node, () => variantRow(persona, section, variant, writable, reason),
            { persona, parent: rowKey('section', section.id) });
        return node;
    };
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
        // The editor about to be replaced keeps its typing.
        stashDraft();
        openVariant = { sectionId: section.id, variantId: variant.id };
        editorDirty = false;
        // The editor replaces the list, drawer and all.
        expandedRow = null;
        scheduleDraw();
    }, true));
    head.append(moreButton(key));
    row.append(head);
    if (!open) return registered(row);

    const last = (persona.variants?.[section.id] ?? []).length <= 1;
    row.append(expansionOf([
        actionButton(STRINGS.common.rename, () => renameVariant(section.id, variant.id, variant.label ?? ''), writable, '', reason),
        actionButton(STRINGS.common.duplicate, () => duplicateVariant(section.id, variant.id), writable, '', reason),
    ], [
        // A section keeps at least one variant: disabled rather than failing after the tap.
        actionButton(STRINGS.common.remove, () => dropVariant(section.id, variant.id, variant.label ?? ''), writable && !last,
            '', last ? STRINGS.manager.lastChoiceKept : reason),
    ]));
    return registered(row);
}

function sectionBlock(persona, section, index, writable, reason) {
    const key = rowKey('section', section.id);
    const open = expandedRow === key;
    const box = el('div', `pm-manager-section${open ? ' pm-manager-rowopen' : ''}`);
    const variants = persona.variants?.[section.id] ?? [];
    // A closed item shows only its name and live pick. Its choice rows appear when it or
    // one of its choices is open, or while searching, so a match is never hidden.
    const choiceOpen = variants.some(variant => expandedRow === rowKey('choice', section.id, variant.id));
    const searching = listUi.compose.open && listUi.compose.query.trim() !== '';
    const showChoices = open || choiceOpen || searching;

    const head = rowHead();
    // Its own span: only an element can take the ellipsis that keeps a long name from
    // pushing the buttons off screen.
    const headParts = [
        markedText('pm-manager-name', section.name ?? '', listUi.compose.open ? listUi.compose.query : ''),
        el('span', 'pm-manager-count', STRINGS.manager.choiceCount(variants.length)),
    ];
    // Unsaved typing marks its choice row, and a closed item hides that row, so
    // the mark moves up to the item.
    if (!showChoices && variants.some(variant => pendingDraft(section.id, variant) !== null)) {
        headParts.push(el('span', 'pm-manager-count', STRINGS.manager.pendingDraft));
    }
    head.append(rowName(key, headParts));
    head.append(dragHandle(section.id, writable, reason));
    head.append(moreButton(key));
    box.append(head);
    // Read by dropTargetAt. An id, not a position: a search filters the list, so a
    // rendered position is not an index into persona.sections.
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

    if (showChoices) {
        for (const variant of variants) box.append(variantRow(persona, section, variant, writable, reason));
        box.append(actionsRow([actionButton(STRINGS.manager.addChoice, () => addVariant(section.id), writable, '', reason)]));
    }
    registerRow(key, box, () => sectionBlock(persona, section, index, writable, reason), { persona });
    return box;
}

/* List search, filters and paging */

// The list whose search field the next draw focuses and scrolls to (the row can sit
// below the fold). A list key, so another tab's draw cannot take it; consumed once.
let focusSearch = null;

function listSearchButton(key) {
    const ui = listUi[key];
    const btn = button('pm-manager-btn', ui.open ? STRINGS.common.searchClose : STRINGS.common.search, () => {
        ui.open = !ui.open;
        if (!ui.open) { ui.query = ''; ui.lang = null; ui.tags = []; ui.page = 1; }
        else focusSearch = key;
        scheduleDraw();
    });
    btn.setAttribute('aria-pressed', ui.open ? 'true' : 'false');
    return btn;
}

// Typing repaints only the list container below, never this field, so an IME
// composition survives; full draws rebuild it from listUi.
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
    // Marked, not focused: the node is not in the document yet (see takeSearchFocus).
    if (focusSearch === key) input.dataset.pmFocus = '1';
    input.addEventListener('input', () => {
        ui.query = input.value;
        ui.page = 1;
        redrawManagerList(key);
    });
    row.append(input);
    return row;
}

// At the end of a draw, once the field has a size: focus it and bring it on screen.
function takeSearchFocus() {
    focusSearch = null;
    const panel = document.getElementById(PANEL_ID);
    const input = panel?.querySelector('input[data-pm-focus]');
    if (!input) return;
    delete input.dataset.pmFocus;
    // Centred: scrolled merely into view, it can end half hidden behind the sticky
    // header or footer.
    input.scrollIntoView?.({ block: 'center' });
    input.focus?.({ preventScroll: true });
}

// One rebuild per frame per list, since keystrokes outpace frames. Keyed, because two
// lists can be waiting at once.
const listTasks = new Map();

function redrawManagerList(key) {
    if (!listTasks.has(key)) listTasks.set(key, frameTask(() => redrawManagerListNow(key)));
    listTasks.get(key).schedule();
}

// A stale frame would make redrawManagerList skip that list on the next open.
function clearListFrames() {
    for (const task of listTasks.values()) task.cancel();
}

// Repaints one list container in place; a no-op when it is not on screen.
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
    else if (key === 'groups') fillGroupList(container, s);
}

// A version's language, judged from the text its own picks compose. Memoised: the
// versions tab asks it of every version on each search keystroke. The key holds
// version.updatedAt (picks changed) and stamp, modifiedAt(persona) (a body changed).
const languageMemo = new Map();

function versionLanguage(persona, version, stamp) {
    if (typeof stamp !== 'number') return detectLanguage(composePicked(persona, version?.picks).text);
    const key = `${version?.id}|${version?.updatedAt}|${stamp}`;
    if (languageMemo.has(key)) return languageMemo.get(key);
    // Bounded like search-pure's caches: an entry per version per edit grows all session.
    if (languageMemo.size > 500) languageMemo.clear();
    const answer = detectLanguage(composePicked(persona, version?.picks).text);
    languageMemo.set(key, answer);
    return answer;
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

// Filtering writes nothing, so a chip is always live; active is colour and aria-pressed.
function filterChip(label, active, onClick) {
    const chip = button(`pm-quickbar-chip${active ? ' pm-quickbar-chip-active' : ''}`, label, onClick);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    return chip;
}

// getOwner resolves the tag owner from a fresh persona at tap time.
function tagChipsRow(tags, writable, reason, kindLabel, getOwner) {
    const row = el('div', 'pm-quickbar-chips pm-tag-chips');
    for (const tag of tags) row.append(button('pm-quickbar-chip', tag, () => removeTagFrom(kindLabel, tag, getOwner), writable));
    row.append(actionButton(STRINGS.manager.tagAdd, () => addTagTo(kindLabel, getOwner), writable, '', reason));
    return row;
}

// Names match through rankOf's full ladder; bodies only by textContains, because the
// sparse and typo tiers match almost any long prose.
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

    const live = new Set();
    for (const section of persona.sections ?? []) {
        live.add(rowKey('section', section.id));
        for (const variant of persona.variants?.[section.id] ?? []) {
            live.add(rowKey('choice', section.id, variant.id));
        }
    }
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;

    if (!(persona.sections ?? []).length) { container.append(emptyOf(STRINGS.manager.noItems)); return; }

    const query = listUi.compose.open ? listUi.compose.query.trim() : '';
    let sections = persona.sections ?? [];
    if (query) sections = sections.filter(section => sectionMatchesQuery(persona, section, query));
    if (!sections.length) { container.append(emptyOf(STRINGS.common.searchNoHits)); return; }
    for (const section of sections) {
        // Index in the full list: the move arrows reorder the real array, not the filtered view.
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
    // Filled while the question was up: nothing to save.
    if (!added.length) { notify('info', STRINGS.manager.fillDefaultsNothing); scheduleDraw(); return; }
    if (commit(null, '', startAvatar)) notify('info', STRINGS.manager.fillDefaultsDone(added.length));
}

// Resplit by titles. Refused over unsaved typing: a stashed draft would be restored
// over its body on next open, putting the old whole text back on top of the split.
function hasUnsavedBody(avatar, persona) {
    if (editorDirty) return true;
    // The revise and full-text copies too: saved after the split, they would write the
    // pre-split text back as new choices.
    if (reviseDirtyCount() > 0 || fullDirtyCount() > 0) return true;
    // Same rule as pendingDraft.
    return (persona.sections ?? []).some(section =>
        (persona.variants?.[section?.id] ?? []).some(variant => {
            const draft = peekDraft(avatar, section.id, variant?.id);
            return draft !== null && draft !== (variant?.text ?? '');
        }));
}

async function doResplit() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (hasUnsavedBody(startAvatar, s.persona)) { notify('warning', STRINGS.manager.resplitDraft); return; }
    const plan = planResplit(s.persona);
    if (!plan) { notify('info', STRINGS.manager.resplitNothing); return; }
    if (!(await askConfirm(STRINGS.manager.confirmResplit(plan.targets, plan.created)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    if (hasUnsavedBody(startAvatar, after.persona)) { notify('warning', STRINGS.manager.resplitDraft); return; }
    const fresh = planResplit(ensureShape(after.persona));
    if (!fresh) { notify('info', STRINGS.manager.resplitNothing); scheduleDraw(); return; }
    const now = Date.now();
    const uuid = freshContext()?.uuidv4;
    let kept = false;
    const changed = applyResplit(after.persona, fresh, uuid, now, after.settings?.defaultHeadingFormat,
        (variantId, text) => { kept = snapshotKeepingIndex(after.persona, variantId, text, now, after.settings, { force: true }) || kept; });
    trimHistory(after.root, after.settings, now);
    if (commit('split-headings', STRINGS.manager.logDetails.resplit(changed.length), startAvatar)) {
        // Mention history only if a snapshot was kept (none is with a history count of 0).
        notify('success', kept ? STRINGS.manager.resplitDone(changed.length) : STRINGS.manager.resplitDoneNoHistory(changed.length));
    }
}

// Split by its own titles: for a managed persona whose whole text sits in one item
// (adopted before state.js seedDescription did this). Only when that item's live
// choice holds the only text, and composing the result gives the same text back.
function ownSplitSource(persona) {
    const holders = (persona.sections ?? []).filter(section =>
        (persona.variants?.[section.id] ?? []).some(variant => String(variant?.text ?? '').trim()));
    if (holders.length !== 1) return null;
    const section = holders[0];
    const live = liveVariant(persona, section);
    const others = (persona.variants?.[section.id] ?? []).filter(v => v !== live && String(v?.text ?? '').trim());
    if (!live || others.length) return null;
    return { section, variant: live };
}

async function doOwnSplit() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (hasUnsavedBody(startAvatar, s.persona)) { notify('warning', STRINGS.manager.resplitDraft); return; }
    const source = ownSplitSource(s.persona);
    if (!source) { notify('warning', STRINGS.manager.ownSplitNotOnly); return; }
    const body = source.variant.text;
    const own = splitOwnSections(body);
    if (!own) { notify('info', STRINGS.manager.ownSplitNothing); return; }
    const trial = structuredClone(s.persona);
    seedOwnSections(trial, own, freshContext()?.uuidv4);
    if (!sameText(compose(trial).text, body)) { notify('warning', STRINGS.manager.ownSplitNotExact); return; }
    const names = trial.sections.map(section => section.name).join(', ');
    if (!(await askConfirm(STRINGS.manager.confirmOwnSplit(trial.sections.length, names)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    if (hasUnsavedBody(startAvatar, after.persona)) { notify('warning', STRINGS.manager.resplitDraft); return; }
    const again = ownSplitSource(after.persona);
    if (!again || again.variant.text !== body) { notify('error', STRINGS.manager.ownSplitNotOnly); scheduleDraw(); return; }
    const persona = ensureShape(after.persona);
    const now = Date.now();
    const oldVariantId = again.variant.id;
    // Their history would linger under ids nothing can open, still counted against the cap.
    const replaced = Object.values(persona.variants).flatMap(list => (Array.isArray(list) ? list : []).map(variant => variant?.id));
    seedOwnSections(persona, own, freshContext()?.uuidv4, now);
    // The old body's history moves to the first new item, with the whole old body on
    // top, so history can put everything back.
    const firstId = persona.activePicks[persona.sections[0].id];
    const kept = Array.isArray(persona.history?.[oldVariantId]) ? persona.history[oldVariantId] : [];
    if (!persona.history) persona.history = {};
    for (const id of replaced) if (id && id !== firstId) delete persona.history[id];
    if (kept.length) persona.history[firstId] = kept;
    const snapped = snapshotKeepingIndex(persona, firstId, body, now, after.settings, { force: true });
    // The history tab may point at a choice that no longer exists.
    historyVariant = null;
    historyIndex = null;
    // Every saved version points at the new items; the old ones are gone.
    for (const version of persona.versions ?? []) {
        if (version && typeof version === 'object') version.picks = { ...persona.activePicks };
    }
    trimHistory(after.root, after.settings, now);
    openVariant = null;
    expandedRow = null;
    if (commit('split-own', names, startAvatar)) {
        notify('success', snapped || kept.length
            ? STRINGS.manager.ownSplitDone(persona.sections.length)
            : STRINGS.manager.ownSplitDoneNoHistory(persona.sections.length));
    }
}

/* Size. Tokens come from SillyTavern's own counter, whose name is unverified: the
   line omits tokens unless the probe answers a number. The probe result is a fact
   about the build, so it is kept for the session. */
let tokenProbe = null;

function tokenCounter() {
    const probeCtx = freshContext();
    if (typeof probeCtx?.getTokenCount !== 'function') return null;
    if (tokenProbe === null) {
        try {
            const probe = probeCtx.getTokenCount('a');
            tokenProbe = Number.isFinite(probe) && probe >= 0;
        } catch { tokenProbe = false; }
    }
    if (!tokenProbe) return null;
    // Optional: a call that stops answering drops the number, not the line.
    return text => freshContext()?.getTokenCount?.(text);
}

// One-slot memo keyed by the body (like diffPartsFor's): draws happen for reasons
// unrelated to the body, and each would re-run the tokenizer for the same line.
let sizeMemoText = null;
let sizeMemoLine = '';

function sizeTextOf(text) {
    const key = String(text ?? '');
    if (sizeMemoText === key) return sizeMemoLine;
    const size = countSize(key, tokenCounter());
    sizeMemoLine = size.tokens === null
        ? STRINGS.manager.sizeLine(size.chars, size.bytes)
        : STRINGS.manager.sizeLineTokens(size.chars, size.bytes, size.tokens);
    sizeMemoText = key;
    return sizeMemoLine;
}

// Trailing, and long enough that a sentence typed at speed costs one count of the
// whole body (see sizeTimer).
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

/* Full text: the whole description in prompt order, each body editable in place.
   Unlike the revise screen, which only adds choices and a version, it overwrites
   bodies, so each is snapshotted into history first. */

function resetFullText() {
    fullActive = false;
    fullView = 'items';
    fullBlocks = null;
    fullTexts = null;
    if (sizeTimer) { clearTimeout(sizeTimer); sizeTimer = 0; }
}

// Live fields into the working copies, before every draw and every read, so a
// rebuild never loses typing.
function harvestFullTexts() {
    if (!fullActive || !Array.isArray(fullTexts)) return;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    for (const area of panel.querySelectorAll('.pm-full-text')) {
        const index = Number(area.dataset.pmBlock);
        if (Number.isInteger(index) && index >= 0 && index < fullTexts.length) fullTexts[index] = area.value;
    }
}

// Bodies that leaving would discard, measured against what the screen opened with.
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
    // Empty items too: this is where they get written.
    const blocks = buildReplaceBlocks(s.persona, true);
    // Only when the persona has no items at all.
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
        const ok = await askOnce(STRINGS.manager.fullTextConfirmLeave(dirty));
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
    // The plan skips bodies that are no longer the ones the screen drew.
    const plan = planFullTextSave(s.persona, fullBlocks, fullTexts);
    if (plan.skipped.length) notify('warning', STRINGS.manager.fullTextSkipped(plan.skipped.join(', ')));
    if (!plan.writes.length) { notify('info', STRINGS.manager.nothingChanged); return; }
    const now = Date.now();
    for (const write of plan.writes) {
        const variant = (s.persona.variants?.[write.sectionId] ?? []).find(entry => entry.id === write.variantId);
        // Cannot happen right after planning; checked so a throw cannot take half a save.
        if (!variant) continue;
        snapshotKeepingIndex(s.persona, write.variantId, write.before, now, s.settings);
        variant.text = write.after;
        variant.updatedAt = now;
        addLog(s.persona, 'variant-edit', variant.label ?? '', now);
        takeDraft(startAvatar, write.sectionId, write.variantId);
    }
    trimHistory(s.root, s.settings, now);
    if (!commit(null, '', startAvatar)) return;
    notify('info', STRINGS.manager.fullTextSaved(plan.writes.length));
    // The written bodies become the new baseline, so the dirty count stops asking.
    // Each block keeps the choice it was drawn from: rebuilding from the persona would
    // re-point it at the choice active now and write typing into the wrong choice.
    const written = new Map(plan.writes.map(write => [write.variantId, write.after]));
    if (written.size) {
        fullBlocks = fullBlocks.map(block => (written.has(block.variantId)
            ? { ...block, text: written.get(block.variantId) }
            : block));
        fullTexts = fullBlocks.map((block, index) => (written.has(block.variantId)
            ? block.text
            : (fullTexts?.[index] ?? block.text)));
    }
}

// Each body under the heading it is printed with; without a heading the caption
// names the item and choice instead (a note says which is shown).
function fullTextScreen(s, writable, reason) {
    const wrap = el('div', 'pm-full');
    wrap.append(noteOf(STRINGS.manager.fullTextGuide));
    const persona = s.persona;
    const blocks = fullBlocks ?? [];
    const line = el('div', 'pm-manager-size pm-size-full', sizeTextOf(composeFrom(persona, blocks, fullTexts)));
    wrap.append(line);
    // The pressed view is filled (pm-manager-primary), as in the history tab's toggles.
    const toggles = el('div', 'pm-manager-actions');
    for (const [key, text] of [['items', STRINGS.manager.fullViewItems], ['raw', STRINGS.manager.fullViewRaw]]) {
        const active = fullView === key;
        const btn = button(`pm-manager-btn${active ? ' pm-manager-primary' : ''}`, text, () => {
            if (fullView === key) return;
            // The boxes leave the screen; their typing lives on in the working copies.
            harvestFullTexts();
            fullView = key;
            scheduleDraw();
        });
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        toggles.append(btn);
    }
    wrap.append(toggles);
    const format = persona.headingFormat;
    if (fullView === 'raw') {
        // The text a save would send now, headings included. Read only, since the joined
        // text cannot tell which item an edit belongs to.
        wrap.append(noteOf(STRINGS.manager.fullViewRawGuide));
        const { box, inner } = textBox('pm-full-raw');
        inner.textContent = composeFrom(persona, blocks, fullTexts) || STRINGS.manager.previewEmpty;
        wrap.append(box);
        const foot = el('div', 'pm-manager-editorfoot');
        foot.append(actionsRow([
            actionButton(STRINGS.manager.fullTextSave, () => saveFullText(), writable && fullDirtyCount() > 0, '',
                fullDirtyCount() > 0 ? reason : STRINGS.manager.nothingChanged),
            actionButton(STRINGS.manager.editorBackToList, () => leaveFullText(), true),
        ]));
        wrap.append(foot);
        return wrap;
    }
    if (headingLine(format, 'x', persona.headingTemplate)) wrap.append(noteOf(STRINGS.manager.fullTextHeadingNote));
    const untitled = new Set((persona.sections ?? []).filter(section => section?.untitled).map(section => section.id));
    blocks.forEach((block, index) => {
        const head = untitled.has(block.sectionId) ? '' : headingLine(format, block.sectionName, persona.headingTemplate);
        const variant = (persona.variants?.[block.sectionId] ?? []).find(entry => entry.id === block.variantId);
        const caption = head || STRINGS.manager.editorHeading(block.sectionName, variant?.label ?? '');
        wrap.append(el('div', `pm-revise-caption${head ? ' pm-full-heading' : ''}`, caption));
        const area = el('textarea', 'pm-full-text');
        area.dataset.pmBlock = String(index);
        const value = fullTexts?.[index] ?? block.text;
        area.value = value;
        // Sized to its content so the screen stays scannable.
        area.rows = Math.min(20, Math.max(4, value.split('\n').length + Math.floor(value.length / 44)));
        area.disabled = !writable;
        area.setAttribute('aria-label', STRINGS.manager.fullTextAria(block.sectionName));
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

/* Prompt placement: position, depth, role and lorebook on SillyTavern's persona
   descriptor. Position and role are SillyTavern enums, so no number is hardcoded:
   options come from its own selects, and with none readable the control says so. */
// The role select is persona_depth_role; persona_description_role was an early guess.
const PLACEMENT_SELECTS = Object.freeze({
    position: { ids: ['persona_description_position'], match: /position/i },
    role: { ids: ['persona_depth_role', 'persona_description_role'], match: /role/i },
});

// Only the option list: the select's value belongs to SillyTavern's selected persona,
// not necessarily this screen's target (readPlacement reads that).
function enumOptions(field) {
    // Cached per draw (enumCache): several controls ask, and the fallback below is a
    // document-wide query.
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
    // Fallback shape scan, so a renamed id in SillyTavern does not silently remove the control.
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
    // An unknown stored value is shown raw rather than given a guessed label.
    return found ? found.label : STRINGS.manager.placementRaw(value);
}

// Every placement write. Not commit(): these are SillyTavern's fields, so there is
// nothing to recompose and the description must not be rewritten.
function applyPlacement(patch, kind, detail) {
    const s = guardTarget();
    if (!s) return false;
    // The controls are already disabled in these states; this stops any path that gets
    // here anyway.
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return false; }
    const ctx = freshContext();
    if (!ctx) { notify('error', STRINGS.manager.noContext); return false; }
    // Also the active persona (not necessarily the target): SillyTavern's singular
    // prompt keys belong to it.
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
    const label = placementLabel(field, value);
    const head = field === 'position' ? STRINGS.manager.placementPosition : STRINGS.manager.placementRole;
    if (applyPlacement({ [field]: value }, 'placement', `${head}: ${label}`)) {
        notify('info', STRINGS.manager.placementSaved);
    }
}

// Read from SillyTavern's own depth input (max=9999) rather than hardcoded; no
// ceiling when the input cannot be found.
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

// The world info book names, if readable; every candidate is shape-checked. Null
// falls back to typing the name, which is what the field stores either way.
function worldNames() {
    const ctx = freshContext();
    for (const candidate of [ctx?.world_names, globalThis.world_names]) {
        if (!Array.isArray(candidate) || !candidate.length) continue;
        const names = candidate.filter(name => typeof name === 'string' && name.trim());
        if (names.length === candidate.length) return names;
    }
    // Usually neither exists; the names are the option text of SillyTavern's #world_info
    // and #world_editor_select. Rows without a value are placeholders.
    if (typeof document === 'undefined') return null;
    let best = null;
    for (const select of document.querySelectorAll('select[id*="world" i]')) {
        // Sort order and strategy selects share the prefix; the book list is the longest.
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

// Label, value and edit button on one line, for the placement fields that are not enums.
function valueRow(label, value, buttonLabel, onClick, enabled, reason) {
    // Tight, so a long lorebook name cannot push the button onto a line of its own.
    const row = el('div', 'pm-row pm-manager-valuerow pm-manager-tightrow');
    row.append(el('span', 'pm-manager-picklabel', label));
    row.append(el('span', 'pm-manager-value', value));
    row.append(actionButton(buttonLabel, onClick, enabled, '', reason));
    return row;
}

function enumRow(field, label, aria, current, writable) {
    const options = enumOptions(field);
    if (!options) {
        // No readable list: show the current value and say why it cannot be changed.
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
    // An unknown stored value keeps its own entry rather than snapping to the first,
    // as in pickSelect.
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
    // The reason once for the block: value rows do not draw it, and a title is never
    // seen on a touch screen.
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* Names per language. They live on our record only: SillyTavern identifies personas
   by its personas map, so writing there renames the persona everywhere. */
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

// Applying renames the persona in SillyTavern (its personas map, plus name1 for the
// chat). A button, never automatic on a language guess: the roster, the chat lock and
// other extensions identify a persona by that name.
async function applyLocalName(lang, toChat) {
    const name = localName(guardTarget()?.persona, lang, '');
    if (!name) { notify('info', STRINGS.manager.localNameNone); return; }
    await applyNameWithScope(name, toChat, `${STRINGS.common.languageNames[lang] ?? lang}: ${name}`);
}

// The one rename write. toChat false writes only SillyTavern's personas map; true also
// re-selects the persona, carrying the name into name1 ({{user}} and the sender line
// of new messages). Past chat text is never rewritten.
async function applyNameWithScope(name, toChat, detail) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    // Whether the persona is active can change after the draw and across the await
    // below, so the scope is re-checked (rule at identifiedDirectly).
    const scopeIsLegal = () => {
        const isActive = (getState()?.avatar ?? null) === startAvatar;
        if (toChat && !isActive) { notify('error', STRINGS.manager.applyChatOnlyActive); scheduleDraw(); return false; }
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
    // A shared name makes the active persona unknowable and every write refuse.
    if (Object.entries(personas).some(([avatar, other]) => avatar !== startAvatar && other === name)) {
        notify('error', STRINGS.manager.localNameTaken);
        return;
    }
    // Chat scope only: a chat already using this name would end up with two of it.
    // Warned in the confirmation, not refused.
    const clash = toChat ? nameCollides({ name, characterName: ctx?.name2, chat: ctx?.chat }) : null;
    const question = !toChat
        ? STRINGS.manager.confirmApplyNameList(current, name)
        : (clash
            ? STRINGS.manager.confirmApplyNameClash(name, clash)
            : STRINGS.manager.confirmApplyNameChat(current, name));
    if (!(await askConfirm(question))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // guardTarget cannot tell whether this persona is still active; a switch during the
    // confirmation would let a chat rename end in switching personas.
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

// The same rename with a typed name instead of one from the language list.
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

/* The persona itself: name, picture, and new personas made from it. All three write
   SillyTavern's record rather than ours, so each asks first. */
// Name scopes: the list (SillyTavern's personas map) or the chat (also name1, so
// {{user}}). Chat needs the persona active, or it would switch to it. List-only on the
// active persona needs it identified directly: otherwise ctx.js matches
// personas[avatar] === name1, and a mismatch makes every write refuse.
function identifiedDirectly() {
    const source = getState()?.source;
    return source === 'precise' || source === 'dom';
}

function nameScopeButtons(name, writable, reason, onList, onChat) {
    const isActive = (getState()?.avatar ?? null) === targetAvatar;
    const has = !!name;
    const listAllowed = !isActive || identifiedDirectly();
    const list = actionButton(STRINGS.manager.applyToList, onList,
        writable && has && listAllowed, '',
        listAllowed ? reason : STRINGS.manager.applyListOnlyActive);
    const chat = actionButton(STRINGS.manager.applyToChat, onChat,
        writable && has && isActive, '', isActive ? reason : STRINGS.manager.applyChatOnlyActive);
    return [list, chat];
}

// The list and chat buttons in one box, so a wrapping row cannot split the pair.
function scopePair(buttons) {
    const box = el('div', 'pm-manager-namescope');
    for (const button of buttons) box.append(button);
    return box;
}

function personaBox(ctx, s, writable, reason) {
    const name = ctx?.powerUserSettings?.personas?.[s.avatar] ?? s.avatar ?? '';
    const box = foldBox('pm-manager-fold', STRINGS.manager.personaHead, name, personaOpen,
        () => { personaOpen = !personaOpen; scheduleDraw(); });
    if (!personaOpen) return box;

    const nameRow = el('div', 'pm-row pm-manager-valuerow pm-manager-tightrow');
    nameRow.append(el('span', 'pm-manager-picklabel', STRINGS.manager.renamePersona));
    nameRow.append(el('span', 'pm-manager-value', name));
    // Both ask for the new name first and differ only in reach; a disabled one shows why.
    nameRow.append(scopePair(nameScopeButtons(name, writable, reason,
        () => renameTargetPersona(false), () => renameTargetPersona(true))));
    box.append(nameRow);

    // The file input lives in the tree, like the asset uploader's, so it is disabled
    // along with everything else.
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
    // Restores the backup a bound version took; disabled with its own reason when none exists.
    const kept = s.persona?.avatarBackup?.label ?? null;
    imageRow.append(actionButton(STRINGS.manager.imageRestore, () => restoreTargetImage(), writable && !!kept,
        '', kept ? reason : STRINGS.manager.imageNoBackup));
    box.append(imageRow, input);
    // A picture picked for replacement is framed here before it is written.
    if (framing?.mode === 'upload' && framing.avatar === s.avatar) box.append(framingEditor(writable, reason));

    box.append(actionsRow([
        actionButton(STRINGS.manager.createPersona, () => createTargetPersona(), writable, '', reason),
        actionButton(STRINGS.manager.duplicatePersona, () => duplicateTargetPersona(), writable, '', reason),
        actionButton(STRINGS.manager.copyOpen, () => openCopyPicker(), writable, '', reason),
    ]));
    box.append(noteOf(STRINGS.manager.applyScopeHint));
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

// The same setting as the settings drawer's checkbox.
function toggleAutoName() {
    const root = getRoot();
    if (!root || root.readOnly) { notify('error', STRINGS.manager.refusalReadOnly); return; }
    root.settings.autoLocalName = !root.settings.autoLocalName;
    // Acts on the open chat now; off cancels anything already queued.
    if (root.settings.autoLocalName) scheduleAutoName();
    else cancelAutoName();
    freshContext()?.saveSettingsDebounced?.();
    // The settings drawer's checkbox syncs on this event.
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
    // The check marks the name in effect (SillyTavern's name for this persona), as in
    // quickbar.js namesGroup. Empty names never match, since all four languages are
    // listed here. Only our side is trimmed, as the panel does, so both screens agree.
    const appliedName = String(base ?? '');
    const isApplied = lang => {
        const name = String(stored[lang] ?? '').trim();
        return !!name && name === appliedName;
    };
    const current = conversationLanguage(freshContext());
    for (const lang of NAME_LANGUAGES) {
        const row = el('div', 'pm-row pm-manager-valuerow pm-manager-tightrow');
        row.append(checkMark(isApplied(lang)));
        // Language and name are one button that edits our record: a third button would not
        // fit, and a row role would nest the row's other buttons.
        const edit = el('button', 'pm-manager-rowname pm-manager-nameedit');
        edit.type = 'button';
        edit.disabled = !writable;
        edit.setAttribute('aria-label', STRINGS.manager.localNamePrompt(STRINGS.common.languageNames[lang] ?? lang));
        const top = el('div', 'pm-manager-rowtop');
        top.append(el('span', 'pm-manager-picklabel', STRINGS.common.languageNames[lang] ?? lang));
        top.append(el('span', 'pm-manager-value', stored[lang] || STRINGS.manager.placementUnset));
        edit.append(top);
        if (writable) edit.addEventListener('click', () => editLocalName(lang));
        row.append(edit);
        row.append(scopePair(nameScopeButtons(stored[lang], writable, reason,
            () => applyLocalName(lang, false), () => applyLocalName(lang, true))));
        box.append(row);
    }
    // Says what the language rows' check means, since the auto-apply row uses one too.
    box.append(noteOf(STRINGS.manager.localNameAppliedHint));
    // Always drawn: without it, an automatic rule that did not fire looks broken.
    box.append(noteOf(`${STRINGS.manager.localNameCurrent}: ${current
        ? (STRINGS.common.languageNames[current] ?? current)
        : STRINGS.manager.localNameNoChat}`));
    const auto = getRoot()?.settings?.autoLocalName === true;
    const autoRow = el('div', 'pm-row pm-manager-valuerow');
    // The state is a check mark: on/off words would be nominalised verbs, which the copy
    // rules (test/wording.test.mjs) refuse.
    autoRow.append(checkMark(auto));
    autoRow.append(el('span', 'pm-manager-picklabel', STRINGS.manager.autoNameRow));
    autoRow.append(el('span', 'pm-manager-value', ''));
    autoRow.append(actionButton(auto ? STRINGS.manager.autoNameTurnOff : STRINGS.manager.autoNameTurnOn,
        () => toggleAutoName(), writable, '', reason));
    box.append(autoRow);
    // Why the automatic rule is idle: its name is already someone else's in this chat.
    // A name already in force is skipped first, as pickAutoName does.
    const wanted = current ? String(stored[current] ?? '').trim() : '';
    const clash = (wanted && wanted !== appliedName)
        ? nameCollides({ name: wanted, characterName: ctx?.name2, chat: ctx?.chat })
        : null;
    if (clash) box.append(noteOf(STRINGS.manager.autoNameClashSkipped(wanted, clash)));
    box.append(noteOf(STRINGS.manager.autoNameHint));
    box.append(noteOf(STRINGS.manager.localNameEditHint));
    box.append(noteOf(STRINGS.manager.applyScopeHint));
    // One reason for the block, as in placementBox.
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* Persona image: SillyTavern's own avatar file, not one of our assets. */
// Puts back the picture kept before the first bound version overwrote the avatar. The
// record stays: a later apply must not back up the restored original a second time.
async function restoreTargetImage() {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const label = s.persona?.avatarBackup?.label;
    if (!label) { notify('info', STRINGS.manager.imageNoBackup); return; }
    if (!(await askConfirm(STRINGS.manager.confirmRestoreImage))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const root = getRoot();
    const ctx = freshContext();
    if (!root || !ctx) { notify('error', STRINGS.manager.noContext); return; }
    const result = await restoreAvatarBackup({ ctx, root, avatarId: startAvatar, label });
    if (result.ok) personaImageChanged(startAvatar);
    scheduleDraw();
    if (!result.ok) {
        if (result.error === 'missing') { notify('error', STRINGS.manager.imageAssetMissing(result.detail)); return; }
        notify('error', STRINGS.manager.imageApplyFailed(result.detail ?? result.error));
        return;
    }
    // The avatar no longer shows any bound label, so the skip-rewrite cache is cleared.
    const live = getPersona(getRoot(), startAvatar);
    if (live) {
        live.avatarWritten = null;
        addLog(live, 'image-restore', label, Date.now());
        freshContext()?.saveSettingsDebounced?.();
    }
    notify('info', STRINGS.manager.imageRestored);
}

// The picked file opens in the framing editor (the avatar's 2:3 frame) first. A file
// the browser cannot measure skips the editor and goes up whole after a confirmation.
async function changeTargetImage(file) {
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    // One upload at a time: a second editor would open while the first upload still
    // lands on the avatar.
    if (framingBusy) { notify('info', STRINGS.manager.framingUploading); return; }
    const startAvatar = targetAvatar;
    const size = await imageSize(file);
    if (!guardTarget(startAvatar)) return;
    if (!size) {
        const personas = freshContext()?.powerUserSettings?.personas ?? {};
        if (!(await askConfirm(STRINGS.manager.confirmChangeImage(personas[startAvatar] ?? startAvatar)))) return;
        if (!guardTarget(startAvatar)) return;
        await uploadTargetImage(startAvatar, file, null);
        return;
    }
    dropFraming();
    framing = {
        mode: 'upload',
        avatar: startAvatar,
        file,
        path: URL.createObjectURL(file),
        nw: size.width,
        nh: size.height,
        view: viewFromCrop(size.width, size.height, null),
    };
    personaOpen = true;
    scheduleDraw();
    revealFraming();
}

// crop is in pixels, as the endpoint takes it, or null for the whole picture.
async function uploadTargetImage(startAvatar, file, crop) {
    // avatarWritten caches which asset label is on the avatar, and applyBoundImage skips
    // writing a match. Cleared inside the write queue so a version apply queued behind
    // this upload sees it cleared.
    const result = await replacePersonaAvatar(freshContext(), startAvatar, file, crop, () => {
        const live = getPersona(getRoot(), startAvatar);
        if (live && live.avatarWritten !== null) {
            live.avatarWritten = null;
            freshContext()?.saveSettingsDebounced?.();
        }
    });
    if (result.ok) {
        personaImageChanged(startAvatar);
        notify('success', STRINGS.manager.changeImageDone);
        return true;
    }
    scheduleDraw();
    // Without that endpoint, hand the file to SillyTavern's own file input, whose crop
    // dialog finishes the job.
    if (result.status === 404) {
        const missing = feedPersonaImage(document, startAvatar, file);
        if (missing) { notify('error', STRINGS.manager.changeImageNoControl(missing)); return false; }
        notify('info', STRINGS.manager.changeImageHandedOver);
        return false;
    }
    notify('error', STRINGS.manager.changeImageFailed(result.detail ?? result.reason));
    return false;
}

/* Per-version persona image. The write lives in assets.js; a failed picture never
   rolls back the applied version, so each branch below reports and stops. */
// loadAssets sets the avatar before it awaits, so an in-flight listing names the right
// persona with an empty list; everything reading the list asks this first.
function listingReady(avatarId) {
    return assetState.avatar === avatarId && !assetState.error && !assetState.loading;
}

async function runBoundImage(avatarId, versionId, force) {
    // This screen's listing when ready, saving a round trip; null makes applyBoundImage
    // fetch its own.
    const known = listingReady(avatarId) ? assetState.list : null;
    const result = await runBoundImageWrite(avatarId, versionId, force, known);
    if (!result || result.skipped) return;
    // The shared writer redraws only the quick panel.
    scheduleDraw();
    if (result.ok) {
        if (result.unrecorded) { notify('warning', STRINGS.manager.imageAppliedUnrecorded); return; }
        if (result.backedUp) notify('info', STRINGS.manager.imageBackupMade);
        return;
    }
    if (result.error === 'listing') { notify('warning', STRINGS.manager.imageListingFailed(result.detail)); return; }
    if (result.error === 'missing') { notify('warning', STRINGS.manager.imageAssetMissing(result.detail)); return; }
    if (result.error === 'backup') { notify('error', STRINGS.manager.imageBackupFailed(result.detail)); return; }
    if (result.error === 'decode') { notify('error', STRINGS.manager.framingDecodeFailed(result.detail)); return; }
    notify('error', STRINGS.manager.imageApplyFailed(result.detail ?? result.error));
}

async function pickBoundAsset(versionId) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    if (!listingReady(startAvatar)) {
        if (!(assetState.avatar === startAvatar && assetState.loading)) await loadAssets(startAvatar);
        else { notify('info', STRINGS.manager.assetListLoading); return; }
        if (targetAvatar !== startAvatar) return;
    }
    if (assetState.error) { notify('warning', STRINGS.manager.imageListingFailed(assetState.error)); return; }
    const labels = assetLabels();
    if (!labels.length) { notify('info', STRINGS.manager.assetNoneForPersona); return; }
    const choice = await askChoice(STRINGS.manager.versionImagePick, labels);
    if (!choice) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    const version = findVersion(after.persona, versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    if (bindAsset(version, choice, Date.now())) commit('image-bind', `${version.name ?? ''} / ${choice}`, startAvatar);
}

function clearBoundAsset(versionId) {
    const s = guardTarget();
    if (!s) return;
    const version = findVersion(s.persona, versionId);
    if (!version) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    if (bindAsset(version, null, Date.now())) commit('image-bind', version.name ?? '', targetAvatar);
}

// The picture block on an open version row. expandedRow holds one key, so this draws
// at most one image.
function versionImageBlock(version, writable, reason) {
    const box = el('div', 'pm-manager-assetsel');
    const listingOk = listingReady(targetAvatar);
    const view = versionImageState(version, assetLabels(), listingOk);
    const framed = !!validCrop(version.avatarCrop);
    const head = view.state === 'none' ? STRINGS.manager.versionImageNone
        : view.state === 'ok' ? (framed ? STRINGS.manager.versionImageFramed(view.label) : view.label)
        : view.state === 'missing' ? STRINGS.manager.versionImageMissing(view.label)
        : STRINGS.manager.versionImageUnknown(view.label);
    box.append(el('div', 'pm-manager-picklabel', STRINGS.manager.versionImageHead));
    box.append(el('div', 'pm-manager-value', head));
    const editing = framing?.mode === 'version' && framing.avatar === targetAvatar
        && framing.versionId === version.id && framing.label === boundAsset(version);
    if (view.state === 'ok' && editing) {
        box.append(framingEditor(writable, reason));
        return box;
    }
    if (view.state === 'ok') {
        const path = findAsset(assetState.list, view.label)?.path;
        if (path) {
            const img = el('img', 'pm-manager-targetimg');
            // The sprite path serves the full-size file; the drawn size keeps the preview cheap.
            img.width = 96;
            img.height = 96;
            img.decoding = 'async';
            img.src = path;
            img.alt = '';
            img.loading = 'lazy';
            box.append(img);
        }
    }
    // Why the picture buttons are disabled. 'unknown' covers a failed listing as well as
    // a loading one, and a failure must not read as loading.
    const listingError = assetState.avatar === targetAvatar ? assetState.error : null;
    const deadReason = view.state === 'ok' ? reason
        : view.state === 'none' ? STRINGS.manager.versionImageNoBinding
            : view.state === 'missing' ? STRINGS.manager.versionImageMissing(view.label)
                : listingError ? STRINGS.manager.imageListingFailed(listingError)
                    : STRINGS.manager.assetListLoading;
    box.append(actionsRow([
        actionButton(STRINGS.manager.versionImagePickButton, () => pickBoundAsset(version.id), writable, '', reason),
        actionButton(STRINGS.manager.versionImageNow, () => runBoundImage(targetAvatar, version.id, true),
            writable && view.state === 'ok', '', deadReason),
        actionButton(STRINGS.manager.versionImageClear, () => clearBoundAsset(version.id),
            writable && view.state !== 'none', '', reason),
        actionButton(STRINGS.manager.versionImageFrame, () => openFraming(version.id),
            writable && view.state === 'ok', '', deadReason),
    ]));
    return box;
}

/* Framing editor. 'version' mode stores a crop on a version's bound asset; 'upload'
   mode writes a just-picked file to the avatar with it. The frame is the avatar's 2:3
   shape; the dashed square is what list and chat icons show. Module state, so a
   redraw rebuilds the editor where it was; dropFraming revokes the object URL. */
const FRAME_WIDTH = 240;
let framing = null;
// True while the editor's upload is in flight, so a second tap cannot send it twice.
let framingBusy = false;

function dropFraming() {
    if (framing?.mode === 'upload' && framing.path) {
        try { URL.revokeObjectURL(framing.path); } catch { /* already gone */ }
    }
    framing = null;
}

// The editor can open far from the tap, so it is scrolled into view once drawn.
function revealFraming() {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelector(`#${PANEL_ID} .pm-framing`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }));
}

function closeFraming() {
    dropFraming();
    gestureHeld = false;
    scheduleDraw();
}

function openFraming(versionId) {
    const s = guardTarget();
    if (!s) return;
    const version = findVersion(s.persona, versionId);
    const label = boundAsset(version);
    const path = findAsset(assetState.list, label, bindingIsExact(version))?.path;
    if (!version || !label || !path) { notify('error', STRINGS.manager.versionGone); scheduleDraw(); return; }
    const avatar = targetAvatar;
    // The crop is a fraction of the picture's size. The path carries the listing's
    // freshness token, so a file replaced under the same name is measured fresh.
    const probe = new Image();
    probe.onload = () => {
        if (targetAvatar !== avatar || !probe.naturalWidth) return;
        const nw = probe.naturalWidth;
        const nh = probe.naturalHeight;
        dropFraming();
        framing = { mode: 'version', avatar, versionId, label, path, nw, nh, view: viewFromCrop(nw, nh, version.avatarCrop) };
        scheduleDraw();
        revealFraming();
    };
    probe.onerror = () => notify('error', STRINGS.manager.framingLoadFailed);
    probe.src = path;
}

function framingEditor(writable, reason) {
    const state = framing;
    const box = el('div', 'pm-framing');
    if (state.mode === 'upload') box.append(el('div', 'pm-manager-picklabel', STRINGS.manager.framingUploadHead));
    const frame = el('div', 'pm-framing-frame');
    frame.style.width = `${FRAME_WIDTH}px`;
    const img = el('img', 'pm-framing-img');
    img.src = state.path;
    img.alt = '';
    img.draggable = false;
    const square = el('div', 'pm-framing-square');
    square.setAttribute('aria-hidden', 'true');
    frame.append(img, square);

    const zoom = el('input', 'pm-framing-zoom');
    zoom.type = 'range';
    zoom.min = '1';
    zoom.max = String(MAX_FRAMING_ZOOM);
    zoom.step = '0.01';
    zoom.setAttribute('aria-label', STRINGS.manager.framingZoom);

    let frameRequest = 0;
    const paint = () => {
        frameRequest = 0;
        const placed = previewBox(state.nw, state.nh, state.view, FRAME_WIDTH);
        if (!placed) return;
        img.style.width = `${placed.width}px`;
        img.style.height = `${placed.height}px`;
        img.style.transform = `translate(${placed.left}px, ${placed.top}px)`;
        // Written even while the slider has focus (a touched slider keeps it), or a wheel
        // zoom leaves it stale and the next nudge jumps.
        zoom.value = String(state.view.zoom);
    };
    // Pointer moves arrive faster than frames on a phone; one style write per frame.
    const schedulePaint = () => { if (!frameRequest) frameRequest = requestAnimationFrame(paint); };
    const setView = next => {
        state.view = clampView(state.nw, state.nh, next) ?? state.view;
        schedulePaint();
    };
    paint();

    zoom.addEventListener('input', () => setView({ ...state.view, zoom: Number(zoom.value) }));

    // One finger drags, two pinch, a wheel zooms. Moves become view changes in the
    // picture's own fractions, independent of the drawn frame size.
    const pointers = new Map();
    const spread = () => {
        const [a, b] = [...pointers.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const middle = () => {
        const all = [...pointers.values()];
        return { x: all.reduce((n, p) => n + p.x, 0) / all.length, y: all.reduce((n, p) => n + p.y, 0) / all.length };
    };
    let last = null;
    if (writable) {
        frame.addEventListener('pointerdown', e => {
            gestureHeld = true;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            // Keeps moves coming outside the frame. Throws for a pointer no longer down, which
            // must not drop the drag already recorded.
            try { frame.setPointerCapture?.(e.pointerId); } catch { /* moves still arrive inside the frame */ }
            last = { mid: middle(), spread: pointers.size > 1 ? spread() : 0 };
            e.preventDefault();
        });
        frame.addEventListener('pointermove', e => {
            if (!pointers.has(e.pointerId) || !last) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const mid = middle();
            const placed = previewBox(state.nw, state.nh, state.view, FRAME_WIDTH);
            if (!placed) return;
            const next = { ...state.view };
            // Picture pixels per screen pixel, so a finger moving 10px moves the
            // picture 10px under it at any zoom.
            next.cx -= (mid.x - last.mid.x) / placed.scale / state.nw;
            next.cy -= (mid.y - last.mid.y) / placed.scale / state.nh;
            if (pointers.size > 1) {
                const now = spread();
                if (last.spread > 0 && now > 0) next.zoom *= now / last.spread;
                last.spread = now;
            }
            last.mid = mid;
            setView(next);
        });
        const lift = e => {
            pointers.delete(e.pointerId);
            last = pointers.size ? { mid: middle(), spread: pointers.size > 1 ? spread() : 0 } : null;
            if (!pointers.size) { gestureHeld = false; releaseGestureDraw(); }
        };
        frame.addEventListener('pointerup', lift);
        frame.addEventListener('pointercancel', lift);
        // A frame taken out of the document loses its capture and hears no up.
        frame.addEventListener('lostpointercapture', lift);
        // The wheel zooms in proportion to deltaY (a mouse notch of 100 is about 20%),
        // since a touchpad sends many small deltas.
        frame.addEventListener('wheel', e => {
            e.preventDefault();
            setView({ ...state.view, zoom: state.view.zoom * Math.exp(-e.deltaY * 0.002) });
        }, { passive: false });
    } else {
        zoom.disabled = true;
    }

    box.append(frame, zoom);
    box.append(el('div', 'pm-manager-hint', STRINGS.manager.framingHint));
    box.append(el('div', 'pm-manager-hint', STRINGS.manager.framingGuide));
    const reset = actionButton(STRINGS.manager.framingReset, () => setView({ zoom: 1, cx: 0.5, cy: 0.5 }), writable, '', reason);
    // Not while uploading: closing does not stop the upload.
    const cancel = actionButton(STRINGS.common.cancel, () => closeFraming(), !framingBusy, '',
        framingBusy ? STRINGS.manager.framingUploading : '');
    if (state.mode === 'upload') {
        const busyReason = framingBusy ? STRINGS.manager.framingUploading : reason;
        box.append(actionsRow([
            actionButton(STRINGS.manager.framingApply, () => saveUploadFraming(true), writable && !framingBusy, '', busyReason),
            actionButton(STRINGS.manager.framingWhole, () => saveUploadFraming(false), writable && !framingBusy, '', busyReason),
            reset, cancel,
        ]));
    } else {
        box.append(actionsRow([
            actionButton(STRINGS.common.save, () => saveFraming(), writable, '', reason),
            reset, cancel,
        ]));
    }
    return box;
}

// Stores the crop on the version; rewrites the avatar now only if that version is active.
function saveFraming() {
    const state = framing;
    if (state?.mode !== 'version') return;
    const s = guardTarget(state.avatar);
    if (!s) return;
    const version = findVersion(s.persona, state.versionId);
    if (!version || boundAsset(version) !== state.label) { notify('error', STRINGS.manager.versionGone); closeFraming(); return; }
    version.avatarCrop = cropFromView(state.nw, state.nh, state.view);
    version.updatedAt = Date.now();
    dropFraming();
    if (!commit('image-crop', version.name ?? '', state.avatar)) return;
    if (s.persona.activeVersionId === version.id) void runBoundImage(state.avatar, version.id, false);
    else notify('info', STRINGS.manager.framingSavedLater);
}

// Uploads the picked file, cropped or whole. The editor stays open until the server
// answers, so a failure can be retried.
async function saveUploadFraming(cropped) {
    const state = framing;
    if (state?.mode !== 'upload' || framingBusy) return;
    if (!guardTarget(state.avatar)) return;
    const crop = cropped ? cropPixels(cropFromView(state.nw, state.nh, state.view), state.nw, state.nh) : null;
    framingBusy = true;
    scheduleDraw();
    let ok = false;
    try {
        ok = await uploadTargetImage(state.avatar, state.file, crop);
    } finally {
        framingBusy = false;
    }
    if (ok && framing === state) closeFraming();
    else scheduleDraw();
}

/* Duplicate as a new persona. SillyTavern owns persona creation and the command's
   arguments are unverified, so it runs and the result is found by diffing the
   personas map: exactly one new key is the copy, anything else is reported. */
const DUPLICATE_COMMANDS = Object.freeze(['persona-duplicate']);

// Built once: the picker sorts on every draw, and the locale cannot change in a session.
const PICKER_COLLATOR = new Intl.Collator(undefined, { numeric: true });

// The screen reset that duplicate, create and copy all end on.
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
    dropFraming();
    resetRevise();
    resetFullText();
    resetListUi();
}

// Runs the duplicate command and answers the one new personas key, or null after
// reporting why. The caller words the many-found message.
async function mintPersona(command, label, manyFoundMessage) {
    const before = new Set(Object.keys(freshContext()?.powerUserSettings?.personas ?? {}));
    try {
        await freshContext()?.executeSlashCommandsWithOptions(`/${command} ${quoteArg(label)}`);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] ${command} failed`, e);
    }
    // SillyTavern finishes after the command resolves, so the result is polled for.
    const added = [];
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
    if (!(await confirmDropWorking())) return;
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const commands = freshContext()?.SlashCommandParser?.commands;
    // Discovered, never assumed, as the persona switch does.
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
    // SillyTavern made the persona; the composition is ours, via the picker's copy.
    const copy = copyPersonaOnto(after.root, startAvatar, destAvatar,
        freshContext()?.uuidv4, Date.now(), STRINGS.manager.copyLogDetail(label));
    // A refusal is reported, not rolled back: the persona exists either way, but carries
    // SillyTavern's copied description. outside 'discard': that copy is not an outside
    // edit and would otherwise become a redundant choice.
    const composed = copy ? saveAndComposeFor(destAvatar, { outside: 'discard' }) : null;
    freshContext()?.saveSettingsDebounced?.();
    const newName = freshContext()?.powerUserSettings?.personas?.[destAvatar] ?? destAvatar;
    // Onto the copy, which the user will edit next.
    landOnPersona(destAvatar);
    if (copy && !composed) notify('warning', refusalMessage(destAvatar));
    else notify('info', STRINGS.manager.duplicateDone(newName));
    scheduleDraw();
}

/* New persona: minted by duplicating (no other creation path is known), then made
   new. The typed name goes on first, since saveAndComposeFor refuses while two
   personas share a name and the copy may carry its source's. Then a blank default
   composition replaces the copied description. The image stays inherited. */
async function createTargetPersona() {
    if (!(await confirmDropWorking())) return;
    const s = guardTarget();
    if (!s) return;
    if (s.readOnly || s.ambiguous) { notify('error', writeReason(s)); return; }
    const startAvatar = targetAvatar;
    const commands = freshContext()?.SlashCommandParser?.commands;
    const command = DUPLICATE_COMMANDS.find(name => commands && Object.hasOwn(commands, name) && commands[name]);
    if (!command) { notify('error', STRINGS.manager.createNoCommand); return; }
    const name = (await askText(STRINGS.manager.createNamePrompt, ''))?.trim();
    if (!name) return;
    // Checked before anything is minted: found later, the new persona would be stuck
    // under whatever name SillyTavern gave it.
    const taken = Object.values(freshContext()?.powerUserSettings?.personas ?? {}).includes(name);
    if (taken) { notify('error', STRINGS.manager.createNameTaken(name)); return; }
    if (!(await askConfirm(STRINGS.manager.confirmCreatePersona(name)))) return;
    if (!guardTarget(startAvatar)) return;
    const label = freshContext()?.powerUserSettings?.personas?.[startAvatar] ?? startAvatar;
    const destAvatar = await mintPersona(command, label, STRINGS.manager.createManyFound);
    if (!destAvatar) return;
    // List scope only. A refusal is not rolled back (no known deletion path); the toast
    // says which name the persona ended up with.
    const renamed = await applyPersonaName(destAvatar, name, { toChat: false });
    // Not guardTarget(startAvatar): the new persona exists, so it gets its blank
    // composition whatever happened to the source meanwhile.
    const root = getRoot();
    const seeded = !!root && !root.readOnly;
    let composed = null;
    if (seeded) {
        // The birth log line keeps the pruner off an entry whose variants are all empty.
        const persona = ensurePersona(root, destAvatar, freshContext()?.uuidv4);
        addLog(persona, 'persona-create', name, Date.now());
        // Overwrites the copied description with the empty composition; outside 'discard'
        // as in duplicateTargetPersona.
        composed = saveAndComposeFor(destAvatar, { outside: 'discard' });
    }
    freshContext()?.saveSettingsDebounced?.();
    landOnPersona(destAvatar);
    if (!seeded || !composed) {
        // The persona exists but still carries the copied description.
        notify('warning', refusalMessage(destAvatar));
    } else if (renamed?.ok) {
        notify('info', STRINGS.manager.createDone(name));
    } else {
        const stName = freshContext()?.powerUserSettings?.personas?.[destAvatar] ?? destAvatar;
        notify('warning', STRINGS.manager.createRenameFailed(stName));
    }
    scheduleDraw();
}

/* Copy onto a persona SillyTavern already lists: our record for it is replaced. The
   destination is chosen in the persona picker. */
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
    if (!(await confirmDropWorking())) return;
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
    // Kept to put the destination back if saveAndComposeFor refuses, rather than leave
    // its record replaced and its description not.
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
    landOnPersona(destAvatar);
    notify('info', STRINGS.manager.copyDone(toName));
    scheduleDraw();
}

function composeTab(s, writable, reason) {
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;

    if (fullActive) { box.append(fullTextScreen(s, writable, reason)); return box; }

    if (openVariant) {
        const body = openBody(persona);
        if (body) {
            box.append(variantEditor(body.section, body.variant, writable, reason));
            return box;
        }
        openVariant = null;
        editorDirty = false;
    }

    box.append(el('div', 'pm-manager-tagshead', STRINGS.manager.personaTagsHead));
    box.append(tagChipsRow(persona.tags ?? [], writable, reason, '', p => p));

    // Folded, so they do not push the item list off the first screen.
    const live = freshContext();
    box.append(personaBox(live, s, writable, reason));
    box.append(localNamesBox(live, s, writable, reason));

    // Here, not in the settings drawer: the value lives on the persona, and the drawer
    // only holds the default for new ones.
    box.append(headingFormatRow(persona, writable, reason));

    box.append(actionsRow([
        listSearchButton('compose'),
        actionButton(STRINGS.manager.fullTextOpen, () => openFullText(), true),
        actionButton(STRINGS.manager.fillDefaults, () => doFillDefaults(), writable, '', reason),
        actionButton(STRINGS.manager.resplit, () => doResplit(), writable, STRINGS.manager.resplitTitle, reason),
        actionButton(STRINGS.manager.ownSplit, () => doOwnSplit(), writable, STRINGS.manager.ownSplitTitle, reason),
    ]));
    if (listUi.compose.open) box.append(listSearchRow('compose'));

    const list = el('div');
    list.dataset.pmList = 'compose';
    fillComposeList(list, s, writable, reason);
    box.append(list);

    box.append(actionsRow([actionButton(STRINGS.manager.addItem, () => addSection(), writable, '', reason)]));
    box.append(placementBox(s, writable, reason));
    return box;
}

// Changing this rewrites the prompt, so it goes through commit.
function headingFormatRow(persona, writable, reason) {
    const row = el('div', 'pm-row pm-manager-headingrow');
    row.append(el('span', 'pm-manager-name', STRINGS.manager.headingFormatLabel));
    const select = el('select', 'pm-manager-select');
    // The description's own title style is offered only to a persona that has one.
    const own = validTemplate(persona.headingTemplate);
    const formats = own ? [...HEADING_FORMATS, 'own'] : [...HEADING_FORMATS];
    const formatName = key => (key === 'own'
        ? STRINGS.manager.headingFormatOwn(persona.headingTemplate.open)
        : STRINGS.manager.headingFormatNames[key]);
    for (const key of formats) {
        const option = el('option', null, formatName(key));
        option.value = key;
        select.append(option);
    }
    select.value = formats.includes(persona.headingFormat) ? persona.headingFormat : 'none';
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.manager.headingFormatAria);
    select.addEventListener('change', () => {
        const wanted = select.value;
        if (!formats.includes(wanted)) return;
        const after = guardTarget();
        if (!after) return;
        ensureShape(after.persona).headingFormat = wanted;
        commit('heading-format', formatName(wanted));
    });
    row.append(select);
    const box = el('div', 'pm-manager-headingbox');
    box.append(row);
    box.append(noteOf(STRINGS.manager.headingFormatHint));
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* Versions tab */

// Repairs a dead slot where it is reported. The no-pick option stays selected, so the
// control shows its real state rather than a choice nobody made.
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

// Name, combination summary and apply; details, repairs and other actions open below.
function versionRow(persona, version, writable, reason) {
    const key = rowKey('version', version.id);
    const open = expandedRow === key;
    const box = el('div', `pm-manager-version${open ? ' pm-manager-rowopen' : ''}`);
    registerRow(key, box, () => versionRow(persona, version, writable, reason), { persona });
    // Ends of the whole list, not the filtered page: a move is one place in stored order.
    const versions = persona.versions ?? [];
    const atTop = versions[0] === version;
    const atEnd = versions[versions.length - 1] === version;

    const head = rowHead();
    head.append(rowName(key, [
        checkMark(version.id === persona.activeVersionId),
        markedText('pm-manager-name', version.name ?? '', listUi.versions.open ? listUi.versions.query : ''),
    ], versionSummaryLine(persona, version)));
    // Picks naming something deleted would drop that section from the prompt, so apply
    // is disabled with a reason that points at the repair.
    const applicable = versionApplicable(persona, version.id);
    // A word, not a thumbnail, so a page of rows does not fetch a picture each.
    if (boundAsset(version)) head.append(el('span', 'pm-manager-value', STRINGS.manager.versionImageMark));
    head.append(actionsRow([
        actionButton(STRINGS.common.apply, () => {
            if (Date.now() - versionToolAt >= VERSION_TOOL_SETTLE_MS) applyVersion(version.id);
        }, writable && applicable,
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
    box.append(el('div', 'pm-manager-tagshead', STRINGS.manager.personaTagsHead));
    box.append(tagChipsRow(version.tags ?? [], writable, reason, version.name ?? '',
        p => findVersion(p, version.id)));
    box.append(expansionOf([
        actionButton(STRINGS.common.rename, () => renameVersion(version.id, version.name ?? ''), writable, '', reason),
        actionButton(STRINGS.common.duplicate, () => duplicateVersion(version.id), writable, '', reason),
        actionButton(STRINGS.manager.overwrite, () => overwriteVersion(version.id, version.name ?? ''), writable,
            STRINGS.manager.overwriteTitle, reason),
        actionButton(STRINGS.manager.moveUp, () => shiftVersion(version.id, -1), writable && !atTop, '', atTop ? '' : reason),
        actionButton(STRINGS.manager.moveDown, () => shiftVersion(version.id, 1), writable && !atEnd, '', atEnd ? '' : reason),
    ], [
        actionButton(STRINGS.common.remove, () => dropVersion(version.id, version.name ?? ''), writable, '', reason),
    ]));
    return box;
}

/* Revise as a new version */

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

// Unsaved revisions leaving would discard: applied steps, plus an open edit box that
// changed. The live field is read first: typing since the last draw exists nowhere else.
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
    const s = guardTarget();
    if (!s) return;
    const blocks = buildReplaceBlocks(s.persona);
    if (!blocks.length) { notify('info', STRINGS.manager.reviseNothing); return; }
    resetRevise();
    reviseActive = true;
    reviseBlocks = blocks;
    reviseTexts = blocks.map(block => block.text);
    expandedRow = null;
    scheduleDraw();
}

async function leaveRevise() {
    // The same one-question-at-a-time flag requestClose uses.
    if (closeAsked) return;
    const dirty = reviseDirtyCount();
    if (dirty > 0) {
        const ok = await askOnce(STRINGS.manager.reviseConfirmLeave(dirty));
        if (!ok || !document.getElementById(HOST_ID)) return;
    }
    resetRevise();
    scheduleDraw();
}

// A selection boundary as {block element, string offset}. Each block is one text
// node, but a drag to a block's edge can land on the element itself (browser
// dependent), where offset counts children: 0 is before the text, more is after.
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

// Absolute inside the position: relative .pm-revise, so it scrolls with the text;
// both rects are viewport based, so their difference is the offset in the wrapper.
function positionRevisePopup(rect) {
    const panel = document.getElementById(PANEL_ID);
    const wrap = panel?.querySelector('.pm-revise');
    const popup = panel?.querySelector('.pm-revise-popup');
    if (!wrap || !popup) return;
    popup.classList.remove('pm-hidden');
    const wrapRect = wrap.getBoundingClientRect();
    // Below the selection, since Android's selection toolbar sits above it; above only
    // when below would leave the wrapper.
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
        // One position write per frame: a handle drag fires this faster than paint. The
        // frame re-reads the live selection; if it died, the grace path below hides.
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
    // Hidden after a grace period: on Android, tapping the popup collapses the selection
    // first, and the click then acts on the stored offsets.
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
    // Clamped: a redraw since the selection can leave the offsets stale.
    const start = Math.max(0, Math.min(reviseSelection.start, text.length));
    const end = Math.max(start, Math.min(reviseSelection.end, text.length));
    if (start === end) return;
    reviseEditing = { block: reviseSelection.block, start, end, original: text.slice(start, end) };
    reviseSelection = null;
    // The box opens below the whole block, possibly a screen away, so the draw scrolls to it.
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
    // Unchanged text is a cancel, not a no-op step.
    if (input.value === original) { reviseEditing = null; scheduleDraw(); return; }
    const prev = reviseTexts[block];
    reviseTexts[block] = applyReplacement(prev, start, end, input.value);
    reviseSteps.push({ block, prevText: prev, from: original, to: input.value });
    reviseEditing = null;
    // The stored drag's offsets described the old text.
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
    const undo = replaceVersionUndo(persona);
    const result = makeReplaceVersion(persona, reviseBlocks, reviseTexts, name, freshContext()?.uuidv4, Date.now());
    if (!result) return;
    // Sections that vanished since opening are reported, never silently dropped.
    if (result.skipped.length) notify('warning', STRINGS.manager.reviseSkipped(result.skipped.join(', ')));
    // write: true, since the edited items' picks move to their new choices. Reset only
    // on an accepted write; a refusal keeps the working copies and undoes the version.
    if (commit('version-create', result.version.name, startAvatar, { write: true })) resetRevise();
    else undoReplaceVersion(persona, result, undo);
}

function reviseBox() {
    const box = el('div', 'pm-revise-box');
    const area = el('textarea', 'pm-revise-input');
    area.rows = 4;
    // typed first: a draw while the box was off screen parked the typing there.
    area.value = reviseEditing?.typed ?? reviseEditing?.original ?? '';
    area.setAttribute('aria-label', STRINGS.manager.reviseBoxAria);
    box.append(area);
    box.append(actionsRow([
        // Edits only the working copy; saveRevise is the guarded write.
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
    // Hidden until a selection positions it; the click acts on the stored offsets.
    wrap.append(button('pm-revise-popup pm-hidden', STRINGS.manager.revisePopup, () => openReviseBox()));
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
    if (!versions.length) { container.append(emptyOf(STRINGS.manager.noVersionsHere)); return; }

    const ui = listUi.versions;
    let list = versions;
    if (ui.open) {
        // Once per version per fill: the chips and the filter would otherwise compose each twice.
        const stamp = modifiedAt(persona);
        const langCache = new Map();
        const langOf = version => {
            if (!langCache.has(version.id)) langCache.set(version.id, versionLanguage(persona, version, stamp));
            return langCache.get(version.id);
        };
        // Chips from what the versions carry now. A filter naming something gone is dropped
        // rather than left to empty the list.
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
    // Bindings are described from the asset listing, which this tab must load itself.
    // loadAssets sets assetState.avatar before its await, so this fires once, not per frame.
    if (assetState.avatar !== targetAvatar && !assetState.loading && (persona.versions ?? []).length) {
        void loadAssets(targetAvatar);
    }
    for (const version of paged.slice) container.append(versionRow(persona, version, writable, reason));
    const pager = pagerRow(paged.page, paged.pages,
        () => { ui.page = Math.max(1, ui.page - 1); redrawManagerList('versions'); },
        () => { ui.page = ui.page + 1; redrawManagerList('versions'); });
    if (pager) container.append(pager);
}

function versionsTab(s, writable, reason) {
    // Revise state lives in module variables, so leaving the tab and coming back resumes it.
    if (reviseActive) return reviseScreen(writable, reason);
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;
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

// Clears the change log. Nothing is logged afterwards: the user asked for an empty
// list (the expiry rule's trace line is for records the extension drops itself).
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
    // Counted again: a save may have added lines while the question was up.
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
    // Grouped by section, since two sections can share a choice label. Counts only: no
    // preview from this call is rendered.
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

// The shell keeps the border and clips while the inner wrapper scrolls, so the
// scrollbar stays inside the rounded edge, as on the panel.
function textBox(extraClass) {
    const box = el('div', `pm-manager-text${extraClass ? ` ${extraClass}` : ''}`);
    const inner = el('div', 'pm-manager-textscroll');
    box.append(inner);
    return { box, inner };
}

// One-slot memo: diffWords' LCS table is costly on long bodies (see history.js), and
// every redraw would rebuild it. Keyed by the two bodies, which is all it depends on.
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
        // Unchanged runs stay plain text nodes; a span each would add hundreds of elements.
        if (part.type === 'del' || part.type === 'add') {
            inner.append(el('span', part.type === 'del' ? 'pm-diff-del' : 'pm-diff-add', part.text));
        } else {
            inner.append(document.createTextNode(part.text));
        }
    }
    if (!parts.truncated) return box;
    // Says when the diff fell back to lines or the whole text, which would otherwise
    // look like a body that really was replaced.
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
        // pm-manager-primary, not pm-manager-tab-active: a later button rule in style.css
        // resets that fill, and the pressed toggle's text vanished.
        const btn = button(`pm-manager-btn${active ? ' pm-manager-primary' : ''}`, label, () => { historyMode = key; scheduleDraw(); });
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
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
    box.append(noteOf(STRINGS.manager.historyRestoreNote));
    return box;
}

function historyTab(s, writable, reason) {
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;

    if (hasEvictionNotice(persona)) {
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
            // Picked out of historyView, so ordering and previews follow one rule.
            const entry = historyView(persona, null, historyVariant)
                .flatMap(group => group.variants)
                .find(item => item.variantId === historyVariant);
            for (const snap of entry?.snapshots ?? []) {
                const row = el('div', 'pm-row pm-manager-historyrow');
                row.append(el('span', 'pm-manager-historytime', formatTime(snap.at)));
                row.append(el('span', 'pm-manager-name', snap.preview));
                row.append(checkMark(historyIndex === snap.index));
                makeRowActivatable(row, () => {
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

    // The change log, newest first, capped on screen only (LOG_ROWS), not in storage.
    const logBox = el('div', 'pm-manager-logbox');
    const logHead = rowHead();
    logHead.append(el('div', 'pm-manager-head pm-manager-loghead', STRINGS.manager.logHead));
    const log = [...(persona.log ?? [])].reverse().slice(0, LOG_ROWS);
    logHead.append(actionButton(STRINGS.manager.logClear, () => clearLog(),
        writable && log.length > 0, '', log.length ? reason : ''));
    logBox.append(logHead);
    if (!log.length) logBox.append(noteOf(STRINGS.manager.logEmpty));
    for (const line of log) {
        const row = el('div', 'pm-manager-logrow');
        row.append(el('span', 'pm-manager-historytime', formatTime(line.at)));
        // Unknown kinds (a newer build's) show raw. Own properties only, so a kind like
        // 'constructor' from a hand-edited settings.json cannot hit an inherited member.
        row.append(el('span', 'pm-manager-logkind',
            Object.hasOwn(STRINGS.manager.logKinds, line.kind) ? STRINGS.manager.logKinds[line.kind] : String(line.kind ?? '')));
        row.append(el('span', 'pm-manager-name', previewText(line.detail, 30)));
        logBox.append(row);
    }
    box.append(logBox);
    return box;
}

/* Assets tab */

// The folder without our avatar backups, which share it. Every screen reads assets
// through here or assetLabels, so a backup is only reachable through image restore.
function visibleAssets() {
    return withoutBackups(assetState.list);
}

function assetLabels() {
    return visibleAssets().map(item => item.label);
}

function assetStyleClass() {
    const style = getRoot()?.settings?.assetStyle ?? 'plain';
    // Stripped because the style name comes from settings.json and goes into a class
    // attribute. (buildImgHtml strips after defaulting, so all-digit names differ.)
    return `pm-asset pm-asset-${String(style).replace(/[^a-z]/gi, '') || 'plain'}`;
}

// Insert, then close. The modal makes the send box inert, so the value is built from
// the caret it kept from before this screen opened, and focus waits until we close.
async function insertIntoSendBox(text) {
    const boxEl = document.getElementById('send_textarea');
    if (!boxEl) { notify('error', STRINGS.manager.sendBoxMissing); return; }
    if (!(await confirmDropWorking())) return;
    const next = insertAtCursor(boxEl.value, boxEl.selectionStart, boxEl.selectionEnd, text);
    boxEl.value = next.value;
    // Closed directly, not via requestClose: the editor's text is stashed, and the
    // working copies were asked about above.
    stashDraft();
    // No quick panel reopen: the user should land in the send box.
    closeManager(false);
    // Only now: focus on an inert element is dropped.
    try { boxEl.focus(); } catch { /* focus is best effort */ }
    if (typeof boxEl.setSelectionRange === 'function') {
        try { boxEl.setSelectionRange(next.caret, next.caret); } catch { /* best effort */ }
    }
    // SillyTavern's auto resize and draft keeping listen for input, which a scripted
    // value assignment does not fire.
    boxEl.dispatchEvent(new Event('input', { bubbles: true }));
    notify('success', STRINGS.manager.sendBoxInserted);
}

// styleClass comes from the caller: assetStyleClass goes through getRoot(), which
// runs migrate() over everything, so it is resolved once per repaint, not per row.
function assetRow(item, key, writable, reason, styleClass) {
    const rowId = rowKey('asset', item.label);
    const open = expandedRow === rowId;
    const row = el('div', `pm-manager-assetrow${open ? ' pm-manager-rowopen' : ''}`);
    registerRow(rowId, row, () => assetRow(item, key, writable, reason, styleClass));
    const head = rowHead();
    // An element rather than buildImgHtml's HTML string, which would need DOMPurify:
    // the path is assigned as a property, so there is nothing to sanitise.
    const img = el('img', styleClass);
    img.src = item.path;
    img.alt = '';
    img.loading = 'lazy';
    head.append(img);
    head.append(rowName(rowId, [markedText('pm-manager-name', item.label, listUi.assets.open ? listUi.assets.query : '')]));
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

// A version's asset selection. null means all files, so every box is ticked and
// unticking one materialises the list.
function versionAssetBlock(version, writable) {
    const box = el('div', 'pm-manager-assetsel');
    const labels = assetLabels();
    const all = !Array.isArray(version.assetSelection);
    box.append(el('div', 'pm-manager-picklabel',
        all ? STRINGS.manager.assetSelectionAll : STRINGS.manager.assetSelectionSome(version.assetSelection.length)));
    // The versions tab loads the listing, so only failure and loading are left to explain.
    if (assetState.avatar === targetAvatar && assetState.error) {
        box.append(noteOf(STRINGS.manager.imageListingFailed(assetState.error)));
        return box;
    }
    // Still loading is not an empty folder.
    if (assetState.avatar !== targetAvatar || assetState.loading) {
        box.append(noteOf(STRINGS.manager.assetLoading));
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
        checkbox.checked = assetSelected(version, label, labels);
        checkbox.disabled = !writable;
        checkbox.addEventListener('change', () => toggleVersionAsset(version.id, label));
        row.append(checkbox, el('span', 'pm-quickbar-labelname', label));
        box.append(row);
    }
    return box;
}

// Our button over a hidden file input: a phone draws a bare input as a second control
// with a label of the browser's choosing.
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
        // Cleared first so picking the same file again still fires change.
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

    // loadAssets sets its avatar before awaiting, so this fires once; a listing still in
    // flight for another persona then publishes nothing.
    if (assetState.avatar !== targetAvatar) {
        loadAssets(targetAvatar);
        box.append(noteOf(STRINGS.manager.assetLoading));
        return box;
    }
    if (assetState.loading) { box.append(noteOf(STRINGS.manager.assetLoading)); return box; }

    const shared = getState();
    const sharedError = (shared?.avatar === targetAvatar) ? shared.assetError : null;
    const error = assetState.error ?? sharedError;
    if (error) {
        box.append(bannerOf('pm-manager-warn', STRINGS.manager.assetListFailed(error)));
        // refreshAssetViews, not loadAssets: the error may come from state.js's listing,
        // which has to be retried too.
        box.append(actionsRow([actionButton(STRINGS.manager.assetRetry, () => refreshAssetViews(targetAvatar), true)]));
        return box;
    }

    const key = resolveFolderKey(s.root, targetAvatar);
    box.append(noteOf(STRINGS.manager.assetFolder(key)));
    if (!visibleAssets().length) box.append(emptyOf(STRINGS.manager.assetNone));
    box.append(uploadRow(writable, reason));
    if (visibleAssets().length) {
        box.append(actionsRow([listSearchButton('assets')]));
        if (listUi.assets.open) box.append(listSearchRow('assets'));
    }
    const list = el('div');
    list.dataset.pmList = 'assets';
    fillAssetList(list, s, writable, reason);
    box.append(list);
    box.append(actionsRow([actionButton(STRINGS.manager.assetRefresh, () => refreshAssetViews(targetAvatar), true)]));
    box.append(noteOf(STRINGS.manager.assetVersionNote));
    return box;
}

function fillAssetList(container, s, writable, reason) {
    container.replaceChildren();
    const live = new Set(visibleAssets().map(item => rowKey('asset', item.label)));
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;
    const folderKey = resolveFolderKey(s.root, targetAvatar);
    const ui = listUi.assets;
    // An empty listing hides the search controls, so it also resets the search.
    if (!visibleAssets().length) { Object.assign(ui, emptyListUi()); return; }
    let list = visibleAssets();
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

// Enter is guarded by isComposingKey, so a hangul IME commit cannot submit.
function newLabelRow(writable) {
    const row = el('div', 'pm-quickbar-newlabel');
    const input = el('input', 'pm-quickbar-newlabel-input');
    input.type = 'text';
    input.placeholder = STRINGS.manager.newGroupPlaceholder;
    input.disabled = !writable;
    input.setAttribute('aria-label', STRINGS.manager.newGroupAria);
    const submit = () => {
        if (!input.value.trim()) return;
        // addLabel only schedules the redraw, so this field is still the live one.
        if (!addLabel(input.value)) return;
        input.value = '';
        // Ends the typing session: the deferred redraw would otherwise wait for a blur that
        // never comes.
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

function labelsTab(s) {
    const box = el('div', 'pm-manager-tabbody');
    box.append(actionsRow([listSearchButton('groups')]));
    if (listUi.groups.open) box.append(listSearchRow('groups'));
    const list = el('div');
    list.dataset.pmList = 'groups';
    fillGroupList(list, s);
    box.append(list);
    box.append(newLabelRow(rosterWritable(getState())));
    return box;
}

function fillGroupList(container, s) {
    container.replaceChildren();
    // Gated by rosterWritable(getState()), exactly what the label handlers check: the
    // screen-wide flag reads getRoot() and can disagree, leaving live buttons that refuse.
    const writable = rosterWritable(getState());
    const labels = s.root?.labels ?? [];
    // Members whose persona SillyTavern no longer has are left out of groupRow's count
    // but never deleted: a persona removed by mistake is sometimes restored.
    const live = new Set(labels.map(label => rowKey('group', label.id)));
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;
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
    for (const label of list) container.append(groupRow(label, query, writable));
}

// One group row, rebuilt alone on open or membership change; the count is computed
// here so a rebuild never shows the count from before the tick.
function groupRow(label, query, writable) {
    const key = rowKey('group', label.id);
    const open = expandedRow === key;
    const block = el('div', `pm-manager-grouprow${open ? ' pm-manager-rowopen' : ''}`);
    registerRow(key, block, () => groupRow(label, query, writable));
    const known = freshContext()?.powerUserSettings?.personas ?? {};
    const count = (label.members ?? []).filter(id => Object.hasOwn(known, id)).length;
    const head = rowHead();
    head.append(rowName(key, [
        markedText('pm-manager-name', label.name ?? '', query),
        el('span', 'pm-manager-count', STRINGS.manager.groupMemberCount(count)),
    ]));
    const member = (label.members ?? []).includes(targetAvatar);
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
    return block;
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
    btn.append(el('span', 'pm-manager-caret', pickerOpen ? '▲' : '▼'));
    btn.title = STRINGS.manager.pickerTitle;
    btn.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false');
    btn.addEventListener('click', () => {
        // The picker replaces the whole body, editor included.
        stashDraft();
        pickerOpen = !pickerOpen;
        // Always target mode from this button: a leftover copy mode would make the next row
        // tap overwrite a persona.
        pickerMode = 'target';
        expandedRow = null;
        scheduleDraw();
    });
    return btn;
}

// The picker's view mode: its own setting (pickerViewMode), separate from the quick
// panel's.
function pickerViewSelect() {
    const select = el('select', 'pm-manager-select');
    for (const key of ['list', 'tiles', 'tilesNamed']) {
        const option = el('option', null, STRINGS.quick.viewNames[key]);
        option.value = key;
        select.append(option);
    }
    const stored = getRoot()?.settings?.pickerViewMode;
    select.value = ['tiles', 'tilesNamed'].includes(stored) ? stored : 'list';
    select.setAttribute('aria-label', STRINGS.quick.viewCaption);
    select.addEventListener('change', () => {
        // Refused on a read-only root rather than written and lost.
        const root = getRoot();
        if (!root || root.readOnly) { scheduleDraw(); return; }
        root.settings.pickerViewMode = select.value;
        freshContext()?.saveSettingsDebounced?.();
        scheduleDraw();
    });
    return select;
}

// The quick panel's tile markup and classes, without its select mode and switching.
function pickerTile(ctx, avatar, name, query, named) {
    const current = avatar === targetAvatar;
    const tile = el('button', `pm-quickbar-tile${named ? ' pm-quickbar-tile-named' : ''}${current ? ' pm-quickbar-tile-active' : ''}`);
    tile.type = 'button';
    tile.setAttribute('aria-label', name);
    if (current) tile.setAttribute('aria-current', 'true');
    const imgbox = el('div', 'pm-quickbar-tileimgbox');
    // The name also sits under the image, so a thumbnail that fails to load still shows it.
    imgbox.append(markedText('pm-quickbar-tilename', name, query));
    const url = thumbnailUrl(ctx, avatar);
    if (url) imgbox.append(pickerThumbs.take('pm-quickbar-tileimg', url));
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
    // Copy mode announces itself before the tap, with its own way out.
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
    pickerThumbs.harvest(container);
    container.replaceChildren();
    const personas = ctx?.powerUserSettings?.personas ?? {};
    let entries = Object.entries(personas);
    if (!entries.length) {
        container.append(noteOf(STRINGS.manager.personasUnavailable));
        return;
    }
    // The avatar id breaks ties so same-named personas keep their order between draws.
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
        // A chosen column count wins; otherwise the CSS auto fill decides.
        const columns = Number(root?.settings?.rosterTileColumns ?? 0);
        if (columns >= 2) grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
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
        if (url) row.append(pickerThumbs.take('pm-quickbar-rowimg', url));
        row.append(markedText('pm-manager-name', String(name ?? ''), query));
        // getPersona only reads: listing must not create entries.
        if (!getPersona(root, avatar)) row.append(el('span', 'pm-manager-count', STRINGS.manager.notAdoptedTag));
        row.append(checkMark(avatar === targetAvatar));
        makeRowActivatable(row, () => {
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

/* Drag to reorder items. Pointer events, since dragstart never fires for touch on
   Android Chromium. Armed by a handle only, so a scroll starting on a row is still a
   scroll. State is an id and numbers; every frame re-queries nodes by id. */
// A finger on the framing picture or a drag handle. A redraw would replace the node
// under it and kill the gesture, so draws wait for the finger, then run once.
let gestureHeld = false;
let drawWaitingOnGesture = false;

function releaseGestureDraw() {
    if (gestureHeld || dragSectionId !== null || !drawWaitingOnGesture) return;
    drawWaitingOnGesture = false;
    scheduleDraw();
}

let dragSectionId = null;
let dragOverSection = null;
let dragAutoScroll = 0;

// Also called on every teardown: a redraw destroys the capturing handle, which then
// never fires pointerup, leaving the drag armed, the auto-scroll running, and a later
// tap on any handle moving a section to the stale target.
function clearDragState() {
    dragSectionId = null;
    dragOverSection = null;
    if (dragAutoScroll) { cancelAnimationFrame(dragAutoScroll); dragAutoScroll = 0; }
    const host = document.getElementById(PANEL_ID);
    for (const node of host?.querySelectorAll('.pm-dragging, .pm-dragover, .pm-dragover-after') ?? []) {
        node.classList.remove('pm-dragging', 'pm-dragover', 'pm-dragover-after');
    }
    releaseGestureDraw();
}

// The row under the pointer, measured from row rects (the capture sends every move to
// the handle). Answers a section id, since a search filters the rendered rows, and
// after: true below the last row's midpoint, the only way to reach the end.
function dropTargetAt(clientY) {
    const host = document.getElementById(PANEL_ID);
    const rows = [...(host?.querySelectorAll('[data-pm-section]') ?? [])];
    if (!rows.length) return null;
    for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return { sectionId: row.dataset.pmSection ?? null, after: false };
    }
    return { sectionId: rows[rows.length - 1].dataset.pmSection ?? null, after: true };
}

// The rule is drawn on the edge the drop lands against: above the row, or below it
// for after.
function paintDragOver(target) {
    const host = document.getElementById(PANEL_ID);
    for (const row of host?.querySelectorAll('[data-pm-section]') ?? []) {
        const hit = dragSectionId !== null && !!target && row.dataset.pmSection === target.sectionId;
        row.classList.toggle('pm-dragover', hit && !target.after);
        row.classList.toggle('pm-dragover-after', hit && !!target.after);
    }
}

// Scrolls while the finger is near the scroller's edge. One geometry pass per frame,
// reads before writes; pointermove only records the finger, and the frame also
// tracks the target while the list scrolls under a still finger.
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
        disable(handle);
        if (reason) handle.dataset.pmReason = reason;
        return handle;
    }
    let lastY = 0;
    // Whether any pointermove fired: the frame loop finds a target even under a still
    // finger, so a plain tap would otherwise redraw the panel for nothing.
    let moved = false;
    handle.addEventListener('pointerdown', e => {
        // Left button or touch only; the capture keeps later moves on this handle.
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        // A tap fires no pointermove, so a stale target from an interrupted drag must go.
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
        // Only the finger position; startAutoScroll's frame does the layout work.
        moved = true;
        lastY = e.clientY;
    });
    const finish = () => {
        if (dragSectionId === null) return;
        const id = dragSectionId;
        // Measured at release: the frame loop's target can be a frame behind, or missing if
        // the release beats the first frame. A drag that never moved drops nothing.
        const onto = moved ? dropTargetAt(lastY) : null;
        clearDragState();
        if (onto) dropSectionAt(id, onto);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', () => clearDragState());
    // The capture is dropped when the node leaves the document, with no pointerup.
    handle.addEventListener('lostpointercapture', () => clearDragState());
    return handle;
}

function dropSectionAt(sectionId, target) {
    const after = guardTarget();
    if (!after) return;
    const persona = ensureShape(after.persona);
    // Indices resolved against the data now; a section deleted mid-drag has none and
    // nothing moves.
    const sections = persona.sections ?? [];
    const onto = sections.findIndex(sec => sec.id === target?.sectionId);
    const from = sections.findIndex(sec => sec.id === sectionId);
    // Dropping an item on itself is a tap that travelled a few pixels, not a move.
    if (onto === -1 || from === -1 || onto === from) { scheduleDraw(); return; }
    // reorderSection splices the item out first, shifting later indices down by one, so
    // a downward drag needs one less.
    const adjusted = onto > from ? onto - 1 : onto;
    const toIndex = target?.after ? adjusted + 1 : adjusted;
    if (!reorderSection(persona, sectionId, toIndex)) { scheduleDraw(); return; }
    const name = (persona.sections ?? []).find(sec => sec.id === sectionId)?.name ?? '';
    commit('section-move', name);
}

// The band under the tab strip: the tab's name, set large.
function bandRow(word) {
    const band = el('div', 'pm-band');
    band.append(el('span', 'pm-band-word', word));
    return band;
}

function headerRow(ctx) {
    // pm-mass draws the solid block and its drip edge with pseudo-elements (style.css),
    // so nothing operable lives in the decoration.
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
            stashDraft();
            // The picker covers the tab body, so a tab tap closes it, copy mode included.
            pickerOpen = false;
            pickerMode = 'target';
            managerTab = key;
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
    enumCache = null;
    applyShapeClass(panel);
    if (gestureHeld || dragSectionId !== null) { drawWaitingOnGesture = true; return; }
    drawWaitingOnGesture = false;
    rowNodes.clear();
    clearDragState();
    // Already waiting for a field to blur; a second listener would draw twice.
    if (drawDeferred) return;
    // Wait for the user to leave a focused field: rebuilding takes it out of the
    // document mid IME composition and loses a half-typed hangul syllable.
    const active = document.activeElement;
    if (active && panel.contains(active) && isTextEntry(active)) {
        drawDeferred = true;
        // Released after the blurring gesture ends (afterGesture): the blur comes on the
        // tap's mousedown, and a rebuild before its mouseup would swallow the click.
        active.addEventListener('blur', () => afterGesture(() => { drawDeferred = false; scheduleDraw(); }), { once: true });
        return;
    }

    // One read for the whole draw; drawing is synchronous and no handler keeps either.
    const ctx = freshContext();
    const s = targetState();

    // .pm-scroll scrolls inside the clipped panel. Emptying it clamps scrollTop to 0, so
    // the offset is saved and restored, as is editor typing: the draw a blur releases
    // would otherwise rebuild the textarea from the stored text.
    const oldScroll = panel.querySelector('.pm-scroll');
    // One offset per screen: the screen being left keeps its offset, and the one entered
    // gets its own, or the top.
    const screen = screenKey();
    if (lastScreen !== null && oldScroll) scrollByScreen.set(lastScreen, oldScroll.scrollTop);
    const scrollTop = screen === lastScreen ? (oldScroll?.scrollTop ?? 0) : (scrollByScreen.get(screen) ?? 0);
    lastScreen = screen;
    const editing = panel.querySelector('.pm-manager-editor-text');
    const typed = (editing && editorDirty)
        ? { value: editing.value, start: editing.selectionStart, end: editing.selectionEnd }
        : null;
    // The revise edit box too, for the same race.
    const reviseField = panel.querySelector('.pm-revise-input');
    const reviseTyped = reviseField
        ? { value: reviseField.value, start: reviseField.selectionStart, end: reviseField.selectionEnd }
        : null;
    // Also parked in module state: the restore below only bridges draws that both show
    // the box, and a draw without it (tab switch, picker) would lose the typing.
    if (reviseEditing && reviseField) reviseEditing.typed = reviseField.value;
    // Full-text typing is parked on the working copies, which the rebuild draws from.
    harvestFullTexts();

    // The scroll box itself is kept: a new one per draw would stop a fling dead.
    const keepScroll = !!oldScroll && oldScroll.parentNode === panel;
    pickerThumbs.clear();
    pickerThumbs.harvest(oldScroll);
    if (keepScroll) {
        for (const child of [...panel.children]) if (child !== oldScroll) child.remove();
        oldScroll.replaceChildren();
    } else {
        panel.replaceChildren();
    }
    // Header, tabs and band stay on top, outside .pm-scroll: as a sticky bar inside it,
    // content showed through the theme's translucent tint.
    const sticky = el('div', 'pm-manager-sticky');
    sticky.append(headerRow(ctx), tabsRow(), bandRow(STRINGS.manager.tabs[managerTab]));
    const scroll = keepScroll ? oldScroll : el('div', 'pm-scroll');
    if (keepScroll) panel.insertBefore(sticky, scroll);
    else panel.append(sticky, scroll);

    const body = el('div', 'pm-manager-body');
    scroll.append(body);

    if (pickerOpen) {
        body.append(personaPicker(ctx));
        if (scroll.scrollTop !== scrollTop) scroll.scrollTop = scrollTop;
        // Returns before the tail below, so the search focus is taken here too.
        if (focusSearch) takeSearchFocus();
        return;
    }

    if (!s) {
        body.append(noteOf(STRINGS.manager.stateUnread));
        return;
    }
    // readOnly means a newer build owns this data (ambiguous: see targetState); every
    // writing control is disabled, with the reason on screen.
    const writable = !s.ambiguous && !s.readOnly && s.listed !== false;
    const reason = writeReason(s);
    if (s.ambiguous) body.append(bannerOf('pm-manager-warn', STRINGS.manager.ambiguous));
    if (s.readOnly) body.append(bannerOf('pm-manager-warn', STRINGS.common.readOnly));

    if (!s.avatar) {
        body.append(noteOf(STRINGS.manager.pickPersonaHere));
        return;
    }
    if (!Object.hasOwn(ctx?.powerUserSettings?.personas ?? {}, s.avatar)) {
        body.append(bannerOf('pm-manager-warn', STRINGS.manager.personaGone));
    }

    // Labels are shared and read nothing of this persona, so the tab works before adoption.
    if (!s.persona && managerTab === 'labels') {
        // No heading: the tab strip and the band already name the tab.
        const group = el('div', 'pm-manager-group');
        group.append(el('div', 'pm-manager-tabdesc', STRINGS.manager.tabDescriptions.labels));
        group.append(labelsTab(s));
        body.append(group);
        if (scroll.scrollTop !== scrollTop) scroll.scrollTop = scrollTop;
        // Returns before the tail too.
        if (focusSearch) takeSearchFocus();
        return;
    }

    if (!s.persona) {
        body.append(noteOf(STRINGS.manager.notAdopted));
        body.append(actionsRow([actionButton(STRINGS.manager.adoptButton, () => adoptTarget(), writable, '', reason)]));
        return;
    }

    if (ctx && hasDiverged(ctx, s.avatar, s.persona)) {
        body.append(bannerOf('pm-manager-warn', STRINGS.manager.divergedBanner));
    }

    const missing = compose(s.persona).missing;
    if (missing.length) {
        body.append(bannerOf('pm-manager-warn', STRINGS.manager.missingBanner(missing.length, missing.join(', '))));
    }

    const group = el('div', 'pm-manager-group');
    group.append(el('div', 'pm-manager-tabdesc', STRINGS.manager.tabDescriptions[managerTab] ?? ''));
    if (managerTab === 'versions') group.append(versionsTab(s, writable, reason));
    else if (managerTab === 'history') group.append(historyTab(s, writable, reason));
    else if (managerTab === 'assets') group.append(assetsTab(s, writable, reason));
    else if (managerTab === 'labels') group.append(labelsTab(s));
    else group.append(composeTab(s, writable, reason));
    body.append(group);

    if (scroll.scrollTop !== scrollTop) scroll.scrollTop = scrollTop;
    // Focus is not restored: it would reopen the keyboard the user just closed.
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
    // First: the dispatch is synchronous and the quick panel reads this right after it.
    detail.handled = true;
    openManager(detail.tab);
    // The quick panel's search shortcut also asks for the search row. Set after
    // openManager, which resets listUi.
    if (detail.search && listUi[detail.tab]) {
        listUi[detail.tab].open = true;
        focusSearch = detail.tab;
        scheduleDraw();
    }
}

// Called by the settings screen after an import replaces the root. The listing and
// the drafts describe the old tree, and drafts would resurface old text over imported
// bodies that reuse ids. The modal hides the import button; the redraw is a safeguard.
export function invalidateManagerCaches() {
    assetState = { avatar: null, list: [], error: null, loading: false };
    // languageMemo is keyed on ids the imported tree can reuse.
    diffMemo = null;
    languageMemo.clear();
    clearDrafts();
    if (typeof document !== 'undefined' && document.getElementById(HOST_ID)) scheduleDraw();
}

export function mountManager() {
    if (mounted || typeof document === 'undefined') return;
    mounted = true;
    track(cleanups, document, 'pm:open-manager', onOpenRequest);
    // Redraws on every state change, since writability and the data can change under it
    // (the target itself does not follow the active persona).
    track(cleanups, document, 'pm:changed', () => {
        if (document.getElementById(HOST_ID)) scheduleDraw();
    });
}

export function unmountManager() {
    // Teardown: no quick panel reopen.
    closeManager(false);
    runCleanups(cleanups);
    clearDrafts();
    mounted = false;
    managerTab = 'compose';
    historyMode = 'diff';
}
