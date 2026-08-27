// Pure logic behind the manager screen.
// Nothing here touches the DOM, so 검사/manager.test.mjs can import it in plain
// Node. The DOM half lives in manager.js and must never be imported by a test.
import { addLog } from './history.js';
import { DEFAULT_SETTINGS, DEFAULT_SECTION_NAMES, SCHEMA_VERSION, makeId, migrate } from './store.js';
import { STRINGS } from './strings.js';

// What a version's slot reads when its pick names nothing that still exists.
// The slot says 없음 and is never filled in for the user.
// Substituting a surviving variant would show a combination the version does not
// actually contain, and the user would never learn that a pick had died.
// The word itself lives in STRINGS; this export is the name the
// DOM half and the tests already reach it by.
export const NO_PICK_LABEL = STRINGS.manager.noPick;

// The last section is never deleted. A persona with no sections
// composes to an empty description, and this screen offers no way back out of
// that, so the refusal has to happen before the mutation rather than after.
export function canDeleteSection(persona, sectionId) {
    const sections = persona?.sections ?? [];
    if (sections.length <= 1) return false;
    return sections.some(section => section.id === sectionId);
}

// Removes a section and everything only it could reach: its variant list, its
// entry in activePicks, and the history of each variant it takes with it.
// Returns a description of what went, or null when the removal was refused.
//
// Version picks are deliberately left pointing at the dead section. Automatic
// substitution is forbidden, and versionSummary renders the orphaned
// slot as 없음, which is the honest report. activePicks is the opposite case: it
// is the live combination, not a saved record of one, so a key naming a section
// nobody can see again is a ghost. compose() iterates sections and would never
// look at it, but describeSelection compares the whole activePicks object against
// each version's picks, so the ghost would make the live combination differ from
// every saved version for as long as the persona exists.
export function removeSection(persona, sectionId, now) {
    if (!canDeleteSection(persona, sectionId)) return null;
    const index = persona.sections.findIndex(section => section.id === sectionId);
    const [section] = persona.sections.splice(index, 1);
    const variants = persona.variants?.[sectionId] ?? [];
    const variantIds = variants.map(variant => variant.id);
    if (persona.history) {
        for (const variantId of variantIds) delete persona.history[variantId];
    }
    if (persona.variants) delete persona.variants[sectionId];
    if (persona.activePicks) delete persona.activePicks[sectionId];
    addLog(persona, 'section-delete', section.name ?? '', now);
    return { id: sectionId, name: section.name ?? '', variantIds };
}

// Moves a section one place up or down. Order is what compose() joins the blocks
// in, so this is a content change and not merely a display preference. Returns
// whether anything moved: a refusal at either end is a no-op, not an error, so
// the arrow at the end of the list simply does nothing.
export function moveSection(persona, sectionId, delta) {
    const sections = persona?.sections;
    if (!Array.isArray(sections)) return false;
    const from = sections.findIndex(section => section.id === sectionId);
    if (from === -1) return false;
    const to = from + delta;
    if (to < 0 || to >= sections.length) return false;
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved);
    return true;
}

// Deletes one variant. A section always keeps at least one variant, and deleting
// the active one moves the pick to the section's first remaining variant and says
// so in the log. Returns what happened, or null when
// the deletion was refused.
//
// The deleted variant's history goes with it for the same reason removeSection
// drops it: no screen can reach a snapshot whose variant is gone, so leaving it
// behind only fills settings.json. Version picks keep the dangling id, exactly as
// in removeSection.
export function deleteVariant(persona, sectionId, variantId, now) {
    const list = persona?.variants?.[sectionId];
    if (!Array.isArray(list) || list.length <= 1) return null;
    const index = list.findIndex(variant => variant.id === variantId);
    if (index === -1) return null;
    const [gone] = list.splice(index, 1);
    if (persona.history) delete persona.history[variantId];
    addLog(persona, 'variant-delete', gone.label ?? '', now);
    let movedTo = null;
    if (persona.activePicks && persona.activePicks[sectionId] === variantId) {
        movedTo = list[0].id;
        persona.activePicks[sectionId] = movedTo;
        addLog(persona, 'pick-moved', `${gone.label ?? ''} -> ${list[0].label ?? ''}`, now);
    }
    return { removed: gone.id, label: gone.label ?? '', movedTo };
}

// Renaming and deleting labels live on this screen. An empty name
// is refused rather than stored: the chip row draws the name and nothing else, so
// a blank one is a chip the user cannot tell from any other blank one. Duplicate
// names are allowed on purpose (21.4): labels are identified by id, and blocking
// the name would stop the user without telling them why.
export function renameLabel(labels, labelId, name) {
    const label = (labels ?? []).find(entry => entry.id === labelId);
    if (!label) return false;
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return false;
    label.name = trimmed;
    return true;
}

