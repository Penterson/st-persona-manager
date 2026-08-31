// Data model, defaults, migration and size accounting.
// Pure: no DOM, no getContext. Everything is passed in.
import { STRINGS } from './strings.js';

export const MODULE_NAME = 'persona-manager';
export const SCHEMA_VERSION = 1;

// There is deliberately no master "enabled" flag. One was defined here and read
// nowhere, and honouring it would have been the wrong repair: SillyTavern's extension
// manager already owns turning this extension off, and a second switch with no screen
// to flip it can only end up disagreeing with the one the user can actually reach.
// An older settings.json may still carry the key. Nothing reads it, and migrate only
// adds defaults, so it sits there harmlessly rather than being deleted from under a
// build that might still want it.
export const DEFAULT_SETTINGS = Object.freeze({
    showQuickBar: true,
    historyPerVariant: 5,
    historyMaxBytes: 262144,
    // Age based expiry (user request). 0 = never, which is the shipped default:
    // a new setting must not delete an existing user's history by appearing.
    historyMaxDays: 0,
    historyCoalesceMinutes: 5,
    injectAssetMacros: true,
    // 언어별 이름 자동 적용 (user request, on by default since 2026-08-27).
    // It was shipped off, on the reasoning that renaming a persona behind the
    // user's back is not something to opt them into. That reasoning was wrong in
    // one specific way: this only ever acts on a persona that has an alternate
    // name REGISTERED for the chat's language, and registering one is the user
    // asking for exactly this. Somebody who has never opened 언어별 이름 has no
    // names, so the switch does nothing for them whichever way it is set.
    autoLocalName: true,
    defaultHeadingFormat: 'none',
    assetStyle: 'plain',
    // The words live in strings.js, this names which ones.
    assetPromptTemplate: STRINGS.settings.assetPromptDefault,
    warnBytes: 524288,
    sortBy: 'name',
    activeLabelId: null,
    lastUsedCap: 50,
    // Two independent switches, both off out of the box: the
    // persona list is SillyTavern's and most rows in it are not ours, so nothing
    // is added to it until the user asks for it.
    rosterShowVersionCount: false,
    rosterShowVersionNames: false,
    // 버전 접기 (user request). Closed out of the box: the quick panel is opened
    // to change a persona, and the version list was taking a third of it to say
    // there were no versions.
    quickVersionOpen: false,
    // 언어별 이름 in the quick panel (user request). Closed like the version list,
    // and for the same reason: the panel is opened to switch a persona.
    quickNamesOpen: false,
    /* The manager's persona picker keeps its own view (user request). It used to
       read rosterViewMode, so choosing tiles in the quick panel changed the picker
       with it and there was no way to have one of each. They are different jobs:
       the quick panel's list is browsed, the picker is a chooser you are already
       halfway through a task in. migrate seeds this from rosterViewMode for anyone
       who already had one, so no picker changes shape on upgrade. */
    pickerViewMode: 'list',
    // 'list' is the layout the panel has always had.
    rosterViewMode: 'list',
    // 0 means automatic columns / everything on one page.
    rosterTileColumns: 0,
    rosterTileShape: 'circle',
    rosterTileRows: 0,
    pageSizeRoster: 20,
    pageSizeAssets: 20,
    pageSizeVersions: 20,
});

// What a persona starts with. Existing personas are untouched;
// the manager's [기본 항목 채우기] adds the missing ones on request.
export const DEFAULT_SECTION_NAMES = Object.freeze([
    '기본 정보', '외모', '배경', '성격', '버릇 & 습관', '능력 & 기술', '관계',
    '숨겨진 욕망', '말투 & 대사', 'NSFW 외모', '성적 취향', 'AI 가이드라인', '캐릭터 노트',
]);

let fallbackCounter = 0;
export function makeId(makeIdFn) {
    if (typeof makeIdFn === 'function') return makeIdFn();
    return `pm-${Date.now().toString(36)}-${(++fallbackCounter).toString(36)}`;
}

export function emptyRoot() {
    return {
        schemaVersion: SCHEMA_VERSION,
        settings: { ...DEFAULT_SETTINGS },
        personas: {},
        labels: [],
        lastUsed: {},
    };
}

