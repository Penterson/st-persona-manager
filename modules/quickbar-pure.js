// Pure logic behind the quick switch bar.
// Nothing here touches the DOM, so 검사/quickbar.test.mjs can import it in plain
// Node. The DOM half lives in quickbar.js and must never be imported by a test.
import { livingLabels, filterByLabel, sortEntries } from './roster.js';
import { STRINGS } from './strings.js';

// Measured on the device. This build has no /persona-set-name, which is exactly
// what the plan had hardcoded. These three
// exist and share the same argument shape (unnamed[persona name], named[mode]).
// The array is the preference order; the command actually used is discovered at
// runtime from SlashCommandParser.commands so the next ST rename cannot repeat
// the same failure silently.
export const PERSONA_COMMAND_NAMES = Object.freeze(['persona-set', 'persona', 'name']);

// The words live in STRINGS; these exports are the names the
// DOM half and the tests already reach them by.
export const NO_VERSION_LABEL = STRINGS.quick.iconNoVersion;
export const MODIFIED_SUFFIX = STRINGS.quick.iconModifiedSuffix;

// How many scheduler turns a persona switch gets before we call it a failure.
// The switch is not synchronous: the slash command resolves before SillyTavern has
// finished swapping name1, so reading name1 on the next line reports a failure that
// did not happen. That false failure then fires the mode argument whose allowed
// values were never measured, and leaves the panel holding an avatar that has
// already moved. Claiming an unobserved success is forbidden, and this is the
// other half of the same rule: do not claim an unobserved failure either.
export const SWITCH_WAIT_TURNS = 10;

// A persona switch flips values SillyTavern already has in memory; making a
// persona writes a file on the server first. Ten turns is about a third of a
// second, which is right for the first and would report the second as a failure
// on any connection worth the name. Two seconds, and the caller says which of the
// two it is waiting for rather than inheriting whichever number came first.
export const CREATE_WAIT_TURNS = 60;

// One scheduler turn. requestAnimationFrame is the right clock while the tab is
// visible and never fires while it is hidden, so a timer runs alongside it and
// whichever arrives first ends the turn. Waiting forever would be worse than
// waiting too long.
//
// It lives here, next to the only function that consumes it, because there used
// to be two of these in two files and one of them had the WRONG SHAPE: it took no
// resolve and returned a promise instead, so waitFor's `new Promise(resolve =>
// schedule(resolve))` was handed a resolve that nobody ever called and the await
// never came back. 페르소나 복제 hung there, silently and forever, whenever
// SillyTavern had not already finished by the first check. One exported turn and
// a default below is what makes that unrepeatable rather than merely fixed.
export const TURN_MS = 32;

export function schedulerTurn(resolve) {
    let done = false;
    const once = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
    setTimeout(once, TURN_MS);
}

// Waits for a condition to hold, giving the page one scheduler turn between checks.
// schedule is a parameter so a node test can drive the turns without a browser clock,
// and the predicate is checked before the first wait so a switch that already landed
// costs nothing. Returns whether the condition held in the end.
export async function waitFor(predicate, schedule = schedulerTurn, turns = SWITCH_WAIT_TURNS) {
    for (let i = 0; i < turns; i++) {
        if (predicate()) return true;
        await new Promise(resolve => schedule(resolve));
    }
    return !!predicate();
}

/* The SillyTavern popup probe. The long note above runPopup in quickbar.js says
   what is being measured and why; these two are the decisions inside it, kept here
   so a node test can check them without a document. None of this may end in a
   screen that does nothing and explains nothing. */

// How long a popup await may run before an unanswerable one is assumed. Every
// screen this extension draws rides a modal dialog, which makes the rest of the
// document inert, so a build whose popup is a plain div paints its question UNDER
// our host and nothing can answer it. Four seconds is long enough that a user
// reading the question is not interrupted and short enough that a hang gets fixed
// while they are still looking at it.
export const POPUP_STUCK_MS = 4000;

// How many stuck windows a popup is re-examined over before the wait is left
// alone for good. shouldSelfCorrect defers to any foreign dialog on screen, so a
// single unrelated dialog that happened to be open at the four second mark used
// to defeat the correction for that popup forever: nothing ever looked again.
// Re-checking a bounded number of times covers the dialog that closes shortly
// after our window; one that outlives every window is the documented tradeoff.
export const POPUP_STUCK_CHECKS = 3;

function asSet(value) {
    if (value instanceof Set) return value;
    return new Set(value ?? []);
}