// Removes the label itself and nothing else. The members array is a list of
// avatar ids, so dropping the label cannot reach a persona, which is exactly the
// intent: the label goes, the personas stay. An activeLabelId left naming the
// deleted label is handled where it is read (buildRosterView falls back to
// showing everything).
export function deleteLabel(labels, labelId) {
    if (!Array.isArray(labels)) return false;
    const index = labels.findIndex(entry => entry.id === labelId);
    if (index === -1) return false;
    labels.splice(index, 1);
    return true;
}

// One row per section of the persona, in section order, describing what this
// version picks there. The whole combination has to be visible at a glance,
// so a section the version never picked reads the same as one whose pick died:
// both are 없음, because in both cases the version selects nothing there.
//
// Picks naming a section the persona no longer has are not shown. They are kept
// in the data (removeSection leaves them alone) so that nothing is silently
// rewritten, but there is no row to show them in and inventing one would describe
// a section the user cannot act on.
export function versionSummary(persona, version) {
    const picks = version?.picks ?? {};
    return (persona?.sections ?? []).map(section => {
        const variantId = Object.hasOwn(picks, section.id) ? picks[section.id] : null;
        const variant = variantId
            ? (persona?.variants?.[section.id] ?? []).find(entry => entry.id === variantId)
            : null;
        return {
            sectionId: section.id,
            sectionName: section.name ?? '',
            variantId: variantId ?? null,
            label: variant ? (variant.label ?? '') : NO_PICK_LABEL,
            dead: !variant,
        };
    });
}

// One line standing in for a whole combination. A version row is kept down to a
// name, a summary and one button, so the per section detail
// moves into the expansion and this is what stays on the row. A dead pick reads
// 없음 here exactly as it does in the detail, because that is what the version
// selects there.
export function versionSummaryLine(persona, version) {
    return versionSummary(persona, version)
        .map(row => `${row.sectionName}: ${row.label}`)
        .join(STRINGS.common.dotSeparator);
}

/* Row expansion keys */

// Exactly one row is expanded at a time, so the open row is one string in the
// screen's module state and every row asks whether that string names it.
//
// JSON rather than a joined string, for the same reason draftKey uses it: an id
// is whatever SillyTavern or a hand edited settings.json put there, so no
// separator is safe, and two different rows that collapsed onto one key would
// open each other.
export function rowKey(kind, ...parts) {
    // A missing part stays null rather than collapsing to '': an id that is
    // absent and an id that is an empty string are two different rows, and one
    // key for both would open each other's drawer, which is the exact failure
    // the JSON encoding exists to rule out.
    return JSON.stringify([String(kind ?? ''), ...parts.map(part => (part == null ? null : String(part)))]);
}

/* Drafts: unsaved editor text (review findings R2 and R3) */

// The editor saves on a button, so every path that takes the textarea off the
// screen used to throw away what was in it: switching tabs and opening a second
// variant's editor both did it without a word. A confirmation on each would be a
// question the user has to answer to do something ordinary, so the text is kept
// instead and put back when that same body is opened again.
//
// Strings only. Nothing here holds a persona, a context or a node, so a draft
// cannot keep a stale object alive; the worst a stale draft can do is offer text
// for a variant that no longer exists, and the editor is only ever built for a
// variant that does.
const drafts = new Map();

// JSON rather than a joined string: an avatar id is a file name and could in
// principle contain whatever separator we picked, and two different triples that
// collapse to one key would hand one variant's text to another.
export function draftKey(avatarId, sectionId, variantId) {
    return JSON.stringify([avatarId ?? null, sectionId ?? null, variantId ?? null]);
}

// null or undefined text clears the slot, so a caller that has nothing to keep
// does not have to reach for a second function to say so.
export function putDraft(avatarId, sectionId, variantId, text) {
    const key = draftKey(avatarId, sectionId, variantId);
    if (text === undefined || text === null) { drafts.delete(key); return false; }
    drafts.set(key, String(text));
    return true;
}

// Reads without consuming. The draw path uses this: a redraw must not be the
// thing that empties the slot, because the next redraw would then find nothing.
export function peekDraft(avatarId, sectionId, variantId) {
    const key = draftKey(avatarId, sectionId, variantId);
    return drafts.has(key) ? drafts.get(key) : null;
}

// Reads and clears. Used once the text has actually been stored on the variant:
// leaving it behind would make the next open restore an edit that is already
// saved, and any later change to that variant would look unsaved next to it.
export function takeDraft(avatarId, sectionId, variantId) {
    const key = draftKey(avatarId, sectionId, variantId);
    if (!drafts.has(key)) return null;
    const text = drafts.get(key);
    drafts.delete(key);
    return text;
}

export function clearDrafts() { drafts.clear(); }

