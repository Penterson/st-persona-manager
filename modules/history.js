// Edit history: snapshots, caps, global eviction and restore.
// Per variant caps alone do not bound total size.
import { STRINGS } from './strings.js';

const LOG_CAP = 200;

// Lines the extension writes about itself rather than about something the user
// did. compose-missing came back on every save while any pick was dead, and
// history-evicted on every save once the budget was full, so the 200 line cap
// filled with copies of one line and pushed the user's own record out. The same
// line as the last one only moves that line's time.
const REPEATING_KINDS = new Set(['compose-missing', 'history-evicted', 'history-expired']);

export function addLog(persona, kind, detail, now) {
    // A value of the wrong shape out of a hand edited settings.json threw on the
    // push, inside the save path.
    if (!Array.isArray(persona.log)) persona.log = [];
    const last = persona.log[persona.log.length - 1];
    if (REPEATING_KINDS.has(kind) && last?.kind === kind && last.detail === detail) {
        last.at = now;
        return;
    }
    persona.log.push({ at: now, kind, detail });
    if (persona.log.length > LOG_CAP) persona.log.splice(0, persona.log.length - LOG_CAP);
}

// force skips the merge window and nothing else: a write that moves text out of
// a body (제목별 분류) has to leave the body it replaced in history even when the
// last save was a minute ago, because its success message promises exactly that.
export function snapshot(persona, variantId, previousText, now, settings, { force = false } = {}) {
    const cap = settings.historyPerVariant ?? 0;
    if (cap <= 0) return false;

    if (!persona.history) persona.history = {};
    // Array.isArray and not `?? []`: the two sweeps below this one already check,
    // and this one did not - so a history value of the wrong shape out of a hand
    // edited settings.json threw on the push, inside the save path, which is the
    // one moment the user's edit exists nowhere else. A value nothing can read is
    // replaced rather than pushed onto.
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
        // Same guard expireOldHistory carries, for the same reason one line down:
        // a null under personas out of a hand edited settings.json threw here,
        // inside the save path, on data the user is about to lose.
        if (!persona || typeof persona !== 'object') continue;
        for (const list of Object.values(persona.history ?? {})) {
            // expireOldHistory a few lines down checks this and these two did not,
            // so a history value that is not an array threw here instead - which is
            // inside the save path, on data the user is about to lose.
            if (!Array.isArray(list)) continue;
            for (const entry of list) total += encoder.encode(entry?.text ?? '').length + 24;
        }
    }
    return total;
}

// Age based expiry (user request). Separate from the byte budget above and run
// before it: dropping what is too old first means the budget has less to evict,
// so a persona whose history is all recent keeps more of it.
//
// 0 means never expire, which is the shipped default: an existing user must not
// lose history because a new setting appeared with an opinion. Snapshots with no
// usable timestamp are KEPT rather than dropped, because a missing `at` is our
// bug and the user's text should not pay for it.
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
        // The same rule enforceGlobalBudget follows: history that vanishes without
        // a line is indistinguishable from data loss. Expiry was returning a count
        // nobody read, so a user who set 보관 기간 saw a shorter list, no banner and
        // no log entry.
        // Through STRINGS like every other line the user reads: this one used to
        // print the bare number, so the history screen showed "기간 만료 · 13".
        if (personaDropped) addLog(persona, 'history-expired', STRINGS.manager.logDetails.expired(personaDropped), now);
    }
    return dropped;
}

