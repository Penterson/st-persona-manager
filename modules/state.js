// Which persona is active and what its data is; everything the UI needs goes through here.
import { MODULE_NAME, migrate, getPersona, ensurePersona, liveVariant, usageBytes, textSignature, makeId, ADOPT_MODES } from './store.js';
import {
    resolveAvatar, findDuplicateNames, loadPreciseApi, freshContext, selectedAvatarFromDom,
} from './ctx.js';
import { writeDescription, hasDiverged, compose, markComposed, baselineSignature, planAbsorb } from './compose.js';
import { addLog, snapshot, expireOldHistory, enforceGlobalBudget } from './history.js';
import { splitDescription, seedFromSplit, splitOwnSections, seedOwnSections, sameText } from './classify.js';
import { STRINGS } from './strings.js';
import { clearSearchCaches } from './search-pure.js';
import { resolveFolderKey, listAssets } from './assets.js';
import { recordUse } from './roster.js';

let preciseApi = null;
let cache = null;

// No exported function takes a context (a kept one goes stale); each asks the provider once.
let provider = freshContext;

// For tests; call with nothing to restore the real provider.
export function setContextProvider(fn) {
    provider = (typeof fn === 'function') ? fn : freshContext;
}

export async function initPrecise() { preciseApi = await loadPreciseApi(); }

// The optional precise api, or null (see loadPreciseApi); callers verify what it says.
export function getPreciseApi() { return preciseApi; }

export function resetState() {
    // destroy() leaves no module state, or a re-enable serves the previous session's data.
    preciseApi = null;
    cache = null;
    clearSearchCaches();
}

function rootOf(ctx) {
    const stored = ctx.extensionSettings[MODULE_NAME];
    // Only a plain object is a root: for anything else migrate returns a fresh copy per call.
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) ctx.extensionSettings[MODULE_NAME] = {};
    return migrate(ctx.extensionSettings[MODULE_NAME]);
}

export function getRoot() {
    const ctx = provider();
    return ctx ? rootOf(ctx) : null;
}

export function getState() { return cache; }

// On demand for the settings screen; in refresh() it would stringify the tree per event.
export function readUsageBytes() {
    const ctx = provider();
    return ctx ? usageBytes(rootOf(ctx)) : 0;
}

// Who is active according to this context; a write re-asks without rebuilding the cache, which
// would hide a disagreement with it.
function resolveActive(ctx) {
    const pu = ctx.powerUserSettings ?? {};
    return resolveAvatar({
        preciseAvatar: preciseApi?.user_avatar ?? null,
        // Read per call, like the context: SillyTavern's list moves when the user switches.
        domAvatar: typeof document === 'undefined' ? null : selectedAvatarFromDom(document),
        lockedAvatar: ctx.chatMetadata?.persona ?? null,
        name1: ctx.name1,
        personas: pu.personas,
    });
}

function refreshWith(ctx) {
    const root = rootOf(ctx);
    const pu = ctx.powerUserSettings ?? {};
    const resolved = resolveActive(ctx);

    const persona = resolved.avatar ? getPersona(root, resolved.avatar) : null;
    // Stale asset data is dropped the moment the persona changes, so no macro injects it.
    const sameAvatar = !!cache && cache.avatar === resolved.avatar;
    // The one place a persona switch is known (so the only recordUse caller); the first
    // refresh records the persona at load. A newer build's root is left alone.
    if (resolved.avatar && !sameAvatar && !root.readOnly) {
        recordUse(root, resolved.avatar, Date.now(), root.settings.lastUsedCap);
        // Saved once per real switch; a load is none.
        if (cache) ctx.saveSettingsDebounced?.();
    }
    cache = {
        root,
        settings: root.settings,
        avatar: resolved.avatar,
        source: resolved.source,
        ambiguous: resolved.ambiguous,
        duplicateNames: findDuplicateNames(pu.personas),
        persona,
        diverged: persona ? hasDiverged(ctx, resolved.avatar, persona) : false,
        assetNames: sameAvatar ? cache.assetNames : [],
        assetPaths: sameAvatar ? cache.assetPaths : new Map(),
        assetError: sameAvatar ? cache.assetError : null,
        readOnly: !!root.readOnly,
    };
    return cache;
}

