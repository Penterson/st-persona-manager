// Persona list sorting and label membership. Pure: no DOM, no getContext.

// Four measures, each readable from both ends, in the settings dropdown's order.
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

// Created time from the avatar file name's leading digits: exactly thirteen (a
// millisecond epoch), else null rather than a misread date.
export function createdAtFromAvatar(avatarId) {
    if (typeof avatarId !== 'string') return null;
    const match = avatarId.match(/^\d+/);
    if (!match || match[0].length !== 13) return null;
    return Number(match[0]);
}

// Newest updatedAt across all variants; 0 when nothing was touched or no persona.
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

// Names can tie (duplicates or collator-equal), so the unique avatar id keeps the order stable
// between renders.
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

// The non-name keys' value. Missing data is -Infinity, which sortEntries puts last in either
// direction.
function sortValue(sortBy, entry, deps) {
    if (sortBy === 'recent') {
        const v = deps?.lastUsed?.[entry.avatar];
        return typeof v === 'number' ? v : -Infinity;
    }
    if (sortBy === 'modified') {
        // 0 means no edits, which must read as missing like the other keys.
        const modified = modifiedAt(deps?.personas?.[entry.avatar]);
        return modified > 0 ? modified : -Infinity;
    }
    const created = createdAtFromAvatar(entry.avatar);
    return created === null ? -Infinity : created;
}

// Sorts a copy. Ties, including entries with no data, break by name then avatar id;
// an unknown sortBy falls back to name.
export function sortEntries(entries, sortBy, deps) {
    const list = [...entries];
    const collator = deps?.collator;
    const asked = SORT_KEYS.includes(sortBy) ? sortBy : 'name';
    // Reversed keys flip the comparator's result, not the array, so the name tie
    // break keeps its direction.
    const key = REVERSED[asked] ?? asked;
    const dir = REVERSED[asked] ? -1 : 1;
    if (key === 'name') {
        list.sort((a, b) => dir * nameCompare(a, b, collator));
        return list;
    }
    list.sort((a, b) => {
        const va = sortValue(key, a, deps);
        const vb = sortValue(key, b, deps);
        const missingA = va === -Infinity;
        const missingB = vb === -Infinity;
        if (missingA !== missingB) return missingA ? 1 : -1;
        // Compared first: -Infinity minus -Infinity is NaN, which would skip the tie break.
        if (va !== vb) return dir * (vb - va);
        return nameCompare(a, b, collator);
    });
    return list;
}

// One active label at most; none, or one that no longer exists, shows everything.
export function filterByLabel(entries, labels, activeLabelId) {
    const label = activeLabelId == null ? null : (labels ?? []).find(l => l.id === activeLabelId);
    if (!label) return [...entries];
    const members = label.members ?? [];
    return entries.filter(entry => members.includes(entry.avatar));
}

// For display, members SillyTavern no longer lists are left out. Stored labels keep them, so a
// persona restored after an accidental deletion keeps its labels.
export function livingLabels(labels, personas) {
    const known = personas ?? {};
    return (labels ?? []).map(label => ({
        ...label,
        members: (label.members ?? []).filter(id => Object.hasOwn(known, id)),
    }));
}

// Records a switch to avatarId, keeping at most cap entries (oldest evicted first).
export function recordUse(root, avatarId, now, cap) {
    if (!root.lastUsed || typeof root.lastUsed !== 'object') root.lastUsed = {};
    root.lastUsed[avatarId] = now;
    const keys = Object.keys(root.lastUsed);
    if (typeof cap === 'number' && keys.length > cap) {
        keys.sort((a, b) => root.lastUsed[a] - root.lastUsed[b]);
        for (let i = 0; i < keys.length - cap; i++) delete root.lastUsed[keys[i]];
    }
}

// Toggles membership; returns whether avatarId is a member afterwards (false for no label).
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