// For the tests and for the teardown check. Nothing on screen reads it.
export function draftCount() { return drafts.size; }

/* History view */

export const PREVIEW_CHARS = 40;

// One line standing in for a whole snapshot. Newlines are folded because the
// list gives each entry a single row, and a body whose first line is blank would
// otherwise show as an empty row that looks like a bug.
export function previewText(text, max = PREVIEW_CHARS) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) return STRINGS.manager.previewEmpty;
    // Cut by code point. Slicing by code unit can split a surrogate pair, and the
    // lone half renders as a replacement character.
    const chars = [...flat];
    if (chars.length <= max) return flat;
    return chars.slice(0, max).join('') + '...';
}

// Every variant of the persona, grouped by section, with its snapshots newest
// first. Each snapshot keeps the index it holds in storage, because that index is
// what history.js's restore() takes; presenting them reversed and then handing
// the display position back would restore the wrong one.
// previewFor decides how much work this does, because previewText runs a regex
// over a whole 2,000+ character body and the history screen only ever renders one
// variant's snapshots. Leave it out for every preview (what the tests read); pass
// a variantId for that variant's previews only; pass null for counts alone, which
// is all the variant select needs. Measured on the device's real shape (13
// sections, 5 snapshots each, ~3,000 character bodies) the whole persona cost
// 3.5-3.9ms per call and drawManager made two of them per repaint, on a screen
// that repaints on every commit, every tab tap and every PERSONA_UPDATED.
export function historyView(persona, sectionId, previewFor) {
    const history = persona?.history ?? {};
    const everything = previewFor === undefined;
    const groups = [];
    for (const section of persona?.sections ?? []) {
        if (sectionId && section.id !== sectionId) continue;
        const variants = (persona?.variants?.[section.id] ?? []).map(variant => {
            const list = history[variant.id] ?? [];
            const wanted = everything || previewFor === variant.id;
            const snapshots = wanted ? list.map((entry, index) => ({
                index,
                at: entry?.at ?? 0,
                preview: previewText(entry?.text),
            })) : [];
            snapshots.reverse();
            return {
                sectionId: section.id,
                sectionName: section.name ?? '',
                variantId: variant.id,
                // From the stored list, not from snapshots, so a call that skipped
                // the previews still reports the real number to the select.
                count: list.length,
                label: variant.label ?? '',
                snapshots,
            };
        });
        groups.push({ sectionId: section.id, sectionName: section.name ?? '', variants });
    }
    return groups;
}

// Eviction leaves a log line so the user can find out why their
// history got shorter. The history screen is where they go looking, so it is the
// screen that has to say it.
export function hasEvictionNotice(persona) {
    // Both kinds. Expiry removes history for a different reason than the byte cap
    // but the user's question is the same one: why is my history shorter.
    return (persona?.log ?? []).some(entry => entry?.kind === 'history-evicted' || entry?.kind === 'history-expired');
}

// A stable identity for the set of sections that fell out of the prompt. The
// banner is permanent, but the toast is not: firing one on every commit turned a
// single unfixed empty section into a toast per tap. Order is not part of the
// set, so it is sorted away before comparing.
//
// JSON rather than a joined string, for the same reason draftKey uses it:
// section names are whatever the user typed, so no separator is safe, and two
// different sets that joined to one string would silence a toast that was owed.
export function missingSignature(missing) {
    return JSON.stringify([...(missing ?? [])].map(name => String(name ?? '')).sort());
}

/* Settings ranges */

// The ranges as data, so the settings screen and the clamp cannot disagree about
// them.
export const SETTING_RANGES = Object.freeze({
    historyPerVariant: Object.freeze({ min: 0, max: 50, step: 1 }),
    historyMaxBytes: Object.freeze({ min: 65536, max: 2097152, step: 1024 }),
    historyMaxDays: Object.freeze({ min: 0, max: 3650, step: 1 }),
    historyCoalesceMinutes: Object.freeze({ min: 1, max: 30, step: 1 }),
    // 0 means everything on one page.
    rosterTileRows: Object.freeze({ min: 0, max: 20, step: 1 }),
    pageSizeRoster: Object.freeze({ min: 0, max: 200, step: 1 }),
    pageSizeAssets: Object.freeze({ min: 0, max: 200, step: 1 }),
    pageSizeVersions: Object.freeze({ min: 0, max: 200, step: 1 }),
});

