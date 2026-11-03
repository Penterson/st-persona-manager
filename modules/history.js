// Edit history: snapshots, caps, global eviction and restore.
// Per variant caps alone do not bound total size.
import { STRINGS } from './strings.js';

const LOG_CAP = 200;

// Self-reported kinds that can recur on every save; a repeat of the last line only
// moves its time, so copies cannot push the user's own record out of the cap.
const REPEATING_KINDS = new Set(['compose-missing', 'history-evicted', 'history-expired']);

export function addLog(persona, kind, detail, now) {
    // Hand-edited settings.json can hold any shape, and a throw here is in the save path.
    if (!Array.isArray(persona.log)) persona.log = [];
    const last = persona.log[persona.log.length - 1];
    if (REPEATING_KINDS.has(kind) && last?.kind === kind && last.detail === detail) {
        last.at = now;
        return;
    }
    persona.log.push({ at: now, kind, detail });
    if (persona.log.length > LOG_CAP) persona.log.splice(0, persona.log.length - LOG_CAP);
}

// force skips only the merge window: a write that moves text out of a body (split by
// title) must leave the replaced body in history, as its success message promises.
export function snapshot(persona, variantId, previousText, now, settings, { force = false } = {}) {
    const cap = settings.historyPerVariant ?? 0;
    if (cap <= 0) return false;

    if (!persona.history) persona.history = {};
    // Array.isArray, not ?? []: an unreadable value (hand edit) is replaced, not pushed onto.
    const stored = persona.history[variantId];
    const list = Array.isArray(stored) ? stored : [];
    const last = list[list.length - 1];

    if (last && last.text === previousText) return false;
    const windowMs = (settings.historyCoalesceMinutes ?? 0) * 60_000;
    if (!force && last && now - last.at < windowMs) return false;

    list.push({ at: now, text: previousText });
    if (list.length > cap) list.splice(0, list.length - cap);
    persona.history[variantId] = list;
    return true;
}

export function historyBytes(root) {
    const encoder = new TextEncoder();
    let total = 0;
    for (const persona of Object.values(root.personas ?? {})) {
        if (!persona || typeof persona !== 'object') continue;
        for (const list of Object.values(persona.history ?? {})) {
            if (!Array.isArray(list)) continue;
            for (const entry of list) total += encoder.encode(entry?.text ?? '').length + 24;
        }
    }
    return total;
}

// Age-based expiry, run before the byte budget so that has less to evict. 0 (default)
// never expires; snapshots without a usable timestamp are kept (a missing at is our bug).
export function expireOldHistory(root, settings, now = Date.now()) {
    const days = Number(settings?.historyMaxDays ?? 0);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = now - days * 86400000;
    let dropped = 0;
    for (const persona of Object.values(root?.personas ?? {})) {
        const history = persona?.history;
        if (!history || typeof history !== 'object') continue;
        let personaDropped = 0;
        for (const [variantId, list] of Object.entries(history)) {
            if (!Array.isArray(list)) continue;
            const kept = list.filter(entry => {
                const at = Number(entry?.at);
                return !Number.isFinite(at) || at >= cutoff;
            });
            if (kept.length === list.length) continue;
            dropped += list.length - kept.length;
            personaDropped += list.length - kept.length;
            if (kept.length) history[variantId] = kept;
            else delete history[variantId];
        }
        // History that vanishes without a log line is indistinguishable from data loss.
        if (personaDropped) addLog(persona, 'history-expired', STRINGS.manager.logDetails.expired(personaDropped), now);
    }
    return dropped;
}

export function enforceGlobalBudget(root, settings, now = Date.now()) {
    const limit = settings.historyMaxBytes ?? Infinity;
    // Measured once, then a running total: rescanning per evicted entry freezes the UI.
    let total = historyBytes(root);
    if (total <= limit) return 0;

    // Flatten every snapshot with its location so we can evict globally oldest first.
    const all = [];
    for (const persona of Object.values(root.personas ?? {})) {
        if (!persona || typeof persona !== 'object') continue;
        for (const [variantId, list] of Object.entries(persona.history ?? {})) {
            if (!Array.isArray(list)) continue;
            list.forEach(entry => all.push({ persona, variantId, at: entry?.at }));
        }
    }
    all.sort((a, b) => a.at - b.at);

    const encoder = new TextEncoder();
    // Per-persona counts, so each log reports its own loss, not the global total.
    const lost = new Map();
    let evicted = 0;
    for (const item of all) {
        if (total <= limit) break;
        const list = item.persona.history[item.variantId];
        if (!list || !list.length) continue;
        const [gone] = list.splice(0, 1);
        total -= encoder.encode(String(gone?.text ?? '')).length + 24;
        evicted++;
        lost.set(item.persona, (lost.get(item.persona) ?? 0) + 1);
        if (!list.length) delete item.persona.history[item.variantId];
    }
    for (const [persona, count] of lost) {
        addLog(persona, 'history-evicted', STRINGS.manager.logDetails.evicted(count), now);
    }
    return evicted;
}