export function enforceGlobalBudget(root, settings, now = Date.now()) {
    const limit = settings.historyMaxBytes ?? Infinity;
    // Measure once and keep a running total. Recomputing the whole tree per evicted
    // entry turned lowering the budget from 2MB to 64KB into hundreds of full scans
    // over a 2MB tree, which is seconds of frozen UI on the phone.
    let total = historyBytes(root);
    if (total <= limit) return 0;

    // Flatten every snapshot with its location so we can evict globally oldest first.
    const all = [];
    for (const persona of Object.values(root.personas ?? {})) {
        // The guard historyBytes and expireOldHistory both carry.
        if (!persona || typeof persona !== 'object') continue;
        for (const [variantId, list] of Object.entries(persona.history ?? {})) {
            if (!Array.isArray(list)) continue;
            list.forEach(entry => all.push({ persona, variantId, at: entry?.at }));
        }
    }
    all.sort((a, b) => a.at - b.at);

    const encoder = new TextEncoder();
    // How many EACH persona lost, not merely which ones did. A set could only ever
    // answer the second question, so all three personas in a three way eviction
    // were told the global total and each of their logs claimed every entry the
    // sweep had taken: three lines reading 23건 for 23 entries. The point of the
    // line is to account for history the user notices is missing, and a number
    // three times too big accounts for it wrongly. expireOldHistory above already
    // counts per persona; this is the same rule, kept the same way.
    const lost = new Map();
    let evicted = 0;
    for (const item of all) {
        if (total <= limit) break;
        const list = item.persona.history[item.variantId];
        if (!list || !list.length) continue;
        const [gone] = list.splice(0, 1);
        total -= encoder.encode(gone.text ?? '').length + 24;
        evicted++;
        lost.set(item.persona, (lost.get(item.persona) ?? 0) + 1);
        if (!list.length) delete item.persona.history[item.variantId];
    }
    // Eviction leaves a line so the user can find out why their
    // history got shorter. Each affected persona carries its own log, so a persona
    // that lost entries has to be told, and told its own number.
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

// The coarser tokens the fallback compares. Each token keeps its own trailing
// newline, so joining them back reproduces the text exactly and the round trip
// property the parts carry is the same one the word tokens give.
function tokenizeLines(text) {
    return String(text ?? '').match(/[^\n]*\n|[^\n]+/g) ?? [];
}

// The table costs (a+1)*(b+1)*4 bytes, so this ceiling is a transient 16MB Uint32
// table. The real bodies on this device are 2679 to 4021 Korean characters, and the
// word tokenizer counts a run of whitespace as a token of its own, which works out
// at roughly one token per two characters. Measured on this desktop against those
// sizes:
//
//   1000 characters a side ->   252k cells,  1.0MB,  7ms
//   2800 characters a side -> 1.97M cells,  7.5MB, 14ms
//   4000 characters a side -> 4.01M cells, over the ceiling, line fallback
//
// So the old one million cell limit tripped at about 2000 characters a side, which
// is to say on every body this user actually has, and the diff was inert for all of
// them. This one covers all but the very longest, and the longest get the line
// fallback below with the history view saying so out loud.
export const MAX_DIFF_CELLS = 4000000;

function lcsTable(a, b) {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    return table;
}

/* The tokens both sides open and close with. A snapshot is an earlier copy of the
   same body, so most of it is shared and the change sits somewhere in the middle;
   the table only has to cover that middle. Without this a 3,300 character body
   built a 1.2 million cell table (4.7MB, about 6ms on the desktop and an
   estimated 60 to 120ms on the phone) inside the tap that opens a snapshot, to
   find a change of a few words. Shared ends are part of every longest common
   subsequence, so the result is still a longest one. */
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

// The LCS walk itself, over whatever tokens it was handed.
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

// How the parts were produced, when it was not the word level comparison the
// caller asked for: false for a real word diff, 'line' when the bodies were too
// large for a word table and were compared line by line, 'whole' when even the
// line table did not fit and the change is reported as one replacement.
//
// The property is deliberately NOT enumerable. The parts array still iterates,
// maps and compares exactly as it always did, so every existing caller and every
// existing test keeps working, and a caller that has to SAY what happened asks for
// it by name. The old code returned a faked del+add pair with no way to tell it
// apart from a real diff, which is how the history view came to render a whole
// body struck through and explain nothing.
function withLevel(parts, truncated) {
    Object.defineProperty(parts, 'truncated', { value: truncated, enumerable: false });
    return parts;
}

export function diffWords(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (fitsTable(a, b)) return withLevel(lcsParts(a, b), false);

    // Too many words, which does not mean the comparison is worthless: a body of
    // several thousand Korean characters is a thousand words but only a few dozen
    // lines, so the line table is orders of magnitude smaller and the user still
    // sees which paragraphs moved instead of the whole body struck through.
    const la = tokenizeLines(before);
    const lb = tokenizeLines(after);
    if (fitsTable(la, lb)) {
        const parts = lcsParts(la, lb);
        // A line comparison that found nothing shared paints exactly what the
        // whole tier paints: everything struck through, everything added. The
        // level names what the user is looking at, not which table happened to
        // fit, so it says 'whole'. A single unbroken 4,000 character body is one
        // line a side and lands here every time.
        return withLevel(parts, parts.some(part => part.type === 'same') ? 'line' : 'whole');
    }

    // Even the lines do not fit, which takes thousands of them. Tokens keep their
    // whitespace, so joining them back reproduces both sides exactly and the round
    // trip property of the parts still holds.
    const parts = [];
    if (a.length) parts.push({ type: 'del', text: a.join('') });
    if (b.length) parts.push({ type: 'add', text: b.join('') });
    return withLevel(parts, 'whole');
}
