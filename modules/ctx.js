// Resolving which persona is active.
// SillyTavern's getContext() does not expose user_avatar, so this is a fallback chain.

// The only place that calls getContext(). Measured against public/scripts/st-context.js:
// every call builds a new object, and name1, chat and characterId are plain values
// copied at call time, not getters. chatMetadata is a reference to chat_metadata, and
// SillyTavern replaces that object outright when the chat changes. So a context held
// in a variable across two events describes the state at the moment it was built, not
// the state now. Call this at the point of use, never store what it returns.
export function freshContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

/* name1 is filled by SillyTavern from the active persona, so a candidate whose
   registered name disagrees with name1 is not the active persona. That is how a
   NAME is turned into an avatar, and it is the only tool available when a name is
   all we have. */
function satisfiesInvariant(candidate, name1, personas) {
    return !!candidate && Object.hasOwn(personas ?? {}, candidate) && personas[candidate] === name1;
}

/* A source that hands over the avatar ITSELF needs no such deduction, and must not
   be held to it.

   SillyTavern's own `user_avatar` is not a guess about who is active; it is the
   answer. Requiring `personas[user_avatar] === name1` on top of it was belt and
   braces from the days when the name was the only route, and it had a cost nobody
   had noticed: it made renaming the list entry ALONE impossible for the persona
   being played. The moment the list entry and the chat name differ - which is the
   entire point of that button - the corroboration fails, the precise answer is
   thrown away, the name lookup finds nobody, and the whole extension locks. Which
   is exactly why the [목록] button was disabled there, and exactly what the user
   reported as it doing nothing.

   All that is needed from a direct answer is that it names a persona SillyTavern
   actually has. A stale or invented id still gets nowhere. */
function namesAKnownPersona(candidate, personas) {
    return !!candidate && Object.hasOwn(personas ?? {}, candidate);
}

export function findDuplicateNames(personas) {
    // A Set, not an object: a truthiness test misses the empty string, and a persona
    // with no name is exactly the case where a duplicate silently goes unreported.
    const seen = new Set();
    const dupes = new Set();
    for (const name of Object.values(personas ?? {})) {
        if (seen.has(name)) dupes.add(name); else seen.add(name);
    }
    return [...dupes];
}

export function resolveAvatar({ preciseAvatar, domAvatar, lockedAvatar, name1, personas, defaultPersona }) {
    const p = personas ?? {};
    const matches = Object.keys(p).filter(k => p[k] === name1);
    // Steps 1, 2 and 4 admit a candidate on the invariant alone, and
    // the invariant is a name comparison, so it cannot separate two personas that
    // carry the same name. A chat lock naming one of them proves only that the chat
    // was locked to it, not that the user is on it now. Only the precise path names
    // an avatar directly, so every other source stays ambiguous while name1 is a
    // duplicate, and the doc says the ambiguous state blocks writing rather than
    // guessing which of the two to overwrite.
    const duplicated = matches.length > 1;
    // The two sources that name an avatar DIRECTLY rather than deducing it from a
    // name. Only they can tell two same-named personas apart, so only they clear
    // the ambiguous flag; everything below is a name comparison and cannot.
    const DIRECT = new Set(['precise', 'dom']);
    const settle = (avatar, source) => ({ avatar, source, ambiguous: duplicated && !DIRECT.has(source) });

    if (namesAKnownPersona(preciseAvatar, p)) return settle(preciseAvatar, 'precise');
    // SillyTavern's own persona list, read from the screen. Same standing as the
    // import: it names the file, so it survives duplicate names AND a list entry
    // whose name the user has deliberately made differ from the chat's.
    if (namesAKnownPersona(domAvatar, p)) return settle(domAvatar, 'dom');
    if (satisfiesInvariant(lockedAvatar, name1, p)) return settle(lockedAvatar, 'lock');

    if (matches.length === 1) return settle(matches[0], 'name');
    // More than one persona carries this name and no precise path resolved it.
    // Guessing here would overwrite the wrong persona's description.
    if (duplicated) return { avatar: null, source: 'none', ambiguous: true };

    if (satisfiesInvariant(defaultPersona, name1, p)) return settle(defaultPersona, 'default');
    return { avatar: null, source: 'none', ambiguous: false };
}

