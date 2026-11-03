// Data model, defaults, migration and size accounting.
// Pure: no DOM, no getContext. Everything is passed in.
import { STRINGS } from './strings.js';
import { validCrop } from './framing.js';

export const MODULE_NAME = 'persona-manager';
/* Bumped whenever an older build would damage the data, since older builds treat a newer
   root as read-only. 2: lastComposed became composedSig (no baseline for 1). 3: heading
   format 'own', whose titles a build on 2 would strip on its next write. */
export const SCHEMA_VERSION = 3;

/* Fingerprint (length + 32-bit FNV-1a) of what was last given to SillyTavern. A full copy
   was a fifth of our stored data, and only equality is ever asked of it. */
export function textSignature(text) {
    const s = String(text ?? '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return `${s.length}:${(h >>> 0).toString(36)}`;
}

// No master "enabled" flag on purpose: SillyTavern's extension manager owns that. An
// older settings.json may still carry the key; nothing reads it, and it is left in place.
export const DEFAULT_SETTINGS = Object.freeze({
    showQuickBar: true,
    historyPerVariant: 5,
    historyMaxBytes: 262144,
    // 0 = never: a new setting must not delete existing history by appearing.
    historyMaxDays: 0,
    historyCoalesceMinutes: 5,
    injectAssetMacros: true,
    // Per-language auto-naming. On by default: it only acts on personas with a name
    // registered for the chat's language, and registering one is asking for this.
    autoLocalName: true,
    defaultHeadingFormat: 'none',
    // How adopt seeds a description (state.js seedDescription): 'own' keeps its own
    // division, 'whole' puts it in one item, 'defaults' matches the shipped names.
    adoptSplitMode: 'own',
    assetStyle: 'plain',
    assetPromptTemplate: STRINGS.settings.assetPromptDefault,
    warnBytes: 524288,
    sortBy: 'name',
    activeLabelId: null,
    lastUsedCap: 50,
    // Off by default: the persona list is SillyTavern's, so nothing is added unasked.
    rosterShowVersionCount: false,
    rosterShowVersionNames: false,
    // Collapsed by default: the quick panel is opened to switch personas.
    quickVersionOpen: false,
    // Per-language names in the quick panel; collapsed for the same reason.
    quickNamesOpen: false,
    // The manager's picker has its own view, separate from the quick panel's
    // rosterViewMode (migrate seeds it from that, so no picker changes on upgrade).
    pickerViewMode: 'list',
    rosterViewMode: 'list',
    // 0 means automatic columns / everything on one page.
    rosterTileColumns: 0,
    rosterTileShape: 'circle',
    rosterTileRows: 0,
    pageSizeRoster: 20,
    pageSizeAssets: 20,
    pageSizeVersions: 20,
});

// The items a new persona starts with; existing personas get them only on request.
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

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// Containers every reader iterates. Arrays are refused where an object is expected:
// JSON.stringify drops an array's named keys, so they would be lost on save.
function backfillContainers(root) {
    if (!isPlainObject(root.settings)) root.settings = {};
    if (!isPlainObject(root.personas)) root.personas = {};
    if (!Array.isArray(root.labels)) root.labels = [];
    if (!isPlainObject(root.lastUsed)) root.lastUsed = {};
    // Array.isArray, not ?? []: a non-iterable value would throw in for..of, and migrate
    // runs from getRoot, so one malformed record would take down every screen.
    for (const persona of Object.values(root.personas)) {
        if (!persona || typeof persona !== 'object') continue;
        if (!Array.isArray(persona.tags)) persona.tags = [];
        if (!Array.isArray(persona.versions)) persona.versions = [];
        for (const version of persona.versions) {
            if (version && typeof version === 'object' && !Array.isArray(version.tags)) version.tags = [];
        }
    }
}

/* A root written by a newer build is shown, never rewritten: screens read a normalised
   copy (cached per stored object, so getRoot does not clone per draw), and every write
   path refuses on readOnly, so nothing is written into the copy and lost. */
const futureViews = new WeakMap();

function futureView(stored) {
    const cached = futureViews.get(stored);
    if (cached) return cached;
    let view;
    try { view = structuredClone(stored); } catch { view = JSON.parse(JSON.stringify(stored)); }
    backfillContainers(view);
    view.readOnly = true;
    futureViews.set(stored, view);
    return view;
}

function backfillVersionPicks(persona) {
    if (!persona || typeof persona !== 'object') return;
    if (!Array.isArray(persona.sections) || !Array.isArray(persona.versions)) return;
    const live = persona.activePicks && typeof persona.activePicks === 'object' ? persona.activePicks : {};
    for (const version of persona.versions) {
        if (!version || typeof version !== 'object') continue;
        if (!version.picks || typeof version.picks !== 'object') version.picks = {};
        for (const section of persona.sections) {
            const id = section?.id;
            if (typeof id !== 'string' || Object.hasOwn(version.picks, id)) continue;
            if (typeof live[id] === 'string') version.picks[id] = live[id];
        }
    }
}

export function migrate(root) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};
    if (typeof root.schemaVersion !== 'number') root.schemaVersion = SCHEMA_VERSION;
    if (root.schemaVersion > SCHEMA_VERSION) return futureView(root);
    backfillContainers(root);
    // Below the read-only return because the rest drops unrecognised values, which is
    // only allowed on a root this build may write.
    const backfillPicks = root.schemaVersion < 3;
    for (const persona of Object.values(root.personas)) {
        if (!persona || typeof persona !== 'object') continue;
        // Schema 1 to 2: the full copy becomes its fingerprint (see textSignature).
        if ('lastComposed' in persona) {
            if (typeof persona.composedSig !== 'string') {
                persona.composedSig = typeof persona.lastComposed === 'string' ? textSignature(persona.lastComposed) : null;
            }
            delete persona.lastComposed;
        }
        // Schema 2 to 3, once: versions saved before an item existed get the item's current
        // pick, as pickInEveryVersion gives new items; without one, applying drops the item.
        if (backfillPicks) backfillVersionPicks(persona);
        if (persona.avatarWritten !== null && typeof persona.avatarWritten !== 'string') persona.avatarWritten = null;
        const backup = persona.avatarBackup;
        if (backup !== null && (typeof backup !== 'object' || typeof backup?.label !== 'string')) persona.avatarBackup = null;
        // An array, guaranteed by backfillContainers above.
        for (const version of persona.versions) {
            if (!version || typeof version !== 'object') continue;
            if ('avatarCrop' in version) version.avatarCrop = validCrop(version.avatarCrop);
            if (version.avatarAsset !== null && typeof version.avatarAsset !== 'string') version.avatarAsset = null;
        }
    }
    root.schemaVersion = SCHEMA_VERSION;
    // A stale readOnly may sit in settings.json (older builds stored it); it would block
    // every write, and nothing else clears it.
    delete root.readOnly;
    // Before the defaults, so a root predating pickerViewMode keeps its view in both places.
    if (!Object.hasOwn(root.settings, 'pickerViewMode') && root.settings.rosterViewMode) {
        root.settings.pickerViewMode = root.settings.rosterViewMode;
    }
    /* A default we shipped is ours to replace; a text the user wrote is not. An exact
       match with a past default means untouched, so it moves to the current one. */
    if (STRINGS.settings.legacyAssetPrompts.includes(root.settings.assetPromptTemplate)) {
        root.settings.assetPromptTemplate = DEFAULT_SETTINGS.assetPromptTemplate;
    }
    // splitOnAdopt shipped on, so its stored value says nothing about the user: dropped.
    delete root.settings.splitOnAdopt;
    // 0.3.1's on/off switch, folded into the mode: on meant the shipped names.
    if (Object.hasOwn(root.settings, 'autoSplitOnAdopt')) {
        if (root.settings.autoSplitOnAdopt === true && !Object.hasOwn(root.settings, 'adoptSplitMode')) {
            root.settings.adoptSplitMode = 'defaults';
        }
        delete root.settings.autoSplitOnAdopt;
    }
    if (Object.hasOwn(root.settings, 'adoptSplitMode') && !ADOPT_MODES.includes(root.settings.adoptSplitMode)) {
        delete root.settings.adoptSplitMode;
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(root.settings, k)) root.settings[k] = v;
    }
    return root;
}

