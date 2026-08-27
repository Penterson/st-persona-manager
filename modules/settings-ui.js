// The extension settings screen.
//
// Attached to #extensions_settings2 as an inline drawer, next to every other
// extension's. The drawer toggle is ours rather than SillyTavern's delegated
// .inline-drawer-toggle handler: that handler has never been measured on this
// build, and a settings screen that cannot be opened at all is a worse outcome
// than one that opens without the slide animation. The surrounding classes are
// still SillyTavern's, so the header sits in line with its neighbours.
//
// Same rule as the other two screens: no handler here closes over a context, a
// state snapshot or a node. Everything is looked up again when it runs, which is
// why refreshSettings queries the panel rather than keeping the fields it built.
import { MODULE_NAME, makeId, pruneEmpty, HEADING_FORMATS, TILE_SHAPES } from './store.js';
import { getRoot, getState, readUsageBytes, refresh } from './state.js';
import { freshContext, getPrecisePath, avatarBlockReport } from './ctx.js';
import { addLog } from './history.js';
import { resolveFolderKey, buildImgHtml } from './assets.js';
import { el, notify, askConfirm, blockDrawerClose, isComposingKey } from './quickbar.js';
import { invalidateManagerCaches } from './manager.js';
import { clampSetting, SETTING_RANGES, serializeRoot, parseImportedRoot } from './manager-pure.js';
// Every sentence the user reads in this drawer comes from there.
import { STRINGS } from './strings.js';

// index.js removes this id on teardown as a belt and braces measure, so the two
// have to agree on it.
const PANEL_ID = `${MODULE_NAME}_settings`;
const CONTENT_ID = `${PANEL_ID}_content`;
const HOST_ID = 'extensions_settings2';

let mounted = false;
let cleanups = [];

function track(list, target, type, fn, options) {
    target.addEventListener(type, fn, options);
    list.push(() => target.removeEventListener(type, fn, options));
}

function runCleanups(list) {
    for (const off of list.splice(0)) {
        try { off(); } catch (e) { console.warn(`[${MODULE_NAME}] cleanup failed`, e); }
    }
}

function save() {
    freshContext()?.saveSettingsDebounced?.();
    // The quick bar reconciles its icon on this event and the manager redraws on
    // it. SillyTavern's own SETTINGS_UPDATED only comes back after its debounce, so
    // without this, flipping 입력창 아이콘 표시 looks like it did nothing for as long
    // as that takes. Dispatching costs one synchronous pass over three listeners.
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('pm:changed'));
}

function panel() {
    return typeof document === 'undefined' ? null : document.getElementById(PANEL_ID);
}

/* Field builders */

function rowOf(labelText, control, hint) {
    const row = el('div', 'pm-settings-row');
    const label = el('label', 'pm-settings-label');
    label.append(el('span', 'pm-settings-labeltext', labelText));
    label.append(control);
    row.append(label);
    if (hint) row.append(el('div', 'pm-settings-hint', hint));
    return row;
}

function toggleField(key, labelText, hint) {
    const input = el('input', 'pm-settings-check');
    input.type = 'checkbox';
    input.dataset.pmKey = key;
    input.addEventListener('change', () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        root.settings[key] = input.checked;
        save();
        syncFields();
    });
    return rowOf(labelText, input, hint);
}

// A number field that clamps on every way out of it. SETTING_RANGES states the
// ranges and clampSetting owns them, so a value pasted in, typed past the end or
// left empty comes back inside the range rather than being written through: a NaN
// stored here reads back as "no cap at all", which is the one outcome the history
// caps exist to prevent.
function numberField(key, labelText, hint) {
    const range = SETTING_RANGES[key];
    const input = el('input', 'pm-settings-number');
    input.type = 'number';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.inputMode = 'numeric';
    input.dataset.pmKey = key;
    const apply = () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        const value = clampSetting(key, input.value);
        root.settings[key] = value;
        // Written back into the field so the user sees what was actually stored
        // rather than the out of range number they typed.
        input.value = String(value);
        save();
        syncFields();
    };
    input.addEventListener('change', apply);
    // There is nothing to compose in a numeric field on most
    // keyboards, but the guard is on every keydown this extension listens to, so
    // that the rule has no exceptions to remember.
    input.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); apply(); input.blur(); }
    });
    return rowOf(labelText, input, hint);
}

