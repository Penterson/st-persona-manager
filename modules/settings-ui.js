// The settings screen: an inline drawer among the other extensions' settings, toggled by its own
// handler (see buildPanel). Handlers look everything up when they run.
import { MODULE_NAME, makeId, pruneEmpty, HEADING_FORMATS, TILE_SHAPES, ADOPT_MODES } from './store.js';
import { getRoot, getState, readUsageBytes, refresh, autoAbsorbOutside } from './state.js';
import { freshContext, getPrecisePath, avatarBlockReport } from './ctx.js';
import { addLog, expireOldHistory, enforceGlobalBudget } from './history.js';
import { resolveFolderKey, buildImgHtml, withoutBackups } from './assets.js';
import { notify, askConfirm, scheduleAutoName, cancelAutoName } from './quickbar.js';
import { el, track, runCleanups, blockDrawerClose, isComposingKey, selectOf } from './dom.js';
import { invalidateManagerCaches } from './manager.js';
import { clampSetting, SETTING_RANGES, TILE_COLUMN_CHOICES, serializeRoot, parseImportedRoot } from './manager-pure.js';
import { STRINGS } from './strings.js';

// index.js also removes this id on teardown, so the two must agree on it.
const PANEL_ID = `${MODULE_NAME}_settings`;
const CONTENT_ID = `${PANEL_ID}_content`;
const HOST_ID = 'extensions_settings2';

let mounted = false;
let cleanups = [];

function save() {
    freshContext()?.saveSettingsDebounced?.();
    // The panels redraw on pm:changed at once; ST's SETTINGS_UPDATED waits for its debounce.
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('pm:changed'));
}

function panel() {
    return typeof document === 'undefined' ? null : document.getElementById(PANEL_ID);
}

// Applies a lowered per-variant cap to existing history (history.js only enforces it on a
// snapshot), oldest first.
function trimPerVariant(root, settings, now = Date.now()) {
    const cap = Number(settings?.historyPerVariant ?? 0);
    if (!Number.isFinite(cap) || cap < 0) return 0;
    let dropped = 0;
    for (const persona of Object.values(root?.personas ?? {})) {
        const history = persona?.history;
        if (!history || typeof history !== 'object') continue;
        let mine = 0;
        for (const [variantId, list] of Object.entries(history)) {
            if (!Array.isArray(list) || list.length <= cap) continue;
            mine += list.length - cap;
            if (cap === 0) delete history[variantId];
            else list.splice(0, list.length - cap);
        }
        // Deleted history always gets a log line, or it reads as data loss.
        if (mine) addLog(persona, 'history-evicted', STRINGS.manager.logDetails.trimmed(mine), now);
        dropped += mine;
    }
    return dropped;
}

// Whether a new history cap can delete stored history. historyMaxDays 0 means never expire.
const HISTORY_CAPS = new Set(['historyMaxBytes', 'historyMaxDays', 'historyPerVariant']);

function tightensCap(key, previous, next) {
    if (!HISTORY_CAPS.has(key) || typeof previous !== 'number') return false;
    if (key === 'historyMaxDays') {
        if (next === 0) return false;
        return previous === 0 || next < previous;
    }
    return next < previous;
}

/* Field builders */

function sectionHead(text) {
    return el('div', 'pm-settings-section', text);
}

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
        // Auto naming acts on the chat already on screen instead of waiting for a message.
        if (key === 'autoLocalName') {
            if (input.checked) scheduleAutoName();
            else cancelAutoName();
        }
        save();
        // A pending outside edit is taken in as soon as the switch goes on.
        if (key === 'autoAbsorbOutside' && input.checked && autoAbsorbOutside()?.ok) {
            document.dispatchEvent(new CustomEvent('pm:changed'));
        }
        syncFields();
    });
    return rowOf(labelText, input, hint);
}

