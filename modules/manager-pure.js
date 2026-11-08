// Pure logic behind the manager screen. No DOM, so tests import it in plain Node;
// the DOM half is manager.js, which tests must never import.
import { addLog } from './history.js';
import {
    DEFAULT_SETTINGS, DEFAULT_SECTION_NAMES, SCHEMA_VERSION, makeId, appendSection, findVersion, liveVariant, migrate,
    HEADING_FORMATS, TILE_SHAPES, VIEW_MODES, pickInEveryVersion,
} from './store.js';
import { SORT_KEYS } from './roster.js';
import { STRINGS } from './strings.js';
import { validCrop, writtenKey } from './framing.js';
import { findAsset, groupLabelOf, selectedNames } from './assets.js';

// What a version's slot reads when its pick names nothing that exists. Never substituted
// with a surviving variant: that would show a combination the version does not contain.
export const NO_PICK_LABEL = STRINGS.manager.noPick;

// The last section is never deleted: a persona without sections composes to nothing, and
// this screen has no way back from that.
export function canDeleteSection(persona, sectionId) {
    const sections = persona?.sections ?? [];
    if (sections.length <= 1) return false;
    return sections.some(section => section.id === sectionId);
}

// Removes a section with its variants, their history and its activePicks entry; returns what
// went, or null if refused. Version picks keep the dead key on purpose: saved records are
// never rewritten, and readers ignore sections that no longer exist.
export function removeSection(persona, sectionId, now) {
    if (!canDeleteSection(persona, sectionId)) return null;
    const index = persona.sections.findIndex(section => section.id === sectionId);
    const [section] = persona.sections.splice(index, 1);
    const variants = persona.variants?.[sectionId] ?? [];
    const variantIds = variants.map(variant => variant.id);
    if (persona.history) {
        for (const variantId of variantIds) delete persona.history[variantId];
    }
    if (persona.variants) delete persona.variants[sectionId];
    if (persona.activePicks) delete persona.activePicks[sectionId];
    addLog(persona, 'section-delete', section.name ?? '', now);
    return { id: sectionId, name: section.name ?? '', variantIds };
}

/* Removes several sections at once, each as removeSection does. Removing every one first
   adds an empty section (picked in every version), since a persona keeps at least one.
   Returns { gone: [removeSection results], added: name | null }. */
export function removeSections(persona, sectionIds, makeIdFn, now) {
    const wanted = new Set(sectionIds ?? []);
    const targets = (persona?.sections ?? []).filter(section => wanted.has(section.id)).map(section => section.id);
    if (!targets.length) return { gone: [], added: null };
    let added = null;
    if (targets.length === persona.sections.length) {
        added = STRINGS.manager.emptyItemName;
        const { sectionId, variantId } = appendSection(persona, { name: added }, makeIdFn, '', now);
        pickInEveryVersion(persona, sectionId, variantId);
    }
    const gone = targets.map(id => removeSection(persona, id, now)).filter(Boolean);
    return { gone, added };
}

// Moves the entry with this id by delta places. Returns whether it moved: a step past
// either end is a no-op, not an error.
function stepById(list, id, delta) {
    if (!Array.isArray(list)) return false;
    const from = list.findIndex(entry => entry?.id === id);
    if (from === -1) return false;
    const to = from + delta;
    if (to < 0 || to >= list.length) return false;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    return true;
}

// Section order is prompt order, so this changes content.
export function moveSection(persona, sectionId, delta) {
    return stepById(persona?.sections, sectionId, delta);
}

// Deletes a variant (never a section's last) with its unreachable history. Deleting the active
// one moves the pick to the first remaining variant; version picks keep the dangling id.
export function deleteVariant(persona, sectionId, variantId, now) {
    const list = persona?.variants?.[sectionId];
    if (!Array.isArray(list) || list.length <= 1) return null;
    const index = list.findIndex(variant => variant.id === variantId);
    if (index === -1) return null;
    const [gone] = list.splice(index, 1);
    if (persona.history) delete persona.history[variantId];
    addLog(persona, 'variant-delete', gone.label ?? '', now);
    let movedTo = null;
    if (persona.activePicks && persona.activePicks[sectionId] === variantId) {
        movedTo = list[0].id;
        persona.activePicks[sectionId] = movedTo;
        addLog(persona, 'pick-moved', `${gone.label ?? ''} -> ${list[0].label ?? ''}`, now);
    }
    return { removed: gone.id, label: gone.label ?? '', movedTo };
}

// Empty names are refused (a blank chip is indistinguishable); duplicates are allowed, since
// labels are identified by id.
export function renameLabel(labels, labelId, name) {
    const label = (labels ?? []).find(entry => entry.id === labelId);
    if (!label) return false;
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return false;
    label.name = trimmed;
    return true;
}

