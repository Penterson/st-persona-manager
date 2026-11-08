// Resolving which persona is active.
// SillyTavern's getContext() does not expose user_avatar, so this is a fallback chain.

// The only caller of getContext(), which copies name1, chat and characterId by value and
// whose chatMetadata is replaced on chat change: call at the point of use, never store it.
export function freshContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

export function saveSettings() {
    freshContext()?.saveSettingsDebounced?.();
}

// A direct source is not held to the name check (a list entry may be renamed apart
// from the chat name on purpose); it need only name a persona SillyTavern has.
function namesAKnownPersona(candidate, personas) {
    return !!candidate && Object.hasOwn(personas ?? {}, candidate);
}

// SillyTavern fills name1 from the active persona, so a candidate whose registered
// name differs from it is not the active one.
function satisfiesInvariant(candidate, name1, personas) {
    return namesAKnownPersona(candidate, personas) && personas[candidate] === name1;
}

// The sources that name an avatar directly instead of deducing it from name1.
const DIRECT = new Set(['precise', 'dom']);

export function findDuplicateNames(personas) {
    // A Set, not a truthiness test, so duplicate empty names are reported too.
    const seen = new Set();
    const dupes = new Set();
    for (const name of Object.values(personas ?? {})) {
        if (seen.has(name)) dupes.add(name); else seen.add(name);
    }
    return [...dupes];
}

export function resolveAvatar({ preciseAvatar, domAvatar, lockedAvatar, name1, personas }) {
    const p = personas ?? {};
    const matches = Object.keys(p).filter(k => p[k] === name1);
    // While name1 is duplicated, only a direct source (precise or dom) can tell the
    // personas apart; the rest stay ambiguous, which blocks writing rather than guessing.
    const duplicated = matches.length > 1;
    const settle = (avatar, source) => ({ avatar, source, ambiguous: duplicated && !DIRECT.has(source) });

    if (namesAKnownPersona(preciseAvatar, p)) return settle(preciseAvatar, 'precise');
    // SillyTavern's persona list on screen names the file, like the precise import.
    if (namesAKnownPersona(domAvatar, p)) return settle(domAvatar, 'dom');
    if (satisfiesInvariant(lockedAvatar, name1, p)) return settle(lockedAvatar, 'lock');

    if (matches.length === 1) return settle(matches[0], 'name');
    return settle(null, 'none');
}

/* Where personas.js (whose user_avatar is the active persona's file name) may sit
   relative to this module: four levels up from third-party/<ext>/modules/ normally, but
   builds differ, so each is tried until one exports a string user_avatar. */
const PRECISE_PATHS = Object.freeze([
    '../../../../personas.js',
    '../../../personas.js',
    '../../../../../personas.js',
]);

// Which path answered, shown in the settings diagnostics.
let precisePath = null;

export function getPrecisePath() { return precisePath; }

export async function loadPreciseApi() {
    // Never load-bearing: importing SillyTavern internals can break at any time, so
    // callers work with null and resolveAvatar falls back to the name lookup.
    for (const path of PRECISE_PATHS) {
        try {
            const mod = await import(/* webpackIgnore: true */ path);
            if (mod && typeof mod.user_avatar === 'string') {
                precisePath = path;
                return mod;
            }
        } catch { /* the next candidate */ }
    }
    precisePath = null;
    return null;
}

/* The import-free route: tiles in #user_avatar_block carry data-avatar-id, and the one
   SillyTavern marks as current is the answer. The marker class is unverified, so a
   candidate counts only when it matches exactly one tile; list order is not stable. */
const SELECTED_MARKERS = Object.freeze([
    '.selected', '.is-selected', '.active', '[data-selected="true"]', '[aria-selected="true"]',
]);

// The tiles of SillyTavern's persona list, or null when the list is not on the page.
function avatarTiles(doc) {
    const block = doc?.getElementById?.('user_avatar_block');
    if (!block?.querySelectorAll) return null;
    try { return [...block.querySelectorAll('[data-avatar-id]')]; } catch { return []; }
}

export function selectedAvatarFromDom(doc) {
    const items = avatarTiles(doc);
    if (!items?.length) return null;
    for (const marker of SELECTED_MARKERS) {
        let hits;
        try {
            // The mark can sit on the tile itself or on something wrapping it.
            hits = items.filter(node => node.matches?.(marker) || node.closest?.(marker));
        } catch { continue; }
        if (hits.length !== 1) continue;
        const id = hits[0].getAttribute?.('data-avatar-id');
        if (typeof id === 'string' && id) return id;
    }
    return null;
}

/* Diagnostics for the settings screen (phones have no console): the avatar tiles found
   and their class names, which tell what marker SELECTED_MARKERS is missing. */
export function avatarBlockReport(doc) {
    const items = avatarTiles(doc);
    if (!items) return { found: false, count: 0, classes: [] };
    const classes = [];
    for (const node of items) {
        const name = String(node.className ?? '').trim();
        if (name && !classes.includes(name)) classes.push(name);
    }
    return { found: true, count: items.length, classes };
}
