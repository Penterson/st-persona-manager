// Data model, defaults, migration and size accounting. Pure: no DOM, no getContext.
import { STRINGS } from './strings.js';
import { validCrop } from './framing.js';

export const MODULE_NAME = 'persona-manager';
/* Bumped whenever an older build would damage the data (older builds treat a newer root as
   read-only). 2: lastComposed became composedSig. 3: heading format 'own'. */
export const SCHEMA_VERSION = 3;

// 32-bit FNV-1a.
export function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Fingerprint (length + hash) of what was last given to SillyTavern; only equality is asked of it.
export function textSignature(text) {
    const s = String(text ?? '');
    return `${s.length}:${fnv1a(s).toString(36)}`;
}

// No master "enabled" flag: SillyTavern's extension manager owns that.
export const DEFAULT_SETTINGS = Object.freeze({
    showQuickBar: true,
    historyPerVariant: 5,
    historyMaxBytes: 262144,
    // 0 = never: a new setting must not delete existing history by appearing.
    historyMaxDays: 0,
    historyCoalesceMinutes: 5,
    injectAssetMacros: true,
    // Acts only on personas with a name registered for the chat's language.
    autoLocalName: true,
    // Edits in SillyTavern's own persona box flow into the items (state.js autoAbsorbOutside).
    autoAbsorbOutside: true,
    defaultHeadingFormat: 'none',
    // How adopt seeds a description (state.js seedDescription): whole, into one 전문 item.
    // Dividing by titles is the user's own step (the edit tab's buttons, or this setting).
    adoptSplitMode: 'whole',
    assetStyle: 'plain',
    assetPromptTemplate: STRINGS.settings.assetPromptDefault,
    warnBytes: 524288,
    sortBy: 'name',
    activeLabelId: null,
    lastUsedCap: 50,
    rosterShowVersionCount: false,
    rosterShowVersionNames: false,
    quickVersionOpen: false,
    quickNamesOpen: false,
    // The manager's picker view; migrate seeds it from rosterViewMode.
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

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// Containers every reader iterates. Arrays are refused where an object is expected, since
// JSON.stringify drops an array's named keys.
function backfillContainers(root) {
    if (!isPlainObject(root.settings)) root.settings = {};
    if (!isPlainObject(root.personas)) root.personas = {};
    if (!Array.isArray(root.labels)) root.labels = [];
    if (!isPlainObject(root.lastUsed)) root.lastUsed = {};
    for (const persona of Object.values(root.personas)) {
        if (!persona || typeof persona !== 'object') continue;
        if (!Array.isArray(persona.tags)) persona.tags = [];
        if (!Array.isArray(persona.versions)) persona.versions = [];
        for (const version of persona.versions) {
            if (version && typeof version === 'object' && !Array.isArray(version.tags)) version.tags = [];
        }
    }
}

/* A root written by a newer build is shown, never rewritten: screens read a normalised copy,
   cached per stored object, and every write path refuses on readOnly. */
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
    const backfillPicks = root.schemaVersion < 3;
    for (const persona of Object.values(root.personas)) {
        if (!persona || typeof persona !== 'object') continue;
        // Schema 1 to 2: the full copy becomes its fingerprint.
        if ('lastComposed' in persona) {
            if (typeof persona.composedSig !== 'string') {
                persona.composedSig = typeof persona.lastComposed === 'string' ? textSignature(persona.lastComposed) : null;
            }
            delete persona.lastComposed;
        }
        // Schema 2 to 3: versions saved before an item existed get the item's current pick.
        if (backfillPicks) backfillVersionPicks(persona);
        if (persona.avatarWritten !== null && typeof persona.avatarWritten !== 'string') persona.avatarWritten = null;
        const backup = persona.avatarBackup;
        if (backup !== null && (typeof backup !== 'object' || typeof backup?.label !== 'string')) persona.avatarBackup = null;
        for (const version of persona.versions) {
            if (!version || typeof version !== 'object') continue;
            if ('avatarCrop' in version) version.avatarCrop = validCrop(version.avatarCrop);
            if (version.avatarAsset !== null && typeof version.avatarAsset !== 'string') version.avatarAsset = null;
        }
    }
    root.schemaVersion = SCHEMA_VERSION;
    // Older builds stored readOnly; left in place it would block every write.
    delete root.readOnly;
    // Before the defaults, so a root predating pickerViewMode keeps its view in both places.
    if (!Object.hasOwn(root.settings, 'pickerViewMode') && root.settings.rosterViewMode) {
        root.settings.pickerViewMode = root.settings.rosterViewMode;
    }
    // A template identical to a past default was never edited, so it moves to the current one.
    if (STRINGS.settings.legacyAssetPrompts.includes(root.settings.assetPromptTemplate)) {
        root.settings.assetPromptTemplate = DEFAULT_SETTINGS.assetPromptTemplate;
    }
    // splitOnAdopt shipped on, so its stored value says nothing about the user.
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
    // 'own' shipped as the default up to 0.3.9 and was saved into every root, so a stored 'own'
    // without this marker says nothing about the user; it takes the new default once.
    if (root.settings.adoptDefault !== 'whole') {
        if (root.settings.adoptSplitMode === 'own') delete root.settings.adoptSplitMode;
        root.settings.adoptDefault = 'whole';
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(root.settings, k)) root.settings[k] = v;
    }
    return root;
}