export function refresh() {
    const ctx = provider();
    // No context: null, not the previous answer passed off as current.
    return ctx ? refreshWith(ctx) : null;
}

/* Seeds a record per settings.adoptSplitMode ('own' keeps the description's own sections only if
   they compose back to the same text); returns items filled, 0 when it went in whole. */
function seedDescription(persona, description, makeIdFn, settings) {
    const mode = ADOPT_MODES.includes(settings?.adoptSplitMode) ? settings.adoptSplitMode : 'own';
    if (mode === 'own') {
        const own = splitOwnSections(description);
        if (own) {
            // Tried on a copy, kept only if it reproduces the description.
            const trial = structuredClone(persona);
            seedOwnSections(trial, own, makeIdFn);
            if (sameText(compose(trial).text, description)) {
                Object.assign(persona, trial);
                return persona.sections.length;
            }
        }
    }
    const split = mode === 'defaults'
        ? splitDescription(description, persona.sections.map(section => section.name))
        : null;
    if (split) return seedFromSplit(persona, split, makeIdFn, settings?.defaultHeadingFormat);
    persona.variants[persona.sections[0].id][0].text = description;
    // Whole means exactly: a heading format would prefix a title on the first write.
    if (String(description ?? '').trim()) persona.headingFormat = 'none';
    return 0;
}

// Creates our record for avatarId, seeded from its existing SillyTavern description.
function createRecord(ctx, root, avatarId) {
    const persona = ensurePersona(root, avatarId, ctx.uuidv4);
    const description = ctx.powerUserSettings?.persona_descriptions?.[avatarId]?.description ?? '';
    const filled = seedDescription(persona, description, ctx.uuidv4, root.settings);
    markComposed(persona, description);
    // A birth log line keeps the pruner off, as it cannot see renamed or reordered sections.
    const detail = filled ? STRINGS.manager.logDetails.importedSplit(filled) : STRINGS.manager.logDetails.imported;
    addLog(persona, 'import', detail, Date.now());
    ctx.saveSettingsDebounced();
    return persona;
}

export function adopt() {
    const ctx = provider();
    if (!ctx) return null;
    const s = refreshWith(ctx);
    if (!s.avatar || s.persona) return s;
    // Checked here too: the disabled button misses a tap queued before the redraw.
    if (s.readOnly) return s;
    createRecord(ctx, s.root, s.avatar);
    return refreshWith(ctx);
}

/* Log kinds that cannot change the composed text: they save our record and leave SillyTavern's
   description alone. Exported as a question only, since a frozen Set still answers .add(). */
const KEEP_KINDS = new Set([
    'version-create', 'version-rename', 'version-duplicate', 'version-overwrite',
    'version-repick', 'version-move', 'version-delete',
    'variant-add', 'variant-rename', 'variant-duplicate',
    'tag-add', 'tag-remove', 'asset-select', 'image-bind', 'image-crop',
]);
export const KEEP_DESCRIPTION_KINDS = Object.freeze({ has: kind => KEEP_KINDS.has(kind) });

// Same result shape as writeDescription, but SillyTavern's own field is left as it is.
function keepDescription(ctx, persona) {
    const { text, missing } = compose(persona);
    ctx.saveSettingsDebounced();
    return { text, missing, kept: true };
}

const unchangedSinceWrite = persona => textSignature(compose(persona).text) === baselineSignature(persona);

/* A keep kind claims the text did not change, so it is checked: a changed composition is
   written unless an outside edit is pending. Equal line for line (sameText) is unchanged. */