// A number input on Android accepts anything the user pastes, and an empty field
// reads as an empty string. Both arrive here as NaN, and storing that would
// serialise as null, which every reader downstream treats as "no cap at all":
// the one outcome the history caps exist to prevent. So a value we cannot make
// sense of becomes the shipped default rather than being written through.
export function clampSetting(key, value) {
    const range = SETTING_RANGES[key];
    if (!range) return value;
    // An empty field converts to 0 rather than to NaN, and 0 is a legal value for
    // historyPerVariant, so a user who cleared the box in order to retype would
    // have turned history off without asking to. An empty string is no value.
    const raw = typeof value === 'string' ? value.trim() : value;
    if (raw === '' || raw === null || raw === undefined) return DEFAULT_SETTINGS[key];
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS[key];
    return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

/* Settings export and import */

// The whole root as a file. Indented, because the file exists so a user can look
// at it and keep it, and a single line of a few hundred KB is not something a
// phone text viewer opens.
export function serializeRoot(root) {
    return JSON.stringify(root ?? {}, null, 2);
}

// The other direction, and the only gate between a file off the disk and a
// wholesale replacement of everything this extension stores. Returns the migrated
// root to install, or a refusal carrying the sentence to put on screen: a failure
// that says nothing is forbidden, and this one can only be reached by a
// user who just picked a file and is waiting to hear about it.
//
// Nothing here writes anywhere. The caller installs the root it gets back, which
// is what keeps the decision testable without a SillyTavern to install into.
export function parseImportedRoot(text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text ?? ''));
    } catch (e) {
        return { ok: false, message: STRINGS.settings.importNotJson(String(e?.message ?? e)) };
    }
    // An array is a typeof object too, and so is null. Neither has a settings or a
    // personas container, and installing one would take the whole screen down on
    // the next read rather than here where we can say what happened.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, message: STRINGS.settings.importNotShape };
    }
    const version = parsed.schemaVersion;
    // A root a newer build owns is never rewritten. On import that
    // means refusing outright, because installing it would put this build into the
    // read only state with the user's real data replaced by the file's.
    if (typeof version === 'number' && version > SCHEMA_VERSION) {
        return { ok: false, message: STRINGS.settings.importNewer(version, SCHEMA_VERSION) };
    }
    /* Every entry under personas has to BE a persona. migrate backfills containers
       and defaults but never changes the shape of what is already there, so a
       hand edited file whose persona is a string or a null installs cleanly and
       then throws the first time anything writes a log line to it - which is
       every write there is. The import would have reported success, and the data
       it replaced would already be gone.

       Refused rather than repaired or quietly dropped: the file is the user's,
       and a persona nobody can read is not something to guess the contents of.
       Nothing has been touched at this point, so their own data is still there. */
    const malformed = Object.values(parsed.personas ?? {})
        .filter(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)).length;
    if (malformed) return { ok: false, message: STRINGS.settings.importBadPersonas(malformed) };

    // migrate backfills the containers and the shipped defaults, so a file written
    // by an older build, or one a user hand edited down to the parts they cared
    // about, arrives complete rather than half missing.
    return { ok: true, root: migrate(parsed) };
}

/* 고쳐서 새 버전 */

// One block per section the composed prompt actually carries, with the same
// rules compose() applies: the trimmed body of the active pick, and nothing at
// all for an empty body or a dead pick. What the revise screen offers for
// editing has to be exactly what the prompt says, or the user would be revising
// text that was never sent. Skipped sections keep their picks at save time.
//
// variantId names the body the block was built from. The revise screen never
// needed it, because it only ever ADDS choices; the 전문 screen writes back into
// the body itself, and without the id a save would land on whatever is picked at
// save time rather than on the body the user was looking at.
export function buildReplaceBlocks(persona) {
    const blocks = [];
    for (const section of persona?.sections ?? []) {
        const pick = persona.activePicks?.[section.id];
        const variant = (persona.variants?.[section.id] ?? []).find(entry => entry.id === pick);
        if (!variant) continue;
        const text = (variant.text ?? '').trim();
        if (!text) continue;
        blocks.push({ sectionId: section.id, sectionName: section.name ?? '', variantId: variant.id, text });
    }
    return blocks;
}

/* ── 설명문 전문 확인·수정 (user request) ───────────────────────────────────
   What [저장] on the 전문 screen would do, decided before anything is written.
   The screen showed one textarea per block, so a write is only safe while the
   body that block came from is still there AND still the section's active pick:
   the composed text the user was editing is the picks as they were, and a pick
   that moved underneath means the text on screen belongs to a body nobody is
   looking at any more.

   The seam this guards is the one that got past two green unit suites last
   round: the function and the screen each agreed with themselves about which
   body index 2 was. Nothing is mutated here, so the caller can snapshot from
   `before` and the plan can be tested without a persona to write to. */
