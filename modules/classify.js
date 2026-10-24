// 가져오기 자동 분류 (user request, 2026-10-24).
//
// 관리 시작 used to put the whole existing description into the first item's first
// choice, so a description already written in parts - 외모, 성격, 말투, each under
// its own title - arrived as one block the user had to cut apart by hand. This reads
// the title lines, matches each title to an item by its name, and puts each part
// into that item. Pure: no document, no context, so the node suite runs it as is.
import { makeId } from './store.js';
import { STRINGS } from './strings.js';

/* What counts as a title line. Each form is one that a description written by hand
   or by a template actually uses, and each is a whole line on its own, so a sentence
   that merely contains a colon is never taken for a title:

     ## 외모   # 외모 ###            (markdown; a space after the marks, so a line of
                                    #해시태그 stays content; only the top level used
                                    in the text splits, deeper ones stay inside)
     [외모]  【외모】  〔외모〕        (brackets)
     **외모**  **외모:**  <외모>      (only when the name is an item's: a bold
                                    sentence and an HTML tag on its own line are
                                    content)
     외모:   외모 :   외모：          (only when the name is an item's: 나이: or
                                    특징: over a list of lines is content)

   A line of the form 외모: 검은 머리 is a title only when 외모 names an item: the
   same shape is how 나이: 27 is written, and that one is content. */
const TITLE_MAX = 30;
const STANDALONE = [
    { kind: 'markdown', re: /^(#{1,6})\s+(.+?)\s*#*$/ },
    { kind: 'bracket', re: /^()\[\s*(.+?)\s*\]$/ },
    { kind: 'bracket', re: /^()【\s*(.+?)\s*】$/ },
    { kind: 'bracket', re: /^()〔\s*(.+?)\s*〕$/ },
    { kind: 'bold', re: /^()\*\*\s*(.+?)\s*[:：]?\s*\*\*\s*[:：]?$/ },
    { kind: 'angle', re: /^()<\s*([^<>/=]+?)\s*>$/ },
    { kind: 'plain', re: /^()([^:：]{1,30}?)\s*[:：]$/ },
];
// Forms that are a title only when the name is an item's.
const NEEDS_MATCH = new Set(['bold', 'angle', 'plain']);
const INLINE = /^([^:：]{1,30}?)\s*[:：]\s*(\S.*)$/;

// Spaces, case and the joining marks a title is written with do not make two
// names different: 버릇 & 습관, 버릇&습관, 버릇/습관 and 버릇·습관 are one item.
export function normalizeTitle(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[\s&/·・,，+_\-–—()（）]+/g, '');
}

/* Other names for the shipped items, for descriptions written in English or with a
   neighbouring Korean word (strings.js, classify.titleAliases). Only the shipped
   names have them: an item the user named themselves is matched by its own name
   and nothing else. */
const ALIASES = STRINGS.classify.titleAliases;

// Every key a title may arrive as, for each item index. The item's own name, each
// part of a name joined by &, and the aliases of a shipped name.
function keysFor(names) {
    return names.map(name => {
        const keys = new Set([normalizeTitle(name)]);
        for (const part of String(name ?? '').split(/[&/·]/)) {
            const key = normalizeTitle(part);
            if (key) keys.add(key);
        }
        for (const alias of ALIASES[name] ?? []) keys.add(normalizeTitle(alias));
        keys.delete('');
        return keys;
    });
}

// The item a title belongs to, or -1. The whole name wins over a part or an alias,
// so an item literally called 말투 is not lost to 말투 & 대사.
function matchKey(key, names, keys) {
    if (!key) return -1;
    const exact = names.findIndex(name => normalizeTitle(name) === key);
    if (exact !== -1) return exact;
    return keys.findIndex(set => set.has(key));
}

// A number in front (1. 외모, 2) 성격) and a gloss in brackets behind (외모
// (Appearance)) do not change which item a title names. The title as written
// is tried first, so an item whose own name carries brackets still matches.
function matchTitle(title, names, keys) {
    const whole = matchKey(normalizeTitle(title), names, keys);
    if (whole !== -1) return whole;
    const bare = String(title ?? '')
        .replace(/^\s*\d{1,3}\s*[.)．]\s*/, '')
        .replace(/\s*[(（\[][^)）\]]*[)）\]]\s*$/, '');
    return matchKey(normalizeTitle(bare), names, keys);
}

