// The manager screen: items, choices, versions, history, assets and groups for one persona, opened
// by pm:open-manager (whose sender reads detail.handled); the pure half is manager-pure.js.
// Handlers outlive their draw, so none closes over a context, a getState() snapshot or a node.
// Writes go to targetAvatar through saveAndComposeFor, which writes SillyTavern's prompt field only
// for the live active persona, so a persona not being played can be edited.
import {
    MODULE_NAME, makeId, appendSection, getPersona, findVersion, findSection, findVariant, liveVariant, ensurePersona,
    HEADING_FORMATS, VIEW_MODES, pickInEveryVersion,
} from './store.js';
import {
    getState, getRoot, adoptFor, saveAndComposeFor, refreshAssets, KEEP_DESCRIPTION_KINDS, logFor,
} from './state.js';
import { freshContext, saveSettings } from './ctx.js';
import {
    compose, composePicked, composeFrom, hasDiverged, headingLine, validTemplate,
    readPlacement, writePlacement, splitFullText, fullTextSplittable, untitledIds,
} from './compose.js';
import { addLog, snapshot, capHistory, restore, diffWords } from './history.js';
import { toggleMember, modifiedAt } from './roster.js';
import { itemsWithText, planResplit, applyResplit, splitOwnSections, seedOwnSections, sameText } from './classify.js';
import {
    validCrop, clampView, cropFromView, viewFromCrop, previewBox, cropPixels, MAX_ZOOM as MAX_FRAMING_ZOOM,
} from './framing.js';
import {
    isTextEntry, pickApplicable, versionApplicable, versionAlreadyApplied, quoteArg, waitFor, nameCollides, rosterWritable,
    CREATE_WAIT_TURNS, conversationLanguage, pickPersonaCommand, NAME_LANGUAGES,
} from './quickbar-pure.js';
import {
    closePanel, openPanel, isPanelOpen, notify, askConfirm, askChoice, askText, askName,
    thumbnailUrl, markedText, pagerRow, applyShapeClass, listUi, searchRow, rankByQuery, filterChips,
    applyPersonaName, personaImageChanged, runBoundImageWrite, notifyBoundImageFailure, adoptModeRow,
    scheduleAutoName, cancelAutoName, releaseToasts, reportCommit, personaTileOf,
} from './quickbar.js';
import {
    el, track, runCleanups, blockDrawerClose, makeRowActivatable, checkMark, emptyBlock, bannerOf as sharedBanner,
    frameTask, button, disable, imagePool, selectOf, checkRow, newGroupRow, showHost, openHost, closeHost,
    trackViewport, typingHold, fieldSnapshot, restoreField, focusMarked, lazyImg, bandRow, debounced, viewportFit,
} from './dom.js';
import { rankOf, textContains, detectLanguage, pageOf } from './search-pure.js';
import {
    resolveFolderKey, claimFolderKey, listAssets, uploadAsset, deleteAsset, withoutBackups,
    replacePersonaAvatar, feedPersonaImage, restoreAvatarBackup, findAsset, imageSize, assetClass,
} from './assets.js';
import {
    canDeleteSection, removeSection, removeSections, moveSection, reorderSection, deleteVariant,
    renameLabel, deleteLabel, versionSummary, versionSummaryLine, NO_PICK_LABEL,
    putDraft, peekDraft, takeDraft, clearDrafts, rowKey,
    historyView, hasEvictionNotice, previewText,
    assetSelected, toggleAssetSelection, insertTagText, insertAtCursor,
    applyReplacement, buildReplaceBlocks, makeReplaceVersion, replaceVersionUndo, undoReplaceVersion,
    addTag, removeTag, missingDefaultSections, fillDefaultSections,
    planFullTextSave, readSelectOptions, parseDepth, copyPersonaOnto,
    setLocalName, localName, countSize,
    boundAsset, bindingIsExact, bindAsset, versionImageState, versionsBindingAsset, pictureSettled,
    renameVersionIn, duplicateVersionIn, overwriteVersionPicks, dropVersionFrom, moveVersion, addVersion,
    applyVersionPicks,
} from './manager-pure.js';
import { STRINGS } from './strings.js';

const HOST_ID = 'pm-manager-host';
const PANEL_ID = 'pm-manager-panel';

const TAB_KEYS = Object.freeze(['compose', 'versions', 'history', 'assets', 'labels']);

const LOG_ROWS = 50;

let mounted = false;
const cleanups = [];
const screenCleanups = [];
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

// The screen a draw shows, for scroll restore: the picker, or a persona's tab with the body
// editor, the revise screen or the full text open over it.
function screenKey() {
    if (pickerOpen) return 'picker';
    const over = openVariant ? ['editor', openVariant.sectionId, openVariant.variantId]
        : reviseActive ? ['revise'] : fullTexts ? ['fulltext'] : [];
    return JSON.stringify([targetAvatar, managerTab, ...over]);
}
const drawTask = frameTask(() => drawManager());
const drawHold = typingHold(scheduleDraw);
let pickerOpen = false;
// History tab selection: a variant id and an index in storage order, as restore() takes.
let historyVariant = null;
let historyIndex = null;
let historyMode = 'diff';
// The one row showing its other actions, as a rowKey string; cleared once that row is gone.
let expandedRow = null;
// The asset listing for targetAvatar (state.js keeps only the active persona's).
let assetState = { avatar: null, list: [], error: null, loading: false };
// The empty-item set already toasted (see reportCommit).
let lastMissing = null;
// Revise screen: reviseBlocks are the original blocks, reviseTexts the working copies. Each
// reviseSteps entry holds the block index and the whole previous string, so undo is one
// assignment. reviseSelection keeps the last drag as offsets, since tapping the popup
// collapses the selection before the click lands.
let reviseActive = false;
let reviseBlocks = null;
let reviseTexts = null;
let reviseSteps = [];
let reviseSelection = null;
let reviseEditing = null;
let revisePopupHide = 0;
let revisePopupFrame = 0;
let reviseScrollToBox = false;
// Full-text screen: fullBlocks pins each textarea to the body it was drawn from; fullTexts
// are working copies re-read from the fields on every draw.
let fullActive = false;
let fullBlocks = null;
let fullTexts = null;
// 'items': one box per item. 'raw': the composed text as SillyTavern receives it, editable
// in one box and divided back along its title lines (fullRaw: { text, start }).
let fullView = 'items';
let fullRaw = null;
// The working copies as they were before each clear (all or one item), newest last, for
// undo; kept across a save so a saved clear can still be taken back (and saved again).
let fullUndo = [];
// Item select mode on the compose tab: checkboxes on the rows, deleted together.
let itemSelecting = false;
let selectedItems = new Set();
// Folded blocks at the top of the compose tab.
let placementOpen = false;
let namesOpen = false;
let personaOpen = false;
// What a picker row tap does: 'target' moves this screen's target, 'copy' copies onto it.
let pickerMode = 'target';
// SillyTavern's position and role options, read off its selects; dropped at every draw.
let enumCache = null;
// Search state per searchable list, keyed by the containers' data-pm-list ids.
const lists = {
    picker: listUi(),
    compose: listUi(),
    versions: listUi(),
    assets: listUi(),
    groups: listUi(),
};
// What a list's open search asks for, as typed; '' while its search row is closed.
function listQuery(key) {
    return lists[key].open ? lists[key].query : '';
}

// In place: search and pager handlers hold these objects.
function resetLists() {
    for (const ui of Object.values(lists)) Object.assign(ui, listUi());
}
// Whether the quick panel was open when this screen opened; only then is it reopened on close.
let fromQuickPanel = false;

// Every redraw goes through here: at most one per frame, held while a field has focus.
function scheduleDraw() {
    drawTask.schedule();
}

/* Shell */

// The history tab's text boxes are capped from the same measure. The top offset is non-zero when
// the page is pinch zoomed or a focused field is panned into view.
const panelFit = viewportFit(PANEL_ID, (height, vv) => ({
    height: `${Math.round(height)}px`,
    '--pm-history-cap': `${Math.round(height * 0.4)}px`,
    top: `${Math.max(0, Math.round(vv?.offsetTop ?? 0))}px`,
}));

function openManager(tab) {
    const wanted = TAB_KEYS.includes(tab) ? tab : 'compose';
    if (document.getElementById(HOST_ID)) { managerTab = wanted; scheduleDraw(); return; }
    // Two modal dialogs would leave the user tapping the wrong one, so the panel closes.
    fromQuickPanel = isPanelOpen();
    closePanel();

    managerTab = wanted;
    // A new panel element carries none of the inline geometry the old one had.
    panelFit.forget();
    closeAsked = false;
    drawHold.held = false;
    historyMode = 'diff';
    pickerMode = 'target';
    moveTarget(getState()?.avatar ?? null);

    const panel = el('div', 'pm-panel pm-manager-panel pm-grain');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', STRINGS.manager.screenAria);
    blockDrawerClose(panel);

    // ESC and the Android back gesture ask about unsaved work first (requestClose).
    const host = openHost(HOST_ID, 'pm-manager-host', [panel], requestClose, screenCleanups);
    /* Chromium's close watcher lets a second back gesture close the dialog natively, so a close
       we did not start runs our teardown (a host left behind blocks reopening). quickbar.js
       dropHost's close, for a non-dialog SillyTavern popup, is not one. */
    host.addEventListener('close', () => {
        if (document.getElementById(HOST_ID) !== host) return;
        if (host.dataset.pmDropped === '1') return;
        // Working copies the draft store does not keep: reopen and ask first.
        if (hasWorkingCopies()) {
            showHost(host);
            void requestClose();
            return;
        }
        stashDraft();
        closeManager(false);
    });
    drawManager();
    panelFit.fit();
    trackViewport(screenCleanups, panelFit.schedule);
    // The revise screen's edit popup follows the selection, which has no per-node event.
    track(screenCleanups, document, 'selectionchange', onReviseSelectionChange);
}

// One close question at a time; the flag comes down even if the popup throws.
async function askOnce(message) {
    closeAsked = true;
    try { return await askConfirm(message); } finally { closeAsked = false; }
}

// askOnce, answering yes only if the screen is still open afterwards.
async function confirmOpen(message) {
    return (await askOnce(message)) && !!document.getElementById(HOST_ID);
}

// Asks, one question per dirty screen, before revise steps or full-text bodies are dropped.
// Answers whether to go on.
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
    // A picked replacement image not yet applied (closing does not stop an upload).
    if (framing?.mode === 'upload' && !framingBusy && !(await confirmOpen(STRINGS.manager.framingConfirmLeave))) return;
    const revising = reviseDirtyCount();
    const fullDirty = fullDirtyCount();
    if (editorDirty || revising > 0 || fullDirty > 0) {
        stashDraft();
        // The editor's text survives in the draft store; the working copies are asked about, the
        // current tab's first, and an editor alone gets the plain question.
        const asks = [[revising, STRINGS.manager.reviseConfirmLeave], [fullDirty, STRINGS.manager.fullTextConfirmLeave]]
            .filter(([count]) => count > 0);
        if (managerTab !== 'versions') asks.reverse();
        const questions = asks.length ? asks.map(([count, ask]) => ask(count)) : [STRINGS.manager.confirmCloseDirty];
        for (const question of questions) if (!(await confirmOpen(question))) return;
    }
    closeManager();
}

// Steps back to the quick panel when that is where the user came from, unless the panel is
// off or there is no persona.
function closeManager(reopenPanel = true) {
    const returnToPanel = reopenPanel && fromQuickPanel;
    fromQuickPanel = false;
    runCleanups(screenCleanups);
    // Before the host goes, which may hold SillyTavern's toast container.
    releaseToasts();
    closeHost(HOST_ID);
    // Unlike drafts, which survive a close on purpose, revise steps and full-text copies go
    // (requestClose has asked about them).
    moveTarget(null);
    closeAsked = false;
    lastScreen = null;
    scrollByScreen.clear();
    // Otherwise detached rows, thumbnails and their closures live until the next open.
    rowNodes.clear();
    pickerThumbs.clear();
    dropFraming();
    gestureHeld = false;
    drawWaitingOnGesture = false;
    drawHold.held = false;
    diffMemo = null;
    languageMemo.clear();
    clearDragState();
    assetState = { avatar: null, list: [], error: null, loading: false };
    pickerMode = 'target';
    focusSearch = null;
    clearListFrames();
    enumCache = null;
    // A stale frame would make the schedulers skip every later draw.
    drawTask.cancel();
    panelFit.cancel();

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
        // False once deleted in SillyTavern behind this screen.
        listed: !targetAvatar || Object.hasOwn(freshContext()?.powerUserSettings?.personas ?? {}, targetAvatar),
        // The active persona is unknowable, so saveAndComposeFor refuses (not about the target).
        ambiguous: !!getState()?.ambiguous,
    };
}