// Offered by the settings drawer and the edit tab; 'own' exists only on personas adopted
// with their own division.
export const HEADING_FORMATS = Object.freeze(['none', 'plain', 'markdown']);
// In the order the choice is offered: the default first.
export const ADOPT_MODES = Object.freeze(['whole', 'own', 'defaults']);
// Validated on read, because the value reaches a class name.
export const TILE_SHAPES = Object.freeze(['circle', 'rounded', 'square']);
// The persona list's views (rosterViewMode, pickerViewMode).
export const VIEW_MODES = Object.freeze(['list', 'tiles', 'tilesNamed']);

export function makeDefaultPersona(makeIdFn, headingFormat) {
    const p = {
        sections: [], variants: {}, versions: [],
        activeVersionId: null, activePicks: {},
        // 'none' unless the user set another default, so adopting never changes the prompt.
        headingFormat: HEADING_FORMATS.includes(headingFormat) ? headingFormat : 'none',
        history: {}, log: [], assets: {},
        assetFolderKey: null,
        // Fingerprint of what SillyTavern was last given; null is the empty text.
        composedSig: null,
        tags: [],
        // The asset holding the avatar as it was before our first overwrite. Written once.
        avatarBackup: null,
        // The label last written to the avatar file, read only to skip a no-op write.
        avatarWritten: null,
    };
    for (const name of DEFAULT_SECTION_NAMES) appendSection(p, { name }, makeIdFn, '', 0);
    return p;
}

// Appends an item with one picked choice under the default label.
export function appendSection(persona, section, makeIdFn, text, updatedAt) {
    const sectionId = makeId(makeIdFn);
    const variantId = makeId(makeIdFn);
    persona.sections.push({ id: sectionId, ...section });
    persona.variants[sectionId] = [{ id: variantId, label: STRINGS.manager.defaultChoiceLabel, text, updatedAt }];
    persona.activePicks[sectionId] = variantId;
    return { sectionId, variantId };
}

// A new item is picked in every saved version too, or applying an older version drops its text.
export function pickInEveryVersion(persona, sectionId, variantId) {
    for (const version of Array.isArray(persona?.versions) ? persona.versions : []) {
        if (version && typeof version === 'object') version.picks = { ...(version.picks ?? {}), [sectionId]: variantId };
    }
}

export function getPersona(root, avatarId) {
    return root?.personas?.[avatarId] ?? null;
}

export function findVersion(persona, versionId) {
    const versions = persona?.versions;
    return Array.isArray(versions) ? versions.find(entry => entry?.id === versionId) ?? null : null;
}

export function findSection(persona, sectionId) {
    return (persona?.sections ?? []).find(entry => entry?.id === sectionId);
}

export function findVariant(persona, sectionId, variantId) {
    return (persona?.variants?.[sectionId] ?? []).find(entry => entry?.id === variantId);
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
    // Tags, names and pictures are user work that lives nowhere else.
    if ((p.tags ?? []).length) return false;
    if (Object.values(p.names ?? {}).some(name => String(name ?? '').trim())) return false;
    if (p.assetFolderKey || p.avatarBackup) return false;
    for (const list of Object.values(p.history ?? {})) {
        if (Array.isArray(list) && list.length) return false;
    }
    for (const list of Object.values(p.variants ?? {})) {
        // A shape this function cannot read is not proof of emptiness.
        if (!Array.isArray(list)) return false;
        for (const v of list) if (typeof v?.text === 'string' && v.text.trim()) return false;
    }
    /* Structure is content even with every body blank: only the exact makeDefaultPersona shell
       counts as empty. A record with no sections stays prunable. */
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