// The tile column count: a fixed choice list, because a free
// number would invite widths no phone can draw (1 or 40 columns).
function tileColumnsField() {
    const select = el('select', 'pm-settings-select');
    select.dataset.pmKey = 'rosterTileColumns';
    for (const value of [0, 2, 3, 4, 5, 6]) {
        const option = el('option', null, value === 0 ? STRINGS.settings.tileColumnsAuto : String(value));
        option.value = String(value);
        select.append(option);
    }
    select.addEventListener('change', () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        root.settings.rosterTileColumns = Number(select.value) || 0;
        save();
        syncFields();
    });
    return rowOf(STRINGS.settings.rosterTileColumns, select, STRINGS.settings.rosterTileColumnsHint);
}

function styleField() {
    const select = el('select', 'pm-settings-select');
    select.dataset.pmKey = 'assetStyle';
    for (const [value, label] of [
        ['plain', STRINGS.settings.assetStylePlain],
        ['bordered', STRINGS.settings.assetStyleBordered],
        ['polaroid', STRINGS.settings.assetStylePolaroid],
    ]) {
        const option = el('option', null, label);
        option.value = value;
        select.append(option);
    }
    select.addEventListener('change', () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        root.settings.assetStyle = select.value;
        save();
        syncFields();
    });
    return rowOf(STRINGS.settings.assetStyle, select, STRINGS.settings.assetStyleHint);
}

// Only what a NEWLY adopted persona starts with: the format itself
// lives on each persona, and the manager's 편집 tab is where an existing one is
// changed. A global switch here would silently do nothing for every persona the
// user already has, which is the shape of control that reads as broken.
// The roster tile shape (user request). Same three-option select shape as the
// asset style and the heading format, so the drawer keeps one control vocabulary.
function tileShapeField() {
    const select = el('select', 'pm-settings-select');
    select.dataset.pmKey = 'rosterTileShape';
    for (const value of TILE_SHAPES) {
        const option = el('option', null, STRINGS.settings.tileShapeNames[value]);
        option.value = value;
        select.append(option);
    }
    select.addEventListener('change', () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        if (!TILE_SHAPES.includes(select.value)) { syncFields(); return; }
        root.settings.rosterTileShape = select.value;
        save();
        syncFields();
    });
    return rowOf(STRINGS.settings.rosterTileShape, select, STRINGS.settings.rosterTileShapeHint);
}

function headingFormatField() {
    const select = el('select', 'pm-settings-select');
    select.dataset.pmKey = 'defaultHeadingFormat';
    for (const value of HEADING_FORMATS) {
        const option = el('option', null, STRINGS.manager.headingFormatNames[value]);
        option.value = value;
        select.append(option);
    }
    select.addEventListener('change', () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        if (!HEADING_FORMATS.includes(select.value)) { syncFields(); return; }
        root.settings.defaultHeadingFormat = select.value;
        save();
        syncFields();
    });
    return rowOf(STRINGS.settings.defaultHeadingFormat, select, STRINGS.settings.defaultHeadingFormatHint);
}

function templateField() {
    const box = el('div', 'pm-settings-row');
    box.append(el('div', 'pm-settings-labeltext', STRINGS.settings.assetTemplate));
    const area = el('textarea', 'pm-settings-textarea');
    area.rows = 4;
    area.dataset.pmKey = 'assetPromptTemplate';
    area.setAttribute('aria-label', STRINGS.settings.assetTemplate);
    // change fires when the field is left, which is the moment the user is done
    // with it. An input handler would ask SillyTavern to save on every keystroke.
    area.addEventListener('change', () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        root.settings.assetPromptTemplate = area.value;
        save();
    });
    // There is deliberately no keydown handler here. Enter has to insert a newline
    // in this field, so there is nothing for a hangul composition commit (mobile
    // rule 5) to fire by accident; a guard that guards nothing only suggests there
    // is a control here that there is not.
    box.append(area);
    box.append(el('div', 'pm-settings-hint', STRINGS.settings.assetTemplateHint));
    return box;
}

/* Buttons */

function buttonOf(label, onClick, writes) {
    const btn = el('button', 'pm-manager-btn', label);
    btn.type = 'button';
    if (writes) btn.dataset.pmWrites = '1';
    // Click only.
    btn.addEventListener('click', onClick);
    return btn;
}