export function restore(persona, variantId, index, now, settings) {
    const list = persona.history?.[variantId] ?? [];
    if (index < 0 || index >= list.length) throw new RangeError(`history index ${index} out of range`);
    const wanted = list[index].text;

    // Restoring is not destructive: the text we are leaving becomes recoverable too.
    const section = (persona.sections ?? []).find(s => (persona.variants[s.id] ?? []).some(v => v.id === variantId));
    const variant = section ? persona.variants[section.id].find(v => v.id === variantId) : null;
    if (variant) {
        snapshot(persona, variantId, variant.text ?? '', now, { ...settings, historyCoalesceMinutes: 0 });
        variant.text = wanted;
        variant.updatedAt = now;
    }
    addLog(persona, 'restore', STRINGS.manager.logDetails.restored(index + 1), now);
    return wanted;
}

// Word level diff for the history view. Tokens keep their trailing whitespace so
// that concatenating the same and del parts reproduces the original exactly.
function tokenize(text) {
    return (text ?? '').match(/\s+|[^\s]+/g) ?? [];
}

// Line tokens for the fallback; each keeps its newline, so the same round trip holds.
function tokenizeLines(text) {
    return String(text ?? '').match(/[^\n]*\n|[^\n]+/g) ?? [];
}

// Cells in the (a+1)*(b+1) Uint32 LCS table: a transient 16MB ceiling. At about one
// token per two Korean characters, that is roughly 4000 characters a side.
const MAX_DIFF_CELLS = 4000000;

function lcsTable(a, b) {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    return table;
}

/* Shared leading and trailing tokens, so the table covers only the changed middle of
   two copies of one body. Shared ends belong to every LCS, so the result stays optimal. */
function commonEnds(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    return { start, endA, endB };
}

function fitsTable(a, b) {
    const { start, endA, endB } = commonEnds(a, b);
    return (endA - start + 1) * (endB - start + 1) <= MAX_DIFF_CELLS;
}

function lcsParts(a, b) {
    const { start, endA, endB } = commonEnds(a, b);
    const ma = a.slice(start, endA);
    const mb = b.slice(start, endB);
    const table = lcsTable(ma, mb);

    const parts = [];
    const push = (type, text) => {
        const last = parts[parts.length - 1];
        if (last && last.type === type) last.text += text;
        else parts.push({ type, text });
    };

    for (let k = 0; k < start; k++) push('same', a[k]);
    let i = 0;
    let j = 0;
    while (i < ma.length && j < mb.length) {
        if (ma[i] === mb[j]) { push('same', ma[i]); i++; j++; }
        else if (table[i + 1][j] >= table[i][j + 1]) { push('del', ma[i]); i++; }
        else { push('add', mb[j]); j++; }
    }
    while (i < ma.length) push('del', ma[i++]);
    while (j < mb.length) push('add', mb[j++]);
    for (let k = endA; k < a.length; k++) push('same', a[k]);
    return parts;
}

// parts.truncated: false for a word diff, 'line' for the line fallback, 'whole' for one
// replacement. Not enumerable, so the array still compares and iterates as plain parts.
function withLevel(parts, truncated) {
    Object.defineProperty(parts, 'truncated', { value: truncated, enumerable: false });
    return parts;
}

export function diffWords(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (fitsTable(a, b)) return withLevel(lcsParts(a, b), false);

    // Too many words: lines are far fewer, and still show which paragraphs changed.
    const la = tokenizeLines(before);
    const lb = tokenizeLines(after);
    if (fitsTable(la, lb)) {
        const parts = lcsParts(la, lb);
        // Nothing shared looks exactly like the whole tier, so it is labelled 'whole'
        // (as is every single-line body too long for words).
        return withLevel(parts, parts.some(part => part.type === 'same') ? 'line' : 'whole');
    }

    // Even the lines do not fit; joined tokens still reproduce both sides exactly.
    const parts = [];
    if (a.length) parts.push({ type: 'del', text: a.join('') });
    if (b.length) parts.push({ type: 'add', text: b.join('') });
    return withLevel(parts, 'whole');
}