// A number field; whatever is typed, pasted or left empty is stored through clampSetting.
function numberField(key, labelText, hint) {
    const range = SETTING_RANGES[key];
    const input = el('input', 'pm-settings-number');
    input.type = 'number';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.inputMode = 'numeric';
    input.dataset.pmKey = key;
    const apply = async () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        const value = clampSetting(key, input.value);
        const previous = root.settings[key];
        if (value === previous) { input.value = String(value); return; }
        // A tighter cap deletes existing history at once, so it is confirmed and reported.
        const destructive = tightensCap(key, previous, value);
        if (destructive && !(await askConfirm(STRINGS.settings.confirmTightenCap))) {
            syncFields();
            return;
        }
        // Re-read after the await: an import can replace the whole root meanwhile.
        const after = getRoot();
        if (!after || after.readOnly) { syncFields(); return; }
        after.settings[key] = value;
        let dropped = 0;
        if (destructive) {
            const now = Date.now();
            dropped = expireOldHistory(after, after.settings, now)
                + trimPerVariant(after, after.settings, now)
                + enforceGlobalBudget(after, after.settings, now);
        }
        // Show the stored, clamped value rather than what was typed.
        input.value = String(value);
        save();
        if (dropped) notify('info', STRINGS.settings.historyTrimmed(dropped));
        // Dropped history changes the usage figure, which only refreshSettings recomputes.
        if (dropped) refreshSettings();
        else syncFields();
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        // Blur only: its change event runs apply() exactly once.
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    return rowOf(labelText, input, hint);
}

// A setting picked from a fixed list of [value, label]; parse turns the option value into the
// stored one.
function selectField(key, choices, labelText, hint, parse = value => value) {
    const select = selectOf('pm-settings-select', choices, undefined, value => {
        const root = getRoot();
        if (!root || root.readOnly || !choices.some(([choice]) => String(choice) === value)) { syncFields(); return; }
        root.settings[key] = parse(value);
        save();
        syncFields();
    });
    select.dataset.pmKey = key;
    return rowOf(labelText, select, hint);
}

const named = (values, names) => values.map(value => [value, names[value]]);

function templateField() {
    const box = el('div', 'pm-settings-row');
    box.append(el('div', 'pm-settings-labeltext', STRINGS.settings.assetTemplate));
    const area = el('textarea', 'pm-settings-textarea');
    area.rows = 4;
    area.dataset.pmKey = 'assetPromptTemplate';
    area.setAttribute('aria-label', STRINGS.settings.assetTemplate);
    // On change, not input, so ST is not asked to save on every keystroke.
    area.addEventListener('change', () => {
        const root = getRoot();
        if (!root || root.readOnly) { syncFields(); return; }
        root.settings.assetPromptTemplate = area.value;
        save();
    });
    box.append(area);
    box.append(el('div', 'pm-settings-hint', STRINGS.settings.assetTemplateHint));
    return box;
}

/* Buttons */

function buttonOf(label, onClick, writes) {
    const btn = el('button', 'pm-manager-btn', label);
    btn.type = 'button';
    if (writes) btn.dataset.pmWrites = '1';
    btn.addEventListener('click', onClick);
    return btn;
}

// The import button and its hidden file input, kept in the tree so syncFields disables it too.
function appendImportControl(actions) {
    const input = el('input', 'pm-hidden');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.dataset.pmWrites = '1';
    input.setAttribute('aria-label', STRINGS.settings.importFileAria);
    input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null;
        // Cleared so the same file can be picked again: an unchanged choice fires no change.
        input.value = '';
        if (file) doImportSettings(file);
    });
    actions.append(buttonOf(STRINGS.settings.importSettings, () => input.click(), true), input);
}

function doPrune() {
    const root = getRoot();
    if (!root || root.readOnly) { notify('error', STRINGS.settings.pruneReadOnly); return; }
    const removed = pruneEmpty(root);
    // The shared cache is rebuilt before save() redraws, or the panel shows the deleted personas.
    refresh();
    save();
    refreshSettings();
    notify('info', removed.length ? STRINGS.settings.pruneDone(removed.length) : STRINGS.settings.pruneNothing);
}