// Removes only the label, never its personas. A stale activeLabelId is handled by
// buildRosterView, which falls back to showing everyone.
export function deleteLabel(labels, labelId) {
    if (!Array.isArray(labels)) return false;
    const index = labels.findIndex(entry => entry.id === labelId);
    if (index === -1) return false;
    labels.splice(index, 1);
    return true;
}

// One row per section saying what this version picks there. Unpicked and dead picks both read
// NO_PICK_LABEL; picks for deleted sections stay in the data but get no row.
export function versionSummary(persona, version) {
    const picks = version?.picks ?? {};
    return (persona?.sections ?? []).map(section => {
        const variantId = Object.hasOwn(picks, section.id) ? picks[section.id] : null;
        const variant = variantId
            ? (persona?.variants?.[section.id] ?? []).find(entry => entry.id === variantId)
            : null;
        return {
            sectionId: section.id,
            sectionName: section.name ?? '',
            variantId: variantId ?? null,
            label: variant ? (variant.label ?? '') : NO_PICK_LABEL,
            dead: !variant,
        };
    });
}

// The whole combination on one line, for the collapsed version row.
export function versionSummaryLine(persona, version) {
    return versionSummary(persona, version)
        .map(row => `${row.sectionName}: ${row.label}`)
        .join(STRINGS.common.dotSeparator);
}

// Version writes, shared by the manager and the quick panel. Each takes the persona looked up
// after the screen's await plus a version id, and answers null when the version is gone.

export function renameVersionIn(persona, versionId, name, now) {
    const version = findVersion(persona, versionId);
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!version || !trimmed) return null;
    version.name = trimmed;
    version.updatedAt = now;
    return version;
}

// Inserted right after the original; activeVersionId stays. Tags and the bound picture go
// with the copy.
export function duplicateVersionIn(persona, versionId, makeIdFn, now) {
    const source = findVersion(persona, versionId);
    if (!source) return null;
    const copy = {
        id: makeId(makeIdFn),
        name: STRINGS.common.copySuffix(source.name ?? ''),
        picks: { ...(source.picks ?? {}) },
        assetSelection: Array.isArray(source.assetSelection) ? [...source.assetSelection] : null,
        tags: Array.isArray(source.tags) ? [...source.tags] : [],
        avatarAsset: typeof source.avatarAsset === 'string' ? source.avatarAsset : null,
        avatarCrop: validCrop(source.avatarCrop),
        updatedAt: now,
    };
    persona.versions.splice(persona.versions.indexOf(source) + 1, 0, copy);
    return copy;
}

// No snapshot: history covers variant text, and a version holds none of its own.
export function overwriteVersionPicks(persona, versionId, now) {
    const version = findVersion(persona, versionId);
    if (!version) return null;
    version.picks = { ...(persona.activePicks ?? {}) };
    version.updatedAt = now;
    return version;
}

// The live picks belong to the persona, so deleting a version leaves them as they are.
export function dropVersionFrom(persona, versionId) {
    const versions = persona?.versions;
    if (!Array.isArray(versions)) return null;
    const index = versions.findIndex(entry => entry?.id === versionId);
    if (index === -1) return null;
    const [removed] = versions.splice(index, 1);
    if (persona.activeVersionId === versionId) persona.activeVersionId = null;
    return removed;
}

// Display order only (no prompt reads it).
export function moveVersion(persona, versionId, delta) {
    return stepById(persona?.versions, versionId, delta);
}

// Points the live picks at the version's and asks write() to store them. A refused write
// puts the previous picks back, or the version would show as applied over the old prompt
// and go out with the next unrelated save. Returns whether the write was accepted.
export function applyVersionPicks(persona, version, write) {
    const previous = { id: persona.activeVersionId, picks: persona.activePicks };
    persona.activeVersionId = version.id;
    persona.activePicks = { ...(version.picks ?? {}) };
    if (write()) return true;
    persona.activeVersionId = previous.id;
    persona.activePicks = previous.picks;
    return false;
}

// Appends a version of the live picks and makes it the active one. assetSelection null is
// every asset, later uploads included; avatarAsset null leaves the picture alone.
export function addVersion(persona, name, makeIdFn, now) {
    const version = {
        id: makeId(makeIdFn),
        name,
        picks: { ...(persona.activePicks ?? {}) },
        assetSelection: null,
        avatarAsset: null,
        updatedAt: now,
    };
    if (!Array.isArray(persona.versions)) persona.versions = [];
    persona.versions.push(version);
    persona.activeVersionId = version.id;
    return version;
}

/* Row expansion keys */

// The one expanded row is stored as a single key string. JSON, not a joined string: ids come
// from ST or hand-edited settings, so no separator is safe.
export function rowKey(kind, ...parts) {
    // Missing parts stay null, so an absent id and an empty one are different rows.
    return JSON.stringify([String(kind ?? ''), ...parts.map(part => (part == null ? null : String(part)))]);
}