/* Splits a description at its title lines.

   Answers null when there is nothing to split: no title at all, or every title
   lands in the home item (the first one, for 관리 시작, where the whole text would
   have gone anyway). In both cases 관리 시작 keeps the old behaviour exactly, byte
   for byte. home is the item the text is in now, for 제목별 분류 on an item that
   is not the first.

   Otherwise: { preamble, parts: [{ title, index, body }], format }. index is the
   matched item or -1 for a title no item has; preamble is whatever came before the
   first title. format is the heading style the titles were written in, so the
   composed description keeps them: 'markdown', 'plain', or null when they were
   mixed or a style compose cannot write. */
export function splitDescription(text, sectionNames, home = 0) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    const names = Array.isArray(sectionNames) ? sectionNames : [];
    const keys = keysFor(names);
    const lines = source.split('\n');
    // First pass: what each line would be as a title, before deciding which ones are.
    const found = lines.map(raw => {
        const line = raw.trim();
        if (!line) return null;
        for (const form of STANDALONE) {
            const m = form.re.exec(line);
            if (!m) continue;
            const title = m[2].trim();
            if (!title || title.length > TITLE_MAX) break;
            const index = matchTitle(title, names, keys);
            if (NEEDS_MATCH.has(form.kind) && index === -1) break;
            // [나이: 27], [Age: 27], [{{user}}: tall, shy]: a bracketed fact, not a
            // title. Only an item's own name may carry these marks and still split.
            if (form.kind === 'bracket' && index === -1 && /[:：,，]|\{\{/.test(title)) break;
            return { kind: form.kind, level: m[1].length, title, index, rest: null };
        }
        const m = INLINE.exec(line);
        if (m) {
            const index = matchTitle(m[1], names, keys);
            if (index !== -1) return { kind: 'inline', level: 0, title: m[1].trim(), index, rest: m[2] };
        }
        return null;
    });
    /* The level that splits is the shallowest one whose titles name items. The
       shallowest level of all was the rule, and a description that opens with
       # 아영 over ## 외모 and ## 성격 became one new item called 아영 holding
       everything. A text whose markdown titles name no item at all falls back to
       its shallowest level, which becomes new items as before. */
    const levels = found.filter(f => f?.kind === 'markdown').map(f => f.level);
    const named = found.filter(f => f?.kind === 'markdown' && f.index !== -1).map(f => f.level);
    const top = named.length ? Math.min(...named) : (levels.length ? Math.min(...levels) : 0);
    const parts = [];
    const preamble = [];
    const kinds = new Set();
    let current = null;
    found.forEach((title, i) => {
        // </외모> after <외모>: the closing half of the title, not content.
        const close = /^<\/\s*([^<>]+?)\s*>$/.exec(lines[i].trim());
        if (close && current && normalizeTitle(close[1]) === normalizeTitle(current.title)) return;
        if (!title || (title.kind === 'markdown' && title.level !== top)) {
            (current ? current.lines : preamble).push(lines[i]);
            return;
        }
        current = { title: title.title, index: title.index, kind: title.kind, raw: lines[i],
            lines: title.rest !== null ? [title.rest] : [] };
        parts.push(current);
    });
    /* A title no item has, with nothing under it, would become an empty new item
       and take its own line with it: [나이] directly over [성별] lost the first
       line for good. Such a line stays where it was, as text of what came before. */
    const kept = [];
    for (const part of parts) {
        if (part.index === -1 && !part.lines.join('\n').trim()) {
            (kept.length ? kept[kept.length - 1].lines : preamble).push(part.raw, ...part.lines);
            continue;
        }
        kept.push(part);
        kinds.add(part.kind);
    }
    if (!kept.length) return null;
    const out = kept.map(part => ({ title: part.title, index: part.index, body: part.lines.join('\n').trim() }));
    // Nothing with a body leaves the home item: the old behaviour already put
    // all of it there, and keeps the text exactly as written.
    if (!out.some(part => part.body && part.index !== home)) return null;
    let format = null;
    if (kinds.size === 1 && kinds.has('markdown')) format = 'markdown';
    else if ([...kinds].every(kind => kind === 'plain' || kind === 'inline')) format = 'plain';
    return { preamble: preamble.join('\n').trim(), parts: out, format };
}

/* Fills a persona made by makeDefaultPersona from a split. Answers how many items
   received text.

   - The text before the first title goes to the first item, ahead of anything a
     title also sent there.
   - Two titles naming one item are joined in the order they were written.
   - A title no item has becomes a new item of that name, at the end: it is
     structure the user wrote, and folding it into a neighbour would hide it.
   - A part with a title and no body leaves its item empty.

   The heading format follows what the titles were written in when compose can
   write that style; otherwise it is the user's default, or plain when that default
   is none - dropping the titles altogether would take the item names out of the
   prompt the model reads. */
export function seedFromSplit(persona, split, makeIdFn, defaultFormat) {
    const bodies = new Map();
    const add = (index, body) => {
        if (!body) return;
        bodies.set(index, bodies.has(index) ? `${bodies.get(index)}\n\n${body}` : body);
    };
    add(0, split.preamble);
    const created = new Map();
    for (const part of split.parts) {
        let index = part.index;
        if (index === -1) {
            if (!part.body) continue;
            const key = normalizeTitle(part.title);
            if (!created.has(key)) {
                const sid = makeId(makeIdFn);
                const vid = makeId(makeIdFn);
                persona.sections.push({ id: sid, name: part.title });
                persona.variants[sid] = [{ id: vid, label: STRINGS.manager.defaultChoiceLabel, text: '', updatedAt: 0 }];
                persona.activePicks[sid] = vid;
                created.set(key, persona.sections.length - 1);
            }
            index = created.get(key);
        }
        add(index, part.body);
    }
    for (const [index, body] of bodies) {
        const section = persona.sections[index];
        const variant = persona.variants?.[section?.id]?.[0];
        if (variant) variant.text = body;
    }
    persona.headingFormat = split.format
        ?? (defaultFormat && defaultFormat !== 'none' ? defaultFormat : 'plain');
    return bodies.size;
}

// How many items carry text in the live combination: what a screen says after
// 관리 시작, so a split is visible as one sentence rather than discovered later.
export function itemsWithText(persona) {
    return (persona?.sections ?? []).filter(section => {
        const pick = persona.activePicks?.[section?.id];
        const variant = (persona.variants?.[section?.id] ?? []).find(entry => entry?.id === pick);
        return !!variant?.text?.trim();
    }).length;
}

/* ── 제목별 분류, for a persona already managed (user request) ───────────────
   Everyone adopted before the split existed has their whole description in
   기본 정보. This reads the live body of every item, and wherever titles in it
   name another item (or no item at all), plans to move those parts there.

   Nothing is lost and nothing leaves the prompt:
   - The source keeps its untitled opening and any part whose title names it.
   - A target that already has text gets the moved part AFTER its own text.
   - A target whose pick names nothing is pointed at its first choice, so the
     moved text reaches the prompt rather than landing in a body nobody reads.
   - A title no item has becomes a new item, as at 관리 시작.
   - Every body that changed gets a history snapshot of what it was. */
function liveVariant(persona, section) {
    const list = persona.variants?.[section?.id] ?? [];
    const pick = persona.activePicks?.[section?.id];
    return list.find(entry => entry?.id === pick) ?? null;
}

export function planResplit(persona) {
    const sections = Array.isArray(persona?.sections) ? persona.sections : [];
    const names = sections.map(section => section?.name ?? '');
    const sources = [];
    sections.forEach((section, index) => {
        const variant = liveVariant(persona, section);
        if (!variant?.text?.trim()) return;
        const split = splitDescription(variant.text, names, index);
        if (split) sources.push({ index, variantId: variant.id, split });
    });
    if (!sources.length) return null;
    const targets = new Set();
    const created = new Set();
    for (const source of sources) {
        for (const part of source.split.parts) {
            if (!part.body || part.index === source.index) continue;
            if (part.index === -1) created.add(normalizeTitle(part.title));
            else targets.add(part.index);
        }
    }
    return { sources, targets: targets.size, created: created.size };
}

// Applies a plan made on this same persona a moment ago (the caller plans again
// after its confirmation, so the plan never outlives the text it was read from).
// snapshotFn(variantId, previousText) is history.js's snapshot, handed in so this
// file stays free of the history settings. Answers the variant ids it changed.
export function applyResplit(persona, plan, makeIdFn, now, defaultFormat, snapshotFn) {
    const before = new Map();
    const touch = variant => {
        if (!before.has(variant.id)) before.set(variant.id, variant.text ?? '');
        variant.updatedAt = now;
    };
    const created = new Map();
    const appends = new Map();
    const pushTo = (index, body) => {
        if (!appends.has(index)) appends.set(index, []);
        appends.get(index).push(body);
    };
    for (const source of plan.sources) {
        const keep = [source.split.preamble];
        for (const part of source.split.parts) {
            if (!part.body) continue;
            if (part.index === source.index) { keep.push(part.body); continue; }
            let index = part.index;
            if (index === -1) {
                const key = normalizeTitle(part.title);
                if (!created.has(key)) {
                    const sid = makeId(makeIdFn);
                    const vid = makeId(makeIdFn);
                    persona.sections.push({ id: sid, name: part.title });
                    persona.variants[sid] = [{ id: vid, label: STRINGS.manager.defaultChoiceLabel, text: '', updatedAt: now }];
                    persona.activePicks[sid] = vid;
                    // Every saved version picks it too. Applying a version replaces
                    // the live picks with the version's, and a version with no pick
                    // for this item would drop the moved text out of the prompt.
                    for (const version of Array.isArray(persona.versions) ? persona.versions : []) {
                        if (version && typeof version === 'object') version.picks = { ...(version.picks ?? {}), [sid]: vid };
                    }
                    created.set(key, persona.sections.length - 1);
                }
                index = created.get(key);
            }
            pushTo(index, part.body);
        }
        const home = liveVariant(persona, persona.sections[source.index]);
        if (!home) continue;
        touch(home);
        home.text = keep.filter(Boolean).join('\n\n');
    }
    for (const [index, bodies] of appends) {
        const section = persona.sections[index];
        let target = liveVariant(persona, section);
        if (!target) {
            target = (persona.variants?.[section.id] ?? [])[0] ?? null;
            if (!target) {
                target = { id: makeId(makeIdFn), label: STRINGS.manager.defaultChoiceLabel, text: '', updatedAt: now };
                persona.variants[section.id] = [target];
            }
            persona.activePicks[section.id] = target.id;
        }
        touch(target);
        target.text = [String(target.text ?? '').trim(), ...bodies].filter(Boolean).join('\n\n');
    }
    // The titles were part of the text until now. Taken out of the bodies under a
    // heading format of none, the item names would vanish from the prompt.
    if (persona.headingFormat !== 'markdown' && persona.headingFormat !== 'plain') {
        const written = plan.sources.map(source => source.split.format).find(Boolean);
        persona.headingFormat = written ?? (defaultFormat && defaultFormat !== 'none' ? defaultFormat : 'plain');
    }
    for (const [variantId, text] of before) {
        if (text && typeof snapshotFn === 'function') snapshotFn(variantId, text);
    }
    return [...before.keys()];
}