// The verdict the popup probe reaches, as data. The three arguments are sets or
// arrays of dialog identities: what was already open when we asked for a popup,
// what was seen open at any point while we waited, and what is still open now.
// True means this build draws its popup as a dialog, so it joins the same top
// layer as our host and needs no help.
//
// A dialog counts only when it BOTH appeared during the window and is still open
// at the end. The old probe counted anything that showed up, so another
// extension's dialog flashing past recorded a div build as a dialog build, and
// nothing ever revisits that verdict: every popup for the rest of the session
// would then be drawn under our host with no way to answer it.
export function popupVerdict({ before, during, openAtEnd } = {}) {
    const was = asSet(before);
    const still = asSet(openAtEnd);
    for (const dialog of asSet(during)) {
        if (!was.has(dialog) && still.has(dialog)) return true;
    }
    return false;
}

// Whether a popup that is still unanswered is unanswered because the verdict above
// was wrong. needsDrop true means we already dropped our host for this popup, so a
// long wait is just a user reading; a foreign dialog on screen means the question
// IS reachable and the wait is theirs to end. Only the third case, a long wait with
// our host still up and nothing else open, has the shape of a mismeasurement.
export function shouldSelfCorrect({ needsDrop, elapsedMs, foreignOpen } = {}) {
    if (needsDrop) return false;
    if (!(Number(elapsedMs) >= POPUP_STUCK_MS)) return false;
    return !foreignOpen;
}

// The controls the diverged banner offers, as data, so the read only rule is one
// decision a node test can check rather than three event handlers in the DOM half.
// 가져오기 overwrites the variant text and 되돌리기 rewrites the description, and both
// used to run before state.js refused the save, which left the mutation sitting in
// the live extensionSettings for SillyTavern to persist on its own next save. A
// read only root has to lose the buttons, exactly like every other writing control.
export function divergedActions(writable) {
    return [
        { key: 'revert', label: STRINGS.quick.divergeRevert, mutates: true, enabled: !!writable },
        { key: 'absorb', label: STRINGS.quick.divergeAbsorb, mutates: true, enabled: !!writable },
        // Dismissing writes nothing, so it stays available in every state.
        { key: 'later', label: STRINGS.quick.divergeLater, mutates: false, enabled: true },
    ];
}

export function pickPersonaCommand(commands) {
    if (!commands || typeof commands !== 'object') return null;
    for (const name of PERSONA_COMMAND_NAMES) {
        // Own properties only. SlashCommandParser.commands is a plain object, so
        // `'name' in commands` would also be true for anything reachable through
        // Object.prototype, and we would then run a command ST does not have.
        // Iterating our preference list rather than the object's keys is what makes
        // the result independent of registration order.
        if (Object.hasOwn(commands, name) && commands[name]) return name;
    }
    return null;
}

// Control characters are folded by code point rather than by a regular expression
// range, because writing that range needs backslash-u escapes and this repo has
// been corrupted three times by escapes turning into the raw bytes they name.
function foldControls(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        out += (code < 32 || code === 127) ? ' ' : ch;
    }
    return out;
}

