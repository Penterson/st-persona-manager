// Persona list sorting and label membership.
// Pure functions only: no DOM, no getContext, no SillyTavern imports.
//

// The four sort criteria, in the order the settings dropdown offers them.
// Eight orders: four measures, each readable from both ends (user request). The
// reversed forms carry a suffix rather than a separate list, so a new measure gets
// its reverse for free and the two can never fall out of step.
export const SORT_KEYS = Object.freeze([
    'name', 'nameDesc',
    'recent', 'recentOld',
    'modified', 'modifiedOld',
    'created', 'createdOld',
]);

// The measure a key sorts on, and whether it reads from the far end.
const REVERSED = Object.freeze({
    nameDesc: 'name', recentOld: 'recent', modifiedOld: 'modified', createdOld: 'created',
});

// A persona's created time comes from the digits leading its avatar file name.
// Anything other than exactly thirteen digits is rejected: a shorter run is not
// a millisecond epoch (reading it as one would sort the persona to 1970), and a
// longer run is not a plausible epoch either, so both come back as "no created
// time" instead of being misread.
export function createdAtFromAvatar(avatarId) {
    if (typeof avatarId !== 'string') return null;
    const match = avatarId.match(/^\d+/);
    if (!match || match[0].length !== 13) return null;
    return Number(match[0]);
}

// The newest updatedAt across every variant of every section. Zero for a
// persona with no variant touched yet, or no persona at all.
export function modifiedAt(persona) {
    let latest = 0;
    for (const list of Object.values(persona?.variants ?? {})) {
        for (const variant of list ?? []) {
            if (typeof variant?.updatedAt === 'number' && variant.updatedAt > latest) {
                latest = variant.updatedAt;
            }
        }
    }
    return latest;
}

// Two personas may carry the same name, and a collator can call two different
// names equal as well. Either way the pair has no order of its own, so the list
// would settle wherever the input happened to put it and move
// again on the next render. The avatar id is unique per persona, so it is the
// final say and the order stops flickering.
function nameCompare(a, b, collator) {
    const byName = (collator && typeof collator.compare === 'function')
        ? collator.compare(a.name, b.name)
        : String(a.name).localeCompare(String(b.name));
    if (byName !== 0) return byName;
    const left = String(a.avatar);
    const right = String(b.avatar);
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

// The value used for the three non name sort keys. Missing data becomes
// negative infinity so it always lands at the back of a descending sort.
function sortValue(sortBy, entry, deps) {
    if (sortBy === 'recent') {
        const v = deps?.lastUsed?.[entry.avatar];
        return typeof v === 'number' ? v : -Infinity;
    }
    if (sortBy === 'modified') {
        return modifiedAt(deps?.personas?.[entry.avatar]);
    }
    // created
    const created = createdAtFromAvatar(entry.avatar);
    return created === null ? -Infinity : created;
}

// Sorts a copy of entries; the array passed in is left untouched. Ties,
// including every entry with no data for the chosen key, always break by
// name and then by avatar id, so the order never flickers between renders.
// An unknown sortBy falls back to name rather than throwing.
export function sortEntries(entries, sortBy, deps) {
    const list = [...entries];
    const collator = deps?.collator;
    const asked = SORT_KEYS.includes(sortBy) ? sortBy : 'name';
    // A reversed key sorts on its own measure and then flips. The flip is applied
    // to the comparator's RESULT, not by reversing the array afterwards: reversing
    // would also invert the name tie break, so two personas with no recorded use
    // would swap places every time the direction changed.
    const key = REVERSED[asked] ?? asked;
    const dir = REVERSED[asked] ? -1 : 1;
    if (key === 'name') {
        list.sort((a, b) => dir * nameCompare(a, b, collator));
        return list;
    }
    list.sort((a, b) => {
        const va = sortValue(key, a, deps);
        const vb = sortValue(key, b, deps);
        // Subtracting here breaks the tie break: two missing entries are both
        // -Infinity, their difference is NaN, NaN !== 0 skips the name compare,
        // and the sort spec treats a NaN comparator result as equal. Compare the
        // values first and only then fall through to the name.
        if (va !== vb) return dir * (vb - va);
        return nameCompare(a, b, collator);
    });
    return list;
}

// Every label a persona belongs to, in label order.
export function labelsFor(labels, avatarId) {
    return (labels ?? []).filter(label => (label.members ?? []).includes(avatarId));
}

// Only one chip can be active at a time. No active label,
// or an active label that no longer exists, means "show everything".
export function filterByLabel(entries, labels, activeLabelId) {
    const label = activeLabelId == null ? null : (labels ?? []).find(l => l.id === activeLabelId);
    if (!label) return [...entries];
    const members = label.members ?? [];
    return entries.filter(entry => members.includes(entry.avatar));
}

// A display only copy of labels with member ids that no longer exist in
// personas filtered out. The stored labels are never touched: a persona
// deleted by mistake in SillyTavern can still be restored with its labels
// intact.
export function livingLabels(labels, personas) {
    const known = personas ?? {};
    return (labels ?? []).map(label => ({
        ...label,
        members: (label.members ?? []).filter(id => Object.hasOwn(known, id)),
    }));
}

// Records that avatarId was switched to at time now, keeping at most cap
// entries. Refreshing an avatar already recorded does not consume a new slot, and
// does restamp it, which moves it behind the others in the eviction order.
export function recordUse(root, avatarId, now, cap) {
    if (!root.lastUsed || typeof root.lastUsed !== 'object') root.lastUsed = {};
    root.lastUsed[avatarId] = now;
    const keys = Object.keys(root.lastUsed);
    if (typeof cap === 'number' && keys.length > cap) {
        keys.sort((a, b) => root.lastUsed[a] - root.lastUsed[b]);
        for (let i = 0; i < keys.length - cap; i++) delete root.lastUsed[keys[i]];
    }
}

// Adds avatarId to labelId's members if absent, removes it if present.
// Returns whether it is a member after the call. A missing label changes
// nothing.
export function toggleMember(labels, labelId, avatarId) {
    const label = (labels ?? []).find(l => l.id === labelId);
    if (!label) return false;
    if (!Array.isArray(label.members)) label.members = [];
    const idx = label.members.indexOf(avatarId);
    if (idx === -1) {
        label.members.push(avatarId);
        return true;
    }
    label.members.splice(idx, 1);
    return false;
}