// The import button, with the file picker it needs behind it. The
// input is in the tree rather than made on demand so syncFields can take it dead
// along with every other control that writes, and .pm-settings .pm-hidden hides it:
// a bare file input is a control the phone draws as a second unexplained button.
function appendImportControl(actions) {
    const input = el('input', 'pm-hidden');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.dataset.pmWrites = '1';
    input.setAttribute('aria-label', STRINGS.settings.importFileAria);
    input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null;
        // Cleared before the read so the same file can be picked again after a
        // refusal: an input still holding the previous choice fires no change event.
        input.value = '';
        if (file) doImportSettings(file);
    });
    // Both straight into the row: the button is a flex item like every other one,
    // and the input beside it is display none, so it takes no space at all.
    actions.append(buttonOf(STRINGS.settings.importSettings, () => input.click(), true), input);
}

function doPrune() {
    const root = getRoot();
    if (!root || root.readOnly) { notify('error', STRINGS.settings.pruneReadOnly); return; }
    // An entry with no sections, no variants, no history and
    // no assets is a shell nobody asked for, and shells are what filled this user's
    // settings.json once already.
    const removed = pruneEmpty(root);
    save();
    refreshSettings();
    notify('info', removed.length ? STRINGS.settings.pruneDone(removed.length) : STRINGS.settings.pruneNothing);
}

async function doClearHistory() {
    const root = getRoot();
    if (!root || root.readOnly) { notify('error', STRINGS.settings.clearHistoryReadOnly); return; }
    if (!(await askConfirm(STRINGS.settings.confirmClearHistory))) return;
    // Read again on the other side of the question: the root object may have been
    // replaced by a settings reload while the popup was up.
    const after = getRoot();
    if (!after || after.readOnly) { notify('error', STRINGS.settings.clearHistoryReadOnly); return; }
    const now = Date.now();
    let cleared = 0;
    for (const persona of Object.values(after.personas ?? {})) {
        let had = 0;
        for (const list of Object.values(persona.history ?? {})) had += (list ?? []).length;
        if (!had) continue;
        persona.history = {};
        cleared += had;
        // Only the personas that actually lost something get a line. Logging on the
        // rest would make every untouched entry non-empty and put it out of reach
        // of the pruner for good.
        addLog(persona, 'history-clear', STRINGS.settings.clearHistoryLog(had), now);
    }
    save();
    refreshSettings();
    notify('info', cleared ? STRINGS.settings.clearHistoryDone(cleared) : STRINGS.settings.clearHistoryNothing);
}

function openManagerScreen() {
    const detail = { tab: 'compose', handled: false };
    document.dispatchEvent(new CustomEvent('pm:open-manager', { detail }));
    if (!detail.handled) notify('error', STRINGS.settings.openManagerFailed);
}

/* Export and import */

