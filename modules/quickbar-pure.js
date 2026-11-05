// Pure logic behind the quick switch bar. No DOM, so tests import it in plain Node;
// the DOM half is quickbar.js, which tests must never import.
import { findVersion } from './store.js';
import { livingLabels, filterByLabel, sortEntries } from './roster.js';
import { STRINGS } from './strings.js';
import { chatSources, contextLanguage } from './search-pure.js';

// Persona-switch slash commands in preference order, all taking (unnamed: persona name, named: mode).
const PERSONA_COMMAND_NAMES = Object.freeze(['persona-set', 'persona', 'name']);

// The languages a persona can carry a name for, keyed by detectLanguage's codes.
export const NAME_LANGUAGES = Object.freeze(['ko', 'ja', 'zh', 'en']);

// Aliases kept for the names the DOM half and the tests import.
export const NO_VERSION_LABEL = STRINGS.quick.iconNoVersion;
export const MODIFIED_SUFFIX = STRINGS.quick.iconModifiedSuffix;

// Scheduler turns a persona switch gets before it counts as failed. The slash command
// resolves before SillyTavern has swapped name1, so checking at once reports false failures.
const SWITCH_WAIT_TURNS = 10;

// Creating a persona writes a file on the server first, so it gets about two seconds
// where a switch (in memory only) gets a third of one.
export const CREATE_WAIT_TURNS = 60;

// One scheduler turn: calls resolve on the next animation frame or after TURN_MS, whichever
// comes first, since requestAnimationFrame never fires in a hidden tab.
const TURN_MS = 32;

export function schedulerTurn(resolve) {
    let done = false;
    const once = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
    setTimeout(once, TURN_MS);
}

// Polls predicate once per scheduler turn and returns whether it held in the end.
// schedule(resolve) must call resolve; tests inject their own to drive the turns.
export async function waitFor(predicate, schedule = schedulerTurn, turns = SWITCH_WAIT_TURNS) {
    for (let i = 0; i < turns; i++) {
        if (predicate()) return true;
        await new Promise(resolve => schedule(resolve));
    }
    return !!predicate();
}

// The SillyTavern popup probe's decisions; runPopup in quickbar.js does the measuring.

// A popup unanswered this long may be unreachable: our screens are modal dialogs, so a
// build that draws its popup as a plain div puts it under our host, in the inert page.
export const POPUP_STUCK_MS = 4000;

// Stuck windows a popup is re-checked over. shouldSelfCorrect defers while a foreign
// dialog is open, so this covers one that closes soon after; a longer one is accepted.
export const POPUP_STUCK_CHECKS = 3;

function asSet(value) {
    if (value instanceof Set) return value;
    return new Set(value ?? []);
}

// True when this build draws its popup as a dialog, in the same top layer as our host.
// Only a dialog that is new AND still open at the end counts: another extension's dialog
// flashing past must not fake the verdict, which is never revisited.
export function popupVerdict({ before, during, openAtEnd } = {}) {
    const was = asSet(before);
    const still = asSet(openAtEnd);
    for (const dialog of asSet(during)) {
        if (!was.has(dialog) && still.has(dialog)) return true;
    }
    return false;
}

// Whether a long-unanswered popup means the verdict was wrong. Not if our host is already
// dropped (the user is just reading) or a foreign dialog is open (the question is reachable).
export function shouldSelfCorrect({ needsDrop, elapsedMs, foreignOpen } = {}) {
    if (needsDrop) return false;
    if (!(Number(elapsedMs) >= POPUP_STUCK_MS)) return false;
    return !foreignOpen;
}

// The diverged banner's controls. Revert and absorb mutate settings before state.js can
// refuse the save, and ST's next save would persist that, so read-only disables them.
export function divergedActions(writable) {
    return [
        { key: 'revert', label: STRINGS.quick.divergeRevert, mutates: true, enabled: !!writable },
        { key: 'absorb', label: STRINGS.quick.divergeAbsorb, mutates: true, enabled: !!writable },
        { key: 'later', label: STRINGS.quick.divergeLater, mutates: false, enabled: true },
    ];
}