// Confirms, then runs clear(persona, now), which answers how many entries it dropped, on every
// record. The root is re-read after the await.
async function clearEveryPersona(question, clear, done, nothing) {
    const writable = root => root && !root.readOnly;
    if (!writable(getRoot())) { notify('error', STRINGS.settings.clearHistoryReadOnly); return; }
    if (!(await askConfirm(question))) return;
    const after = getRoot();
    if (!writable(after)) { notify('error', STRINGS.settings.clearHistoryReadOnly); return; }
    const now = Date.now();
    let cleared = 0;
    for (const persona of Object.values(after.personas ?? {})) {
        if (persona && typeof persona === 'object') cleared += clear(persona, now);
    }
    save();
    refreshSettings();
    notify('info', cleared ? done(cleared) : nothing);
}

function doClearHistory() {
    return clearEveryPersona(STRINGS.settings.confirmClearHistory, (persona, now) => {
        let had = 0;
        for (const list of Object.values(persona.history ?? {})) had += Array.isArray(list) ? list.length : 0;
        if (!had) return 0;
        persona.history = {};
        // Logged only where something was lost: a log line keeps the pruner off a persona.
        addLog(persona, 'history-clear', STRINGS.settings.clearHistoryLog(had), now);
        return had;
    }, STRINGS.settings.clearHistoryDone, STRINGS.settings.clearHistoryNothing);
}

// Clears every persona's change log, which no history budget touches. Nothing is logged about
// it, or the pruner would skip every persona.
function doClearLogs() {
    return clearEveryPersona(STRINGS.settings.confirmClearLogs, persona => {
        const had = (persona.log ?? []).length;
        if (!had) return 0;
        persona.log = [];
        return had;
    }, STRINGS.settings.clearLogsDone, STRINGS.settings.clearLogsNothing);
}

function openManagerScreen() {
    const detail = { tab: 'compose', handled: false };
    document.dispatchEvent(new CustomEvent('pm:open-manager', { detail }));
    if (!detail.handled) notify('error', STRINGS.settings.openManagerFailed);
}

/* Export and import */