/* Drafts: unsaved editor text */

// Text from an editor taken off screen unsaved, restored when the same body reopens. Strings
// only, so a draft never keeps a stale persona, context or node alive.
const drafts = new Map();

// JSON: an avatar id is a file name and may contain any separator.
export function draftKey(avatarId, sectionId, variantId) {
    return JSON.stringify([avatarId ?? null, sectionId ?? null, variantId ?? null]);
}

// null or undefined text clears the slot.
export function putDraft(avatarId, sectionId, variantId, text) {
    const key = draftKey(avatarId, sectionId, variantId);
    if (text === undefined || text === null) { drafts.delete(key); return false; }
    drafts.set(key, String(text));
    return true;
}

// Reads without consuming, for the draw path: the next redraw must still find it.
export function peekDraft(avatarId, sectionId, variantId) {
    const key = draftKey(avatarId, sectionId, variantId);
    return drafts.has(key) ? drafts.get(key) : null;
}

// Reads and clears, once the text is stored, so an already saved edit is never restored.
export function takeDraft(avatarId, sectionId, variantId) {
    const key = draftKey(avatarId, sectionId, variantId);
    if (!drafts.has(key)) return null;
    const text = drafts.get(key);
    drafts.delete(key);
    return text;
}

export function clearDrafts() { drafts.clear(); }

/* History view */

const PREVIEW_CHARS = 40;

// A one-row preview of a snapshot; whitespace is folded so a leading blank line never shows
// as an empty row.
export function previewText(text, max = PREVIEW_CHARS) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) return STRINGS.manager.previewEmpty;
    // By code point: slicing code units can split a surrogate pair.
    const chars = [...flat];
    if (chars.length <= max) return flat;
    return chars.slice(0, max).join('') + '...';
}

// Variants grouped by section, snapshots newest first, each keeping its storage index (what
// history.js restore() takes). previewFor limits the costly previews: omit it for all, pass a
// variantId for that variant's only, or null for counts alone.
export function historyView(persona, sectionId, previewFor) {
    const history = persona?.history ?? {};
    const everything = previewFor === undefined;
    const groups = [];
    for (const section of persona?.sections ?? []) {
        if (sectionId && section.id !== sectionId) continue;
        const variants = (persona?.variants?.[section.id] ?? []).map(variant => {
            const list = history[variant.id] ?? [];
            const wanted = everything || previewFor === variant.id;
            const snapshots = wanted ? list.map((entry, index) => ({
                index,
                at: entry?.at ?? 0,
                preview: previewText(entry?.text),
            })) : [];
            snapshots.reverse();
            return {
                sectionId: section.id,
                sectionName: section.name ?? '',
                variantId: variant.id,
                // From the stored list, so it is right even when previews were skipped.
                count: list.length,
                label: variant.label ?? '',
                snapshots,
            };
        });
        groups.push({ sectionId: section.id, sectionName: section.name ?? '', variants });
    }
    return groups;
}

// Whether the history screen should explain why history got shorter (eviction or expiry).
export function hasEvictionNotice(persona) {
    return (persona?.log ?? []).some(entry => entry?.kind === 'history-evicted' || entry?.kind === 'history-expired');
}

// An order-free identity for the set of sections missing from the prompt, so the toast fires
// only when the set changes. JSON, as in draftKey: names are user text.
export function missingSignature(missing) {
    return JSON.stringify([...(missing ?? [])].map(name => String(name ?? '')).sort());
}

/* Settings ranges */

// Shared by the settings screen and clampSetting, so the two cannot disagree.
export const SETTING_RANGES = Object.freeze({
    historyPerVariant: Object.freeze({ min: 0, max: 50, step: 1 }),
    historyMaxBytes: Object.freeze({ min: 65536, max: 2097152, step: 1024 }),
    historyMaxDays: Object.freeze({ min: 0, max: 3650, step: 1 }),
    historyCoalesceMinutes: Object.freeze({ min: 1, max: 30, step: 1 }),
    // 0 means everything on one page.
    rosterTileRows: Object.freeze({ min: 0, max: 20, step: 1 }),
    pageSizeRoster: Object.freeze({ min: 0, max: 200, step: 1 }),
    pageSizeAssets: Object.freeze({ min: 0, max: 200, step: 1 }),
    pageSizeVersions: Object.freeze({ min: 0, max: 200, step: 1 }),
    // Not on the drawer but clamped for imports: 0 or less would empty the recent list on
    // every switch, and a string would skip roster.js's trim.
    lastUsedCap: Object.freeze({ min: 10, max: 500, step: 1 }),
});

// The drawer's fixed column choices (0 is auto); imports are held to the same list.
export const TILE_COLUMN_CHOICES = Object.freeze([0, 2, 3, 4, 5, 6]);