function mustWrite(ctx, avatarId, persona, write) {
    if (write) return true;
    if (unchangedSinceWrite(persona)) return false;
    if (hasDiverged(ctx, avatarId, persona)) return false;
    const current = ctx.powerUserSettings?.persona_descriptions?.[avatarId]?.description ?? '';
    return !sameText(compose(persona).text, current);
}

/* While an outside edit is pending, a write that would only restore what SillyTavern was last
   given is skipped. Applying a version passes force. */
function leaveOutsideEdit(ctx, avatarId, persona, outside, force) {
    return outside === 'keep' && !force && unchangedSinceWrite(persona) && hasDiverged(ctx, avatarId, persona);
}

/* An outside edit is never overwritten without a copy: it is kept, unpicked, as a new choice in
   the item holding the text (or the first item). */
function keepOutsideText(ctx, avatarId, persona) {
    const text = ctx.powerUserSettings?.persona_descriptions?.[avatarId]?.description;
    if (typeof text !== 'string' || !text.trim()) return null;
    const sections = Array.isArray(persona.sections) ? persona.sections : [];
    if (!sections.length) return null;
    const filled = sections.filter(section => (liveVariant(persona, section)?.text ?? '').trim());
    const section = filled.length === 1 ? filled[0] : sections[0];
    if (!Array.isArray(persona.variants[section.id])) persona.variants[section.id] = [];
    const now = Date.now();
    const label = STRINGS.common.outsideKeptLabel(now);
    persona.variants[section.id].push({ id: makeId(ctx.uuidv4), label, text, updatedAt: now });
    addLog(persona, 'diverge-kept', `${section.name ?? ''} / ${label}`, now);
    return { section: section.name ?? '', label };
}

// The shared tail of both saves: keep SillyTavern's text when the write would change
// nothing or clobber a pending outside edit, otherwise write it (copying any outside edit).
function writeOrKeep(ctx, avatarId, persona, activeAvatar, { write, outside, force }) {
    if (leaveOutsideEdit(ctx, avatarId, persona, outside, force) || !mustWrite(ctx, avatarId, persona, write)) {
        const kept = keepDescription(ctx, persona);
        refreshWith(ctx);
        return kept;
    }
    const keptOutside = outside === 'keep' && hasDiverged(ctx, avatarId, persona)
        ? keepOutsideText(ctx, avatarId, persona) : null;
    const result = writeDescription(ctx, avatarId, persona, activeAvatar);
    if (result.missing.length) {
        // A section that vanished from the prompt must leave a trace.
        addLog(persona, 'compose-missing', result.missing.join(', '), Date.now());
        ctx.saveSettingsDebounced();
    }
    refreshWith(ctx);
    return keptOutside ? { ...result, keptOutside } : result;
}

export function saveAndCompose(expectedAvatar, { write = true, outside = 'keep', force = false } = {}) {
    const ctx = provider();
    if (!ctx) return null;
    const s = getState();
    if (!s?.persona || !s.avatar || s.readOnly) return null;
    // Who is active per the live context, not the cache, which may lag.
    const active = resolveActive(ctx);
    // Same named personas without a precise path are not guessed at.
    if (active.ambiguous) return null;
    // The editor may have been opened on one persona and saved after a switch.
    if (expectedAvatar !== undefined && expectedAvatar !== null && expectedAvatar !== s.avatar) {
        return { ok: false, reason: 'persona-changed', expected: expectedAvatar, actual: s.avatar };
    }
    // The cache itself may have fallen behind, unnoticed upstream.
    if (active.avatar !== s.avatar) {
        return { ok: false, reason: 'persona-changed', expected: s.avatar, actual: active.avatar };
    }
    return writeOrKeep(ctx, s.avatar, s.persona, active.avatar, { write, outside, force });
}

