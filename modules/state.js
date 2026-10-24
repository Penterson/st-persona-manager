// Single place that knows "which persona are we on and what is its data".
// Everything the UI needs goes through here.
import { MODULE_NAME, migrate, getPersona, ensurePersona, usageBytes, textSignature } from './store.js';
import {
    resolveAvatar, findDuplicateNames, loadPreciseApi, freshContext, selectedAvatarFromDom,
} from './ctx.js';
import { writeDescription, hasDiverged, compose, markComposed, baselineSignature } from './compose.js';
import { addLog } from './history.js';
import { splitDescription, seedFromSplit } from './classify.js';
import { STRINGS } from './strings.js';
import { clearSearchCaches } from './search-pure.js';
import { resolveFolderKey, listAssets } from './assets.js';
import { recordUse } from './roster.js';

let preciseApi = null;
let cache = null;

// No exported function takes a context, because a context handed in is a context
// somebody kept. getContext() copies name1, chat and characterId by value at call
// time, so a stored one keeps naming the persona that was active when it was built,
// and resolving from it writes one persona's text into another's record. Every
// exported function below asks the provider itself, once per invocation.
let provider = freshContext;

// Tests point this at a provider that returns a different context each call, which
// is what SillyTavern actually does. Call with nothing to put the real one back.
export function setContextProvider(fn) {
    provider = (typeof fn === 'function') ? fn : freshContext;
}

export async function initPrecise() { preciseApi = await loadPreciseApi(); }

// The optional precise path, or null. This is a bonus, never a dependency, and
// the import has been seen failing on this device. Callers have to work with
// null and must verify whatever they do with it.
export function getPreciseApi() { return preciseApi; }

export function resetState() {
    // destroy() has to leave no module state behind. Otherwise re-enabling the
    // extension keeps serving the previous session's persona and asset list.
    preciseApi = null;
    cache = null;
    // The search caches hold whole description bodies keyed by their own text, so
    // leaving them behind keeps the previous session's personas in memory.
    clearSearchCaches();
}

function rootOf(ctx) {
    if (!ctx.extensionSettings[MODULE_NAME]) ctx.extensionSettings[MODULE_NAME] = {};
    return migrate(ctx.extensionSettings[MODULE_NAME]);
}

export function getRoot() {
    const ctx = provider();
    return ctx ? rootOf(ctx) : null;
}

export function getState() { return cache; }

// The number belongs on the settings screen only. Computing it inside refresh()
// means a full stringify of the whole tree on every persona change, settings
// update and chat change.
export function readUsageBytes() {
    const ctx = provider();
    return ctx ? usageBytes(rootOf(ctx)) : 0;
}

// Who is active according to THIS context. Separate from refreshWith so a write can
// ask the question again without rebuilding the cache, which would only replace one
// stale answer with another and hide the disagreement we need to see.
function resolveActive(ctx) {
    const pu = ctx.powerUserSettings ?? {};
    return resolveAvatar({
        preciseAvatar: preciseApi?.user_avatar ?? null,
        // Read at the moment the question is asked, like everything else here: the
        // list on screen is SillyTavern's own and it moves when the user switches.
        domAvatar: typeof document === 'undefined' ? null : selectedAvatarFromDom(document),
        lockedAvatar: ctx.chatMetadata?.persona ?? null,
        name1: ctx.name1,
        personas: pu.personas,
        defaultPersona: pu.default_persona,
    });
}