// The first of names this build registers. Builds differ, so commands are looked up, never assumed.
export function pickPersonaCommand(commands, names = PERSONA_COMMAND_NAMES) {
    if (!commands || typeof commands !== 'object') return null;
    for (const name of names) {
        // Own properties only: `in` would see Object.prototype.
        if (Object.hasOwn(commands, name) && commands[name]) return name;
    }
    return null;
}

// Folded by code point, not a regex range: the range needs backslash-u escapes, and tools
// have turned those into the raw bytes they name in this repo.
function foldControls(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        out += (code < 32 || code === 127) ? ' ' : ch;
    }
    return out;
}

export function quoteArg(value) {
    // A newline would end the command line and cannot be escaped, so controls become spaces.
    const text = foldControls(String(value ?? ''))
        // One pass, so an added backslash is never re-escaped. | separates commands, braces
        // open macros, and " would close the argument.
        .replace(/[\\"|{}]/g, m => '\\' + m);
    return `"${text}"`;
}

// Whether our data may be written at all: not when the active persona is ambiguous or the
// root belongs to a newer build. Label and settings writes, which are not tied to one
// persona, check only this.
export function rosterWritable(s) {
    return !!s && !s.ambiguous && !s.readOnly;
}

// A node the user may be typing into, where a redraw must wait: replacing it discards a
// hangul composition in progress. Not every <input>: Chromium focuses a tapped checkbox,
// and deferring on that would drop redraws while nobody is typing.
export function isTextEntry(node) {
    const tag = node?.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    // .type is always a lowercase string; search boxes compose hangul too.
    return node.type === 'text' || node.type === 'search';
}

// Whether this persona has the section and variant: a native picker left open across a
// redraw can resolve after the active persona moved, and a foreign pick would never match
// a version, leaving the icon marked modified for good.
export function pickApplicable(persona, sectionId, variantId) {
    if (!persona || !sectionId || !variantId) return false;
    if (!(persona.sections ?? []).some(section => section.id === sectionId)) return false;
    return (persona.variants?.[sectionId] ?? []).some(variant => variant.id === variantId);
}

// Whether the version applies to this persona as it stands; re-run after any await, since
// the active persona can move during a popup. A pick of a deleted variant fails; a pick of a
// deleted section is skipped (removeSection leaves those keys and compose ignores them).
export function versionApplicable(persona, versionId) {
    const version = findVersion(persona, versionId);
    if (!version) return false;
    const living = new Set((persona.sections ?? []).map(section => section?.id));
    for (const [sectionId, variantId] of Object.entries(version.picks ?? {})) {
        if (!living.has(sectionId)) continue;
        if (!pickApplicable(persona, sectionId, variantId)) return false;
    }
    return true;
}

// Active and unchanged: re-applying (say, a double tap) would repeat the write, log line
// and picture upload.
export function versionAlreadyApplied(persona, versionId) {
    if (!persona || persona.activeVersionId !== versionId) return false;
    const version = findVersion(persona, versionId);
    return !!version && picksEqual(persona.activePicks, version.picks, livingSections(persona));
}

function livingSections(persona) {
    return (Array.isArray(persona?.sections) ? persona.sections : []).map(section => section?.id).filter(Boolean);
}

// Compared over living sections only: a deleted section leaves the live picks but stays
// in saved versions, and must not mark the active version modified.
function picksEqual(a, b, living) {
    const left = a ?? {};
    const right = b ?? {};
    for (const id of living) {
        const l = Object.hasOwn(left, id) ? left[id] : undefined;
        const r = Object.hasOwn(right, id) ? right[id] : undefined;
        if (l !== r) return false;
    }
    return true;
}

// The icon label: no version, the active version's name, or that name marked modified,
// so a changed combination never passes for the saved one.
export function describeSelection(persona) {
    if (!persona) return NO_VERSION_LABEL;
    // v?.id because a hand-edited null entry survives migrate.
    const version = findVersion(persona, persona.activeVersionId);
    if (!version) return NO_VERSION_LABEL;
    const name = version.name ?? '';
    // A pick of a since-deleted variant needs no special case here; compose().missing
    // reports the section it drops.
    return picksEqual(version.picks, persona.activePicks, livingSections(persona)) ? name : name + MODIFIED_SUFFIX;
}

// Unknown keys, including undefined from settings saved before sorting existed, fall back
// to the name sort. Own properties only: 'constructor' must not reach the prototype.
export function sortLabel(sortBy) {
    const names = STRINGS.quick.sortNames;
    if (typeof sortBy === 'string' && Object.hasOwn(names, sortBy)) return names[sortBy];
    return names.name;
}

// The chip row and persona list. personas is ST's avatar -> name map; root is only read, so
// this never creates an entry. A missing or memberless active label falls back to showing
// all; the caller persists that, since only it knows whether writing is allowed.
export function buildRosterView({ personas } = {}, root, collator) {
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

// A roster row's version info: badge (count beside the name) and line (names below), each
// null when off. Personas without versions get neither, so ST's other personas stay clean.
export function rosterVersionLine(persona, { count, names } = {}) {
    const versions = persona?.versions;
    if (!Array.isArray(versions) || versions.length === 0) return { badge: null, line: null };
    const badge = count ? STRINGS.quick.versionBadge(versions.length) : null;
    const printable = names
        ? versions.map(version => String(version?.name ?? '').trim()).filter(name => name !== '')
        : [];
    const line = printable.length ? printable.join(STRINGS.common.dotSeparator) : null;
    return { badge, line };
}

// The name this persona should carry in the chat's language, or null to leave it. Never one
// another persona has: duplicate names make the active persona unknowable and block every
// write. The current name is read from personas by avatar, never from a possibly stale caller.
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

// What search-pure.js contextLanguage votes on, read from a SillyTavern context. In a group
// chat every member's card counts; a shallow-loaded card (no description yet) votes by name.
export function languageContextOf(ctx) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const { user, reply, greeting } = chatSources(chat);
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    let cards = [];
    if (ctx?.groupId !== undefined && ctx?.groupId !== null && ctx?.groupId !== '') {
        const group = (Array.isArray(ctx?.groups) ? ctx.groups : []).find(g => g?.id == ctx.groupId);
        const members = Array.isArray(group?.members) ? group.members : [];
        cards = characters.filter(c => c && members.includes(c.avatar));
    } else if (ctx?.characterId !== undefined && ctx?.characterId !== null) {
        const card = characters[Number(ctx.characterId)];
        if (card) cards = [card];
    }
    const field = (card, key) => {
        const value = card?.data?.[key] ?? card?.[key];
        return typeof value === 'string' ? value : '';
    };
    const names = cards.map(card => field(card, 'name')).filter(Boolean);
    if (!names.length && typeof ctx?.name2 === 'string') names.push(ctx.name2);
    return {
        user,
        reply,
        greeting,
        card: cards.map(card => ['description', 'personality', 'scenario'].map(key => field(card, key)).join(' ')).join(' '),
        name: names.join(' '),
        persona: typeof ctx?.powerUserSettings?.persona_description === 'string'
            ? ctx.powerUserSettings.persona_description : '',
    };
}

// The language the persona's name should follow right now, or null.
export function conversationLanguage(ctx) {
    return contextLanguage(languageContextOf(ctx)).lang;
}

// The chat name a rename of the active persona would collide with, or null: {{user}} would
// match the character or a recent speaker. Reports only; chat text is never rewritten.
export function nameCollides({ name, characterName, chat, scan = 40 } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return null;
    const character = String(characterName ?? '').trim();
    if (character && character === wanted) return character;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1, seen = 0; i >= 0 && seen < scan; i--, seen++) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        // The user's own past messages carry the persona's older names; not a collision.
        if (message.is_user) continue;
        const sender = String(message.name ?? '').trim();
        if (sender && sender === wanted) return sender;
    }
    return null;
}