// Heading formats offered by the settings drawer and the edit tab. 'own' is not listed:
// it exists only on personas adopted with their own division, whose select adds it.
export const HEADING_FORMATS = Object.freeze(['none', 'plain', 'markdown']);
export const ADOPT_MODES = Object.freeze(['own', 'whole', 'defaults']);

// Roster tile shapes; validated on read, because the value reaches a class name.
export const TILE_SHAPES = Object.freeze(['circle', 'rounded', 'square']);

export function makeDefaultPersona(makeIdFn, headingFormat) {
    const p = {
        sections: [], variants: {}, versions: [],
        activeVersionId: null, activePicks: {},
        // 'none' unless the user set another default, so adopting never changes the
        // prompt by itself; unknown values (hand edits) fall back here.
        headingFormat: HEADING_FORMATS.includes(headingFormat) ? headingFormat : 'none',
        history: {}, log: [], assets: {},
        assetFolderKey: null,
        // The fingerprint of what SillyTavern was last given; null is the empty text.
        composedSig: null,
        tags: [],
        // The asset holding the avatar as it was before our first overwrite. Written once:
        // a second backup would copy our own replacement.
        avatarBackup: null,
        // The label we last wrote to the avatar file. A cache of a server fact,
        // read only to skip a write that would change nothing.
        avatarWritten: null,
    };
    for (const name of DEFAULT_SECTION_NAMES) appendSection(p, { name }, makeIdFn, '', 0);
    return p;
}