export function planFullTextSave(persona, blocks, texts) {
    const writes = [];
    const skipped = [];
    (blocks ?? []).forEach((block, index) => {
        const next = texts?.[index];
        if (typeof next !== 'string') return;
        // buildReplaceBlocks trimmed what it handed the screen, so this compares
        // against what was DISPLAYED. An untouched block is never written, which
        // is what keeps a save from stamping every body with a new timestamp.
        if (next === (block?.text ?? '')) return;
        const section = (persona?.sections ?? []).find(entry => entry.id === block?.sectionId);
        const variant = (persona?.variants?.[block?.sectionId] ?? []).find(entry => entry.id === block?.variantId);
        const picked = persona?.activePicks?.[block?.sectionId];
        if (!section || !variant || picked !== block?.variantId) {
            skipped.push(block?.sectionName ?? '');
            return;
        }
        const before = variant.text ?? '';
        // The trim above can make an edit that only added surrounding whitespace
        // come out identical to what is stored. A log line and a history snapshot
        // for a body that did not change would both be false records.
        if (before === next) return;
        writes.push({
            sectionId: block.sectionId,
            variantId: block.variantId,
            label: variant.label ?? '',
            before,
            after: next,
        });
    });
    return { writes, skipped };
}

/* ── SillyTavern's own enum controls (user request) ─────────────────────────
   position and role on the persona descriptor are SillyTavern's enums and their
   NUMBERS have never been measured on this build. This project has already
   shipped three guessed values (depth 4, connections, a slash command that does
   not exist) and all three were wrong, so the numbers are not guessed here
   either: they are read off SillyTavern's own select, which carries the value
   and the label for each option together and therefore cannot pair them wrongly.

   Any malformed option refuses the WHOLE select. A partially understood enum is
   how a wrong mapping gets shipped, and the cost of refusing is a control that
   says it is unavailable, which is visible and fixable. Takes anything with an
   options list of {value, textContent}, so the DOM half hands in a select and
   the test hands in a plain object. */
export function readSelectOptions(select) {
    const raw = select?.options;
    if (!raw) return null;
    const options = [];
    const seen = new Set();
    for (const option of Array.from(raw)) {
        const label = String(option?.textContent ?? option?.text ?? '').trim();
        const value = String(option?.value ?? '').trim();
        if (!label) return null;
        if (!/^-?\d+$/.test(value)) return null;
        const number = Number(value);
        if (seen.has(number)) continue;
        seen.add(number);
        options.push({ value: number, label });
    }
    // One option is not a choice, and an empty list is not an enum. Either way
    // there is nothing here worth trusting as SillyTavern's position list.
    return options.length >= 2 ? options : null;
}