export function migrate(root) {
    if (!root || typeof root !== 'object') root = {};
    if (typeof root.schemaVersion !== 'number') root.schemaVersion = SCHEMA_VERSION;
    // Containers must exist either way so callers never dereference undefined.
    // This has to run before the future-schema early return below: otherwise a
    // read-only root from a newer build would leave labels and lastUsed missing
    // and the screen would break trying to read them.
    if (!root.settings || typeof root.settings !== 'object') root.settings = {};
    if (!root.personas || typeof root.personas !== 'object') root.personas = {};
    if (!Array.isArray(root.labels)) root.labels = [];
    if (!root.lastUsed || typeof root.lastUsed !== 'object') root.lastUsed = {};
    // Tags live on personas and versions. Backfilled before the
    // future-schema return below for the same reason as the containers above:
    // the read-only screens still iterate them, and no reader may meet
    // undefined.
    for (const persona of Object.values(root.personas)) {
        if (!persona || typeof persona !== 'object') continue;
        if (!Array.isArray(persona.tags)) persona.tags = [];
        for (const version of persona.versions ?? []) {
            if (version && typeof version === 'object' && !Array.isArray(version.tags)) version.tags = [];
        }
    }
    // A newer build wrote this. Do not rewrite what we cannot understand.
    if (root.schemaVersion > SCHEMA_VERSION) { root.readOnly = true; return root; }
    /* Past the read-only return, because this DROPS values rather than filling
       them in: a shape we do not recognise under a key we own is worth clearing,
       but only on a root this build is allowed to write. Readers still go through
       boundAsset, so a hand edited file cannot reach them either way. */
    for (const persona of Object.values(root.personas)) {
        if (!persona || typeof persona !== 'object') continue;
        if (persona.avatarWritten !== null && typeof persona.avatarWritten !== 'string') persona.avatarWritten = null;
        const backup = persona.avatarBackup;
        if (backup !== null && (typeof backup !== 'object' || typeof backup?.label !== 'string')) persona.avatarBackup = null;
        for (const version of persona.versions ?? []) {
            if (!version || typeof version !== 'object') continue;
            if (version.avatarAsset !== null && typeof version.avatarAsset !== 'string') version.avatarAsset = null;
        }
    }
    // This flag lives on the object we persist, so a single run against a newer
    // build leaves it in settings.json. Nothing else ever clears it, and a stale
    // one silently blocks every write from then on.
    delete root.readOnly;
    // Before the defaults below, so a root that predates the split keeps the view
    // it was already showing in both places rather than snapping the picker to the
    // shipped default.
    if (!Object.hasOwn(root.settings, 'pickerViewMode') && root.settings.rosterViewMode) {
        root.settings.pickerViewMode = root.settings.rosterViewMode;
    }
    /* A default we shipped is ours to replace; a text the user wrote is not.

       The asset instruction is a stored setting, and the backfill below only fills
       what is MISSING, so every rewrite of the default reached new installs only
       and left everybody else on the first version of it (device report: 지시문이
       여전히 옛날 문구). Exact equality against the list of what we have shipped is
       what separates the two cases: byte for byte one of ours means untouched. */
    if (STRINGS.settings.legacyAssetPrompts.includes(root.settings.assetPromptTemplate)) {
        root.settings.assetPromptTemplate = DEFAULT_SETTINGS.assetPromptTemplate;
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(root.settings, k)) root.settings[k] = v;
    }
    return root;
}

// The three composition headings. Exported so the two screens that
// offer them and the migration that validates a stored value all read one list
// rather than three copies of the same three strings.
export const HEADING_FORMATS = Object.freeze(['none', 'plain', 'markdown']);

// Tile shapes for the roster's tile views. The user asked for the choice rather
// than a house shape: a circle crops a rectangular avatar hardest, and somebody
// whose portraits are full-body art wants the square. Validated on read, because
// the value reaches a class name.
export const TILE_SHAPES = Object.freeze(['circle', 'rounded', 'square']);

export function makeDefaultPersona(makeIdFn, headingFormat) {
    const p = {
        sections: [], variants: {}, versions: [],
        activeVersionId: null, activePicks: {},
        // 'none' unless the user has set a different default, so
        // adopting an existing description never changes the prompt by itself.
        // An unknown value out of a hand edited settings.json falls back rather
        // than reaching headingFor, which would silently treat it as 'none'.
        headingFormat: HEADING_FORMATS.includes(headingFormat) ? headingFormat : 'none',
        history: {}, log: [], assets: {},
        assetFolderKey: null,
        lastComposed: '',
        tags: [],
        /* Replacing a persona picture OVERWRITES SillyTavern's avatar file, so
           the first time a bound image is written the picture that was there is
           gone. avatarBackup names the asset it was copied into before that
           happened, and it is written once and never again: a second backup
           would be a backup of our own replacement. */
        avatarBackup: null,
        // The label we last wrote to the avatar file. A cache of a server fact,
        // read only to skip a write that would change nothing.
        avatarWritten: null,
    };
    for (const name of DEFAULT_SECTION_NAMES) {
        const sid = makeId(makeIdFn);
        const vid = makeId(makeIdFn);
        p.sections.push({ id: sid, name });
        // The same word the manager seeds into a new item's first choice, from
        // the same place: a second copy here once drifted.
        p.variants[sid] = [{ id: vid, label: STRINGS.manager.defaultChoiceLabel, text: '', updatedAt: 0 }];
        p.activePicks[sid] = vid;
    }
    return p;
}

export function getPersona(root, avatarId) {
    return root?.personas?.[avatarId] ?? null;
}

export function ensurePersona(root, avatarId, makeIdFn) {
    if (!root.personas[avatarId]) {
        root.personas[avatarId] = makeDefaultPersona(makeIdFn, root?.settings?.defaultHeadingFormat);
    }
    return root.personas[avatarId];
}

export function isEmptyPersona(p) {
    if (!p) return true;
    if (Object.keys(p.assets ?? {}).length) return false;
    if ((p.versions ?? []).length) return false;
    if ((p.log ?? []).length) return false;
    // Count actual history entries, not variant keys: a key holding an empty
    // array must not count as history content.
    for (const list of Object.values(p.history ?? {})) {
        if ((list ?? []).length) return false;
    }
    for (const list of Object.values(p.variants ?? {})) {
        for (const v of list) if (v.text && v.text.trim()) return false;
    }
    return true;
}

export function pruneEmpty(root) {
    const removed = [];
    for (const [avatarId, p] of Object.entries(root.personas ?? {})) {
        if (isEmptyPersona(p)) { delete root.personas[avatarId]; removed.push(avatarId); }
    }
    return removed;
}

export function usageBytes(root) {
    // TextEncoder is available in Node and in browsers.
    return new TextEncoder().encode(JSON.stringify(root ?? {})).length;
}