// Every write starts and resumes here. Across an await the target may move or the entry be pruned,
// so writes pass the avatar they started on. Unlike the quick panel's guard, this never closes the
// screen.
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

// Asks, then acts on the target as it stands after the answer, if the screen still edits the
// persona the question was about. A null or false answer cancels.
async function afterAsking(ask, act) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const answer = await ask(s);
    if (answer === null || answer === false) return;
    const after = guardTarget(startAvatar);
    if (after) return act(after, answer, startAvatar);
}

// An error the screen may now draw differently (a row gone, a refusal), so it redraws too.
function fail(message) {
    notify('error', message);
    scheduleDraw();
}

// Whether a write must stop because the data is read-only or the active persona unknowable.
function refusedWrite(s) {
    if (!s.readOnly && !s.ambiguous) return false;
    notify('error', writeReason(s));
    return true;
}

// saveAndComposeFor answers every refusal with null; this tells the user which one.
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

// The context an asset request needs, or a throw its caller reports.
function needContext() {
    const ctx = freshContext();
    if (!ctx) throw new Error(STRINGS.manager.noContext);
    return ctx;
}

// A hand-edited settings.json may lack a container, and a throw would take the screen down.
function ensureShape(persona) {
    if (!Array.isArray(persona.sections)) persona.sections = [];
    if (!persona.variants || typeof persona.variants !== 'object') persona.variants = {};
    if (!persona.activePicks || typeof persona.activePicks !== 'object') persona.activePicks = {};
    if (!Array.isArray(persona.versions)) persona.versions = [];
    return persona;
}

/* Writes */

// detail is shown to the user, so it carries names, never ids. kind is null when the helper already
// logged; write overrides what the kind implies; version-apply forces the write, as in the quick
// panel.
function commit(kind, detail, expectedAvatar, { write } = {}) {
    const avatar = expectedAvatar ?? targetAvatar;
    // Read before the save, logged only after it.
    const persona = getPersona(getRoot(), avatar);
    const result = saveAndComposeFor(avatar, {
        write: write ?? !KEEP_DESCRIPTION_KINDS.has(kind),
        force: kind === 'version-apply',
    });
    if (!result) { notify('error', refusalMessage(avatar)); scheduleDraw(); return false; }
    lastMissing = reportCommit(persona, kind, detail, result, lastMissing);
    scheduleDraw();
    return true;
}

/* Writes: sections */

function addSection() {
    return afterAsking(() => askName(STRINGS.manager.newItemName, ''), (after, name, startAvatar) => {
        const persona = ensureShape(after.persona);
        const { sectionId, variantId } = appendSection(persona, { name }, freshContext()?.uuidv4, '', Date.now());
        pickInEveryVersion(persona, sectionId, variantId);
        commit('section-add', name, startAvatar);
    });
}

function renameSection(sectionId, current) {
    return afterAsking(() => askName(STRINGS.manager.itemName, current), (after, name, startAvatar) => {
        const section = findSection(after.persona, sectionId);
        if (!section) { fail(STRINGS.manager.itemGone); return; }
        section.name = name;
        commit('section-rename', name, startAvatar);
    });
}

function shiftSection(sectionId, delta) {
    const s = guardTarget();
    if (!s) return;
    const name = findSection(s.persona, sectionId)?.name ?? '';
    if (!moveSection(s.persona, sectionId, delta)) return;
    commit('section-move', name, s.avatar);
}

function dropSection(sectionId, name) {
    return afterAsking(s => {
        // Checked before the question, so a confirmation never ends in a refusal.
        if (!canDeleteSection(s.persona, sectionId)) { notify('error', STRINGS.manager.lastItemKept); return false; }
        return askConfirm(STRINGS.manager.confirmDropItem(name));
    }, (after, _, startAvatar) => {
        const gone = removeSection(after.persona, sectionId, Date.now());
        if (!gone) { fail(STRINGS.manager.lastItemKept); return; }
        forgetSection(startAvatar, sectionId, gone.variantIds);
        commit(null, gone.name, startAvatar);
    });
}

// A removed item's editor, history selection and drafts (unreachable text until teardown).
function forgetSection(avatar, sectionId, variantIds) {
    if (openVariant?.sectionId === sectionId) { openVariant = null; editorDirty = false; }
    if (variantIds.includes(historyVariant)) { historyVariant = null; historyIndex = null; }
    for (const variantId of variantIds) takeDraft(avatar, sectionId, variantId);
}

function resetItemSelect() {
    itemSelecting = false;
    selectedItems = new Set();
}

function dropSelectedSections() {
    return afterAsking(s => {
        const ids = (s.persona.sections ?? []).filter(section => selectedItems.has(section.id)).map(section => section.id);
        if (!ids.length) { notify('info', STRINGS.manager.itemDropNothing); return false; }
        const all = ids.length === (s.persona.sections ?? []).length;
        return askConfirm(all ? STRINGS.manager.confirmDropAllItems(ids.length) : STRINGS.manager.confirmDropItems(ids.length));
    }, (after, _, startAvatar) => {
        const { gone } = removeSections(ensureShape(after.persona), [...selectedItems], freshContext()?.uuidv4, Date.now());
        if (!gone.length) { notify('info', STRINGS.manager.itemDropNothing); scheduleDraw(); return; }
        for (const item of gone) forgetSection(startAvatar, item.id, item.variantIds);
        resetItemSelect();
        if (commit(null, gone.map(item => item.name).join(', '), startAvatar)) notify('info', STRINGS.manager.itemsDropped(gone.length));
    });
}

function itemSelectButton() {
    const btn = button(`pm-manager-btn${itemSelecting ? ' pm-manager-primary' : ''}`, STRINGS.manager.itemSelect, () => {
        const wasOn = itemSelecting;
        resetItemSelect();
        itemSelecting = !wasOn;
        scheduleDraw();
    });
    btn.setAttribute('aria-pressed', itemSelecting ? 'true' : 'false');
    return btn;
}

// Above the list in select mode: select all or none, and delete the checked items.
function itemSelectActions(persona, writable, reason) {
    // While searching, select all means the items on screen.
    const query = listQuery('compose').trim();
    const ids = (persona.sections ?? []).filter(section => !query || sectionMatchesQuery(persona, section, query)).map(section => section.id);
    const allPicked = ids.length > 0 && ids.every(id => selectedItems.has(id));
    // Deletion takes every checked item, hidden by the search or not.
    const count = (persona.sections ?? []).filter(section => selectedItems.has(section.id)).length;
    return actionsRow([
        actionButton(allPicked ? STRINGS.manager.itemSelectNone : STRINGS.manager.itemSelectAll, () => {
            selectedItems = allPicked ? new Set() : new Set(ids);
            scheduleDraw();
        }, true),
        actionButton(STRINGS.manager.itemDropSelected(count), () => dropSelectedSections(), writable && count > 0, '',
            count > 0 ? reason : STRINGS.manager.itemDropNothing),
    ]);
}

/* Writes: variants */

function pickVariant(sectionId, variantId) {
    const s = guardTarget();
    if (!s) return;
    // The native Android picker stays open across a redraw, so a change can come from a
    // detached select; it is dropped silently.
    if (!pickApplicable(s.persona, sectionId, variantId)) return;
    s.persona.activePicks = { ...(s.persona.activePicks ?? {}), [sectionId]: variantId };
    const section = findSection(s.persona, sectionId);
    const variant = findVariant(s.persona, sectionId, variantId);
    commit('pick', `${section?.name ?? ''}: ${variant?.label ?? ''}`, s.avatar);
}

function addVariant(sectionId) {
    return afterAsking(() => askName(STRINGS.manager.newChoiceName, ''), (after, label, startAvatar) => {
        const persona = ensureShape(after.persona);
        if (!Array.isArray(persona.variants[sectionId])) { fail(STRINGS.manager.itemGone); return; }
        persona.variants[sectionId].push({ id: makeId(freshContext()?.uuidv4), label, text: '', updatedAt: Date.now() });
        commit('variant-add', label, startAvatar);
    });
}