// Android number inputs accept any paste, and NaN would serialise as null, which readers take
// as no cap at all. Unparseable values become the shipped default instead.
export function clampSetting(key, value) {
    const range = SETTING_RANGES[key];
    if (!range) return value;
    // Number('') is 0, which would turn history off for a user clearing the box to retype,
    // so an empty field is no value.
    const raw = typeof value === 'string' ? value.trim() : value;
    if (raw === '' || raw === null || raw === undefined) return DEFAULT_SETTINGS[key];
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS[key];
    return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

/* Settings export and import */

// Indented: one line of hundreds of KB is unreadable in a phone text viewer.
export function serializeRoot(root) {
    return JSON.stringify(root ?? {}, null, 2);
}

// Settings limited to a fixed set, with the choices the drawer and screens offer.
const SETTING_CHOICES = Object.freeze({
    assetStyle: ['plain', 'bordered', 'polaroid'],
    rosterTileShape: TILE_SHAPES,
    defaultHeadingFormat: HEADING_FORMATS,
    sortBy: SORT_KEYS,
    rosterViewMode: VIEW_MODES,
    pickerViewMode: VIEW_MODES,
});

// The only gate before an imported file replaces everything stored. Writes nothing: returns
// { ok: true, root } to install, or { ok: false, message } with the sentence to show.
export function parseImportedRoot(text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text ?? ''));
    } catch (e) {
        return { ok: false, message: STRINGS.settings.importNotJson(String(e?.message ?? e)) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, message: STRINGS.settings.importNotShape };
    }
    // An array container would take named keys in memory and lose them all on save.
    for (const key of ['personas', 'settings', 'lastUsed']) {
        if (Object.hasOwn(parsed, key) && (!parsed[key] || typeof parsed[key] !== 'object' || Array.isArray(parsed[key]))) {
            return { ok: false, message: STRINGS.settings.importNotShape };
        }
    }
    if (Object.hasOwn(parsed, 'labels') && !Array.isArray(parsed.labels)) {
        return { ok: false, message: STRINGS.settings.importNotShape };
    }
    const version = parsed.schemaVersion;
    // A newer build's root would install read-only, with the user's data already replaced.
    if (typeof version === 'number' && version > SCHEMA_VERSION) {
        return { ok: false, message: STRINGS.settings.importNewer(version, SCHEMA_VERSION) };
    }
    // Every persona entry must be an object: migrate never fixes existing shapes, and a string
    // or null would throw on the first write. Refused, not repaired; nothing is touched yet.
    const malformed = Object.values(parsed.personas ?? {})
        .filter(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)).length;
    if (malformed) return { ok: false, message: STRINGS.settings.importBadPersonas(malformed) };

    // migrate backfills containers and defaults for older or hand-trimmed files.
    const root = migrate(parsed);
    // Imported numbers get the drawer's clamp (migrate keeps whatever is present):
    // historyMaxBytes 0 would make the budget evict every snapshot.
    if (root.settings && typeof root.settings === 'object') {
        for (const key of Object.keys(SETTING_RANGES)) {
            if (Object.hasOwn(root.settings, key)) root.settings[key] = clampSetting(key, root.settings[key]);
        }
        if (!TILE_COLUMN_CHOICES.includes(Number(root.settings.rosterTileColumns))) {
            root.settings.rosterTileColumns = DEFAULT_SETTINGS.rosterTileColumns;
        } else {
            root.settings.rosterTileColumns = Number(root.settings.rosterTileColumns);
        }
        // Choices and switches too, or the drawer would show a blank select or a misleading box.
        for (const [key, allowed] of Object.entries(SETTING_CHOICES)) {
            if (Object.hasOwn(root.settings, key) && !allowed.includes(root.settings[key])) root.settings[key] = DEFAULT_SETTINGS[key];
        }
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (typeof value === 'boolean' && typeof root.settings[key] !== 'boolean') root.settings[key] = value;
        }
    }
    // Non-object groups and versions would crash the first draw, so they are dropped.
    root.labels = root.labels.filter(label => label && typeof label === 'object' && !Array.isArray(label));
    for (const persona of Object.values(root.personas)) {
        persona.versions = persona.versions.filter(version => version && typeof version === 'object' && !Array.isArray(version));
    }
    return { ok: true, root };
}

/* Revise into a new version */

// One block per section the prompt carries, by compose()'s rules, so edits start from what was
// sent. variantId pins the full-text screen's save to the body shown; includeEmpty keeps empty
// bodies for that screen, which is where they get written.
export function buildReplaceBlocks(persona, includeEmpty) {
    const blocks = [];
    for (const section of persona?.sections ?? []) {
        const variant = liveVariant(persona, section);
        if (!variant) continue;
        const text = (variant.text ?? '').trim();
        if (!text && !includeEmpty) continue;
        blocks.push({ sectionId: section.id, sectionName: section.name ?? '', variantId: variant.id, text });
    }
    return blocks;
}