// The depth the user typed. A whole number of messages, so anything else is
// refused rather than rounded: depth reaches the prompt builder, and a silently
// coerced 2.7 would place the description somewhere the user did not ask for.
// No upper bound, because the ceiling is SillyTavern's and was never measured.
export function parseDepth(raw) {
    const text = String(raw ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : null;
}

/* ── Copy one persona's composition onto another (user request) ─────────────
   duplicatePersona makes the copy; this is where it lands. SillyTavern owns the
   creation of personas and the API for it has not been measured, so the
   destination is always a persona that already exists: the caller passes an
   avatar id SillyTavern listed, and what gets replaced is OUR record for it.

   Returns the copy, or null on every refusal. Copying onto the source would
   regenerate every id under the user's feet for no gain, which is why the two
   being equal is a refusal rather than a no-op. */
export function copyPersonaOnto(root, sourceAvatar, destAvatar, makeIdFn, now, detail) {
    if (!root || typeof root !== 'object') return null;
    if (!root.personas || typeof root.personas !== 'object') return null;
    if (typeof sourceAvatar !== 'string' || typeof destAvatar !== 'string') return null;
    if (!sourceAvatar || !destAvatar || sourceAvatar === destAvatar) return null;
    const source = root.personas[sourceAvatar];
    if (!source) return null;
    const copy = duplicatePersona(source, makeIdFn);
    if (!copy) return null;
    // On the COPY, not on the source: the source did not have anything happen to
    // it, and the destination's own log is gone with the record it belonged to.
    addLog(copy, 'persona-copy', detail ?? '', now);
    root.personas[destAvatar] = copy;
    return copy;
}

// One replacement applied to one block's working text. A non
// empty replacement goes in verbatim. An empty one is a deletion, and a deletion
// takes the whitespace run right after the span with it, so cutting a sentence
// out of the middle does not leave a double space behind; a span at the very end
// of the block takes the run before it instead. Offsets outside the text are
// clamped rather than thrown on: they come from a DOM selection, and a stale
// pair should degrade to a smaller edit, not a crash.
//
// The forward absorption stops at a newline UNLESS the span itself begins at
// the start of its line. Deleting the last sentence of a paragraph
// must not swallow the blank line after it and fuse two paragraphs; deleting a
// whole line or paragraph, which is what a span starting at a line start is,
// should take its line breaks along so no empty line is left behind.
export function applyReplacement(text, start, end, replacement) {
    const source = String(text ?? '');
    const from = Number.isInteger(start) ? Math.max(0, Math.min(start, source.length)) : 0;
    const to = Number.isInteger(end) ? Math.max(from, Math.min(end, source.length)) : from;
    const insert = String(replacement ?? '');
    if (insert !== '') return source.slice(0, from) + insert + source.slice(to);
    let cutFrom = from;
    let cutTo = to;
    if (cutTo < source.length && /\s/.test(source[cutTo])) {
        const wholeLine = from === 0 || source[from - 1] === '\n';
        while (cutTo < source.length && /\s/.test(source[cutTo])) {
            if (!wholeLine && source[cutTo] === '\n') break;
            cutTo++;
        }
    } else if (cutTo >= source.length) {
        while (cutFrom > 0 && /\s/.test(source[cutFrom - 1])) cutFrom--;
    }
    return source.slice(0, cutFrom) + source.slice(cutTo);
}

// The save behind [버전으로 저장]. Only the sections whose
// working text differs get a new choice, labelled with the version's name, and
// the live pick moves onto it; everything else keeps the pick it has. The new
// version is then the pick set as it stands, exactly the shape saveAsVersion
// stores. Nothing existing is overwritten anywhere in this function, which is
// what makes a stale block harmless: the worst outcome is a new choice beside
// the old ones.
//
// Logging: one variant-add per new choice is written here, where the loop is.
// The version-create line is left to the caller's commit(), which is the shared
// path that also saves and composes; writing it here too would log it twice.
//
// Returns what happened, or null when the name was empty: { version, changed,
// skipped }, skipped naming the sections that vanished between the screen
// opening and the save (the manager is modal, so normally none).
export function makeReplaceVersion(persona, blocks, workingTexts, name, makeIdFn, now) {
    const trimmed = String(name ?? '').trim();
    if (!persona || !trimmed) return null;
    const changed = [];
    const skipped = [];
    (blocks ?? []).forEach((block, index) => {
        // A missing working text is an unchanged block, never a deletion: ''
        // here would grow an empty choice and move the pick onto it for a block
        // the caller merely failed to hand over.
        const working = String(workingTexts?.[index] ?? block.text);
        if (working === block.text) return;
        const list = persona.variants?.[block.sectionId];
        if (!Array.isArray(list) || !persona.sections?.some(section => section.id === block.sectionId)) {
            skipped.push(block.sectionName);
            return;
        }
        const variantId = makeId(makeIdFn);
        list.push({ id: variantId, label: trimmed, text: working, updatedAt: now });
        if (!persona.activePicks) persona.activePicks = {};
        persona.activePicks[block.sectionId] = variantId;
        addLog(persona, 'variant-add', trimmed, now);
        changed.push({ sectionId: block.sectionId, variantId });
    });
    const version = {
        id: makeId(makeIdFn),
        name: trimmed,
        picks: { ...(persona.activePicks ?? {}) },
        // Null is 전체, and a version made today should keep
        // using every file including ones uploaded tomorrow.
        assetSelection: null,
        updatedAt: now,
    };
    if (!Array.isArray(persona.versions)) persona.versions = [];
    persona.versions.push(version);
    persona.activeVersionId = version.id;
    return { version, changed, skipped };
}

/* Tags */

// Adds one tag to a tags-bearing thing (a persona or a version). Trimmed,
// refused when empty, deduplicated by exact text: a duplicate tag chip would
// be two chips the user cannot tell apart. Returns the stored tag or null.
// Drag reorder. moveSection above steps one place at a time because the up/down
// buttons do; a drag lands on an arbitrary index and needs to say so directly.
// The index is where the section ends up AFTER the move, which is what a drop
// target means: dragging item 0 onto position 3 leaves it third, not fourth.
export function reorderSection(persona, sectionId, toIndex) {
    const sections = persona?.sections;
    if (!Array.isArray(sections)) return false;
    const from = sections.findIndex(section => section.id === sectionId);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(sections.length - 1, Math.trunc(Number(toIndex))));
    if (!Number.isFinite(to) || to === from) return false;
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved);
    return true;
}

// Bulk tagging over a set of personas. Returns the number actually changed so the
// screen can report what happened rather than claiming a number it assumed: a tag
// already present on half the selection is not an edit to those halves.
export function addTagToAll(personas, tag) {
    const trimmed = String(tag ?? '').trim();
    if (!trimmed) return 0;
    let changed = 0;
    for (const persona of personas ?? []) {
        if (addTag(persona, trimmed)) changed++;
    }
    return changed;
}

export function removeTagFromAll(personas, tag) {
    let changed = 0;
    for (const persona of personas ?? []) {
        if (removeTag(persona, tag)) changed++;
    }
    return changed;
}