function renameVariant(sectionId, variantId, current) {
    return afterAsking(() => askName(STRINGS.manager.choiceName, current), (after, label, startAvatar) => {
        const variant = findVariant(after.persona, sectionId, variantId);
        if (!variant) { fail(STRINGS.manager.choiceGone); return; }
        variant.label = label;
        commit('variant-rename', label, startAvatar);
    });
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

function dropVariant(sectionId, variantId, label) {
    return afterAsking(s => {
        if ((s.persona.variants?.[sectionId] ?? []).length <= 1) { notify('error', STRINGS.manager.lastChoiceKept); return false; }
        return askConfirm(STRINGS.manager.confirmDropChoice(label));
    }, (after, _, startAvatar) => {
        const result = deleteVariant(after.persona, sectionId, variantId, Date.now());
        if (!result) { fail(STRINGS.manager.choiceUndeletable); return; }
        if (openVariant?.variantId === variantId) { openVariant = null; editorDirty = false; }
        takeDraft(startAvatar, sectionId, variantId);
        if (historyVariant === variantId) { historyVariant = null; historyIndex = null; }
        // The pick moved without a tap, so say so.
        if (result.movedTo) notify('info', STRINGS.manager.pickMovedToFirst);
        commit(null, result.label, startAvatar);
    });
}

// snapshot(), clearing historyIndex when the per-variant cap drops from the front: the index
// is a position and would point at a different snapshot. Answers whether one was kept.
function snapshotKeepingIndex(persona, variantId, previous, now, settings, options) {
    const first = persona.history?.[variantId]?.[0];
    const kept = snapshot(persona, variantId, previous, now, settings, options);
    if (historyVariant === variantId && persona.history?.[variantId]?.[0] !== first) historyIndex = null;
    return kept;
}

// Applies the history caps after snapshots are written; any trim clears historyIndex.
function trimHistory(root, settings, now) {
    if (capHistory(root, settings, now)) historyIndex = null;
}

// The one path that writes a variant body; the old text goes into history first.
function saveVariantText(sectionId, variantId, text) {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const variant = findVariant(s.persona, sectionId, variantId);
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
    // A snapshot is the only moment the total grows, so the global caps apply here.
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
    // A repeat tap over an outside edit is not skipped as already applied.
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
    // The picture follows only an accepted write, as in the quick panel.
    if (!applyVersionPicks(after.persona, version, () => commit('version-apply', version.name ?? '', startAvatar))) return;
    // Not awaited: a version whose picture fails to move is still applied.
    void runBoundImage(startAvatar, versionId, false);
}

function saveAsVersion() {
    return afterAsking(() => askName(STRINGS.common.newVersionName, ''), (after, name, startAvatar) => {
        const version = addVersion(ensureShape(after.persona), name, freshContext()?.uuidv4, Date.now());
        commit('version-create', version.name, startAvatar);
    });
}

function renameVersion(versionId, current) {
    return afterAsking(() => askName(STRINGS.manager.versionName, current), (after, name, startAvatar) => {
        const version = renameVersionIn(after.persona, versionId, name, Date.now());
        if (!version) { fail(STRINGS.manager.versionGone); return; }
        commit('version-rename', version.name, startAvatar);
    });
}

function duplicateVersion(versionId) {
    versionToolAt = Date.now();
    const s = guardTarget();
    if (!s) return;
    const persona = ensureShape(s.persona);
    const uuid = freshContext()?.uuidv4;
    const copy = duplicateVersionIn(persona, versionId, uuid, Date.now());
    if (!copy) { fail(STRINGS.manager.versionGone); return; }
    commit('version-duplicate', copy.name, s.avatar);
}

// After a duplicate or move the row under the finger is another version's, so its apply
// button ignores taps this long (TOOL_SETTLE_MS in quickbar.js).
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

function overwriteVersion(versionId, name) {
    return afterAsking(() => askConfirm(STRINGS.manager.confirmOverwriteVersion(name)), (after, _, startAvatar) => {
        const version = overwriteVersionPicks(after.persona, versionId, Date.now());
        if (!version) { fail(STRINGS.manager.versionGone); return; }
        commit('version-overwrite', version.name ?? '', startAvatar);
    });
}

// Fills one slot of a version in place, e.g. a dead slot shown as empty.
function setVersionPick(versionId, sectionId, variantId) {
    const s = guardTarget();
    if (!s) return;
    // The same stray-event check pickVariant makes, for the same reason.
    if (!pickApplicable(s.persona, sectionId, variantId)) return;
    const version = findVersion(s.persona, versionId);
    if (!version) { fail(STRINGS.manager.versionGone); return; }
    version.picks = { ...(version.picks ?? {}), [sectionId]: variantId };
    version.updatedAt = Date.now();
    commit('version-repick', version.name ?? '', s.avatar);
}

function dropVersion(versionId, name) {
    return afterAsking(() => askConfirm(STRINGS.manager.confirmDropVersion(name)), (after, _, startAvatar) => {
        if (!dropVersionFrom(after.persona, versionId)) { fail(STRINGS.manager.versionGone); return; }
        commit('version-delete', name, startAvatar);
    });
}

/* Writes: history */

function restoreSnapshot(variantId, index) {
    // The selection may have been cleared since the draw; restore() would throw on null.
    if (!Number.isInteger(index)) return;
    return afterAsking(() => askConfirm(STRINGS.manager.confirmRestore), (after, _, startAvatar) => {
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
        // Restoring snapshots the current text, so the caps apply; the selection clears either
        // way, as its snapshot is now the live text.
        capHistory(after.root, after.settings, now);
        historyIndex = null;
        if (openVariant?.variantId === variantId) { openVariant = null; editorDirty = false; }
        // A draft would be restored over the restored text.
        const found = locateVariant(after.persona, variantId);
        if (found) takeDraft(startAvatar, found.section.id, variantId);
        commit(null, '', startAvatar);
    });
}

/* Writes: assets */

async function loadAssets(avatar) {
    const root = getRoot();
    if (!root || !avatar) return;
    assetState = { avatar, list: [], error: null, loading: true };
    // resolveFolderKey stores nothing, so listing works for a persona not yet adopted.
    const key = resolveFolderKey(root, avatar);
    try {
        const list = await listAssets(needContext(), key);
        // The screen may have moved to another persona meanwhile.
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
    if (!s || refusedWrite(s)) return;
    const startAvatar = targetAvatar;
    // Claimed once for the whole batch; guardTarget proved the entry exists.
    const key = claimFolderKey(s.root, startAvatar, saveSettings);
    let ok = 0;
    // Shared by this selection's files (see uploadAsset).
    const batch = {};
    for (const file of files) {
        try {
            await uploadAsset(needContext(), key, file, batch);
            ok++;
        } catch (e) {
            // One toast per file: each failed for its own reason.
            notify('error', STRINGS.manager.assetUploadFailed(file?.name ?? STRINGS.manager.assetFileFallback, String(e?.message ?? e)));
        }
    }
    if (ok) {
        logFor(startAvatar, 'asset-upload', STRINGS.manager.assetUploadedLog(ok));
        notify('success', STRINGS.manager.assetUploaded(ok));
    }
    await refreshAssetViews(startAvatar);
}

async function dropAsset(label) {
    const s = guardTarget();
    if (!s || refusedWrite(s)) return;
    const startAvatar = targetAvatar;
    // The question names the versions showing this file, old lowercased labels included.
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
        await deleteAsset(needContext(), key, label);
        // A backup record naming a deleted file would keep every later overwrite from backing up.
        const persona = getPersona(root, startAvatar);
        if (persona?.avatarBackup?.label === label) persona.avatarBackup = null;
        // Bound versions keep naming the file, now exactly, or a loose match would move on to
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
    logFor(startAvatar, 'asset-delete', label);
    await refreshAssetViews(startAvatar);
}

// Ours draws this tab; state.js's feeds the macros and is refetched only for the active persona.
async function refreshAssetViews(avatar) {
    await loadAssets(avatar);
    if (getState()?.avatar !== avatar) return;
    await refreshAssets();
    // Again: the failure banner also reads state.js's listing.
    scheduleDraw();
    // index.js re-points chat pictures whose file was just replaced.
    document.dispatchEvent(new CustomEvent('pm:assets-changed'));
}

function toggleVersionAsset(versionId, filename) {
    const s = guardTarget();
    if (!s) return;
    const version = findVersion(s.persona, versionId);
    if (!version) { fail(STRINGS.manager.versionGone); return; }
    toggleAssetSelection(version, filename, assetLabels());
    version.updatedAt = Date.now();
    commit('asset-select', version.name ?? '', s.avatar);
}

/* Writes: labels */

// Group writes are not about the target persona, so they check rosterWritable. The tab disables
// its buttons by it, but the state can turn under a handler waiting on a popup.
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
    if (!renameLabel(after.root?.labels, labelId, name)) { fail(STRINGS.manager.groupGone); return; }
    saveSettings();
    scheduleDraw();
}

async function dropLabel(labelId, name) {
    if (!rosterWritable(getState())) return refuseRoster();
    if (!(await askConfirm(STRINGS.manager.confirmDropGroup(name)))) return;
    const after = getState();
    if (!rosterWritable(after)) return refuseRoster();
    if (!deleteLabel(after.root?.labels, labelId)) { fail(STRINGS.manager.groupGone); return; }
    saveSettings();
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
    saveSettings();
    scheduleDraw();
    return true;
}

function toggleLabelMembership(labelId, avatarId) {
    const s = getState();
    if (!rosterWritable(s)) return refuseRoster();
    if (!Array.isArray(s.root.labels)) s.root.labels = [];
    toggleMember(s.root.labels, labelId, avatarId);
    saveSettings();
    // The group's own row carries its count and the attach/detach button.
    if (!redrawRows([rowKey('group', labelId)])) scheduleDraw();
}

/* Target selection */

// The screen state that belongs to one persona, reset for another and on open and close:
// working copies, folds, search and selections.
function moveTarget(avatar) {
    resetFullText();
    resetItemSelect();
    placementOpen = false;
    namesOpen = false;
    personaOpen = false;
    resetRevise();
    resetLists();
    targetAvatar = avatar;
    openVariant = null;
    editorDirty = false;
    pickerOpen = false;
    historyVariant = null;
    historyIndex = null;
    expandedRow = null;
    lastMissing = null;
}

async function selectTarget(avatar) {
    if (avatar === targetAvatar) { pickerOpen = false; scheduleDraw(); return; }
    // Working copies carried over would be saved onto the new persona.
    if (!(await confirmDropWorking())) return;
    if (avatar === targetAvatar) { pickerOpen = false; scheduleDraw(); return; }
    // Before the target moves, so the draft is stored under the persona being left.
    stashDraft();
    moveTarget(avatar);
    scheduleDraw();
}

// An entry is created only on request, never by viewing a persona.
async function adoptTarget() {
    const avatar = targetAvatar;
    if (!avatar) return;
    if (!(await askConfirm(STRINGS.manager.confirmAdopt))) return;
    if (avatar !== targetAvatar) { notify('error', STRINGS.manager.targetMovedNotAdopted); return; }
    // An existing record's items are not a split to announce.
    const existed = !!getPersona(getRoot(), avatar);
    const persona = adoptFor(avatar);
    if (!persona) { notify('error', refusalMessage(avatar)); return; }
    const count = existed ? 0 : itemsWithText(persona);
    if (count > 1) notify('success', STRINGS.common.adoptSplit(count));
    scheduleDraw();
}

/* Drafts */

// Read from the document, not a captured node: the redraw a blur releases can detach it.
function readEditorText() {
    const area = document.getElementById(PANEL_ID)?.querySelector('.pm-manager-editor-text');
    return area ? area.value : null;
}

// Every path that takes the editor off screen unsaved stashes the text under its body.
function stashDraft() {
    if (!editorDirty || !openVariant || !targetAvatar) return;
    const text = readEditorText();
    if (text === null) return;
    // Typed and taken back: nothing to keep.
    const stored = findVariant(getPersona(getRoot(), targetAvatar), openVariant.sectionId, openVariant.variantId)?.text ?? '';
    if (text === stored) { takeDraft(targetAvatar, openVariant.sectionId, openVariant.variantId); return; }
    putDraft(targetAvatar, openVariant.sectionId, openVariant.variantId, text);
}

/* Content */

// reason explains a disabled button; actionsRow also draws it, as touch screens show no tooltip.
function actionButton(label, onClick, enabled, title, reason) {
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

// The sticky button row under an editing screen (sticky within .pm-scroll).
function editorFoot(buttons) {
    const foot = el('div', 'pm-manager-editorfoot');
    foot.append(actionsRow(buttons));
    return foot;
}

function noteOf(text) {
    return el('div', 'pm-manager-note', text);
}

// Why writes are blocked, in the write path's own wording; empty when nothing blocks.
function writeReason(s) {
    if (!s) return STRINGS.manager.refusalNoRoot;
    if (s.readOnly) return STRINGS.manager.refusalReadOnly;
    if (s.ambiguous) return STRINGS.manager.refusalAmbiguous;
    if (s.listed === false) return STRINGS.manager.refusalUnknownPersona;
    return '';
}

/* Rows redrawn in place */

// Each row registers how to rebuild itself, so a toggle rebuilds only the rows it touches (a choice
// through its item). A queued or held draw, a field being typed in or replaced data takes the full
// draw.
const rowNodes = new Map();

// The picker's thumbnails, reused across redraws, as in the quick panel.
const pickerThumbs = imagePool('img.pm-quickbar-rowimg, img.pm-quickbar-tileimg');

function registerRow(key, node, build, { persona = null, parent = null } = {}) {
    rowNodes.set(key, { node, build, persona, parent });
}

function redrawRows(keys) {
    if (drawTask.pending() || drawHold.held || gestureHeld || dragSectionId !== null) return false;
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

// A row's name, as the button that unfolds it. Not a row-level handler, which would also fire
// for the row's primary action. summary is an optional one-line second line.
function rowNameButton(parts, summary, open, onClick) {
    const btn = el('button', 'pm-manager-rowname');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const top = el('div', 'pm-manager-rowtop');
    top.append(...parts);
    btn.append(top);
    if (summary) btn.append(el('div', 'pm-manager-rowsummary', summary));
    btn.addEventListener('click', onClick);
    return btn;
}

function rowName(key, parts, summary) {
    return rowNameButton(parts, summary, expandedRow === key, () => toggleExpanded(key));
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

// A folding block above a tab's list, shaped like a row, with its own open flag.
function foldBox(className, title, summary, open, onToggle) {
    const box = el('div', `${className}${open ? ' pm-manager-rowopen' : ''}`);
    const head = rowHead();
    head.append(rowNameButton([el('span', 'pm-manager-name', title)], summary, open, onToggle));
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

// The drawer under an open row. Destructive buttons go last in a block of their own, so a
// near miss cannot delete.
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

// Fixed locale: the browser default can put an English date beside Korean captions.
function formatTime(at) {
    if (!at) return '';
    try { return new Date(at).toLocaleString('ko-KR'); } catch { return String(at); }
}

// A pick naming a deleted choice is shown as such; snapping to the first option would show a
// combination the prompt lacks.
function pickSelect(persona, section, writable) {
    const variants = persona.variants?.[section.id] ?? [];
    const picked = persona.activePicks?.[section.id] ?? '';
    const options = variants.map(variant => [variant.id, variant.label ?? '']);
    if (picked && !variants.some(variant => variant.id === picked)) options.unshift([picked, STRINGS.common.deletedChoiceOption]);
    const select = selectOf('pm-manager-select', options, picked);
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.manager.activeChoiceAria(section.name ?? ''));
    select.addEventListener('change', () => pickVariant(section.id, select.value));
    return select;
}

// The unsaved draft worth a badge, or null; the editor applies the same rule.
function pendingDraft(sectionId, variant) {
    const draft = peekDraft(targetAvatar, sectionId, variant.id);
    return (draft !== null && draft !== (variant.text ?? '')) ? draft : null;
}

// The body the editor is open on, or null if it was deleted meanwhile.
function openBody(persona) {
    if (!openVariant) return null;
    const section = findSection(persona, openVariant.sectionId);
    if (!section) return null;
    const variant = findVariant(persona, section.id, openVariant.variantId);
    return variant ? { section, variant } : null;
}

// The body editor, replacing the item list while open. No keydown handler: Enter is a newline.
function variantEditor(section, variant, writable, reason) {
    const sectionId = section.id;
    const box = el('div', 'pm-manager-editorscreen');
    box.append(el('div', 'pm-manager-editorhead',
        STRINGS.manager.editorHeading(section.name ?? '', variant.label ?? '')));
    const stored = variant.text ?? '';
    const draft = peekDraft(targetAvatar, sectionId, variant.id);
    if (draft !== null && draft === stored) takeDraft(targetAvatar, sectionId, variant.id);
    const restored = draft !== null && draft !== stored;
    if (restored) {
        // Unsaved text again, so closing asks.
        editorDirty = true;
        box.append(noteOf(STRINGS.manager.editorRestored));
    }
    const area = el('textarea', 'pm-manager-editor-text');
    area.value = restored ? draft : stored;
    area.rows = 12;
    area.disabled = !writable;
    area.setAttribute('aria-label', STRINGS.manager.editorAria(variant.label ?? ''));
    area.addEventListener('input', () => { editorDirty = true; sizeLines.schedule(); });
    box.append(area);
    // Updated by sizeLines, never by a redraw, which would pull the field out mid composition.
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
    box.append(editorFoot(buttons));
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
        markedText('pm-manager-name', variant.label ?? '', listQuery('compose')),
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
    // A closed item shows only its name and live pick; its choices appear when it or one of
    // them is open, or while searching.
    const choiceOpen = variants.some(variant => expandedRow === rowKey('choice', section.id, variant.id));
    const searching = lists.compose.open && lists.compose.query.trim() !== '';
    const showChoices = open || choiceOpen || searching;

    const head = rowHead();
    if (itemSelecting) {
        const check = el('input', 'pm-checkbox pm-manager-itemcheck');
        check.type = 'checkbox';
        check.checked = selectedItems.has(section.id);
        check.setAttribute('aria-label', STRINGS.manager.itemSelectAria(section.name ?? ''));
        check.addEventListener('change', () => {
            if (check.checked) selectedItems.add(section.id);
            else selectedItems.delete(section.id);
            scheduleDraw();
        });
        head.append(check);
    }
    const headParts = [
        markedText('pm-manager-name', section.name ?? '', listQuery('compose')),
        el('span', 'pm-manager-count', STRINGS.manager.choiceCount(variants.length)),
    ];
    // A closed item hides its choices, so their unsaved-typing mark moves up to it.
    if (!showChoices && variants.some(variant => pendingDraft(section.id, variant) !== null)) {
        headParts.push(el('span', 'pm-manager-count', STRINGS.manager.pendingDraft));
    }
    head.append(rowName(key, headParts));
    head.append(dragHandle(section.id, writable, reason));
    head.append(moreButton(key));
    box.append(head);
    // Read by dropTargetAt; an id, since a search filters the rendered rows.
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

// The list whose search field the next draw focuses; consumed once.
let focusSearch = null;

function listSearchButton(key) {
    const ui = lists[key];
    const btn = button('pm-manager-btn', ui.open ? STRINGS.common.searchClose : STRINGS.common.search, () => {
        if (ui.open) Object.assign(ui, listUi());
        else { ui.open = true; focusSearch = key; }
        scheduleDraw();
    });
    btn.setAttribute('aria-pressed', ui.open ? 'true' : 'false');
    return btn;
}

function listSearchRow(key) {
    const { row, input } = searchRow(lists[key], () => redrawManagerList(key));
    // Marked, not focused: the node is not in the document yet (see takeSearchFocus).
    if (focusSearch === key) input.dataset.pmFocus = '1';
    return row;
}

// At the end of a draw, once the field has a size.
function takeSearchFocus() {
    focusSearch = null;
    focusMarked(document.getElementById(PANEL_ID));
}

// One rebuild per frame per list, since keystrokes outpace frames.
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
    const writable = rosterWritable(s);
    const reason = writeReason(s);
    if (key === 'versions') fillVersionList(container, s, writable, reason);
    else if (key === 'assets') fillAssetList(container, s, writable, reason);
    else if (key === 'compose') fillComposeList(container, s, writable, reason);
    else if (key === 'groups') fillGroupList(container, s);
}

// A version's language, from the text its own picks compose. Memoised per version, picks
// (updatedAt) and bodies (stamp: modifiedAt), since search asks on every keystroke.
const languageMemo = new Map();

function versionLanguage(persona, version, stamp) {
    if (typeof stamp !== 'number') return detectLanguage(composePicked(persona, version?.picks).text);
    const key = `${version?.id}|${version?.updatedAt}|${stamp}`;
    if (languageMemo.has(key)) return languageMemo.get(key);
    if (languageMemo.size > 500) languageMemo.clear();
    const answer = detectLanguage(composePicked(persona, version?.picks).text);
    languageMemo.set(key, answer);
    return answer;
}

/* Tags */

function addTagTo(kindLabel, getOwner) {
    return afterAsking(() => askName(STRINGS.manager.tagAddPrompt, ''), (after, tag, startAvatar) => {
        const owner = getOwner(ensureShape(after.persona));
        if (!owner) { fail(STRINGS.manager.versionGone); return; }
        const stored = addTag(owner, tag);
        if (!stored) { notify('info', STRINGS.manager.tagDuplicate); return; }
        commit('tag-add', kindLabel ? `${kindLabel}: ${stored}` : stored, startAvatar);
    });
}

function removeTagFrom(kindLabel, tag, getOwner) {
    return afterAsking(() => askConfirm(STRINGS.manager.confirmDropTag(tag)), (after, _, startAvatar) => {
        const owner = getOwner(ensureShape(after.persona));
        if (!owner) { fail(STRINGS.manager.versionGone); return; }
        if (!removeTag(owner, tag)) { notify('info', STRINGS.manager.tagGone); scheduleDraw(); return; }
        commit('tag-remove', kindLabel ? `${kindLabel}: ${tag}` : tag, startAvatar);
    });
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

// Names match through rankOf's full ladder; bodies only by textContains, since the sparse and
// typo tiers match almost any long prose.
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

    if (!(persona.sections ?? []).length) { container.append(emptyBlock(STRINGS.manager.noItems)); return; }

    const query = listQuery('compose').trim();
    let sections = persona.sections ?? [];
    if (query) sections = sections.filter(section => sectionMatchesQuery(persona, section, query));
    if (!sections.length) { container.append(emptyBlock(STRINGS.common.searchNoHits)); return; }
    for (const section of sections) {
        // Index in the full list, which the move arrows reorder.
        container.append(sectionBlock(persona, section, persona.sections.indexOf(section), writable, reason));
    }
}

function doFillDefaults() {
    return afterAsking(s => {
        const missing = missingDefaultSections(s.persona);
        if (!missing.length) { notify('info', STRINGS.manager.fillDefaultsNothing); return false; }
        return askConfirm(STRINGS.manager.confirmFillDefaults(missing.length));
    }, (after, _, startAvatar) => {
        const added = fillDefaultSections(ensureShape(after.persona), freshContext()?.uuidv4, Date.now());
        // Filled while the question was up: nothing to save.
        if (!added.length) { notify('info', STRINGS.manager.fillDefaultsNothing); scheduleDraw(); return; }
        if (commit(null, '', startAvatar)) notify('info', STRINGS.manager.fillDefaultsDone(added.length));
    });
}

// Splits are refused over unsaved typing (editor, drafts, revise or full-text copies), which
// would put the old whole text back on top of the split.
function hasUnsavedBody(avatar, persona) {
    if (editorDirty) return true;
    if (reviseDirtyCount() > 0 || fullDirtyCount() > 0) return true;
    // Same rule as pendingDraft.
    return (persona.sections ?? []).some(section =>
        (persona.variants?.[section?.id] ?? []).some(variant => {
            const draft = peekDraft(avatar, section.id, variant?.id);
            return draft !== null && draft !== (variant?.text ?? '');
        }));
}

function doResplit() {
    return afterAsking(s => {
        if (hasUnsavedBody(targetAvatar, s.persona)) { notify('warning', STRINGS.manager.resplitDraft); return false; }
        const plan = planResplit(s.persona);
        if (!plan) { notify('info', STRINGS.manager.resplitNothing); return false; }
        return askConfirm(STRINGS.manager.confirmResplit(plan.targets, plan.created));
    }, (after, _, startAvatar) => {
        if (hasUnsavedBody(startAvatar, after.persona)) { notify('warning', STRINGS.manager.resplitDraft); return; }
        // Planned again on the persona as it stands now.
        const fresh = planResplit(ensureShape(after.persona));
        if (!fresh) { notify('info', STRINGS.manager.resplitNothing); scheduleDraw(); return; }
        const now = Date.now();
        let kept = false;
        const changed = applyResplit(after.persona, fresh, freshContext()?.uuidv4, now, after.settings?.defaultHeadingFormat,
            (variantId, text) => { kept = snapshotKeepingIndex(after.persona, variantId, text, now, after.settings, { force: true }) || kept; });
        trimHistory(after.root, after.settings, now);
        if (commit('split-headings', STRINGS.manager.logDetails.resplit(changed.length), startAvatar)) {
            // History is mentioned only if a snapshot was kept.
            notify('success', kept ? STRINGS.manager.resplitDone(changed.length) : STRINGS.manager.resplitDoneNoHistory(changed.length));
        }
    });
}

// Split by its own titles, for a managed persona whose whole text sits in one item's live
// choice; only when composing the result gives the same text back.
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

function doOwnSplit() {
    let body = '';
    let own = null;
    let names = '';
    return afterAsking(s => {
        if (hasUnsavedBody(targetAvatar, s.persona)) { notify('warning', STRINGS.manager.resplitDraft); return false; }
        const source = ownSplitSource(s.persona);
        if (!source) { notify('warning', STRINGS.manager.ownSplitNotOnly); return false; }
        body = source.variant.text;
        own = splitOwnSections(body);
        if (!own) { notify('info', STRINGS.manager.ownSplitNothing); return false; }
        const trial = structuredClone(s.persona);
        seedOwnSections(trial, own, freshContext()?.uuidv4);
        if (!sameText(compose(trial).text, body)) { notify('warning', STRINGS.manager.ownSplitNotExact); return false; }
        names = trial.sections.map(section => section.name).join(', ');
        return askConfirm(STRINGS.manager.confirmOwnSplit(trial.sections.length, names));
    }, (after, _, startAvatar) => {
        if (hasUnsavedBody(startAvatar, after.persona)) { notify('warning', STRINGS.manager.resplitDraft); return; }
        const again = ownSplitSource(after.persona);
        if (!again || again.variant.text !== body) { fail(STRINGS.manager.ownSplitNotOnly); return; }
        const persona = ensureShape(after.persona);
        const now = Date.now();
        const oldVariantId = again.variant.id;
        // Their history would linger under ids nothing can open, still counted against the cap.
        const replaced = Object.values(persona.variants).flatMap(list => (Array.isArray(list) ? list : []).map(variant => variant?.id));
        seedOwnSections(persona, own, freshContext()?.uuidv4, now);
        // The old body's history moves to the first new item, the whole old body on top.
        const firstId = persona.activePicks[persona.sections[0].id];
        const kept = Array.isArray(persona.history?.[oldVariantId]) ? persona.history[oldVariantId] : [];
        if (!persona.history) persona.history = {};
        for (const id of replaced) if (id && id !== firstId) delete persona.history[id];
        if (kept.length) persona.history[firstId] = kept;
        const snapped = snapshotKeepingIndex(persona, firstId, body, now, after.settings, { force: true });
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
    });
}

/* Size. Tokens come from SillyTavern's own counter, whose name is unverified, so the line shows
   them only if a probe answers a number; the probe's result is kept for the session. */
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

// One-slot memo keyed by the body: most draws are for unrelated reasons.
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

// Trailing, so a sentence typed at speed costs one count of the whole body (SillyTavern's token
// count does not run per keystroke).
const sizeLines = debounced(() => refreshSizeLines(), 500);

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

/* Full text: the whole description in prompt order, each body editable in place. Unlike the
   revise screen it overwrites bodies, so each is snapshotted into history first. */

function resetFullText() {
    fullActive = false;
    fullView = 'items';
    fullRaw = null;
    fullUndo = [];
    fullBlocks = null;
    fullTexts = null;
    sizeLines.cancel();
}

// Live fields into the working copies, before every draw and every read.
function harvestFullTexts() {
    if (!fullActive || !Array.isArray(fullTexts)) return;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const raw = panel.querySelector('.pm-full-raw-text');
    if (raw && fullRaw) fullRaw.text = raw.value;
    for (const area of panel.querySelectorAll('.pm-full-text')) {
        const index = Number(area.dataset.pmBlock);
        if (Number.isInteger(index) && index >= 0 && index < fullTexts.length) fullTexts[index] = area.value;
    }
}

// Bodies that leaving would discard, measured against what the screen opened with.
function fullDirtyCount() {
    if (!fullActive || !Array.isArray(fullBlocks)) return 0;
    harvestFullTexts();
    const split = splitRaw();
    // An undividable joined text still holds typing that leaving would lose.
    if (!split.ok) return Math.max(1, countChanged(fullTexts));
    return countChanged(split.texts);
}

function countChanged(texts) {
    let count = 0;
    fullBlocks.forEach((block, index) => {
        if ((texts?.[index] ?? block.text) !== block.text) count++;
    });
    return count;
}

// The joined view's text divided back into the working copies, or why it cannot be.
function splitRaw() {
    if (!fullRaw || fullRaw.text === fullRaw.start) return { ok: true, texts: fullTexts };
    const s = targetState();
    if (!s?.persona) return { ok: false, reason: 'stray', name: '' };
    return splitFullText(s.persona, fullBlocks, fullRaw.text, fullTexts);
}

function rawRefusal(split) {
    if (split.reason === 'order') return STRINGS.manager.fullRawOrder(split.name);
    if (split.reason === 'missing') return STRINGS.manager.fullRawMissing(split.name);
    return STRINGS.manager.fullRawStray;
}

// Leaves the joined view only when its text divides; otherwise the typing stays on screen.
function takeRaw() {
    harvestFullTexts();
    const split = splitRaw();
    if (!split.ok) { notify('warning', rawRefusal(split)); return false; }
    fullTexts = split.texts;
    fullRaw = null;
    return true;
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

// Leaves an editing screen, asking first when that would discard working copies.
async function leaveWorking(dirtyCount, question, reset) {
    if (closeAsked) return;
    const dirty = dirtyCount();
    if (dirty > 0 && !(await confirmOpen(question(dirty)))) return;
    reset();
    scheduleDraw();
}

function leaveFullText() {
    return leaveWorking(fullDirtyCount, STRINGS.manager.fullTextConfirmLeave, resetFullText);
}

function saveFullText() {
    const s = guardTarget();
    if (!s) return;
    const startAvatar = targetAvatar;
    const inRaw = !!fullRaw;
    if (!takeRaw()) return;
    // The plan skips bodies that are no longer the ones the screen drew.
    const plan = planFullTextSave(s.persona, fullBlocks, fullTexts);
    if (plan.skipped.length) notify('warning', STRINGS.manager.fullTextSkipped(plan.skipped.join(', ')));
    // The joined view stays open, redrawn from the working copies.
    const reopenRaw = () => {
        if (!inRaw) return;
        const text = composeFrom(s.persona, fullBlocks, fullTexts);
        fullRaw = { text, start: text };
        // The next draw harvests the box first, so the box takes the new text now.
        const area = document.getElementById(PANEL_ID)?.querySelector('.pm-full-raw-text');
        if (area) area.value = text;
    };
    if (!plan.writes.length) { reopenRaw(); notify('info', STRINGS.manager.nothingChanged); return; }
    const now = Date.now();
    for (const write of plan.writes) {
        const variant = findVariant(s.persona, write.sectionId, write.variantId);
        if (!variant) continue;
        snapshotKeepingIndex(s.persona, write.variantId, write.before, now, s.settings);
        variant.text = write.after;
        variant.updatedAt = now;
        addLog(s.persona, 'variant-edit', variant.label ?? '', now);
        takeDraft(startAvatar, write.sectionId, write.variantId);
    }
    trimHistory(s.root, s.settings, now);
    if (!commit(null, '', startAvatar)) { reopenRaw(); return; }
    notify('info', STRINGS.manager.fullTextSaved(plan.writes.length));
    // The written bodies become the new baseline. Each block keeps the choice it was drawn
    // from, or typing could land in the choice active now.
    const written = new Map(plan.writes.map(write => [write.variantId, write.after]));
    if (written.size) {
        fullBlocks = fullBlocks.map(block => (written.has(block.variantId)
            ? { ...block, text: written.get(block.variantId) }
            : block));
        fullTexts = fullBlocks.map((block, index) => (written.has(block.variantId)
            ? block.text
            : (fullTexts?.[index] ?? block.text)));
    }
    reopenRaw();
    scheduleDraw();
}

// Working copies back into the fields on screen: a draw harvests the fields first, so state
// changed from code must reach them or the draw would read the old text back.
function pushFullToFields() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const raw = panel.querySelector('.pm-full-raw-text');
    if (raw && fullRaw) raw.value = fullRaw.text;
    for (const area of panel.querySelectorAll('.pm-full-text')) {
        const index = Number(area.dataset.pmBlock);
        if (Number.isInteger(index) && typeof fullTexts?.[index] === 'string') area.value = fullTexts[index];
    }
}

// Empties every body on the screen at once, without asking: undoFullClear takes it back.
// Nothing is written until the save.
function clearFullText() {
    if (!fullActive || !Array.isArray(fullTexts)) return;
    harvestFullTexts();
    const rawText = fullRaw ? fullRaw.text : null;
    if (!fullTexts.some(text => String(text ?? '').trim()) && !(rawText ?? '').trim()) {
        notify('info', STRINGS.manager.fullClearNothing);
        return;
    }
    fullUndo.push([...fullTexts]);
    fullTexts = fullTexts.map(() => '');
    if (fullRaw) fullRaw.text = '';
    pushFullToFields();
    notify('info', STRINGS.manager.fullCleared);
    scheduleDraw();
}

// One item's body, emptied in place; undone like clear-all.
function clearFullItem(index) {
    if (!fullActive || !Array.isArray(fullTexts) || !(index >= 0 && index < fullTexts.length)) return;
    harvestFullTexts();
    const name = fullBlocks?.[index]?.sectionName ?? '';
    if (!String(fullTexts[index] ?? '').trim()) { notify('info', STRINGS.manager.fullClearNothing); return; }
    fullUndo.push([...fullTexts]);
    fullTexts[index] = '';
    pushFullToFields();
    notify('info', STRINGS.manager.fullItemCleared(name));
    scheduleDraw();
}

// Takes back the newest clear only; earlier ones stay for the next press.
function undoFullClear() {
    if (!fullUndo.length) return;
    harvestFullTexts();
    const s = targetState();
    fullTexts = [...fullUndo.pop()];
    if (fullRaw && s?.persona) {
        // Same text as start: the working copies alone carry what differs from the bodies.
        const text = composeFrom(s.persona, fullBlocks, fullTexts);
        fullRaw = { text, start: text };
    }
    pushFullToFields();
    notify('info', STRINGS.manager.fullClearUndone);
    scheduleDraw();
}

// A text box tall enough for its text (a line per 44 characters), within min and max.
function rowsFor(text, min, max) {
    return Math.min(max, Math.max(min, text.split('\n').length + Math.floor(text.length / 44)));
}

// Each body under the heading it is printed with, or a caption naming the item and choice.
function fullTextScreen(s, writable, reason) {
    const wrap = el('div', 'pm-full');
    wrap.append(noteOf(STRINGS.manager.fullTextGuide));
    const persona = s.persona;
    const blocks = fullBlocks ?? [];
    const line = el('div', 'pm-manager-size pm-size-full',
        sizeTextOf(fullRaw ? fullRaw.text : composeFrom(persona, blocks, fullTexts)));
    wrap.append(line);
    const toggles = el('div', 'pm-manager-actions');
    for (const [key, text] of [['items', STRINGS.manager.fullViewItems], ['raw', STRINGS.manager.fullViewRaw]]) {
        const active = fullView === key;
        const btn = button(`pm-manager-btn${active ? ' pm-manager-primary' : ''}`, text, () => {
            if (fullView === key) return;
            // The boxes leave the screen; their typing lives on in the working copies.
            harvestFullTexts();
            if (fullView === 'raw' && !takeRaw()) return;
            if (key === 'raw' && fullTextSplittable(persona, blocks)) {
                const text = composeFrom(persona, blocks, fullTexts);
                fullRaw = { text, start: text };
            }
            fullView = key;
            scheduleDraw();
        });
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        toggles.append(btn);
    }
    toggles.append(actionButton(STRINGS.manager.fullClear, () => clearFullText(), writable, STRINGS.manager.fullClearTitle, reason));
    const undoButton = () => actionButton(STRINGS.manager.fullClearUndo(fullUndo.length), () => undoFullClear(), writable, '', reason);
    if (fullUndo.length) toggles.append(undoButton());
    // Save, the undo again (the top one can be a screen away), and back.
    const fullFoot = () => editorFoot([
        actionButton(STRINGS.manager.fullTextSave, () => saveFullText(), writable, '', reason),
        ...(fullUndo.length ? [undoButton()] : []),
        actionButton(STRINGS.manager.editorBackToList, () => leaveFullText(), true),
    ]);
    wrap.append(toggles);
    const format = persona.headingFormat;
    if (fullView === 'raw' && fullRaw) {
        // Editable: saving divides the text back along the title lines (splitFullText).
        wrap.append(noteOf(STRINGS.manager.fullViewRawGuide));
        const area = el('textarea', 'pm-full-text pm-full-raw-text');
        area.value = fullRaw.text;
        area.rows = rowsFor(fullRaw.text, 8, 30);
        area.disabled = !writable;
        area.setAttribute('aria-label', STRINGS.manager.fullRawAria);
        area.addEventListener('input', () => sizeLines.schedule());
        wrap.append(area);
        wrap.append(fullFoot());
        return wrap;
    }
    if (fullView === 'raw') {
        // Read only: with no title lines the joined text cannot tell which item an edit belongs to.
        wrap.append(noteOf(STRINGS.manager.fullViewRawLocked));
        const { box, inner } = textBox('pm-full-raw');
        inner.textContent = composeFrom(persona, blocks, fullTexts) || STRINGS.manager.previewEmpty;
        wrap.append(box);
        wrap.append(editorFoot([
            actionButton(STRINGS.manager.fullTextSave, () => saveFullText(), writable && fullDirtyCount() > 0, '',
                fullDirtyCount() > 0 ? reason : STRINGS.manager.nothingChanged),
            actionButton(STRINGS.manager.editorBackToList, () => leaveFullText(), true),
        ]));
        return wrap;
    }
    if (headingLine(format, 'x', persona.headingTemplate)) wrap.append(noteOf(STRINGS.manager.fullTextHeadingNote));
    const untitled = untitledIds(persona);
    blocks.forEach((block, index) => {
        const head = untitled.has(block.sectionId) ? '' : headingLine(format, block.sectionName, persona.headingTemplate);
        const variant = findVariant(persona, block.sectionId, block.variantId);
        const caption = head || STRINGS.manager.editorHeading(block.sectionName, variant?.label ?? '');
        const itemHead = el('div', 'pm-full-itemhead');
        itemHead.append(el('div', `pm-revise-caption${head ? ' pm-full-heading' : ''}`, caption));
        const clear = actionButton(STRINGS.manager.fullItemClear, () => clearFullItem(index), writable, '', reason);
        clear.setAttribute('aria-label', STRINGS.manager.fullItemClearAria(block.sectionName));
        itemHead.append(clear);
        wrap.append(itemHead);
        const area = el('textarea', 'pm-full-text');
        area.dataset.pmBlock = String(index);
        const value = fullTexts?.[index] ?? block.text;
        area.value = value;
        area.rows = rowsFor(value, 4, 20);
        area.disabled = !writable;
        area.setAttribute('aria-label', STRINGS.manager.fullTextAria(block.sectionName));
        area.addEventListener('input', () => sizeLines.schedule());
        wrap.append(area);
    });
    wrap.append(fullFoot());
    return wrap;
}

/* Prompt placement: SillyTavern's own descriptor fields. Position and role are its enums, so
   options come from its own selects, never hardcoded numbers. */
const PLACEMENT_SELECTS = Object.freeze({
    position: { ids: ['persona_description_position'], match: /position/i },
    role: { ids: ['persona_depth_role', 'persona_description_role'], match: /role/i },
});

// Only the option list: the select's value belongs to SillyTavern's selected persona, not
// necessarily this target. Cached per draw.
function enumOptions(field) {
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
    // A renamed id must not silently remove the control.
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
    return found ? found.label : STRINGS.manager.placementRaw(value);
}

// Every placement write. Not commit(): these are SillyTavern's fields, and the description
// must not be rewritten.
function applyPlacement(patch, kind, detail) {
    const s = guardTarget();
    if (!s || refusedWrite(s)) return false;
    const ctx = freshContext();
    if (!ctx) { notify('error', STRINGS.manager.noContext); return false; }
    // SillyTavern's singular prompt keys belong to the active persona, not the target.
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

// SillyTavern's own depth input's max, or no ceiling.
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

// The world info book names, if readable; null falls back to typing the name.
function worldNames() {
    const ctx = freshContext();
    for (const candidate of [ctx?.world_names, globalThis.world_names]) {
        if (!Array.isArray(candidate) || !candidate.length) continue;
        const names = candidate.filter(name => typeof name === 'string' && name.trim());
        if (names.length === candidate.length) return names;
    }
    // Usually the option text of SillyTavern's world selects; rows without a value are placeholders.
    if (typeof document === 'undefined') return null;
    let best = null;
    for (const select of document.querySelectorAll('select[id*="world" i]')) {
        // Other selects share the prefix; the book list is the longest.
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
    const entries = options.map(option => [option.value, option.label]);
    // An unknown stored value keeps its own entry rather than snapping to the first.
    if (current !== null && current !== undefined && !options.some(option => option.value === current)) {
        entries.unshift([current, STRINGS.manager.placementRaw(current)]);
    }
    const select = selectOf('pm-manager-select', entries, current === null || current === undefined ? '' : String(current),
        value => pickPlacementEnum(field, value));
    select.disabled = !writable;
    select.setAttribute('aria-label', aria);
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
    // The reason once for the block: value rows do not draw it.
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* Names per language. They live on our record only: SillyTavern identifies personas by its
   personas map, so writing there renames the persona everywhere. */

function editLocalName(lang) {
    const langName = STRINGS.common.languageNames[lang] ?? lang;
    // An empty answer deletes the name.
    return afterAsking(s => (refusedWrite(s) ? false : askText(STRINGS.manager.localNamePrompt(langName), localName(s.persona, lang, ''))), (after, answer) => {
        if (!setLocalName(ensureShape(after.persona), lang, answer)) {
            notify('info', STRINGS.manager.nothingChanged);
            return;
        }
        const stored = localName(after.persona, lang, '');
        addLog(after.persona, 'name-local', `${langName}: ${stored || STRINGS.manager.placementUnset}`, Date.now());
        saveSettings();
        notify('info', stored ? STRINGS.manager.localNameSaved : STRINGS.manager.localNameRemoved);
        scheduleDraw();
    });
}

// Applying renames the persona in SillyTavern, by a button, never on a language guess: the
// roster, the chat lock and other extensions identify a persona by that name.
async function applyLocalName(lang, toChat) {
    const name = localName(guardTarget()?.persona, lang, '');
    if (!name) { notify('info', STRINGS.manager.localNameNone); return; }
    await applyNameWithScope(name, toChat, `${STRINGS.common.languageNames[lang] ?? lang}: ${name}`);
}

// The one rename write. toChat false writes only SillyTavern's personas map; true also carries
// the name into name1 ({{user}} and new messages). Past chat text is never rewritten.
async function applyNameWithScope(name, toChat, detail) {
    const s = guardTarget();
    if (!s || refusedWrite(s)) return;
    const startAvatar = targetAvatar;
    // Whether the persona is active can change across the await, so the scope is re-checked
    // (rule at identifiedDirectly).
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
    // Chat scope only: a chat already using this name is warned about, not refused.
    const clash = toChat ? nameCollides({ name, characterName: ctx?.name2, chat: ctx?.chat }) : null;
    const question = !toChat
        ? STRINGS.manager.confirmApplyNameList(current, name)
        : (clash
            ? STRINGS.manager.confirmApplyNameClash(name, clash)
            : STRINGS.manager.confirmApplyNameChat(current, name));
    if (!(await askConfirm(question))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
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
    saveSettings();
    notify('info', toChat
        ? STRINGS.manager.localNameApplied(name)
        : STRINGS.manager.listNameApplied(name));
    scheduleDraw();
}

// The same rename with a typed name instead of one from the language list.
async function renameTargetPersona(toChat) {
    const s = guardTarget();
    if (!s || refusedWrite(s)) return;
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

/* The persona itself: name, picture, and new personas made from it. All write SillyTavern's
   record, so each asks first. Name scopes: the list (SillyTavern's personas map) or the chat
   (also name1). Chat needs the persona active, or it would switch to it; list-only on the active
   persona needs it identified directly, as otherwise ctx.js matches personas[avatar] === name1
   and a mismatch makes every write refuse. */
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
    nameRow.append(scopePair(nameScopeButtons(name, writable, reason,
        () => renameTargetPersona(false), () => renameTargetPersona(true))));
    box.append(nameRow);

    // The file input lives in the tree, so it is disabled with everything else.
    const imageRow = el('div', 'pm-row pm-manager-valuerow');
    const input = el('input', 'pm-manager-file pm-hidden');
    input.type = 'file';
    input.accept = 'image/*';
    input.disabled = !writable;
    input.setAttribute('aria-label', STRINGS.manager.changeImageAria);
    input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null;
        // Cleared so the same file can be picked again: an unchanged choice fires no change.
        input.value = '';
        if (file) changeTargetImage(file);
    });
    imageRow.append(el('span', 'pm-manager-picklabel', STRINGS.manager.imageLabel));
    const url = thumbnailUrl(ctx, s.avatar);
    if (url) imageRow.append(lazyImg('pm-manager-targetimg', url));
    imageRow.append(el('span', 'pm-manager-value', ''));
    imageRow.append(actionButton(STRINGS.manager.imageButton, () => input.click(), writable,
        STRINGS.manager.changeImage, reason));
    const kept = s.persona?.avatarBackup?.label ?? null;
    imageRow.append(actionButton(STRINGS.manager.imageRestore, () => restoreTargetImage(), writable && !!kept,
        '', kept ? reason : STRINGS.manager.imageNoBackup));
    box.append(imageRow, input);
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
    saveSettings();
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
    // The check marks the name in effect (SillyTavern's), trimmed as the quick panel does.
    const appliedName = String(base ?? '');
    const isApplied = lang => {
        const name = String(stored[lang] ?? '').trim();
        return !!name && name === appliedName;
    };
    const current = conversationLanguage(freshContext());
    for (const lang of NAME_LANGUAGES) {
        const row = el('div', 'pm-row pm-manager-valuerow pm-manager-tightrow');
        row.append(checkMark(isApplied(lang)));
        // Language and name are one button: a third would not fit, and a row role would nest
        // the row's other buttons.
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
    box.append(noteOf(STRINGS.manager.localNameAppliedHint));
    // Always drawn: without it, an automatic rule that did not fire looks broken.
    box.append(noteOf(`${STRINGS.manager.localNameCurrent}: ${current
        ? (STRINGS.common.languageNames[current] ?? current)
        : STRINGS.manager.localNameNoChat}`));
    const auto = getRoot()?.settings?.autoLocalName === true;
    const autoRow = el('div', 'pm-row pm-manager-valuerow');
    // A check mark, as on/off words would break the copy rules (test/wording.test.mjs).
    autoRow.append(checkMark(auto));
    autoRow.append(el('span', 'pm-manager-picklabel', STRINGS.manager.autoNameRow));
    autoRow.append(el('span', 'pm-manager-value', ''));
    autoRow.append(actionButton(auto ? STRINGS.manager.autoNameTurnOff : STRINGS.manager.autoNameTurnOn,
        () => toggleAutoName(), writable, '', reason));
    box.append(autoRow);
    // Why the automatic rule is idle: its name is already someone else's in this chat.
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
// Puts back the picture kept before the first bound version overwrote the avatar. The record
// stays: a later apply must not back up the restored original a second time.
function restoreTargetImage() {
    let label = null;
    return afterAsking(s => {
        if (refusedWrite(s)) return false;
        label = s.persona?.avatarBackup?.label;
        if (!label) { notify('info', STRINGS.manager.imageNoBackup); return false; }
        return askConfirm(STRINGS.manager.confirmRestoreImage);
    }, async (_after, _, startAvatar) => {
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
            saveSettings();
        }
        notify('info', STRINGS.manager.imageRestored);
    });
}

// The picked file opens in the framing editor first; one the browser cannot measure goes up
// whole after a confirmation.
async function changeTargetImage(file) {
    const s = guardTarget();
    if (!s || refusedWrite(s)) return;
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
    // avatarWritten names the asset on the avatar, so it is cleared, inside the write queue,
    // for a version apply queued behind this upload.
    const result = await replacePersonaAvatar(freshContext(), startAvatar, file, crop, () => {
        const live = getPersona(getRoot(), startAvatar);
        if (live && live.avatarWritten !== null) {
            live.avatarWritten = null;
            saveSettings();
        }
    });
    if (result.ok) {
        personaImageChanged(startAvatar);
        notify('success', STRINGS.manager.changeImageDone);
        return true;
    }
    scheduleDraw();
    // Without that endpoint, SillyTavern's own file input and crop dialog finish the job.
    if (result.status === 404) {
        const missing = feedPersonaImage(document, startAvatar, file);
        if (missing) { notify('error', STRINGS.manager.changeImageNoControl(missing)); return false; }
        notify('info', STRINGS.manager.changeImageHandedOver);
        return false;
    }
    notify('error', STRINGS.manager.changeImageFailed(result.detail ?? result.reason));
    return false;
}

/* Per-version persona image. A failed picture never rolls back the applied version. */
// loadAssets sets the avatar before it awaits, so readers of the list ask this first.
function listingReady(avatarId) {
    return assetState.avatar === avatarId && !assetState.error && !assetState.loading;
}

async function runBoundImage(avatarId, versionId, force) {
    // This screen's listing when ready, saving a round trip.
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
    if (result.error === 'listing') notify('warning', STRINGS.manager.imageListingFailed(result.detail));
    else notifyBoundImageFailure(result);
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
    if (!version) { fail(STRINGS.manager.versionGone); return; }
    if (bindAsset(version, choice, Date.now())) commit('image-bind', `${version.name ?? ''} / ${choice}`, startAvatar);
}

function clearBoundAsset(versionId) {
    const s = guardTarget();
    if (!s) return;
    const version = findVersion(s.persona, versionId);
    if (!version) { fail(STRINGS.manager.versionGone); return; }
    if (bindAsset(version, null, Date.now())) commit('image-bind', version.name ?? '', targetAvatar);
}

// The picture block on an open version row (at most one is open).
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
            // The full-size file at a small drawn size.
            img.width = 96;
            img.height = 96;
            img.decoding = 'async';
            img.src = path;
            img.alt = '';
            img.loading = 'lazy';
            box.append(img);
        }
    }
    // Why the picture buttons are disabled; a failed listing must not read as loading.
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

/* Framing editor. 'version' mode stores a crop on a version's bound asset; 'upload' mode writes
   a just-picked file to the avatar with it. Module state, so a redraw rebuilds the editor where
   it was; dropFraming revokes the object URL. */
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
    if (!version || !label || !path) { fail(STRINGS.manager.versionGone); return; }
    const avatar = targetAvatar;
    // Measured fresh: the path carries the listing's freshness token.
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
        // Written even while the slider has focus, or a wheel zoom leaves it stale.
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

    // One finger drags, two pinch, a wheel zooms, in the picture's own fractions.
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
            // Keeps moves coming outside the frame; throws for a pointer no longer down.
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
            // Picture pixels per screen pixel, so the picture follows the finger at any zoom.
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
        // In proportion to deltaY, since a touchpad sends many small deltas.
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

// Uploads the picked file, cropped or whole; the editor stays open until the server answers.
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

/* Duplicate as a new persona. SillyTavern owns persona creation, so the command runs and the
   result is found by diffing the personas map: exactly one new key is the copy. */
const DUPLICATE_COMMANDS = Object.freeze(['persona-duplicate']);

// Built once: the picker sorts on every draw.
const PICKER_COLLATOR = new Intl.Collator(undefined, { numeric: true });

// The screen reset that duplicate, create and copy all end on.
function landOnPersona(avatar) {
    pickerMode = 'target';
    dropFraming();
    moveTarget(avatar);
}

// Runs the duplicate command and answers the one new personas key, or null after saying why.
async function mintPersona(command, label, manyFoundMessage) {
    const before = new Set(Object.keys(freshContext()?.powerUserSettings?.personas ?? {}));
    try {
        await freshContext()?.executeSlashCommandsWithOptions(`/${command} ${quoteArg(label)}`);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] ${command} failed`, e);
    }
    // Polled: SillyTavern finishes after the command resolves.
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

// The checks both ways of minting a persona start with; answers the source and the command.
async function readyToMint(noCommandMessage) {
    if (!(await confirmDropWorking())) return null;
    const s = guardTarget();
    if (!s || refusedWrite(s)) return null;
    const command = pickPersonaCommand(freshContext()?.SlashCommandParser?.commands, DUPLICATE_COMMANDS);
    if (!command) { notify('error', noCommandMessage); return null; }
    return { startAvatar: targetAvatar, command };
}

async function duplicateTargetPersona() {
    const ready = await readyToMint(STRINGS.manager.duplicateNoCommand);
    if (!ready) return;
    const { startAvatar, command } = ready;
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
    // A refusal is reported, not rolled back: the persona exists either way. outside 'discard':
    // SillyTavern's copied description is no outside edit to keep.
    const composed = copy ? saveAndComposeFor(destAvatar, { outside: 'discard' }) : null;
    saveSettings();
    const newName = freshContext()?.powerUserSettings?.personas?.[destAvatar] ?? destAvatar;
    // Onto the copy, which the user will edit next.
    landOnPersona(destAvatar);
    if (copy && !composed) notify('warning', refusalMessage(destAvatar));
    else notify('info', STRINGS.manager.duplicateDone(newName));
    scheduleDraw();
}

/* New persona: minted by duplicating (no other creation path is known), then renamed first,
   since saveAndComposeFor refuses while two personas share a name, then given a blank default
   composition. The image stays inherited. */
async function createTargetPersona() {
    const ready = await readyToMint(STRINGS.manager.createNoCommand);
    if (!ready) return;
    const { startAvatar, command } = ready;
    const name = (await askText(STRINGS.manager.createNamePrompt, ''))?.trim();
    if (!name) return;
    // Checked before anything is minted.
    const taken = Object.values(freshContext()?.powerUserSettings?.personas ?? {}).includes(name);
    if (taken) { notify('error', STRINGS.manager.createNameTaken(name)); return; }
    if (!(await askConfirm(STRINGS.manager.confirmCreatePersona(name)))) return;
    if (!guardTarget(startAvatar)) return;
    const label = freshContext()?.powerUserSettings?.personas?.[startAvatar] ?? startAvatar;
    const destAvatar = await mintPersona(command, label, STRINGS.manager.createManyFound);
    if (!destAvatar) return;
    // List scope only. A refusal is not rolled back; the toast names what the persona got.
    const renamed = await applyPersonaName(destAvatar, name, { toChat: false });
    // Not guardTarget: the new persona exists, whatever happened to the source meanwhile.
    const root = getRoot();
    const seeded = !!root && !root.readOnly;
    let composed = null;
    if (seeded) {
        // The birth log line keeps the pruner off this all-empty entry.
        const persona = ensurePersona(root, destAvatar, freshContext()?.uuidv4);
        addLog(persona, 'persona-create', name, Date.now());
        composed = saveAndComposeFor(destAvatar, { outside: 'discard' });
    }
    saveSettings();
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

// Copy onto a persona SillyTavern already lists, chosen in the picker; our record for it is replaced.
function openCopyPicker() {
    const s = guardTarget();
    if (!s || refusedWrite(s)) return;
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
    if (!s || refusedWrite(s)) return;
    const startAvatar = targetAvatar;
    if (destAvatar === startAvatar) { notify('info', STRINGS.manager.copySameTarget); return; }
    const personas = freshContext()?.powerUserSettings?.personas ?? {};
    if (!Object.hasOwn(personas, destAvatar)) { notify('error', STRINGS.manager.refusalUnknownPersona); return; }
    const fromName = personas[startAvatar] ?? startAvatar;
    const toName = personas[destAvatar] ?? destAvatar;
    if (!(await askConfirm(STRINGS.manager.copyConfirm(fromName, toName)))) return;
    const after = guardTarget(startAvatar);
    if (!after) return;
    // Kept to put the destination back if saveAndComposeFor refuses.
    const previous = after.root.personas?.[destAvatar] ?? null;
    const copy = copyPersonaOnto(after.root, startAvatar, destAvatar,
        freshContext()?.uuidv4, Date.now(), STRINGS.manager.copyLogDetail(fromName));
    if (!copy) { fail(STRINGS.manager.copyFailed); return; }
    const result = saveAndComposeFor(destAvatar);
    if (!result) {
        if (previous) after.root.personas[destAvatar] = previous;
        else delete after.root.personas[destAvatar];
        notify('error', refusalMessage(destAvatar));
        scheduleDraw();
        return;
    }
    saveSettings();
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

    // The drawer only holds the default for new personas.
    box.append(headingFormatRow(persona, writable, reason));

    box.append(actionsRow([
        listSearchButton('compose'),
        actionButton(STRINGS.manager.fullTextOpen, () => openFullText(), true),
        actionButton(STRINGS.manager.fillDefaults, () => doFillDefaults(), writable, '', reason),
        actionButton(STRINGS.manager.resplit, () => doResplit(), writable, STRINGS.manager.resplitTitle, reason),
        actionButton(STRINGS.manager.ownSplit, () => doOwnSplit(), writable, STRINGS.manager.ownSplitTitle, reason),
        itemSelectButton(),
    ]));
    if (lists.compose.open) box.append(listSearchRow('compose'));
    if (itemSelecting) box.append(itemSelectActions(persona, writable, reason));

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
    // The description's own title style is offered only to a persona that has one.
    const formats = validTemplate(persona.headingTemplate) ? [...HEADING_FORMATS, 'own'] : [...HEADING_FORMATS];
    const formatName = key => (key === 'own'
        ? STRINGS.manager.headingFormatOwn(persona.headingTemplate.open)
        : STRINGS.manager.headingFormatNames[key]);
    const select = selectOf('pm-manager-select', formats.map(key => [key, formatName(key)]),
        formats.includes(persona.headingFormat) ? persona.headingFormat : 'none', wanted => {
            if (!formats.includes(wanted)) return;
            const after = guardTarget();
            if (!after) return;
            ensureShape(after.persona).headingFormat = wanted;
            commit('heading-format', formatName(wanted));
        });
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.manager.headingFormatAria);
    row.append(select);
    const box = el('div', 'pm-manager-headingbox');
    box.append(row);
    box.append(noteOf(STRINGS.manager.headingFormatHint));
    if (!writable && reason) box.append(el('div', 'pm-manager-hint', reason));
    return box;
}

/* Versions tab */

// Repairs a dead slot where it is reported; the no-pick option stays selected, as that is the
// slot's real state.
function deadPickSelect(persona, version, row, writable) {
    const options = [['', NO_PICK_LABEL], ...(persona.variants?.[row.sectionId] ?? []).map(variant => [variant.id, variant.label ?? ''])];
    const select = selectOf('pm-manager-select', options, '', value => {
        if (value) setVersionPick(version.id, row.sectionId, value);
    });
    select.disabled = !writable;
    select.setAttribute('aria-label', STRINGS.manager.pickChoiceAria(row.sectionName));
    return select;
}

// Name, combination summary and apply; details, repairs and other actions open below.
function versionRow(persona, version, writable, reason) {
    const key = rowKey('version', version.id);
    const open = expandedRow === key;
    const box = el('div', `pm-manager-version${open ? ' pm-manager-rowopen' : ''}`);
    registerRow(key, box, () => versionRow(persona, version, writable, reason), { persona });
    // Ends of the whole list, not the filtered page.
    const versions = persona.versions ?? [];
    const atTop = versions[0] === version;
    const atEnd = versions[versions.length - 1] === version;

    const head = rowHead();
    head.append(rowName(key, [
        checkMark(version.id === persona.activeVersionId),
        markedText('pm-manager-name', version.name ?? '', listQuery('versions')),
    ], versionSummaryLine(persona, version)));
    // Picks naming something deleted would drop that item, so apply points at the repair.
    const applicable = versionApplicable(persona, version.id);
    // A word, not a thumbnail, so a page of rows fetches no pictures.
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

// Unsaved revisions leaving would discard: applied steps, plus an open edit box that changed
// (read live, as typing since the last draw exists nowhere else).
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

function leaveRevise() {
    return leaveWorking(reviseDirtyCount, STRINGS.manager.reviseConfirmLeave, resetRevise);
}

// A selection boundary as {block element, string offset}. A drag to a block's edge can land on
// the element itself, where offset counts children: 0 is before the text, more is after.
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

// The last valid drag, as offsets into one block's text; null across an item boundary.
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

// Absolute inside .pm-revise, so it scrolls with the text.
function positionRevisePopup(rect) {
    const panel = document.getElementById(PANEL_ID);
    const wrap = panel?.querySelector('.pm-revise');
    const popup = panel?.querySelector('.pm-revise-popup');
    if (!wrap || !popup) return;
    popup.classList.remove('pm-hidden');
    const wrapRect = wrap.getBoundingClientRect();
    // Below the selection, as Android's selection toolbar sits above it.
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
        // One position write per frame; the frame re-reads the live selection.
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
    // Hidden after a grace period: on Android, tapping the popup collapses the selection first.
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
    // The box opens below the whole block, possibly a screen away.
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

function saveRevise() {
    return afterAsking(() => askName(STRINGS.common.newVersionName, ''), (after, name, startAvatar) => {
        const persona = ensureShape(after.persona);
        const undo = replaceVersionUndo(persona);
        const result = makeReplaceVersion(persona, reviseBlocks, reviseTexts, name, freshContext()?.uuidv4, Date.now());
        if (!result) return;
        if (result.skipped.length) notify('warning', STRINGS.manager.reviseSkipped(result.skipped.join(', ')));
        // write: the edited items' picks move to their new choices. A refusal keeps the working
        // copies and undoes the version.
        if (commit('version-create', result.version.name, startAvatar, { write: true })) resetRevise();
        else undoReplaceVersion(persona, result, undo);
    });
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
    // Hidden until a selection positions it.
    wrap.append(button('pm-revise-popup pm-hidden', STRINGS.manager.revisePopup, () => openReviseBox()));
    wrap.append(editorFoot([
        actionButton(STRINGS.manager.reviseUndo, () => undoRevise(), reviseSteps.length > 0 && !reviseEditing),
        actionButton(STRINGS.manager.reviseSaveVersion, () => saveRevise(), writable && !reviseEditing, '', reason),
        actionButton(STRINGS.manager.editorBackToList, () => leaveRevise(), true),
    ]));
    return wrap;
}

function fillVersionList(container, s, writable, reason) {
    container.replaceChildren();
    const persona = s.persona;
    if (!persona) return;
    const versions = persona.versions ?? [];
    const live = new Set(versions.map(version => rowKey('version', version.id)));
    if (expandedRow !== null && !live.has(expandedRow)) expandedRow = null;
    if (!versions.length) { container.append(emptyBlock(STRINGS.manager.noVersionsHere)); return; }

    const ui = lists.versions;
    let list = versions;
    if (ui.open) {
        // Once per version per fill, or the chips and the filter would compose each twice.
        const stamp = modifiedAt(persona);
        const langCache = new Map();
        const langOf = version => {
            if (!langCache.has(version.id)) langCache.set(version.id, versionLanguage(persona, version, stamp));
            return langCache.get(version.id);
        };
        const tagsOf = version => version.tags ?? [];
        list = filterChips(container, ui, versions, list, { langOf, tagsOf, chip: filterChip, redraw: scheduleDraw });
        const query = ui.query.trim();
        if (query) list = rankByQuery(list, query, version => [version.name ?? '', ...tagsOf(version)]);
        if (!list.length) { container.append(emptyBlock(STRINGS.common.searchNoHits)); return; }
    }

    const paged = pageOf(list, ui.page, s.root?.settings?.pageSizeVersions ?? 20);
    ui.page = paged.page;
    // Bindings are described from the asset listing, which this tab loads itself (once:
    // loadAssets sets assetState.avatar before its await).
    if (assetState.avatar !== targetAvatar && !assetState.loading && (persona.versions ?? []).length) {
        void loadAssets(targetAvatar);
    }
    for (const version of paged.slice) container.append(versionRow(persona, version, writable, reason));
    const pager = pagerRow(paged, ui, () => redrawManagerList('versions'));
    if (pager) container.append(pager);
}

function versionsTab(s, writable, reason) {
    // Revise state lives in module variables, so coming back to the tab resumes it.
    if (reviseActive) return reviseScreen(writable, reason);
    const box = el('div', 'pm-manager-tabbody');
    const persona = s.persona;
    if (!persona) return box;
    box.append(actionsRow([
        actionButton(STRINGS.manager.reviseOpen, () => openRevise(), writable, '', reason),
        listSearchButton('versions'),
    ]));
    if (lists.versions.open) box.append(listSearchRow('versions'));
    const list = el('div');
    list.dataset.pmList = 'versions';
    fillVersionList(list, s, writable, reason);
    box.append(list);
    box.append(actionsRow([actionButton(STRINGS.manager.saveCurrentAsVersion, () => saveAsVersion(), writable, '', reason)]));
    return box;
}

/* History tab */

// Clears the change log. Nothing is logged afterwards: the user asked for an empty list.
function clearLog() {
    return afterAsking(s => {
        if (refusedWrite(s)) return false;
        const count = (s.persona.log ?? []).length;
        if (!count) { notify('info', STRINGS.manager.logEmpty); return false; }
        return askConfirm(STRINGS.manager.confirmClearLog(count));
    }, after => {
        // Counted again: a save may have added lines while the question was up.
        const cleared = (after.persona.log ?? []).length;
        after.persona.log = [];
        saveSettings();
        notify('info', STRINGS.manager.logCleared(cleared));
        scheduleDraw();
    });
}

// A choice by id alone, with the item holding it.
function locateVariant(persona, variantId) {
    for (const section of persona?.sections ?? []) {
        const variant = findVariant(persona, section.id, variantId);
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

// The shell keeps the border and clips while the inner wrapper scrolls, so the scrollbar stays
// inside the border.
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
    const found = locateVariant(persona, variantId);
    const current = found?.variant?.text ?? '';

    const toggles = el('div', 'pm-manager-actions');
    for (const [key, label] of [
        ['before', STRINGS.manager.historyModeBefore],
        ['now', STRINGS.manager.historyModeNow],
        ['diff', STRINGS.manager.historyModeDiff],
    ]) {
        const active = historyMode === key;
        // pm-manager-primary, not pm-manager-tab-active: the later button rule in style.css resets
        // that fill, and the pressed toggle's text vanished.
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
        box.append(emptyBlock(STRINGS.manager.historyPickFirst));
    } else {
        const list = persona.history?.[historyVariant] ?? [];
        if (!list.length) {
            box.append(emptyBlock(STRINGS.manager.historyEmpty));
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

// styleClass is resolved once per repaint by the caller, not per row.
function assetRow(item, key, writable, reason, styleClass) {
    const rowId = rowKey('asset', item.label);
    const open = expandedRow === rowId;
    const row = el('div', `pm-manager-assetrow${open ? ' pm-manager-rowopen' : ''}`);
    registerRow(rowId, row, () => assetRow(item, key, writable, reason, styleClass));
    const head = rowHead();
    // An element rather than buildImgHtml's HTML string, which would need DOMPurify:
    // the path is assigned as a property, so there is nothing to sanitise.
    head.append(lazyImg(styleClass, item.path));
    head.append(rowName(rowId, [markedText('pm-manager-name', item.label, listQuery('assets'))]));
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
        box.append(checkRow(label, assetSelected(version, label, labels), writable, () => toggleVersionAsset(version.id, label)));
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
    if (!visibleAssets().length) box.append(emptyBlock(STRINGS.manager.assetNone));
    box.append(uploadRow(writable, reason));
    if (visibleAssets().length) {
        box.append(actionsRow([listSearchButton('assets')]));
        if (lists.assets.open) box.append(listSearchRow('assets'));
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
    const ui = lists.assets;
    // An empty listing hides the search controls, so it also resets the search.
    if (!visibleAssets().length) { Object.assign(ui, listUi()); return; }
    let list = visibleAssets();
    const query = ui.open ? ui.query.trim() : '';
    if (query) {
        list = rankByQuery(list, query, item => [item.label ?? '']);
        if (!list.length) { container.append(emptyBlock(STRINGS.common.searchNoHits)); return; }
    }
    const paged = pageOf(list, ui.page, s.root?.settings?.pageSizeAssets ?? 20);
    ui.page = paged.page;
    const styleClass = assetClass(s.root?.settings?.assetStyle);
    for (const item of paged.slice) container.append(assetRow(item, folderKey, writable, reason, styleClass));
    const pager = pagerRow(paged, ui, () => redrawManagerList('assets'));
    if (pager) container.append(pager);
}

/* Labels tab */

function labelsTab(s) {
    const box = el('div', 'pm-manager-tabbody');
    box.append(actionsRow([listSearchButton('groups')]));
    if (lists.groups.open) box.append(listSearchRow('groups'));
    const list = el('div');
    list.dataset.pmList = 'groups';
    fillGroupList(list, s);
    box.append(list);
    // addLabel answers false on a refusal, which keeps the typed name.
    box.append(newGroupRow({
        placeholder: STRINGS.manager.newGroupPlaceholder, aria: STRINGS.manager.newGroupAria,
        buttonClass: 'pm-manager-btn', buttonLabel: STRINGS.common.create,
        enabled: rosterWritable(getState()), onSubmit: value => addLabel(value),
    }));
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
    if (!labels.length) { container.append(emptyBlock(STRINGS.manager.groupsEmpty)); return; }
    let list = labels;
    const query = listQuery('groups').trim();
    if (query) {
        list = rankByQuery(labels, query, label => [label.name ?? '']);
        if (!list.length) { container.append(emptyBlock(STRINGS.common.searchNoHits)); return; }
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
    if (url) btn.append(lazyImg('pm-manager-targetimg', url));
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

// The picker's view mode: its own setting, separate from the quick panel's.
function pickerViewSelect() {
    const stored = getRoot()?.settings?.pickerViewMode;
    const select = selectOf('pm-manager-select', VIEW_MODES.map(key => [key, STRINGS.quick.viewNames[key]]),
        VIEW_MODES.includes(stored) ? stored : 'list', value => {
            // Refused on a read-only root rather than written and lost.
            const root = getRoot();
            if (!root || root.readOnly) { scheduleDraw(); return; }
            root.settings.pickerViewMode = value;
            saveSettings();
            scheduleDraw();
        });
    select.setAttribute('aria-label', STRINGS.quick.viewCaption);
    return select;
}

// A picker tap: copy onto the persona in copy mode, otherwise make it the target.
function pickPersona(avatar) {
    if (pickerMode === 'copy') copyOnto(avatar);
    else selectTarget(avatar);
}

function pickerTile(ctx, avatar, name, query, named) {
    const tile = personaTileOf(ctx, { avatar, name, query, named, active: avatar === targetAvatar, pool: pickerThumbs });
    tile.addEventListener('click', () => pickPersona(avatar));
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
    if (lists.picker.open) box.append(listSearchRow('picker'));
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
    const ui = lists.picker;
    const query = ui.open ? ui.query.trim() : '';
    if (query) {
        entries = rankByQuery(entries, query, ([avatar, name]) => [String(name ?? ''), ...(getPersona(root, avatar)?.tags ?? [])]);
        if (!entries.length) { container.append(emptyBlock(STRINGS.common.searchNoHits)); return; }
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
    } else {
        for (const [avatar, name] of paged.slice) {
            const row = el('div', 'pm-row pm-manager-personarow');
            const url = thumbnailUrl(ctx, avatar);
            if (url) row.append(pickerThumbs.take('pm-quickbar-rowimg', url));
            row.append(markedText('pm-manager-name', String(name ?? ''), query));
            // getPersona only reads: listing must not create entries.
            if (!getPersona(root, avatar)) row.append(el('span', 'pm-manager-count', STRINGS.manager.notAdoptedTag));
            row.append(checkMark(avatar === targetAvatar));
            makeRowActivatable(row, () => pickPersona(avatar));
            container.append(row);
        }
    }
    const pager = pagerRow(paged, ui, () => redrawManagerList('picker'));
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
    commit('section-move', findSection(persona, sectionId)?.name ?? '');
}

function headerRow(ctx) {
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
    if (drawHold.wait(panel)) return;

    // One read for the whole draw; drawing is synchronous and no handler keeps either.
    const ctx = freshContext();
    const s = targetState();

    // .pm-scroll scrolls inside the clipped panel and emptying it clamps scrollTop to 0, so each
    // screen's offset is saved and restored, as is editor typing: the draw a blur releases would
    // otherwise rebuild the textarea from the stored text.
    const oldScroll = panel.querySelector('.pm-scroll');
    const screen = screenKey();
    if (lastScreen !== null && oldScroll) scrollByScreen.set(lastScreen, oldScroll.scrollTop);
    const scrollTop = screen === lastScreen ? (oldScroll?.scrollTop ?? 0) : (scrollByScreen.get(screen) ?? 0);
    lastScreen = screen;
    const typed = editorDirty ? fieldSnapshot(panel.querySelector('.pm-manager-editor-text')) : null;
    // The revise edit box too, also parked in module state: the restore below only bridges
    // draws that both show the box.
    const reviseField = panel.querySelector('.pm-revise-input');
    const reviseTyped = fieldSnapshot(reviseField);
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
    // Header, tabs and band stay outside .pm-scroll: as a sticky bar inside it, content
    // showed through the theme's translucent tint.
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
        // Beside 관리 시작: how adopting takes the description in (the drawer's same setting).
        body.append(adoptModeRow(s, writable, ['pm-row pm-manager-headingrow', 'pm-manager-name', 'pm-manager-select'], scheduleDraw));
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
    if (typed) restoreField(panel.querySelector('.pm-manager-editor-text'), typed);
    if (reviseTyped) restoreField(panel.querySelector('.pm-revise-input'), reviseTyped);
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
    // openManager, which resets the lists.
    if (detail.search && lists[detail.tab]) {
        lists[detail.tab].open = true;
        focusSearch = detail.tab;
        scheduleDraw();
    }
}

// Called by the settings screen after an import replaces the root: the listing and the drafts
// describe the old tree, and drafts would resurface old text over imported bodies that reuse ids.
// The modal hides the import button; the redraw is a safeguard.
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