// Hands the browser a file. This runs in the SillyTavern page, not in a sandboxed
// frame, so a download an anchor starts is a download the user gets; the anchor is
// taken back out immediately, because a link left in the drawer is a control the
// user can tap again with a URL that is about to be revoked.
function downloadJson(filename, text) {
    if (typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
        notify('error', STRINGS.settings.noDownload);
        return false;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = filename;
    // The outside-tap block applies to this synthetic click too: without the block
    // it bubbles to document, SillyTavern reads it as a tap outside a drawer, and
    // the extensions drawer the user is standing in closes on the spot. Parked
    // inside our own panel when it exists, which is blocked as a whole anyway.
    blockDrawerClose(link);
    (panel() ?? document.body).append(link);
    link.click();
    link.remove();
    // Revoked on the next turn rather than on this line: Chromium starts the
    // download asynchronously, and a URL revoked in the same task can lose that
    // race. Only the string outlives this call, and only until the timer runs.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }, 0);
    return true;
}

function stamp() {
    // Local date, so the name matches the day the user thinks they made it on.
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// The optional regex export. What it can be is limited, and the
// limit is the point: our renderer resolves a bare {{pimg::파일명}} against
// whichever persona is active when the message is drawn, and a static regex has no
// way to ask that question. character-assets solves it with a {{charkey}} macro
// whose behaviour this extension refuses to depend on. So the exported script is
// pinned to ONE folder, the active persona's at the moment of the export, and the
// screen says so rather than shipping a file that quietly shows the wrong pictures.
function regexScript(folderKey, style) {
    return {
        // SillyTavern's own regex script shape. These field names are not measured
        // on this build, which is why the hint calls the file a starting point.
        id: makeId(freshContext()?.uuidv4),
        scriptName: STRINGS.settings.regexScriptName(folderKey),
        findRegex: '/\\{\\{pimg::(.*?)\\}\\}/g',
        // The same HTML our renderer builds, with the path spelled out instead of
        // looked up. buildImgHtml escapes the attribute values, and $1 is the
        // filename the pattern captured.
        replaceString: buildImgHtml(`/characters/${folderKey}/$1`, style),
        trimStrings: [],
        placement: [1, 2],
        disabled: false,
        // Display only, exactly like our renderer: the stored message keeps the tag
        // the way it was written, so the next turn the model sees its own text.
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

function doExportRegex() {
    const root = getRoot();
    if (!root) { notify('error', STRINGS.settings.noRoot); return; }
    const avatar = getState()?.avatar ?? null;
    if (!avatar) { notify('error', STRINGS.settings.noActivePersona); return; }
    // resolveFolderKey only reads, so asking here cannot create an entry for a
    // persona the user never adopted.
    const key = resolveFolderKey(root, avatar);
    const script = regexScript(key, root.settings?.assetStyle ?? 'plain');
    if (!downloadJson(`persona-manager-regex-${key}.json`, JSON.stringify(script, null, 2))) return;
    notify('info', STRINGS.settings.regexExported(key));
}

function doExportSettings() {
    const root = getRoot();
    if (!root) { notify('error', STRINGS.settings.noRoot); return; }
    if (!downloadJson(`persona-manager-${stamp()}.json`, serializeRoot(root))) return;
    notify('info', STRINGS.settings.settingsExported);
}

async function doImportSettings(file) {
    const root = getRoot();
    if (!root || root.readOnly) { notify('error', STRINGS.settings.importReadOnly); return; }
    if (typeof file?.text !== 'function') { notify('error', STRINGS.settings.noFileRead); return; }
    let text;
    try {
        text = await file.text();
    } catch (e) {
        notify('error', STRINGS.settings.importReadFailed(String(e?.message ?? e)));
        return;
    }
    // Judged before the question is asked, so the user is never walked through a
    // confirmation that ends in a refusal.
    const parsed = parseImportedRoot(text);
    if (!parsed.ok) { notify('error', parsed.message); return; }
    if (!(await askConfirm(STRINGS.settings.confirmImport))) return;
    // Read again on the other side of the question: the root object may have been
    // replaced by a settings reload while the popup was up.
    const ctx = freshContext();
    if (!ctx) { notify('error', STRINGS.settings.importNoContext); return; }
    const after = getRoot();
    if (!after || after.readOnly) { notify('error', STRINGS.settings.importNotApplied); return; }
    ctx.extensionSettings[MODULE_NAME] = parsed.root;
    ctx.saveSettingsDebounced?.();
    // Everything anyone was holding describes the tree that just went away, so the
    // shared cache is rebuilt, the manager's own caches (its asset listing and the
    // unsaved drafts) are dropped, and every open screen is told to redraw.
    refresh();
    invalidateManagerCaches();
    save();
    refreshSettings();
    notify('success', STRINGS.settings.importDone);
}

/* Refresh */

// Reads every value back out of settings and puts the fields in step with it.
// The panel is queried rather than remembered: a node kept in module state would
// outlive the screen that built it, which is the rule the other two screens state
// at their top.
function syncFields() {
    const box = panel();
    if (!box) return;
    const root = getRoot();
    const settings = root?.settings ?? {};
    const readOnly = !!root?.readOnly;

    for (const node of box.querySelectorAll('[data-pm-key]')) {
        // Never overwrite the field the user is standing in. A refresh triggered by
        // a sibling control would otherwise replace a half typed template.
        if (node === document.activeElement) continue;
        const key = node.dataset.pmKey;
        if (node.type === 'checkbox') node.checked = !!settings[key];
        else node.value = String(settings[key] ?? '');
    }
    // A root a newer build owns is opened read only rather than
    // rewritten, so every control that writes goes dead and the reason is on
    // screen. 관리자 열기 and 사용량 새로고침 write nothing and stay available.
    for (const node of box.querySelectorAll('[data-pm-key], [data-pm-writes]')) {
        node.disabled = readOnly;
        node.classList.toggle('pm-disabled', readOnly);
    }
    box.querySelector('.pm-settings-readonly')?.classList.toggle('pm-hidden', !readOnly);
}

/* 페르소나 식별 줄 (device: Termux, 콘솔 없음).

   Two lines. The first says which route named the active persona and therefore
   whether two same-named personas can be edited; the second is evidence, and it
   only appears when the answer is one that could be improved. When the screen
   route came up empty, the classes SillyTavern puts on its own avatar tiles are
   the one fact needed to teach it the right marker, and a screenshot of this row
   carries that fact without a console. */
function refreshIdentify() {
    const box = panel();
    const line = box?.querySelector('.pm-settings-identify');
    if (!line) return;
    const s = getState();
    const source = s?.source ?? 'none';
    const how = STRINGS.settings.identifySources[source] ?? source;
    const direct = source === 'precise' || source === 'dom';
    const detail = source === 'precise' ? (getPrecisePath() ?? '') : '';
    line.textContent = STRINGS.settings.identifyLine(how, detail);
    line.classList.toggle('pm-settings-warn', !direct);

    const evidence = box.querySelector('.pm-settings-identify-why');
    if (!evidence) return;
    // Only where it can still be acted on: a direct answer needs no evidence.
    if (direct) { evidence.textContent = ''; evidence.classList.add('pm-hidden'); return; }
    const report = avatarBlockReport(typeof document === 'undefined' ? null : document);
    evidence.textContent = report.found && report.count
        ? STRINGS.settings.identifyTiles(report.count, report.classes.join(' | '))
        : STRINGS.settings.identifyNoTiles;
    evidence.classList.remove('pm-hidden');
}

// The usage number belongs on this screen only, and this is the
// only place that asks for it. It stringifies the whole tree, so it runs when the
// drawer is opened, when the user asks again, and after the two buttons that
// change how much is stored. Never on an event.
function refreshSettings() {
    const box = panel();
    if (!box) return;
    syncFields();
    refreshIdentify();
    const usage = box.querySelector('.pm-settings-usage');
    if (!usage) return;
    const bytes = readUsageBytes();
    const warnBytes = getRoot()?.settings?.warnBytes;
    const warn = typeof warnBytes === 'number' && bytes > warnBytes;
    usage.textContent = STRINGS.settings.usageBytes((bytes / 1024).toFixed(1));
    // The warning carries a theme colour AND a weight change, because colour alone
    // is not a signal everyone can read: the same rule that governs how the
    // selected row is shown.
    usage.classList.toggle('pm-settings-warn', warn);
}

/* Lifecycle */

function buildPanel() {
    const box = el('div', 'inline-drawer pm-settings');
    box.id = PANEL_ID;

    // The drawer gets the same grid language as the two panels: the header is a
    // filled block with the type knocked out, the grain sits under it, and the
    // repeated-word band names the screen. Reported as "확장 설정 부분에는 디자인
    // 적용 안됨": it had only inherited the rules, never the shapes.
    // pm-mass is NOT here. It is added while the drawer is open and taken off when
    // it closes (toggleDrawer below). Collapsed, this row sits in SillyTavern's own
    // extension list among a dozen plain rows, and a filled ink block there reads as
    // one extension shouting rather than as this one's design. Reported from the
    // device as 통일성을 해쳐 보기 좋지 않음.
    const header = el('div', 'inline-drawer-header pm-settings-header');
    header.append(el('b', null, STRINGS.settings.title));
    // SillyTavern's own drawer chevron, by its own class names. Every other
    // extension in that list draws this exact element, and ours was drawing a
    // text ▼ instead: the one thing in the row that did not match its neighbours
    // (device report, 2026-08-27). fa-solid comes from SillyTavern's own
    // FontAwesome, which is already loaded or none of the other rows would have
    // an icon either.
    const caret = el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
    header.append(caret);

    // The content carries NO SillyTavern class at all, and is collapsed and
    // expanded by an INLINE display. Both halves are lessons from the device
    // ("안 열림" persisted through 0.3.1): a class of ST's gives every build's
    // stylesheet and drawer script a handle on our content, and whichever of
    // display rules or slideToggle grabs it, the drawer reads as dead. With our
    // own class only and an inline style, nothing outside this file owns it.
    const content = el('div', 'pm-settings-content pm-grain');
    content.id = CONTENT_ID;
    content.style.display = 'none';
    const toggleDrawer = () => {
        const collapsed = content.style.display !== 'none';
        content.style.display = collapsed ? 'none' : 'block';
        // The same two classes SillyTavern swaps on its own drawers.
        caret.classList.toggle('fa-circle-chevron-down', collapsed);
        caret.classList.toggle('down', collapsed);
        caret.classList.toggle('fa-circle-chevron-up', !collapsed);
        caret.classList.toggle('up', !collapsed);
        header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        // The panel's own look belongs to the panel. Closed, this is one row in
        // SillyTavern's list and looks like the rest of them.
        header.classList.toggle('pm-mass', !collapsed);
        // The usage number is read when this screen is opened and
        // when the user asks for it again, never on a timer and never per event.
        if (!collapsed) refreshSettings();
    };
    // Click only, never touchstart. The propagation stops HERE,
    // not only at the box: ST's own drawer handling is delegated at the
    // document, and a click that bubbles past us can reach a delegate that
    // toggles the same drawer a second time, folding it shut in the same tap
    // (the second suspect behind the dead drawer).
    header.addEventListener('click', e => { e.stopPropagation(); toggleDrawer(); });
    // A div with role=button is only a button if it can be reached and fired the
    // way one is. Without these the drawer is unopenable from a keyboard, which is
    // how the icon in the send form is reached too (see buildButton in quickbar.js).
    header.tabIndex = 0;
    header.addEventListener('keydown', e => {
        // A hangul composition commits with an Enter whose keyCode is
        // 229, and firing on that opens the drawer while the user is still typing.
        if (isComposingKey(e)) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDrawer(); }
    });
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', 'false');
    // Names what the header opens, so a screen reader can say where the state it
    // just announced applies.
    header.setAttribute('aria-controls', CONTENT_ID);

    const readOnlyBanner = el('div', 'pm-manager-banner pm-manager-warn pm-settings-readonly pm-hidden');
    readOnlyBanner.append(el('div', 'pm-manager-banner-text', STRINGS.settings.readOnlyBanner));
    content.append(readOnlyBanner);
    // The band, built the same way the manager's is (three spans, outer two
    // ghosted and aria-hidden). Local rather than imported: settings-ui already
    // imports el from quickbar, and one more cross-module edge for four lines of
    // markup is not worth the coupling.
    const band = el('div', 'pm-band');
    for (const ghost of [true, false, true]) {
        const span = el('span', `pm-band-word${ghost ? ' pm-band-ghost' : ''}`, STRINGS.settings.bandWord);
        if (ghost) span.setAttribute('aria-hidden', 'true');
        band.append(span);
    }
    content.append(band);

    // Named for what it does. It was labelled 확장 사용, which promises a master
    // switch this extension deliberately does not have (see store.js): the only
    // thing it reaches is the quick bar icon, and its own hint said so. Turning the
    // extension off is SillyTavern's own extension manager's job.
    content.append(toggleField('showQuickBar', STRINGS.settings.showQuickBar, STRINGS.settings.showQuickBarHint));
    // Two switches, not one three way choice. Either can be on by
    // itself, and both off is the shipped default.
    content.append(toggleField('rosterShowVersionCount', STRINGS.settings.rosterShowVersionCount, STRINGS.settings.rosterShowVersionCountHint));
    content.append(toggleField('rosterShowVersionNames', STRINGS.settings.rosterShowVersionNames, STRINGS.settings.rosterShowVersionNamesHint));
    // Tile columns and the three page sizes. 열 수 and 줄 수 are one
    // setting in two fields (either left at 0 falls back to the page size), so they
    // sit together. 타일 모양 used to stand between them.
    content.append(tileColumnsField());
    content.append(numberField('rosterTileRows', STRINGS.settings.rosterTileRows, STRINGS.settings.rosterTileRowsHint));
    content.append(tileShapeField());
    content.append(numberField('pageSizeRoster', STRINGS.settings.pageSizeRoster, STRINGS.settings.pageSizeHint));
    content.append(numberField('pageSizeAssets', STRINGS.settings.pageSizeAssets, ''));
    content.append(numberField('pageSizeVersions', STRINGS.settings.pageSizeVersions, ''));
    content.append(numberField('historyPerVariant', STRINGS.settings.historyPerVariant, STRINGS.settings.historyPerVariantHint));
    content.append(numberField('historyMaxBytes', STRINGS.settings.historyMaxBytes, STRINGS.settings.historyMaxBytesHint));
    content.append(numberField('historyMaxDays', STRINGS.settings.historyMaxDays, STRINGS.settings.historyMaxDaysHint));
    content.append(numberField('historyCoalesceMinutes', STRINGS.settings.historyCoalesceMinutes, STRINGS.settings.historyCoalesceMinutesHint));
    // 언어별 이름 자동 적용 (user request). Beside the other two persona-wide
    // switches rather than with the asset ones: it changes what the persona is
    // called, which is what the roster and the chat show.
    content.append(toggleField('autoLocalName', STRINGS.settings.autoLocalName, STRINGS.settings.autoLocalNameHint));
    content.append(toggleField('injectAssetMacros', STRINGS.settings.injectAssetMacros, STRINGS.settings.injectAssetMacrosHint));
    content.append(headingFormatField());
    content.append(templateField());
    content.append(styleField());

    content.append(el('div', 'pm-settings-identify', STRINGS.settings.identify));
    content.append(el('div', 'pm-settings-identify-why pm-hidden'));

    const usage = el('div', 'pm-settings-usage', STRINGS.settings.usage);
    content.append(usage);

    const actions = el('div', 'pm-manager-actions pm-settings-actions');
    actions.append(buttonOf(STRINGS.settings.refreshUsage, () => refreshSettings(), false));
    actions.append(buttonOf(STRINGS.settings.pruneEmpty, () => doPrune(), true));
    actions.append(buttonOf(STRINGS.settings.clearHistory, () => doClearHistory(), true));
    // The three owed controls. Exporting writes nothing here, so both
    // export buttons stay available on a read only root; importing replaces
    // everything, so it goes dead with the rest.
    actions.append(buttonOf(STRINGS.settings.exportRegex, () => doExportRegex(), false));
    actions.append(buttonOf(STRINGS.settings.exportSettings, () => doExportSettings(), false));
    appendImportControl(actions);
    actions.append(buttonOf(STRINGS.settings.openManager, () => openManagerScreen(), false));
    content.append(actions);
    content.append(el('div', 'pm-settings-hint', STRINGS.settings.regexHint));
    content.append(el('div', 'pm-settings-hint', STRINGS.settings.importHint));

    box.append(header, content);
    // The outside-tap block, applied here for the same reason as everywhere else: our
    // clicks are ours, and SillyTavern's drawer machinery must not read them as a
    // tap that landed outside one of its own panels.
    blockDrawerClose(box);
    return box;
}

export function mountSettings() {
    if (mounted || typeof document === 'undefined') return;
    // ST lays its Extensions panel out as two columns, #extensions_settings and
    // #extensions_settings2, and not every build has both. A missing second
    // column made this screen silently not exist, which from the outside is
    // indistinguishable from "the drawer will not open" (device report). Fall
    // back through the known hosts before giving up.
    const host = document.getElementById(HOST_ID)
        ?? document.getElementById('extensions_settings')
        ?? document.querySelector('.extensions_settings');
    // Not an error worth a toast: the settings drawer is built by SillyTavern and
    // may simply not exist yet on a build that lays its screens out differently.
    if (!host) { console.warn(`[${MODULE_NAME}] #${HOST_ID} not found, settings screen skipped`); return; }
    document.getElementById(PANEL_ID)?.remove();
    host.append(buildPanel());
    mounted = true;
    // The root can turn read only, and showQuickBar can be flipped from the quick
    // panel, so the screen follows the same state changes the others do. Fields
    // only, never the usage number: that one stringifies the whole tree, and this
    // event fires on every persona switch and every settings save. It also skips
    // whichever field has the focus, so it cannot interrupt typing.
    track(cleanups, document, 'pm:changed', () => syncFields());
    // Deliberately nothing else. Mounting used to end with refreshSettings(), which
    // stringifies the whole tree (5.2ms measured on this desktop, for a 2.7MB
    // settings.json) at boot, to fill in a drawer that starts collapsed and that
    // most sessions never open. The drawer computes it when it opens, and every
    // pm:changed syncs the fields, so nothing is left stale by not doing it here.
}

export function unmountSettings() {
    runCleanups(cleanups);
    if (typeof document !== 'undefined') document.getElementById(PANEL_ID)?.remove();
    mounted = false;
}