// Every tag in use across a set, sorted, for the picker the bulk actions offer.
// Sorted by the locale-independent order so two runs on the same data agree.
export function tagsAcross(personas) {
    const seen = new Set();
    for (const persona of personas ?? []) {
        for (const tag of persona?.tags ?? []) seen.add(tag);
    }
    return [...seen].sort();
}

/* ── Per-language names (user request) ──────────────────────────────────────
   The same persona under a different chat language wants a different NAME, not a
   different persona: 미르 in Korean, Miro in English. The alternates live on
   our own record; SillyTavern's personas map is untouched until the user actually
   switches, because that map is what every other part of ST identifies a persona
   by and rewriting it behind their back would rename the persona everywhere.

   Keyed by the same language codes detectLanguage answers with, so the roster's
   language chips and this share one vocabulary. */
export function setLocalName(persona, lang, name) {
    if (!persona || typeof persona !== 'object') return false;
    const code = String(lang ?? '').trim();
    if (!code) return false;
    if (!persona.names || typeof persona.names !== 'object') persona.names = {};
    const trimmed = String(name ?? '').trim();
    // An empty name removes the alternate rather than storing a blank one: a blank
    // would win over the real name the moment that language was chosen.
    if (!trimmed) {
        if (!Object.hasOwn(persona.names, code)) return false;
        delete persona.names[code];
        return true;
    }
    if (persona.names[code] === trimmed) return false;
    persona.names[code] = trimmed;
    return true;
}

// The name to show for a language, falling back to the one SillyTavern knows.
export function localName(persona, lang, fallback) {
    const stored = persona?.names?.[lang];
    return (typeof stored === 'string' && stored.trim()) ? stored : (fallback ?? '');
}

/* ── Size (user request) ─────────────────────────────────────────────────────
   Characters are exact and free. Tokens are not ours to compute: the count that
   matters is whatever tokenizer the user's model uses, and guessing it would put
   a confident wrong number next to a real one. countSize takes the counter as an
   argument so the DOM half can hand in SillyTavern's if this build has one, and
   the screen simply omits the token line when it does not. */
export function countSize(text, tokenCounter) {
    const body = String(text ?? '');
    // Code points, not UTF-16 units: a surrogate pair is one character to a reader
    // and 'length' would call an emoji two.
    const chars = [...body].length;
    let tokens = null;
    if (typeof tokenCounter === 'function') {
        try {
            const n = tokenCounter(body);
            if (Number.isFinite(n) && n >= 0) tokens = Math.round(n);
        } catch { tokens = null; }
    }
    return { chars, tokens, bytes: new TextEncoder().encode(body).length };
}

/* ── Duplicate a persona (user request) ──────────────────────────────────────
   Copies OUR record only, onto an avatar id the caller supplies. Ids inside are
   regenerated so the two personas cannot share a section or variant id: version
   picks name variant ids, and a shared id would make one persona's version apply
   to the other's data. History is deliberately not copied , it is the record of
   what happened to THAT persona, and duplicating it would attribute edits to a
   persona that never had them. */
export function duplicatePersona(source, makeIdFn) {
    if (!source || typeof source !== 'object') return null;
    const idMap = new Map();
    const fresh = id => {
        if (!idMap.has(id)) idMap.set(id, makeId(makeIdFn));
        return idMap.get(id);
    };
    const copy = {
        sections: (source.sections ?? []).map(sec => ({ ...sec, id: fresh(sec.id) })),
        variants: {},
        versions: [],
        activeVersionId: null,
        activePicks: {},
        headingFormat: source.headingFormat ?? 'none',
        history: {},
        log: [],
        assets: {},
        assetFolderKey: null,
        lastComposed: '',
        tags: [...(source.tags ?? [])],
        names: { ...(source.names ?? {}) },
    };
    for (const [sectionId, list] of Object.entries(source.variants ?? {})) {
        copy.variants[fresh(sectionId)] = (list ?? []).map(v => ({ ...v, id: fresh(v.id) }));
    }
    for (const [sectionId, variantId] of Object.entries(source.activePicks ?? {})) {
        copy.activePicks[fresh(sectionId)] = fresh(variantId);
    }
    for (const version of source.versions ?? []) {
        const picks = {};
        for (const [sectionId, variantId] of Object.entries(version.picks ?? {})) {
            picks[fresh(sectionId)] = fresh(variantId);
        }
        const next = { ...version, id: makeId(makeIdFn), picks, tags: [...(version.tags ?? [])] };
        // Asset selections name files in a folder the copy does not own yet.
        next.assetSelection = null;
        copy.versions.push(next);
        if (source.activeVersionId === version.id) copy.activeVersionId = next.id;
    }
    return copy;
}

export function addTag(owner, tag) {
    if (!owner || typeof owner !== 'object') return null;
    const trimmed = String(tag ?? '').trim();
    if (!trimmed) return null;
    if (!Array.isArray(owner.tags)) owner.tags = [];
    if (owner.tags.includes(trimmed)) return null;
    owner.tags.push(trimmed);
    return trimmed;
}