// Appends an item with one picked choice under the default label; the item's id is
// made before the choice's.
export function appendSection(persona, section, makeIdFn, text, updatedAt) {
    const sectionId = makeId(makeIdFn);
    const variantId = makeId(makeIdFn);
    persona.sections.push({ id: sectionId, ...section });
    persona.variants[sectionId] = [{ id: variantId, label: STRINGS.manager.defaultChoiceLabel, text, updatedAt }];
    persona.activePicks[sectionId] = variantId;
    return { sectionId, variantId };
}

export function getPersona(root, avatarId) {
    return root?.personas?.[avatarId] ?? null;
}

export function findVersion(persona, versionId) {
    const versions = persona?.versions;
    return Array.isArray(versions) ? versions.find(entry => entry?.id === versionId) ?? null : null;
}

// The choice an item currently uses (its live pick), or null.
export function liveVariant(persona, section) {
    const pick = persona?.activePicks?.[section?.id];
    return (persona?.variants?.[section?.id] ?? []).find(entry => entry?.id === pick) ?? null;
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
    // Tags and per-language names are user work that lives nowhere else, and the birth
    // log line that usually protects a record can be cleared from the history tab.
    if ((p.tags ?? []).length) return false;
    if (Object.values(p.names ?? {}).some(name => String(name ?? '').trim())) return false;
    // Likewise for pictures: this record is the only way back to the server-side files.
    if (p.assetFolderKey || p.avatarBackup) return false;
    // Actual history entries, not keys: an empty array is not history content.
    for (const list of Object.values(p.history ?? {})) {
        if (Array.isArray(list) && list.length) return false;
    }
    for (const list of Object.values(p.variants ?? {})) {
        // A shape this function cannot read is not proof of emptiness: kept.
        if (!Array.isArray(list)) return false;
        for (const v of list) if (typeof v?.text === 'string' && v.text.trim()) return false;
    }
    /* Structure is content even with every body blank: only the exact makeDefaultPersona
       shell (default items and names, one default choice each) counts as empty. A record
       with no sections stays prunable; it is the shell the prune button exists for. */
    const sections = p.sections ?? [];
    if (sections.length) {
        if (sections.length !== DEFAULT_SECTION_NAMES.length) return false;
        if (sections.some((sec, i) => sec?.name !== DEFAULT_SECTION_NAMES[i])) return false;
        for (const list of Object.values(p.variants ?? {})) {
            if ((list ?? []).length !== 1) return false;
            if (list[0]?.label !== STRINGS.manager.defaultChoiceLabel) return false;
        }
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
    return new TextEncoder().encode(JSON.stringify(root ?? {})).length;
}
