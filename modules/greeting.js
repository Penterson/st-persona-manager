// {{user}} in the greeting, kept in step with the persona that is playing.
//
// SillyTavern resolves {{user}} in the first message when it draws it, and then
// writes the resolved text back into chat[0].mes (script.js messageFormatting).
// In a chat that is not pristine, and on builds before that rule existed, the
// swipe being left is also written back into swipes[] (syncMesToSwipe). So once
// a greeting has been shown, the user's name is baked into it as plain text.
// Rename the persona, switch to another, or let the per-language name change
// it, and the greeting keeps the old name: on screen, in every alternate
// greeting reached by swiping, and in the prompt, where the model reads a
// {{user}} that is not the user.
//
// The fix is a substitution, and a substitution on chat text has to be narrow:
//   - only the greeting (message 0, from the character) and only while the user
//     has not answered it, which is when it is still a greeting and not history;
//   - only names that have been the user's name (the caller supplies them);
//   - only at the places the card's own greeting had {{user}}, when the card is
//     there to say where those are. A name that is also an ordinary word in the
//     greeting ("Rose" in a rose garden) is left alone.
// Pure apart from syncGreetingInContext, which takes the context it acts on.

// {{user}} and <USER> in any case, written out so the names beside it in one
// pattern can stay case-sensitive.
const MACRO_SOURCE = '\\{\\{[uU][sS][eE][rR]\\}\\}|<[uU][sS][eE][rR]>';
const MACRO_ONLY = new RegExp(`^(?:${MACRO_SOURCE})$`, 'u');

// Letters that join a Latin name to its neighbours. A Hangul or kana name takes
// particles straight after it (앨리스는), so no guard is put on that side.
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

// Every place a name occurs, in order, as [start, end, name].
function occurrences(text, names) {
    if (!names.length) return [];
    const re = new RegExp(names.map(namePattern).join('|'), 'gu');
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push([m.index, m.index + m[0].length, m[0]]);
        if (m[0].length === 0) re.lastIndex++;
    }
    return out;
}

/* Which of the old-name occurrences in `text` stand where {{user}} stood in
   `template`. The template's tokens - {{user}} macros and literal old names -
   are listed in order; when the text has exactly that many old-name hits, they
   line up one to one and only the macro positions are taken. Without a
   template, or when the counts do not line up (a regex script rewrote part of
   the greeting), every hit is taken only if the template has no literal old
   name at all, which is the case where no hit can be an ordinary word. */
function macroPositions(text, template, names) {
    const hits = occurrences(text, names);
    if (!hits.length) return [];
    if (typeof template !== 'string') return hits;
    const tokens = [];
    const re = new RegExp(`${MACRO_SOURCE}|${names.map(namePattern).join('|')}`, 'gu');
    let m;
    while ((m = re.exec(template)) !== null) {
        tokens.push(MACRO_ONLY.test(m[0]) ? 'macro' : 'literal');
        if (m[0].length === 0) re.lastIndex++;
    }
    const macros = tokens.filter(kind => kind === 'macro').length;
    if (!macros) return [];
    if (tokens.length === hits.length) return hits.filter((_, i) => tokens[i] === 'macro');
    return tokens.includes('literal') ? [] : hits;
}

export function replaceUserName(text, oldNames, newName, template) {
    const source = String(text ?? '');
    const current = String(newName ?? '').trim();
    if (!source || !current) return source;
    const names = cleanNames(oldNames, current);
    if (!names.length) return source;
    // Never touch a stretch that already reads as the current name: an old name
    // that is part of the new one ("Al" inside "Alice") is not stale.
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

/* Applies replaceUserName to the greeting's text and every swipe of it.
   templates, when given, is the card's greetings in swipe order. Answers
   whether anything changed. */
export function syncGreetingUser(message, oldNames, newName, templates) {
    if (!message || typeof message !== 'object') return false;
    const pick = i => (Array.isArray(templates) ? templates[i] : undefined);
    let changed = false;
    if (Array.isArray(message.swipes)) {
        message.swipes = message.swipes.map((swipe, i) => {
            if (typeof swipe !== 'string') return swipe;
            const next = replaceUserName(swipe, oldNames, newName, pick(i));
            if (next !== swipe) changed = true;
            return next;
        });
    }
    if (typeof message.mes === 'string') {
        const index = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        const next = replaceUserName(message.mes, oldNames, newName, pick(index));
        if (next !== message.mes) { message.mes = next; changed = true; }
    }
    return changed;
}

/* The card's greetings, in the order SillyTavern builds the swipes from them
   (script.js getFirstMessage): first_mes, then the alternates, with an empty
   first_mes dropped. Only returned when it lines up with the message. */
export function cardGreetings(card, message) {
    const first = card?.data?.first_mes ?? card?.first_mes;
    const alternates = card?.data?.alternate_greetings;
    const list = [typeof first === 'string' ? first : ''];
    if (Array.isArray(alternates)) list.push(...alternates.filter(text => typeof text === 'string'));
    if (!list[0] && list.length > 1) list.shift();
    const count = Array.isArray(message?.swipes) ? message.swipes.length : 1;
    return list.length === count ? list : null;
}

/* The one side-effecting entry point. Reads everything from the context it is
   handed, writes the greeting, redraws it through SillyTavern's own
   updateMessageBlock and saves the chat. Group chats are left to SillyTavern,
   which reloads them itself when the persona changes.

   names.broad is every name a persona has carried (any persona, any language);
   it is used only when the card's greetings are there to say where {{user}}
   stood. names.narrow is the names THIS persona has carried; without a template
   only those are replaced, so an NPC who shares another persona's name is never
   renamed on a guess. */
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
    try { void ctx.saveChat?.(); } catch { /* saved with the next message */ }
    return true;
}