// Full-text screen: what saving would write, decided without mutating anything. A block is
// written only while its body exists and is still the active pick; otherwise it is skipped.
export function planFullTextSave(persona, blocks, texts) {
    const writes = [];
    const skipped = [];
    (blocks ?? []).forEach((block, index) => {
        const next = texts?.[index];
        if (typeof next !== 'string') return;
        // Compared with the trimmed text displayed; untouched blocks are never written.
        if (next === (block?.text ?? '')) return;
        const section = (persona?.sections ?? []).find(entry => entry.id === block?.sectionId);
        const variant = (persona?.variants?.[block?.sectionId] ?? []).find(entry => entry.id === block?.variantId);
        const picked = persona?.activePicks?.[block?.sectionId];
        if (!section || !variant || picked !== block?.variantId) {
            skipped.push(block?.sectionName ?? '');
            return;
        }
        const before = variant.text ?? '';
        // A whitespace-only edit can equal the stored text; writing it would log a false change.
        if (before === next) return;
        writes.push({
            sectionId: block.sectionId,
            variantId: block.variantId,
            label: variant.label ?? '',
            before,
            after: next,
        });
    });
    return { writes, skipped };
}

// SillyTavern's persona position/role enums, read off its own <select> so values and labels
// cannot be mispaired; the numbers are never hard-coded. Any malformed option refuses the
// whole select. Takes anything with options of {value, textContent}.
export function readSelectOptions(select) {
    const raw = select?.options;
    if (!raw) return null;
    const options = [];
    const seen = new Set();
    for (const option of Array.from(raw)) {
        const label = String(option?.textContent ?? option?.text ?? '').trim();
        const value = String(option?.value ?? '').trim();
        if (!label) return null;
        if (!/^-?\d+$/.test(value)) return null;
        const number = Number(value);
        if (seen.has(number)) continue;
        seen.add(number);
        options.push({ value: number, label });
    }
    return options.length >= 2 ? options : null;
}