export function removeTag(owner, tag) {
    if (!Array.isArray(owner?.tags)) return false;
    const index = owner.tags.indexOf(tag);
    if (index === -1) return false;
    owner.tags.splice(index, 1);
    return true;
}

/* 기본 항목 채우기 */

// Space-insensitive name identity, plus the aliases that map the pre-28 default
// names onto their successors, so filling cannot create a 기본 정보 next to an
// old 기본정보 or an 외모 next to an 외형.
const SECTION_NAME_ALIASES = Object.freeze({ '외형': '외모', '기본정보': '기본 정보' });

function sectionNameKey(name) {
    const flat = String(name ?? '').replace(/\s+/g, '');
    const alias = SECTION_NAME_ALIASES[flat];
    return (alias ?? flat).replace(/\s+/g, '');
}

// What [기본 항목 채우기] would add, so the confirmation can name the count
// before anything is written.
export function missingDefaultSections(persona) {
    const have = new Set((persona?.sections ?? []).map(section => sectionNameKey(section.name)));
    return DEFAULT_SECTION_NAMES.filter(name => !have.has(sectionNameKey(name)));
}

// Appends every default section the persona does not already have, each with
// one empty 기본 choice picked, and says what it added. Empty bodies never
// reach the prompt (compose skips them), so this changes nothing the model
// sees until the user writes into a new section.
export function fillDefaultSections(persona, makeIdFn, now) {
    if (!persona) return [];
    const added = [];
    for (const name of missingDefaultSections(persona)) {
        const sectionId = makeId(makeIdFn);
        const variantId = makeId(makeIdFn);
        if (!Array.isArray(persona.sections)) persona.sections = [];
        if (!persona.variants) persona.variants = {};
        if (!persona.activePicks) persona.activePicks = {};
        persona.sections.push({ id: sectionId, name });
        persona.variants[sectionId] = [{ id: variantId, label: STRINGS.manager.defaultChoiceLabel, text: '', updatedAt: now }];
        persona.activePicks[sectionId] = variantId;
        addLog(persona, 'section-add', name, now);
        added.push(name);
    }
    return added;
}

/* Per version asset selection */

// null means 전체, which is not the same as a list naming every file: a file
// uploaded tomorrow is included by null and excluded by the list. So the list is
// only materialised when the user actually removes something, and it collapses
// back to null the moment nothing is excluded any more.
//
// The full file list is a parameter because null cannot be turned into "all but
// this one" without knowing what all is. Passing what the screen is showing keeps
// the decision in one place.
export function assetSelected(version, filename) {
    const selection = version?.assetSelection;
    if (!Array.isArray(selection)) return true;
    return selection.includes(filename);
}

export function toggleAssetSelection(version, filename, allFilenames = []) {
    if (!version) return null;
    const all = [];
    for (const name of allFilenames ?? []) {
        if (typeof name === 'string' && !all.includes(name)) all.push(name);
    }
    const current = Array.isArray(version.assetSelection) ? version.assetSelection : null;

    let next;
    if (current === null) {
        // Was 전체. The only thing a tap can mean here is "not this one".
        next = all.filter(name => name !== filename);
    } else if (current.includes(filename)) {
        next = current.filter(name => name !== filename);
    } else {
        // Kept in the order the folder lists them, so the stored array reads the
        // same way the screen does however the boxes were ticked.
        next = all.filter(name => current.includes(name) || name === filename);
        if (!all.includes(filename)) next.push(filename);
    }

    // Nothing excluded any more, so say 전체 rather than freezing today's folder
    // contents into the version.
    if (all.length && next.length === all.length && all.every(name => next.includes(name))) {
        version.assetSelection = null;
        return null;
    }
    version.assetSelection = next;
    return next;
}

/* Asset tags */

// The folder qualified form, always. The bare form resolves against whoever is
// active when the message is rendered, so a message written today would show a
// different persona's picture tomorrow.
export function insertTagText(folderKey, filename) {
    return `{{pimg::${String(folderKey ?? '')}/${String(filename ?? '')}}}`;
}

// What a textarea should hold after inserting text at the caret, and where the
// caret then belongs. Kept pure so the send box path is testable without a DOM;
// a selection is replaced, and a caret we were given nothing usable for puts the
// text at the end rather than silently at position zero.
export function insertAtCursor(value, start, end, text) {
    const source = String(value ?? '');
    const insert = String(text ?? '');
    const from = Number.isInteger(start) && start >= 0 ? Math.min(start, source.length) : source.length;
    const to = Number.isInteger(end) && end >= from ? Math.min(end, source.length) : from;
    return { value: source.slice(0, from) + insert + source.slice(to), caret: from + insert.length };
}
