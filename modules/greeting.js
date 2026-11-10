// Keeps {{user}} in an unanswered greeting on the playing persona. SillyTavern bakes the resolved
// name into chat[0].mes and swipes[], so former user names are replaced where the card had
// {{user}}. Pure except syncGreetingInContext.

// {{user}} and <USER> in any case, spelled out so the names sharing the pattern stay case-
// sensitive.
const MACRO_SOURCE = '\\{\\{[uU][sS][eE][rR]\\}\\}|<[uU][sS][eE][rR]>';
const MACRO_ONLY = new RegExp(`^(?:${MACRO_SOURCE})$`, 'u');

// Letters that join a Latin name to its neighbours. Hangul and kana names take particles right
// after them, so they get no boundary guard.
const JOINING = /[\p{Script=Latin}\p{N}_]/u;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namePattern(name) {
    const left = JOINING.test(name[0]) ? '(?<![\\p{Script=Latin}\\p{N}_])' : '';
    const right = JOINING.test(name[name.length - 1]) ? '(?![\\p{Script=Latin}\\p{N}_])' : '';
    return `${left}${escapeRegExp(name)}${right}`;
}

function cleanNames(names, current) {
    const list = (Array.isArray(names) ? names : [names])
        .map(name => String(name ?? '').trim())
        .filter(name => name && name !== current);
    // Longest first, so "Alice Kim" is matched before "Alice".
    return [...new Set(list)].sort((a, b) => b.length - a.length);
}

// Every place a name occurs, as [start, end, name]. Names are never empty, so no match is.
function occurrences(text, names) {
    if (!names.length) return [];
    return [...text.matchAll(new RegExp(names.map(namePattern).join('|'), 'gu'))]
        .map(m => [m.index, m.index + m[0].length, m[0]]);
}

/* The old-name hits in text standing where template had {{user}}: one to one when the counts
   agree, else all hits if the template has no literal old name. Without a template, every hit. */
function macroPositions(text, template, names) {
    const hits = occurrences(text, names);
    if (!hits.length) return [];
    if (typeof template !== 'string') return hits;
    const tokens = [...template.matchAll(new RegExp(`${MACRO_SOURCE}|${names.map(namePattern).join('|')}`, 'gu'))]
        .map(m => (MACRO_ONLY.test(m[0]) ? 'macro' : 'literal'));
    const macros = tokens.filter(kind => kind === 'macro').length;
    if (!macros) return [];
    if (tokens.length === hits.length) return hits.filter((_, i) => tokens[i] === 'macro');
    return tokens.includes('literal') ? [] : hits;
}

function replaceUserName(text, oldNames, newName, template) {
    const source = String(text ?? '');
    const current = String(newName ?? '').trim();
    if (!source || !current) return source;
    const names = cleanNames(oldNames, current);
    if (!names.length) return source;
    // An old name inside the current one ("Al" in "Alice") is not stale.
    const keep = occurrences(source, [current]);
    const targets = macroPositions(source, template, names)
        .filter(([start, end]) => !keep.some(([a, b]) => start < b && end > a));
    if (!targets.length) return source;
    let out = '';
    let cursor = 0;
    for (const [start, end] of targets) {
        out += source.slice(cursor, start) + current;
        cursor = end;
    }
    return out + source.slice(cursor);
}

// Whether message `index` is a greeting the user has not answered yet.
export function greetingNeedsUserSync(chat, index) {
    if (!Array.isArray(chat) || Number(index) !== 0) return false;
    const first = chat[0];
    if (!first || first.is_user || first.is_system) return false;
    return !chat.some(message => message && message.is_user && !message.is_system);
}

// replaceUserName over the greeting and its swipes; templates are the card's greetings in swipe
// order. Answers whether anything changed.
export function syncGreetingUser(message, oldNames, newName, templates) {
    if (!message || typeof message !== 'object') return false;
    const aligned = Array.isArray(templates);
    // Swipes past the card's greetings were generated, so nothing says where {{user}} stood in
    // them.
    const skip = i => aligned && i >= templates.length;
    const pick = i => (aligned ? templates[i] : undefined);
    let changed = false;
    if (Array.isArray(message.swipes)) {
        message.swipes = message.swipes.map((swipe, i) => {
            if (typeof swipe !== 'string' || skip(i)) return swipe;
            const next = replaceUserName(swipe, oldNames, newName, pick(i));
            if (next !== swipe) changed = true;
            return next;
        });
    }
    if (typeof message.mes === 'string') {
        const index = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        if (!skip(index)) {
            const next = replaceUserName(message.mes, oldNames, newName, pick(index));
            if (next !== message.mes) { message.mes = next; changed = true; }
        }
    }
    return changed;
}

/* The card's greetings in swipe order (first_mes unless empty, then the alternates), or null
   when the message has fewer swipes (card edited since). More is fine: swiping appends generated
   ones. */
export function cardGreetings(card, message) {
    const first = card?.data?.first_mes ?? card?.first_mes;
    const alternates = card?.data?.alternate_greetings;
    const list = [typeof first === 'string' ? first : ''];
    if (Array.isArray(alternates)) list.push(...alternates.filter(text => typeof text === 'string'));
    if (!list[0] && list.length > 1) list.shift();
    const count = Array.isArray(message?.swipes) ? message.swipes.length : 1;
    return count >= list.length ? list : null;
}

/* The side-effecting entry point: rewrites, redraws and saves the greeting. Group chats are left
   to SillyTavern, which reloads them on a persona change. names.broad (every persona name) needs
   the card's templates; without them only names.narrow, the names it can hold. */
export function syncGreetingInContext(ctx, names = {}) {
    const chat = ctx?.chat;
    if (!greetingNeedsUserSync(chat, 0)) return false;
    if (ctx.groupId !== undefined && ctx.groupId !== null && ctx.groupId !== '') return false;
    const current = typeof ctx.name1 === 'string' ? ctx.name1 : '';
    if (!current) return false;
    const card = Array.isArray(ctx.characters) ? ctx.characters[Number(ctx.characterId)] : null;
    const message = chat[0];
    const templates = card ? cardGreetings(card, message) : null;
    const oldNames = templates ? (names.broad ?? []) : (names.narrow ?? []);
    if (!syncGreetingUser(message, oldNames, current, templates)) return false;
    try { ctx.updateMessageBlock?.(0, message); } catch { /* the data is right; the next draw shows it */ }
    // saveChat is async, so its rejection needs a catch of its own.
    try {
        Promise.resolve(ctx.saveChat?.()).catch(() => { /* saved with the next message */ });
    } catch { /* saved with the next message */ }
    return true;
}