// The typed depth in messages: non-integers are refused, not rounded. No upper bound here;
// the ceiling is SillyTavern's.
export function parseDepth(raw) {
    const text = String(raw ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : null;
}

// Copies one persona's composition onto another that ST already lists, replacing our record
// for it. Returns the copy, or null; a copy onto itself is refused as it would only churn ids.
export function copyPersonaOnto(root, sourceAvatar, destAvatar, makeIdFn, now, detail) {
    if (!root || typeof root !== 'object') return null;
    if (!root.personas || typeof root.personas !== 'object') return null;
    if (typeof sourceAvatar !== 'string' || typeof destAvatar !== 'string') return null;
    if (!sourceAvatar || !destAvatar || sourceAvatar === destAvatar) return null;
    const source = root.personas[sourceAvatar];
    if (!source) return null;
    const copy = duplicatePersona(source, makeIdFn);
    if (!copy) return null;
    // The destination keeps what describes its own picture (folder, avatar backup, written
    // asset): the copy replaces the text, not the image file.
    const dest = root.personas[destAvatar];
    if (dest && typeof dest === 'object') {
        if (dest.assetFolderKey) copy.assetFolderKey = dest.assetFolderKey;
        if (dest.avatarBackup) copy.avatarBackup = dest.avatarBackup;
        if (typeof dest.avatarWritten === 'string') copy.avatarWritten = dest.avatarWritten;
    }
    // And its per-language names: copied, auto naming would rename it to the source's name,
    // which the source could then never take back (names must be unique).
    copy.names = dest && typeof dest === 'object' && dest.names && typeof dest.names === 'object'
        ? { ...dest.names } : {};
    // Logged on the copy: nothing happened to the source.
    addLog(copy, 'persona-copy', detail ?? '', now);
    root.personas[destAvatar] = copy;
    return copy;
}

// Applies one replacement to a block's text; offsets (from a DOM selection) are clamped. A
// deletion also takes the following whitespace (the preceding run at the end of the text), but
// stops at a newline unless the span starts a line, so paragraphs never fuse.
export function applyReplacement(text, start, end, replacement) {
    const source = String(text ?? '');
    const from = Number.isInteger(start) ? Math.max(0, Math.min(start, source.length)) : 0;
    const to = Number.isInteger(end) ? Math.max(from, Math.min(end, source.length)) : from;
    const insert = String(replacement ?? '');
    if (insert !== '') return source.slice(0, from) + insert + source.slice(to);
    let cutFrom = from;
    let cutTo = to;
    if (cutTo < source.length && /\s/.test(source[cutTo])) {
        const wholeLine = from === 0 || source[from - 1] === '\n';
        while (cutTo < source.length && /\s/.test(source[cutTo])) {
            if (!wholeLine && source[cutTo] === '\n') break;
            cutTo++;
        }
    } else if (cutTo >= source.length) {
        while (cutFrom > 0 && /\s/.test(source[cutFrom - 1])) cutFrom--;
    }
    return source.slice(0, cutFrom) + source.slice(cutTo);
}

// Saves the revise screen as a new version: each changed section gets a new choice named after
// the version and picked; nothing existing is overwritten. Logs variant-add only (the caller's
// commit() logs version-create). Returns { version, changed, skipped }, or null for no name.
export function makeReplaceVersion(persona, blocks, workingTexts, name, makeIdFn, now) {
    const trimmed = String(name ?? '').trim();
    if (!persona || !trimmed) return null;
    const changed = [];
    const skipped = [];
    (blocks ?? []).forEach((block, index) => {
        // A missing working text means unchanged, never a deletion.
        const working = String(workingTexts?.[index] ?? block.text);
        if (working === block.text) return;
        const list = persona.variants?.[block.sectionId];
        if (!Array.isArray(list) || !persona.sections?.some(section => section.id === block.sectionId)) {
            skipped.push(block.sectionName);
            return;
        }
        const variantId = makeId(makeIdFn);
        list.push({ id: variantId, label: trimmed, text: working, updatedAt: now });
        if (!persona.activePicks) persona.activePicks = {};
        persona.activePicks[block.sectionId] = variantId;
        addLog(persona, 'variant-add', trimmed, now);
        changed.push({ sectionId: block.sectionId, variantId });
    });
    return { version: addVersion(persona, trimmed, makeIdFn, now), changed, skipped };
}

// Captured before makeReplaceVersion runs, so a refused save can be fully undone instead of
// leaving everything to be duplicated by a retry.
export function replaceVersionUndo(persona) {
    return {
        // A copy: makeReplaceVersion writes into the picks object in place.
        activePicks: persona?.activePicks ? { ...persona.activePicks } : persona?.activePicks,
        activeVersionId: persona?.activeVersionId ?? null,
        log: Array.isArray(persona?.log) ? persona.log.slice() : persona?.log,
    };
}

export function undoReplaceVersion(persona, result, undo) {
    if (!persona || !result) return;
    const versions = Array.isArray(persona.versions) ? persona.versions : [];
    const at = versions.indexOf(result.version);
    if (at !== -1) versions.splice(at, 1);
    for (const { sectionId, variantId } of result.changed ?? []) {
        const list = persona.variants?.[sectionId];
        if (!Array.isArray(list)) continue;
        const index = list.findIndex(variant => variant?.id === variantId);
        if (index !== -1) list.splice(index, 1);
    }
    persona.activePicks = undo.activePicks;
    persona.activeVersionId = undo.activeVersionId;
    persona.log = undo.log;
}

// Per-version persona picture: the asset that becomes the avatar when the version is applied.
// Always read through here, since a hand-edited settings.json can hold anything.
export function boundAsset(version) {
    const label = version?.avatarAsset;
    return typeof label === 'string' && label ? label : null;
}

// Whether the binding is an exact file name (set since 0.3.3). Older ones may hold 0.2.0's
// lowercased server label and keep findAsset's loose match; exact ones must not, or a deleted
// pose.png would resolve to pose-1.png.
export function bindingIsExact(version) {
    return version?.avatarAssetExact === true;
}

// Returns whether anything changed; an empty label clears the binding.
export function bindAsset(version, label, now) {
    if (!version || typeof version !== 'object') return false;
    const next = typeof label === 'string' && label.trim() ? label.trim() : null;
    if (boundAsset(version) === next) return false;
    version.avatarAsset = next;
    if (next) version.avatarAssetExact = true;
    else delete version.avatarAssetExact;
    // A crop belongs to the picture it was made on.
    version.avatarCrop = null;
    version.updatedAt = now;
    return true;
}

// Whether the avatar file already shows the version's picture (or none is bound). Re-applying
// the active version is skipped only then, so a failed picture write can be retried.
export function pictureSettled(persona, versionId) {
    const version = findVersion(persona, versionId);
    const label = boundAsset(version);
    return !label || persona?.avatarWritten === writtenKey(label, validCrop(version?.avatarCrop));
}

// The binding's state for the screen. 'unknown' while the asset listing is not loaded:
// an unread listing is no proof that the asset is gone.
export function versionImageState(version, assetLabels, listingOk) {
    const label = boundAsset(version);
    if (!label) return { label: null, state: 'none' };
    if (!listingOk) return { label, state: 'unknown' };
    // Matched as the write matches it (findAsset), so screen and write agree on old labels.
    const hit = resolveBinding(label, assetLabels, bindingIsExact(version));
    return hit ? { label: hit.label, state: 'ok' } : { label, state: 'missing' };
}

const resolveBinding = (label, assetLabels, exact) =>
    findAsset((assetLabels ?? []).map(name => ({ label: name, serverLabel: groupLabelOf(name) })), label, exact);

// Versions bound to an asset, counted by the delete confirmation. Given the listing, bindings
// resolve as the write resolves them, so old lowercased labels count too.
export function versionsBindingAsset(persona, label, assetLabels = null) {
    if (!label) return [];
    const points = Array.isArray(assetLabels)
        ? version => resolveBinding(boundAsset(version), assetLabels, bindingIsExact(version))?.label === label
        : version => boundAsset(version) === label;
    return (persona?.versions ?? []).filter(version => version && points(version));
}

/* Drag reorder */

// Moves a section to toIndex, its position after the move (what a drop target means).
export function reorderSection(persona, sectionId, toIndex) {
    const sections = persona?.sections;
    if (!Array.isArray(sections)) return false;
    const from = sections.findIndex(section => section.id === sectionId);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(sections.length - 1, Math.trunc(Number(toIndex))));
    if (!Number.isFinite(to) || to === from) return false;
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved);
    return true;
}