// adopt() for any persona SillyTavern knows, not only the active one (the manager picker).
export function adoptFor(avatarId) {
    const ctx = provider();
    if (!ctx) return null;
    const root = getRoot();
    if (!root || root.readOnly) return null;
    // Never for an avatar SillyTavern does not list.
    if (!Object.hasOwn(ctx.powerUserSettings?.personas ?? {}, avatarId)) return null;
    return getPersona(root, avatarId) || createRecord(ctx, root, avatarId);
}

// Composes and stores any persona, pinned by argument; SillyTavern's prompt field is written
// only if it is the live active one.
export function saveAndComposeFor(avatarId, { write = true, outside = 'keep', force = false } = {}) {
    const ctx = provider();
    if (!ctx) return null;
    const root = getRoot();
    if (!root || root.readOnly) return null;
    if (!Object.hasOwn(ctx.powerUserSettings?.personas ?? {}, avatarId)) return null;
    const persona = getPersona(root, avatarId);
    if (!persona) return null;
    const active = resolveActive(ctx);
    // Duplicate names and no precise path: whether to write the singular field is unknowable.
    if (active.ambiguous) return null;
    const result = writeOrKeep(ctx, avatarId, persona, active.avatar, { write, outside, force });
    // No persona confirmed active: only the stored copy was written, which the caller reports.
    return !result.kept && !active.avatar ? { ...result, activeUnknown: true } : result;
}

/* An edit made in SillyTavern's own persona box, taken into the active persona's items as it
   happens (settings.autoAbsorbOutside). SillyTavern's text is left exactly as typed: it
   becomes the new baseline, so nothing is written back into the box while the user types.
   Snapshots are not forced, so a burst of typing keeps one history entry per merge window.
   Returns null when there is nothing to do, else planAbsorb's refusal or { ok, changed }. */
export function autoAbsorbOutside() {
    const ctx = provider();
    if (!ctx) return null;
    const root = getRoot();
    if (!root || root.readOnly || root.settings?.autoAbsorbOutside === false) return null;
    const active = resolveActive(ctx);
    if (active.ambiguous || !active.avatar) return null;
    const persona = getPersona(root, active.avatar);
    if (!persona || !hasDiverged(ctx, active.avatar, persona)) return null;
    const text = ctx.powerUserSettings?.persona_descriptions?.[active.avatar]?.description ?? '';
    const plan = planAbsorb(persona, text);
    if (!plan.ok) return plan;
    const now = Date.now();
    const changed = [];
    for (const write of plan.writes) {
        const section = (persona.sections ?? []).find(entry => entry.id === write.sectionId);
        const variant = section ? liveVariant(persona, section) : null;
        if (!variant || (variant.text ?? '') === write.text) continue;
        snapshot(persona, variant.id, variant.text ?? '', now, root.settings);
        variant.text = write.text;
        variant.updatedAt = now;
        changed.push(section.name ?? '');
    }
    expireOldHistory(root, root.settings, now);
    enforceGlobalBudget(root, root.settings, now);
    if (changed.length) addLog(persona, 'diverge-auto', changed.join(', '), now);
    markComposed(persona, text);
    ctx.saveSettingsDebounced?.();
    refreshWith(ctx);
    return { ok: true, changed };
}

export async function refreshAssets() {
    const ctx = provider();
    if (!ctx) return [];
    const before = getState();
    if (!before?.avatar) return [];
    const avatar = before.avatar;
    const key = resolveFolderKey(before.root, avatar);
    try {
        const list = await listAssets(ctx, key);
        // Published only if the (replaced) cache is still on this listing's persona.
        const after = getState();
        if (!after || after.avatar !== avatar) return list;
        after.assetNames = list.map(a => a.label);
        after.assetPaths = new Map(list.map(a => [a.label, a.path]));
        after.assetError = null;
        return list;
    } catch (e) {
        const after = getState();
        if (after && after.avatar === avatar) {
            after.assetNames = [];
            after.assetPaths = new Map();
            // Shown in the asset tab, since a phone has no console.
            after.assetError = String(e?.message ?? e);
        }
        return [];
    }
}