export function quoteArg(value) {
    // A newline terminates the command line and nothing after it can be escaped
    // back into the argument, so folding is the only honest option. Personas on
    // this device include CJK names such as 陆瑜, which pass through untouched.
    const text = foldControls(String(value ?? ''))
        // One pass with a callback so the backslash we add is never re-escaped.
        // The pipe separates commands, braces open macros, and the quote would
        // close the argument early.
        .replace(/[\\"|{}]/g, m => '\\' + m);
    return `"${text}"`;
}

// A node the user may be typing into, so a redraw has to wait for it. A hangul
// composition lives in the element itself, and replacing that element throws away the
// syllable being assembled.
//
// Only a textarea and this panel's one text input qualify. Every checkbox in the
// label editor is an <input> too, Chromium focuses one when it is tapped, and a rule
// that matched every input therefore set the deferral on a tap that involves no
// typing at all: every redraw until that checkbox lost focus was dropped, so
// unchecking the active chip's label left the row sitting in a list it had left.
// The DOM half passes document.activeElement; a node is enough, nothing is stored.
export function isTextEntry(node) {
    const tag = node?.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    // Every input this panel builds sets its type, and the DOM resolves the property
    // to a lowercase string even when the attribute is missing or unknown. search
    // joined text when the search boxes arrived: they compose hangul exactly like
    // the label input, and a full redraw mid composition is what this defers.
    return node.type === 'text' || node.type === 'search';
}

// Whether a single pick names a section and a variant this persona actually has.
// pickVariant used to write activePicks[sectionId] = variantId unchecked, and the
// event it acts on can outlive the <select> that produced it: a native picker left
// open across a redraw resolves against a node that is no longer in the document, so
// the key it carries can belong to a persona that is no longer active. A foreign key
// in activePicks never matches any version's picks, which is how it renders as a
// permanent MODIFIED_SUFFIX on the icon.
export function pickApplicable(persona, sectionId, variantId) {
    if (!persona || !sectionId || !variantId) return false;
    if (!(persona.sections ?? []).some(section => section.id === sectionId)) return false;
    return (persona.variants?.[sectionId] ?? []).some(variant => variant.id === variantId);
}

// Whether this version belongs to this persona and can be applied to it as it
// stands. applyVersion looks the version up before it awaits a confirmation, and the
// active persona can move while that popup is open, so the object it holds may belong
// to the persona the panel opened on rather than the one the write would land on.
// Re-finding the version through here, on the persona resolved after the await, is
// what keeps one persona's variant ids from being written onto another's picks.
//
// A pick that names a deleted variant fails too: applying it would put a pick in the
// live combination that no longer selects anything, and the section it belongs to
// would drop out of the composed description.
//
// A pick for a SECTION deleted since the version was saved is skipped. removeSection
// leaves the key in every version on purpose (nothing is silently rewritten), and
// compose reads only sections that exist, so the key selects nothing either way.
// Failing on it made every version saved before a section delete unappliable for
// good, with a reason pointing at a [⋯] whose detail has no row for a section that
// is gone - nothing on screen could repair it.
export function versionApplicable(persona, versionId) {
    const version = (persona?.versions ?? []).find(v => v?.id === versionId);
    if (!version) return false;
    const living = new Set((persona.sections ?? []).map(section => section?.id));
    // Own enumerable keys only, which is what a picks object saved into settings.json
    // carries; nothing reachable through Object.prototype is treated as a pick.
    for (const [sectionId, variantId] of Object.entries(version.picks ?? {})) {
        if (!living.has(sectionId)) continue;
        if (!pickApplicable(persona, sectionId, variantId)) return false;
    }
    return true;
}

// The version is the one marked active and the live combination still equals it,
// so applying it again would write the same text, log the same line and queue the
// same picture upload a second time (a double tap did exactly that).
export function versionAlreadyApplied(persona, versionId) {
    if (!persona || persona.activeVersionId !== versionId) return false;
    const version = (persona.versions ?? []).find(v => v?.id === versionId);
    return !!version && picksEqual(persona.activePicks, version.picks);
}

function picksEqual(a, b) {
    const left = a ?? {};
    const right = b ?? {};
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const k of keys) {
        if (!Object.hasOwn(right, k) || left[k] !== right[k]) return false;
    }
    return true;
}

// What the icon label shows. Three states: no version selected, the selected
// version, and the selected version with the current combination changed away
// from it. The changed state must be visible, because silently
// treating it as the saved version is how a user's combination disappears.
export function describeSelection(persona) {
    if (!persona) return NO_VERSION_LABEL;
    const version = (persona.versions ?? []).find(v => v.id === persona.activeVersionId);
    if (!version) return NO_VERSION_LABEL;
    const name = version.name ?? '';
    // A version whose picks name a variant that was later deleted is not special
    // here. Either the live picks moved to a surviving variant, in which case they
    // differ and the label says so, or they still name the same dead id and the
    // combination really is the saved one. The section that then drops out of the
    // prompt is reported separately, from compose().missing.
    return picksEqual(version.picks, persona.activePicks) ? name : name + MODIFIED_SUFFIX;
}

// An unrecognised key, including undefined on a settings object saved before this
// feature existed, reads the same as the explicit default rather than throwing or
// showing a blank control. The names themselves are STRINGS.quick.sortNames. Own
// properties only, for the same reason pickPersonaCommand checks: sortBy is
// whatever settings.json holds, and a value like 'constructor' must fall back
// rather than print something from the prototype.
export function sortLabel(sortBy) {
    const names = STRINGS.quick.sortNames;
    if (typeof sortBy === 'string' && Object.hasOwn(names, sortBy)) return names[sortBy];
    return names.name;
}

// The chip row and persona list, built in one pass so the panel never
// has to reimplement 21.4's fallback itself. personas is SillyTavern's own
// avatarId -> name map (power_user.personas); root is our extension's data and is
// only read here, never written, so calling this can never create a personas entry
// (21.1's central rule). name1 is accepted for the same reason ctx.js's
// resolveAvatar takes it alongside personas, even though today's sort and filter
// logic does not need it.
//
// The 21.4 fallback (an active label that no longer exists, or one whose living
// members are now empty, falls back to showing everything) is only computed here.
// Persisting the correction back to settings.activeLabelId is the caller's job,
// because only the caller knows whether writing is allowed right now.
export function buildRosterView({ personas, name1 } = {}, root, collator) {
    const stPersonas = personas ?? {};
    const settings = root?.settings ?? {};
    const chips = livingLabels(root?.labels, stPersonas);
    const allEntries = Object.entries(stPersonas).map(([avatar, name]) => ({ avatar, name: name ?? '' }));

    let activeLabelId = settings.activeLabelId ?? null;
    if (activeLabelId != null) {
        const active = chips.find(label => label.id === activeLabelId);
        if (!active || !active.members.length) activeLabelId = null;
    }

    const filtered = filterByLabel(allEntries, chips, activeLabelId);
    const entries = sortEntries(filtered, settings.sortBy, {
        personas: root?.personas,
        lastUsed: root?.lastUsed,
        collator,
    });

    return { chips, entries, activeLabelId };
}

// What a persona row in the list adds about its versions, as
// data, for two settings that are independent of each other: badge rides the name
// line ("버전 3"), line is the version names on a row of their own underneath.
// Either, both or neither, and the caller draws whatever is not null.
//
// A persona this extension has no entry for gets nothing at all, whichever
// toggles are on. The list is SillyTavern's and most of it is not ours, so
// hanging "버전 0" off thirty rows would bury the few that do carry our data.
// An entry whose versions array is empty is the same case to the user, and reads
// the same here.
export function rosterVersionLine(persona, { count, names } = {}) {
    const versions = persona?.versions;
    if (!Array.isArray(versions) || versions.length === 0) return { badge: null, line: null };
    const badge = count ? STRINGS.quick.versionBadge(versions.length) : null;
    // A blank name would print as a stray separator with nothing beside it, so it
    // is skipped; if that leaves nothing at all there is no row to draw.
    const printable = names
        ? versions.map(version => String(version?.name ?? '').trim()).filter(name => name !== '')
        : [];
    const line = printable.length ? printable.join(STRINGS.common.dotSeparator) : null;
    return { badge, line };
}

/* 언어별 이름 자동 적용 (user request). The decision, with no side effects: given
   the language the chat is being held in, which name should this persona carry?

   null means leave it alone, and there are four reasons for that answer:
   no language decided, nothing registered for it, the persona already carries
   it, or another persona already has that name. The last one matters most: two
   personas sharing a name make the active one unknowable and every
   write in this extension refuses from then on, so renaming INTO that state
   automatically is the one outcome this feature must never produce.

   The current name is read from the map by avatar rather than passed in, so a
   caller holding a stale name cannot make this answer with it. */
export function pickAutoName({ persona, lang, avatar, personas } = {}) {
    if (!lang || !avatar) return null;
    const wanted = persona?.names?.[lang];
    if (typeof wanted !== 'string') return null;
    const name = wanted.trim();
    if (!name) return null;
    const map = personas ?? {};
    if (!Object.hasOwn(map, avatar)) return null;
    if (map[avatar] === name) return null;
    for (const [key, other] of Object.entries(map)) {
        if (key !== avatar && other === name) return null;
    }
    return name;
}

/* 채팅 속 동명이인 (user request 2026-08-27). Renaming the ACTIVE persona changes
   {{user}}, and {{user}} is what the model reads as the user's name. If the chat
   already has somebody called that (the character, or a name on a past message),
   the model now has two of them and no way to tell which is which.

   Answers the colliding name, or null. The name only, never a rewrite of
   anything: this extension does not touch a single character of chat text, and
   the risk here is a collision, not a substitution. */
export function nameCollides({ name, characterName, chat, scan = 40 } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return null;
    const character = String(characterName ?? '').trim();
    if (character && character === wanted) return character;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1, seen = 0; i >= 0 && seen < scan; i--, seen++) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        // A past message of the user's own carries the name the persona had THEN.
        // Matching it is not a collision: it is the same person under an older
        // name, which is exactly what a per-language name is.
        if (message.is_user) continue;
        const sender = String(message.name ?? '').trim();
        if (sender && sender === wanted) return sender;
    }
    return null;
}