// Every tag in use, in locale-independent order so runs agree.
export function tagsAcross(personas) {
    const seen = new Set();
    for (const persona of personas ?? []) {
        for (const tag of persona?.tags ?? []) seen.add(tag);
    }
    return [...seen].sort();
}

// Per-language names, kept on our record and keyed by detectLanguage's codes. ST's personas
// map changes only on an explicit apply, since ST identifies personas by it everywhere.
export function setLocalName(persona, lang, name) {
    if (!persona || typeof persona !== 'object') return false;
    const code = String(lang ?? '').trim();
    if (!code) return false;
    if (!persona.names || typeof persona.names !== 'object') persona.names = {};
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
        if (!Object.hasOwn(persona.names, code)) return false;
        delete persona.names[code];
        return true;
    }
    if (persona.names[code] === trimmed) return false;
    persona.names[code] = trimmed;
    return true;
}

// The name to show for a language, falling back to the one SillyTavern knows.
export function localName(persona, lang, fallback) {
    const stored = persona?.names?.[lang];
    return (typeof stored === 'string' && stored.trim()) ? stored : (fallback ?? '');
}

// Size of a text. Tokens come only from SillyTavern's counter when one is passed in (a guessed
// tokenizer would be confidently wrong); otherwise tokens is null.
export function countSize(text, tokenCounter) {
    const body = String(text ?? '');
    // Code points: .length would count an emoji as two.
    const chars = [...body].length;
    let tokens = null;
    if (typeof tokenCounter === 'function') {
        try {
            const n = tokenCounter(body);
            if (Number.isFinite(n) && n >= 0) tokens = Math.round(n);
        } catch { tokens = null; }
    }
    return { chars, tokens, bytes: new TextEncoder().encode(body).length };
}

// Copies our record of a persona with fresh ids, so the two never share section or variant ids
// that version picks could cross-match. History is not copied: it belongs to the source.
export function duplicatePersona(source, makeIdFn) {
    if (!source || typeof source !== 'object') return null;
    const idMap = new Map();
    const fresh = id => {
        if (!idMap.has(id)) idMap.set(id, makeId(makeIdFn));
        return idMap.get(id);
    };
    const copy = {
        sections: (source.sections ?? []).map(sec => ({ ...sec, id: fresh(sec.id) })),
        variants: {},
        versions: [],
        activeVersionId: null,
        activePicks: {},
        headingFormat: source.headingFormat ?? 'none',
        // The own format's title pattern, or the copy would print every title as markdown.
        ...(source.headingTemplate ? { headingTemplate: { ...source.headingTemplate } } : {}),
        history: {},
        log: [],
        assets: {},
        assetFolderKey: null,
        composedSig: null,
        tags: [...(source.tags ?? [])],
        names: { ...(source.names ?? {}) },
    };
    for (const [sectionId, list] of Object.entries(source.variants ?? {})) {
        copy.variants[fresh(sectionId)] = (list ?? []).map(v => ({ ...v, id: fresh(v.id) }));
    }
    for (const [sectionId, variantId] of Object.entries(source.activePicks ?? {})) {
        copy.activePicks[fresh(sectionId)] = fresh(variantId);
    }
    for (const version of source.versions ?? []) {
        const picks = {};
        for (const [sectionId, variantId] of Object.entries(version.picks ?? {})) {
            picks[fresh(sectionId)] = fresh(variantId);
        }
        const next = { ...version, id: makeId(makeIdFn), picks, tags: [...(version.tags ?? [])] };
        // Asset selections name files in a folder the copy does not own yet.
        next.assetSelection = null;
        // So does the bound picture, which the spread copied.
        next.avatarAsset = null;
        copy.versions.push(next);
        if (source.activeVersionId === version.id) copy.activeVersionId = next.id;
    }
    return copy;
}

/* Tags */