function refreshWith(ctx) {
    const root = rootOf(ctx);
    const pu = ctx.powerUserSettings ?? {};
    const resolved = resolveActive(ctx);

    const persona = resolved.avatar ? getPersona(root, resolved.avatar) : null;
    // Drop stale asset data the moment the persona changes, so a macro cannot
    // inject the previous persona's file list while the refetch is in flight.
    const sameAvatar = !!cache && cache.avatar === resolved.avatar;
    // This is the one place a persona switch is known to have
    // actually happened, whether the user drove it through this panel or through
    // SillyTavern's own persona screen. sameAvatar is false on the very first
    // refresh too (there is no previous cache to match), which correctly records
    // whichever persona was already active when the extension loaded. A failed
    // switch never reaches this line, because the avatar refresh() resolves did
    // not change; nothing else in this file may call recordUse.
    //
    // root.readOnly is checked here and not inside recordUse, because reading the
    // panel must not write to data a newer build owns. The cap cannot save us
    // there either: migrate returns before it backfills defaults on a future
    // schema root, so settings.lastUsedCap is undefined, roster.js's typeof gate
    // never trims, and lastUsed grows without a bound. A Node simulation of 120
    // switches on a future schema root ended with 121 entries; that is a simulation
    // on this desktop, not a measurement taken on the device.
    if (resolved.avatar && !sameAvatar && !root.readOnly) {
        recordUse(root, resolved.avatar, Date.now(), root.settings.lastUsedCap);
        // recordUse mutates settings and nothing else here asks for a save, so the
        // record only reached disk when some later write happened to save for its
        // own reasons, and the recent sort could be a whole session behind. This
        // runs at most once per switch that actually happened.
        //
        // Not on the first refresh of a session. No switch happened there, only a
        // load, and saving meant serializing every extension's settings (ours
        // measured 8.4MB at ten personas) and posting them on every page load,
        // while the phone was still loading the chat. The stamp stays in memory
        // and goes out with the next save anything makes.
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
    // Nothing to resolve against. Leaving the cache alone would serve the previous
    // answer as if it were current, which is the failure this module exists to avoid.
    return ctx ? refreshWith(ctx) : null;
}

/* 가져오기 자동 분류 (user request). The existing description goes into the items
   its titles name (classify.js), or whole into the first item when it has no
   titles to go by or the user turned the split off. Answers how many items a
   split filled, 0 when the text went in whole.

   The baseline is the ORIGINAL text in both cases, so adopting never shows the
   외부 수정 banner. After a split the composed text is laid out the way compose
   writes titles, and SillyTavern receives that layout with the next write. */
function seedDescription(persona, description, makeIdFn, settings) {
    const split = settings?.splitOnAdopt === false ? null
        : splitDescription(description, persona.sections.map(section => section.name));
    if (split) return seedFromSplit(persona, split, makeIdFn, settings?.defaultHeadingFormat);
    persona.variants[persona.sections[0].id][0].text = description;
    return 0;
}

function importDetail(filled) {
    return filled ? STRINGS.manager.logDetails.importedSplit(filled) : STRINGS.manager.logDetails.imported;
}

export function adopt() {
    // Create our data for this persona, seeded from the existing description so
    // nothing the user already wrote is lost.
    const ctx = provider();
    if (!ctx) return null;
    const s = refreshWith(ctx);
    if (!s.avatar || s.persona) return s;
    // adoptFor and saveAndCompose refuse a root a newer build owns, and this
    // relied on the button being drawn disabled: a tap queued before the redraw
    // still wrote into that root.
    if (s.readOnly) return s;
    const persona = ensurePersona(s.root, s.avatar, ctx.uuidv4);
    const existing = ctx.powerUserSettings?.persona_descriptions?.[s.avatar]?.description ?? '';
    const filled = seedDescription(persona, existing, ctx.uuidv4, s.root.settings);
    markComposed(persona, existing);
    // The pruner drops entries with no sections, no variants, no history and no
    // assets, but isEmptyPersona cannot see renamed or reordered sections. One
    // log line at birth makes every entry we create non-empty, so the pruner can
    // only ever reach leftovers we never touched.
    addLog(persona, 'import', importDetail(filled), Date.now());
    ctx.saveSettingsDebounced();
    // The same context for the whole call: this body has no await, so nothing can
    // change under it, and re-asking would only cost a second object.
    return refreshWith(ctx);
}

/* Writes that cannot change the composed text: a version renamed, moved, copied
   or deleted, a tag, an asset tick, a variant nobody picked. They used to go
   through writeDescription like every other write, which rewrote SillyTavern's
   description with the composed text. With an outside edit pending (the 외부
   수정 banner, offering 되돌리기 and 가져오기) that silently threw the edit
   away, no snapshot, on a tap that had nothing to do with the text; and on every
   other tap it emitted PERSONA_UPDATED and redrew both screens for a text that had
   not changed. These save our record and leave ST's fields alone. */
export const KEEP_DESCRIPTION_KINDS = Object.freeze(new Set([
    'version-create', 'version-rename', 'version-duplicate', 'version-overwrite',
    'version-repick', 'version-move', 'version-delete',
    'variant-add', 'variant-rename', 'variant-duplicate',
    'tag-add', 'tag-remove', 'asset-select', 'image-bind', 'image-crop',
]));

// The result has writeDescription's shape, so a caller reads missing the same
// way. The text is what ST was last given, not a fresh composition.
function keepDescription(ctx, persona) {
    const { text, missing } = compose(persona);
    ctx.saveSettingsDebounced();
    return { text, missing, kept: true };
}

/* The kind is the caller's claim that the text did not change, and a claim can be
   wrong: 고쳐서 새 버전 saved under version-create while moving every edited
   item's pick onto a new choice, so the prompt kept the old text and the screen
   showed the new version applied. Checked here instead of trusted: when the
   composition is not what SillyTavern was last given, the write happens - unless
   an outside edit is pending, which a write would throw away and which the
   banner already offers to resolve. */
function mustWrite(ctx, avatarId, persona, write) {
    if (write) return true;
    if (textSignature(compose(persona).text) === baselineSignature(persona)) return false;
    return !hasDiverged(ctx, avatarId, persona);
}

export function saveAndCompose(expectedAvatar, { write = true } = {}) {
    const ctx = provider();
    if (!ctx) return null;
    const s = getState();
    if (!s?.persona || !s.avatar || s.readOnly) return null;
    // Ask the live context who is active BEFORE writing anything. The cache was built
    // by whichever event fired last, and the singular field is one slot
    // shared by every persona, so composing straight from the cache puts this
    // persona's text into whoever is really active. Handing s.avatar to
    // writeDescription as its own activeAvatar made that check compare a value to
    // itself, which is a guard that can never fail.
    const active = resolveActive(ctx);
    // Same named personas without a precise path are not guessed at.
    if (active.ambiguous) return null;
    // The editor may have been opened on one persona and saved after a switch.
    // Writing the current persona with the other one's text loses the edit silently.
    if (expectedAvatar !== undefined && expectedAvatar !== null && expectedAvatar !== s.avatar) {
        return { ok: false, reason: 'persona-changed', expected: expectedAvatar, actual: s.avatar };
    }
    // Same answer, one step further out: the cache itself may be the thing that fell
    // behind, and then nobody upstream can have noticed the switch.
    if (active.avatar !== s.avatar) {
        return { ok: false, reason: 'persona-changed', expected: s.avatar, actual: active.avatar };
    }
    if (!mustWrite(ctx, s.avatar, s.persona, write)) {
        const kept = keepDescription(ctx, s.persona);
        refreshWith(ctx);
        return kept;
    }
    const result = writeDescription(ctx, s.avatar, s.persona, active.avatar);
    if (result.missing.length) {
        // A section that vanished from the prompt must leave a trace.
        // Disappearing silently is the worst outcome available here.
        addLog(s.persona, 'compose-missing', result.missing.join(', '), Date.now());
        ctx.saveSettingsDebounced();
    }
    refreshWith(ctx);
    return result;
}

// Manager picker support: create our entry for ANY persona SillyTavern knows,
// not only the active one. Same seeding contract as adopt: the existing
// description arrives byte for byte, and a birth log line keeps the pruner away.
export function adoptFor(avatarId) {
    const ctx = provider();
    if (!ctx) return null;
    const root = getRoot();
    if (!root || root.readOnly) return null;
    // Never create an entry for an avatar SillyTavern itself does not list; a typo
    // here would mint an orphan that nothing can ever display or clean up.
    if (!Object.hasOwn(ctx.powerUserSettings?.personas ?? {}, avatarId)) return null;
    const existing = getPersona(root, avatarId);
    if (existing) return existing;
    const persona = ensurePersona(root, avatarId, ctx.uuidv4);
    const description = ctx.powerUserSettings?.persona_descriptions?.[avatarId]?.description ?? '';
    const filled = seedDescription(persona, description, ctx.uuidv4, root.settings);
    markComposed(persona, description);
    addLog(persona, 'import', importDetail(filled), Date.now());
    ctx.saveSettingsDebounced();
    return persona;
}

// Compose and store an arbitrary persona. The write target is pinned by argument,
// so the await-window race class that needed startAvatar guards in the quick panel
// does not exist here: a persona switch mid-edit changes which persona is ACTIVE,
// never which persona this call writes. The singular prompt field is written only
// when the target happens to be the live active persona, which writeDescription
// already decides from its fourth argument.
export function saveAndComposeFor(avatarId, { write = true } = {}) {
    const ctx = provider();
    if (!ctx) return null;
    const root = getRoot();
    if (!root || root.readOnly) return null;
    if (!Object.hasOwn(ctx.powerUserSettings?.personas ?? {}, avatarId)) return null;
    const persona = getPersona(root, avatarId);
    if (!persona) return null;
    const active = resolveActive(ctx);
    // With duplicate names and no precise path, which persona is
    // active is unknowable, so whether to write the singular field is unknowable.
    if (active.ambiguous) return null;
    if (!mustWrite(ctx, avatarId, persona, write)) {
        const kept = keepDescription(ctx, persona);
        refreshWith(ctx);
        return kept;
    }
    const result = writeDescription(ctx, avatarId, persona, active.avatar);
    if (result.missing.length) {
        addLog(persona, 'compose-missing', result.missing.join(', '), Date.now());
        ctx.saveSettingsDebounced();
    }
    refreshWith(ctx);
    return result;
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
        // refresh() builds a brand new cache object on every event, so the object we
        // captured before the await may already be discarded. Re-read it, and publish
        // only if we are still on the persona this listing belongs to.
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
            // The asset tab goes disabled with a message. A console
            // warning alone is invisible on a phone.
            after.assetError = String(e?.message ?? e);
        }
        return [];
    }
}

