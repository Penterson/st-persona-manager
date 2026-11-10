// Which persona is active. getContext() has no user_avatar, so this is a fallback chain.

// The only getContext() caller. Its result copies name1, chat and characterId by value and its
// chatMetadata is replaced on chat change, so call at the point of use and never keep it.
export function freshContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

export function saveSettings() {
    freshContext()?.saveSettingsDebounced?.();
}

// A direct source need only name a persona SillyTavern has: its list name may differ from name1 on
// purpose.
function namesAKnownPersona(candidate, personas) {
    return !!candidate && Object.hasOwn(personas ?? {}, candidate);
}

// SillyTavern fills name1 from the active persona, so a candidate registered under another name is
// not it.
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
    // While name1 is duplicated only a direct source can tell the personas apart; the rest stay
    // ambiguous, which blocks writes rather than guessing.
    const duplicated = matches.length > 1;
    const settle = (avatar, source) => ({ avatar, source, ambiguous: duplicated && !DIRECT.has(source) });

    if (namesAKnownPersona(preciseAvatar, p)) return settle(preciseAvatar, 'precise');
    if (namesAKnownPersona(domAvatar, p)) return settle(domAvatar, 'dom');
    if (satisfiesInvariant(lockedAvatar, name1, p)) return settle(lockedAvatar, 'lock');

    if (matches.length === 1) return settle(matches[0], 'name');
    return settle(null, 'none');
}

/* personas.js exports user_avatar (the active persona's file). Its path relative to this module
   differs between builds, so each candidate is tried. */
const PRECISE_PATHS = Object.freeze([
    '../../../../personas.js',
    '../../../personas.js',
    '../../../../../personas.js',
]);

// Which path answered, for the settings diagnostics.
let precisePath = null;

export function getPrecisePath() { return precisePath; }

export async function loadPreciseApi() {
    // Never load-bearing: SillyTavern internals can change at any time, so callers cope with null
    // and resolveAvatar falls back to names.
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

/* The import-free route: the tile SillyTavern marks current in #user_avatar_block. The marker
   class is unverified, so a marker counts only when it matches exactly one tile. */
const SELECTED_MARKERS = Object.freeze([
    '.selected', '.is-selected', '.active', '[data-selected="true"]', '[aria-selected="true"]',
]);

// SillyTavern's persona tiles, or null when the list is not on the page.
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

/* Settings diagnostics (phones have no console): the tiles' class names show which marker
   SELECTED_MARKERS misses. */
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