// Adds a trimmed, non-empty, not yet present tag to a persona or version; returns it or null.
export function addTag(owner, tag) {
    if (!owner || typeof owner !== 'object') return null;
    const trimmed = String(tag ?? '').trim();
    if (!trimmed) return null;
    if (!Array.isArray(owner.tags)) owner.tags = [];
    if (owner.tags.includes(trimmed)) return null;
    owner.tags.push(trimmed);
    return trimmed;
}

export function removeTag(owner, tag) {
    if (!Array.isArray(owner?.tags)) return false;
    const index = owner.tags.indexOf(tag);
    if (index === -1) return false;
    owner.tags.splice(index, 1);
    return true;
}

/* Fill in default sections */

// Space-insensitive name identity, with aliases from old default names to current ones, so
// filling never adds a renamed default next to its old spelling.
const SECTION_NAME_ALIASES = Object.freeze({ '외형': '외모', '기본정보': '기본 정보' });

function sectionNameKey(name) {
    const flat = String(name ?? '').replace(/\s+/g, '');
    // Own keys only, so prototype names never match.
    const alias = Object.hasOwn(SECTION_NAME_ALIASES, flat) ? SECTION_NAME_ALIASES[flat] : undefined;
    return (alias ?? flat).replace(/\s+/g, '');
}

// The default sections fillDefaultSections would add, for the confirmation's count.
export function missingDefaultSections(persona) {
    const have = new Set((persona?.sections ?? []).map(section => sectionNameKey(section.name)));
    return DEFAULT_SECTION_NAMES.filter(name => !have.has(sectionNameKey(name)));
}

// Appends the missing default sections, each with one empty choice picked, and returns their
// names. compose skips empty bodies, so the prompt is unchanged until text is written.
export function fillDefaultSections(persona, makeIdFn, now) {
    if (!persona) return [];
    const added = [];
    for (const name of missingDefaultSections(persona)) {
        if (!Array.isArray(persona.sections)) persona.sections = [];
        if (!persona.variants) persona.variants = {};
        if (!persona.activePicks) persona.activePicks = {};
        const { sectionId, variantId } = appendSection(persona, { name }, makeIdFn, '', now);
        pickInEveryVersion(persona, sectionId, variantId);
        addLog(persona, 'section-add', name, now);
        added.push(name);
    }
    return added;
}

/* Per version asset selection */

// assetSelection null means every asset, including future uploads; a list exists only while
// something is excluded. Names resolve as {{persona_assets}} does (selectedNames), since
// selections up to 0.2.0 hold ST's lowercased labels. allFilenames is what the screen lists.
export function assetSelected(version, filename, allFilenames = []) {
    const selection = version?.assetSelection;
    if (!Array.isArray(selection)) return true;
    const all = Array.isArray(allFilenames) && allFilenames.includes(filename) ? allFilenames : [...(allFilenames ?? []), filename];
    return selectedNames(selection, all).has(filename);
}

export function toggleAssetSelection(version, filename, allFilenames = []) {
    if (!version) return null;
    const all = [];
    for (const name of allFilenames ?? []) {
        if (typeof name === 'string' && !all.includes(name)) all.push(name);
    }
    // Normalise stored names to the folder's spelling (an old group label becomes its files);
    // names matching no file are kept so a re-upload is selected again.
    const raw = Array.isArray(version.assetSelection) ? version.assetSelection : null;
    let current = null;
    if (raw !== null) {
        const covered = selectedNames(raw, all);
        const orphans = raw.filter(entry => typeof entry === 'string' && !selectedNames([entry], all).size);
        current = [...all.filter(name => covered.has(name)), ...orphans];
    }

    let next;
    if (current === null) {
        // Was every asset, so a tap means all but this one.
        next = all.filter(name => name !== filename);
    } else if (current.includes(filename)) {
        next = current.filter(name => name !== filename);
    } else {
        // In folder order, however the boxes were ticked.
        next = all.filter(name => current.includes(name) || name === filename);
        if (!all.includes(filename)) next.push(filename);
    }

    // Nothing excluded: back to null rather than freezing today's folder contents.
    if (all.length && next.length === all.length && all.every(name => next.includes(name))) {
        version.assetSelection = null;
        return null;
    }
    version.assetSelection = next;
    return next;
}

/* Asset tags */

// Always folder-qualified: a bare tag resolves against whoever is active at render time.
export function insertTagText(folderKey, filename) {
    return `{{pimg::${String(folderKey ?? '')}/${String(filename ?? '')}}}`;
}

// The textarea value and caret after inserting text at the caret, replacing any selection;
// with no usable caret the text goes at the end, not at position zero.
export function insertAtCursor(value, start, end, text) {
    const source = String(value ?? '');
    const insert = String(text ?? '');
    const from = Number.isInteger(start) && start >= 0 ? Math.min(start, source.length) : source.length;
    const to = Number.isInteger(end) && end >= from ? Math.min(end, source.length) : from;
    return { value: source.slice(0, from) + insert + source.slice(to), caret: from + insert.length };
}