// Downloads text as a file through a temporary anchor.
function downloadJson(filename, text) {
    if (typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
        notify('error', STRINGS.settings.noDownload);
        return false;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = filename;
    // Blocked, or ST reads this synthetic click as a tap outside and closes its drawer.
    blockDrawerClose(link);
    (panel() ?? document.body).append(link);
    link.click();
    link.remove();
    // Revoked a task later: Chromium starts the download asynchronously.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }, 0);
    return true;
}

function stamp() {
    // Local date, the day the user thinks they made it on.
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// Export for SillyTavern's regex extension. A static regex cannot follow the active persona, so
// it is pinned to one folder, with one script per file ({{pimg::folder/name}} or the bare name).
const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function regexScripts(folderKey, files, style, makeIdFn) {
    return files.map(({ label, path }) => {
        const bare = String(path).split('?')[0];
        const ext = /\.[a-z0-9]+$/i.exec(bare)?.[0] ?? '';
        return {
            // SillyTavern's own regex script shape.
            id: makeId(makeIdFn),
            scriptName: STRINGS.settings.regexScriptName(`${folderKey}/${label}`),
            findRegex: `/\\{\\{pimg::(?:${escapeRegex(folderKey)}\\/)?${escapeRegex(label)}(?:${escapeRegex(ext)})?\\}\\}/gi`,
            // The same HTML our renderer builds. buildImgHtml escapes the value.
            replaceString: buildImgHtml(bare, style),
            trimStrings: [],
            placement: [1, 2],
            disabled: false,
            // Display only, like our renderer: the stored message keeps the tag the model wrote.
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        };
    });
}

function doExportRegex() {
    const root = getRoot();
    if (!root) { notify('error', STRINGS.settings.noRoot); return; }
    const s = getState();
    const avatar = s?.avatar ?? null;
    if (!avatar) { notify('error', STRINGS.settings.noActivePersona); return; }
    // resolveFolderKey only reads, so no entry is created for an unadopted persona.
    const key = resolveFolderKey(root, avatar);
    const files = withoutBackups([...(s.assetPaths ?? new Map())].map(([label, path]) => ({ label, path })));
    if (!files.length) { notify('warning', STRINGS.settings.regexNoFiles(key)); return; }
    const scripts = regexScripts(key, files, root.settings?.assetStyle ?? 'plain', freshContext()?.uuidv4);
    if (!downloadJson(`persona-manager-regex-${key}.json`, JSON.stringify(scripts, null, 2))) return;
    notify('info', STRINGS.settings.regexExported(key, scripts.length));
}

function doExportSettings() {
    const root = getRoot();
    if (!root) { notify('error', STRINGS.settings.noRoot); return; }
    // A read-only root is a normalised copy, so the backup is the stored object itself.
    const stored = root.readOnly ? freshContext()?.extensionSettings?.[MODULE_NAME] : null;
    if (!downloadJson(`persona-manager-${stamp()}.json`, serializeRoot(stored ?? root))) return;
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
    // Validated before asking, so a confirmation never ends in a refusal.
    const parsed = parseImportedRoot(text);
    if (!parsed.ok) { notify('error', parsed.message); return; }
    if (!(await askConfirm(STRINGS.settings.confirmImport))) return;
    // Re-read after the await, as in doClearHistory.
    const ctx = freshContext();
    if (!ctx) { notify('error', STRINGS.settings.importNoContext); return; }
    const after = getRoot();
    if (!after || after.readOnly) { notify('error', STRINGS.settings.importNotApplied); return; }
    ctx.extensionSettings[MODULE_NAME] = parsed.root;
    ctx.saveSettingsDebounced?.();
    // Every cache described the old tree.
    refresh();
    invalidateManagerCaches();
    save();
    refreshSettings();
    notify('success', STRINGS.settings.importDone);
}

/* Refresh */

// Puts every field in step with the stored settings.
function syncFields() {
    const box = panel();
    if (!box) return;
    const root = getRoot();
    const settings = root?.settings ?? {};
    const readOnly = !!root?.readOnly;

    for (const node of box.querySelectorAll('[data-pm-key]')) {
        // Skip the focused field, or a sibling's refresh would clobber half-typed text.
        if (node === document.activeElement) continue;
        const key = node.dataset.pmKey;
        if (node.type === 'checkbox') node.checked = !!settings[key];
        else node.value = String(settings[key] ?? '');
    }
    // A read-only root disables every writing control; the banner says why.
    for (const node of box.querySelectorAll('[data-pm-key], [data-pm-writes]')) {
        node.disabled = readOnly;
        node.classList.toggle('pm-disabled', readOnly);
    }
    box.querySelector('.pm-settings-readonly')?.classList.toggle('pm-hidden', !readOnly);
}

// The identification line: which route named the active persona (it decides whether same-named
// personas are editable). An indirect route adds ST's avatar tile classes, for a screenshot.
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
    if (direct) { evidence.textContent = ''; evidence.classList.add('pm-hidden'); return; }
    const report = avatarBlockReport(typeof document === 'undefined' ? null : document);
    evidence.textContent = report.found && report.count
        ? STRINGS.settings.identifyTiles(report.count, report.classes.join(' | '))
        : STRINGS.settings.identifyNoTiles;
    evidence.classList.remove('pm-hidden');
}

// The usage figure stringifies the whole root, so it is computed only on open, on request and
// after storage changes, deferred so a burst computes once.
let usageTimer = 0;

function refreshSettings() {
    const box = panel();
    if (!box) return;
    syncFields();
    refreshIdentify();
    if (!box.querySelector('.pm-settings-usage')) return;
    if (usageTimer) return;
    usageTimer = setTimeout(() => { usageTimer = 0; paintUsage(); }, 50);
}

function paintUsage() {
    const usage = panel()?.querySelector('.pm-settings-usage');
    if (!usage) return;
    const bytes = readUsageBytes();
    const warnBytes = getRoot()?.settings?.warnBytes;
    const warn = typeof warnBytes === 'number' && bytes > warnBytes;
    usage.textContent = STRINGS.settings.usageBytes((bytes / 1024).toFixed(1));
    // The warn class adds weight as well as colour.
    usage.classList.toggle('pm-settings-warn', warn);
}

/* Lifecycle */

function buildPanel() {
    const box = el('div', 'inline-drawer pm-settings');
    box.id = PANEL_ID;

    // The panels' look, with pm-mass only while open: collapsed, it matches ST's other rows.
    const header = el('div', 'inline-drawer-header pm-settings-header');
    header.append(el('b', null, STRINGS.settings.title));
    // ST's own drawer chevron, from its loaded FontAwesome.
    const caret = el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
    header.append(caret);

    // No ST class on the content: a build's stylesheet or slideToggle could grab it.
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
        header.classList.toggle('pm-mass', !collapsed);
        if (!collapsed) refreshSettings();
    };
    // Click only, stopped here: ST's drawer delegate would otherwise toggle it shut again.
    header.addEventListener('click', e => { e.stopPropagation(); toggleDrawer(); });
    // Keyboard-operable, as role=button promises.
    header.tabIndex = 0;
    header.addEventListener('keydown', e => {
        if (isComposingKey(e)) return;
        // Stopped: ST's document keydown turns Enter into a click, which would toggle twice.
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleDrawer(); }
    });
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', 'false');
    header.setAttribute('aria-controls', CONTENT_ID);

    const readOnlyBanner = el('div', 'pm-manager-banner pm-manager-warn pm-settings-readonly pm-hidden');
    readOnlyBanner.append(el('div', 'pm-manager-banner-text', STRINGS.settings.readOnlyBanner));
    content.append(readOnlyBanner);
    const band = el('div', 'pm-band');
    band.append(el('span', 'pm-band-word', STRINGS.settings.bandWord));
    content.append(band);

    const sections = STRINGS.settings.sections;
    // showQuickBar only hides the icon: disabling the extension is ST's job.
    content.append(sectionHead(sections.display));
    content.append(toggleField('showQuickBar', STRINGS.settings.showQuickBar, STRINGS.settings.showQuickBarHint));
    content.append(toggleField('rosterShowVersionCount', STRINGS.settings.rosterShowVersionCount, STRINGS.settings.rosterShowVersionCountHint));
    content.append(toggleField('rosterShowVersionNames', STRINGS.settings.rosterShowVersionNames, STRINGS.settings.rosterShowVersionNamesHint));
    content.append(selectField('assetStyle', [
        ['plain', STRINGS.settings.assetStylePlain],
        ['bordered', STRINGS.settings.assetStyleBordered],
        ['polaroid', STRINGS.settings.assetStylePolaroid],
    ], STRINGS.settings.assetStyle, STRINGS.settings.assetStyleHint));

    // Columns and rows act as one setting: either at 0 falls back to the page size.
    content.append(sectionHead(sections.list));
    content.append(selectField('rosterTileColumns',
        TILE_COLUMN_CHOICES.map(value => [value, value === 0 ? STRINGS.settings.tileColumnsAuto : String(value)]),
        STRINGS.settings.rosterTileColumns, STRINGS.settings.rosterTileColumnsHint, value => Number(value) || 0));
    content.append(numberField('rosterTileRows', STRINGS.settings.rosterTileRows, STRINGS.settings.rosterTileRowsHint));
    content.append(selectField('rosterTileShape', named(TILE_SHAPES, STRINGS.settings.tileShapeNames),
        STRINGS.settings.rosterTileShape, STRINGS.settings.rosterTileShapeHint));
    content.append(numberField('pageSizeRoster', STRINGS.settings.pageSizeRoster, STRINGS.settings.pageSizeHint));
    content.append(numberField('pageSizeAssets', STRINGS.settings.pageSizeAssets, ''));
    content.append(numberField('pageSizeVersions', STRINGS.settings.pageSizeVersions, ''));

    content.append(sectionHead(sections.history));
    content.append(numberField('historyPerVariant', STRINGS.settings.historyPerVariant, STRINGS.settings.historyPerVariantHint));
    content.append(numberField('historyMaxBytes', STRINGS.settings.historyMaxBytes, STRINGS.settings.historyMaxBytesHint));
    content.append(numberField('historyMaxDays', STRINGS.settings.historyMaxDays, STRINGS.settings.historyMaxDaysHint));
    content.append(numberField('historyCoalesceMinutes', STRINGS.settings.historyCoalesceMinutes, STRINGS.settings.historyCoalesceMinutesHint));

    content.append(sectionHead(sections.text));
    content.append(toggleField('autoAbsorbOutside', STRINGS.settings.autoAbsorbOutside, STRINGS.settings.autoAbsorbOutsideHint));
    content.append(toggleField('autoLocalName', STRINGS.settings.autoLocalName, STRINGS.settings.autoLocalNameHint));
    // How adopting a persona takes in its description (state.js seedDescription).
    content.append(selectField('adoptSplitMode', named(ADOPT_MODES, STRINGS.settings.adoptModeNames),
        STRINGS.settings.splitOnAdopt, STRINGS.settings.splitOnAdoptHint));
    content.append(selectField('defaultHeadingFormat', named(HEADING_FORMATS, STRINGS.manager.headingFormatNames),
        STRINGS.settings.defaultHeadingFormat, STRINGS.settings.defaultHeadingFormatHint));

    content.append(sectionHead(sections.assets));
    content.append(toggleField('injectAssetMacros', STRINGS.settings.injectAssetMacros, STRINGS.settings.injectAssetMacrosHint));
    content.append(templateField());

    content.append(sectionHead(sections.data));
    content.append(el('div', 'pm-settings-identify', STRINGS.settings.identify));
    content.append(el('div', 'pm-settings-identify-why pm-hidden'));

    const usage = el('div', 'pm-settings-usage', STRINGS.settings.usage);
    content.append(usage);

    const actions = el('div', 'pm-manager-actions pm-settings-actions');
    actions.append(buttonOf(STRINGS.settings.refreshUsage, () => refreshSettings(), false));
    actions.append(buttonOf(STRINGS.settings.pruneEmpty, () => doPrune(), true));
    actions.append(buttonOf(STRINGS.settings.clearHistory, () => doClearHistory(), true));
    actions.append(buttonOf(STRINGS.settings.clearLogs, () => doClearLogs(), true));
    // Exports write nothing, so they stay enabled on a read-only root; import does not.
    actions.append(buttonOf(STRINGS.settings.exportRegex, () => doExportRegex(), false));
    actions.append(buttonOf(STRINGS.settings.exportSettings, () => doExportSettings(), false));
    appendImportControl(actions);
    actions.append(buttonOf(STRINGS.settings.openManager, () => openManagerScreen(), false));
    content.append(actions);
    content.append(el('div', 'pm-settings-hint', STRINGS.settings.regexHint));
    content.append(el('div', 'pm-settings-hint', STRINGS.settings.importHint));

    box.append(header, content);
    // So ST's drawer code never reads our clicks as taps outside its panels.
    blockDrawerClose(box);
    return box;
}

export function mountSettings() {
    if (mounted || typeof document === 'undefined') return;
    // Not every ST build has both extension columns, so the known hosts are tried in turn.
    const host = document.getElementById(HOST_ID)
        ?? document.getElementById('extensions_settings')
        ?? document.querySelector('.extensions_settings');
    // A console warning, not a toast: a build with another layout may lack the host.
    if (!host) { console.warn(`[${MODULE_NAME}] #${HOST_ID} not found, settings screen skipped`); return; }
    document.getElementById(PANEL_ID)?.remove();
    host.append(buildPanel());
    mounted = true;
    // Settings also change elsewhere. Fields only: the usage figure is too costly per event.
    track(cleanups, document, 'pm:changed', () => syncFields());
}

export function unmountSettings() {
    runCleanups(cleanups);
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = 0;
    if (typeof document !== 'undefined') document.getElementById(PANEL_ID)?.remove();
    mounted = false;
}