/* SillyTavern 자신은 아바타 파일 이름을 들고 있다. 우리가 못 볼 이유가 없다.

   `personas.js`는 `user_avatar`를 내보내고, 그것이 곧 활성 페르소나의 파일
   이름이다. 이름 역추적이 필요 없어지고, 같은 이름이 둘이어도 어느 쪽인지 확정된다.

   그런데 이 확장은 그 파일을 한 칸 잘못된 곳에서 찾고 있었다. 브라우저가 이 모듈을
   읽는 주소는

       /scripts/extensions/third-party/<확장>/modules/ctx.js

   이므로 `/scripts/personas.js`까지는 네 칸을 올라가야 하는데 세 칸만 올라가고
   있었다. 즉 `/scripts/extensions/personas.js`를 찾고 404를 받고 catch로 떨어져서,
   이 빌드에는 정밀 경로가 없다고 기록되어 있었다. 진단 1회차의 실패는 iframe 안에서
   난 다른 오류였고, 그 기록조차 확장에서는 성공할 수 있으므로 단정하지 않는다고
   유보해 두었다. 아무도 확장에서 다시 재 보지 않았다.

   깊이는 빌드가 확장을 어디에 놓느냐에 따라 달라질 수 있으므로 후보를 차례로
   시도하고, 성공 여부는 `user_avatar`가 실제로 문자열인지로 판정한다. 지어내지
   않고 물어보는 방식은 sprites 업로드 필드 때와 같다. */
export const PRECISE_PATHS = Object.freeze([
    '../../../../personas.js',
    '../../../personas.js',
    '../../../../../personas.js',
]);

// Which one answered, for the ready line in index.js. A build that moves us again
// should be visible in one console line rather than in a week of symptoms.
let precisePath = null;

export function getPrecisePath() { return precisePath; }

export async function loadPreciseApi() {
    // Optional accuracy boost. The official docs warn that importing SillyTavern
    // internals can break at any time, so this must never be load bearing: every
    // caller works with null, and resolveAvatar falls back to the name lookup.
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

/* The second route to the same answer, and the one that needs no import at all.

   진단 2회차 measured SillyTavern's own persona list: `#user_avatar_block` holds
   `div.avatar-container.interactable` elements, each carrying the file name in
   `data-avatar-id`. Whichever of them SillyTavern has marked as the current one is
   the answer, and reading it is not a guess about internals - it is reading the
   screen the user is looking at.

   What IS unmeasured is the class SillyTavern marks it with, so the candidates are
   tried in turn and a candidate only counts when it matches EXACTLY ONE element.
   Zero means that build does not use that word; more than one means the word means
   something else here (hover, focus, a filter). Either way we decline rather than
   pick. 진단 3회차 also warns that the list order is not stable, so position is
   never used. Whatever comes back still has to satisfy the invariant in
   resolveAvatar before anything is written with it. */
const SELECTED_MARKERS = Object.freeze([
    '.selected', '.is-selected', '.active', '[data-selected="true"]', '[aria-selected="true"]',
]);

export function selectedAvatarFromDom(doc) {
    const block = doc?.getElementById?.('user_avatar_block');
    if (!block?.querySelectorAll) return null;
    let items;
    try { items = [...block.querySelectorAll('[data-avatar-id]')]; } catch { return null; }
    if (!items.length) return null;
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

/* 진단 한 줄, 화면용. Termux에서는 콘솔을 볼 방법이 없다는 기기 보고에 따라
   붙였다.

   Which route named the active persona decides whether two same-named personas can
   be edited at all, and until now the only place that said so was a console line.
   On a phone that line does not exist. This returns what the settings screen needs
   to print instead, and when the screen route came up empty it also returns the
   class names SillyTavern actually puts on its avatar tiles - which is the one
   fact needed to add the right marker to SELECTED_MARKERS. */
export function avatarBlockReport(doc) {
    const block = doc?.getElementById?.('user_avatar_block');
    if (!block?.querySelectorAll) return { found: false, count: 0, classes: [] };
    let items;
    try { items = [...block.querySelectorAll('[data-avatar-id]')]; } catch { return { found: true, count: 0, classes: [] }; }
    const classes = [];
    for (const node of items) {
        const name = String(node.className ?? '').trim();
        if (name && !classes.includes(name)) classes.push(name);
    }
    return { found: true, count: items.length, classes };
}
