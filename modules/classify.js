// Splits a description at its title lines into items, matched by name. Pure: no
// document, no context, so the node suite runs it as is.
import { makeId, appendSection, liveVariant } from './store.js';
import { STRINGS } from './strings.js';

/* Title lines are whole lines: ## Name (a space after the marks, so #hashtag is content),
   [Name] and its CJK brackets, and, only when Name is an item's, bold, <Name>, Name:
   and the inline Name: text (the same shape as a fact such as Age: 27). */
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

// Spaces, case and joining marks do not make names differ: A & B, A&B, A/B and A·B match.
export function normalizeTitle(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[\s&/·・,，+_\-–—()（）]+/g, '');
}

// Aliases for the shipped item names only; a user-named item matches by its own name.
const ALIASES = STRINGS.classify.titleAliases;

// Per item: its name, each &-joined part of it, and a shipped name's aliases.
function keysFor(names) {
    return names.map(name => {
        const keys = new Set([normalizeTitle(name)]);
        for (const part of String(name ?? '').split(/[&/·]/)) {
            const key = normalizeTitle(part);
            if (key) keys.add(key);
        }
        // Own keys only: an item named constructor would read Object.prototype's.
        const aliases = Object.hasOwn(ALIASES, name) && Array.isArray(ALIASES[name]) ? ALIASES[name] : [];
        for (const alias of aliases) keys.add(normalizeTitle(alias));
        keys.delete('');
        return keys;
    });
}

// The item a title belongs to, or -1. A whole name beats a part or an alias, so an item
// called A is not lost to one called A & B.
function matchKey(key, names, keys) {
    if (!key) return -1;
    const exact = names.findIndex(name => normalizeTitle(name) === key);
    if (exact !== -1) return exact;
    return keys.findIndex(set => set.has(key));
}

// A leading number (1. Name) or trailing gloss (Name (Gloss)) does not change the match;
// the title as written is tried first, for names that carry brackets themselves.
function matchTitle(title, names, keys) {
    const whole = matchKey(normalizeTitle(title), names, keys);
    if (whole !== -1) return whole;
    const bare = String(title ?? '')
        .replace(/^\s*\d{1,3}\s*[.)．]\s*/, '')
        .replace(/\s*[(（\[][^)）\]]*[)）\]]\s*$/, '');
    return matchKey(normalizeTitle(bare), names, keys);
}

/* Answers null when no body would leave the home item (the item the text is in now),
   else { preamble, parts: [{ title, index (-1: no such item), body }], format }, format
   being 'markdown', 'plain', or null for mixed styles compose cannot write. */
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
            // [Age: 27] or [{{user}}: tall] is a bracketed fact, unless it names an item.
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
    // The shallowest markdown level whose titles name items splits (so a # Name over
    // item titles is not one big item); with none named, the shallowest level does.
    const levels = found.filter(f => f?.kind === 'markdown').map(f => f.level);
    const named = found.filter(f => f?.kind === 'markdown' && f.index !== -1).map(f => f.level);
    const top = named.length ? Math.min(...named) : (levels.length ? Math.min(...levels) : 0);
    const parts = [];
    const preamble = [];
    const kinds = new Set();
    let current = null;
    found.forEach((title, i) => {
        // </Name> after <Name>: the closing half of the title, not content.
        const close = /^<\/\s*([^<>]+?)\s*>$/.exec(lines[i].trim());
        if (close && current && normalizeTitle(close[1]) === normalizeTitle(current.title)) return;
        // When markdown titles name items, an inline Name: text line inside one is content.
        const contentLine = !title || (title.kind === 'markdown' && title.level !== top)
            || (named.length > 0 && current?.kind === 'markdown' && title.kind === 'inline');
        if (contentLine) {
            (current ? current.lines : preamble).push(lines[i]);
            return;
        }
        current = { title: title.title, index: title.index, kind: title.kind, raw: lines[i],
            lines: title.rest !== null ? [title.rest] : [] };
        parts.push(current);
    });
    // An unmatched title with nothing under it stays as text of what came before;
    // as an empty new item, its line would be lost.
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
    // Nothing with a body leaves the home item: keep the text exactly as written.
    if (!out.some(part => part.body && part.index !== home)) return null;
    let format = null;
    if (kinds.size === 1 && kinds.has('markdown')) format = 'markdown';
    else if ([...kinds].every(kind => kind === 'plain' || kind === 'inline')) format = 'plain';
    return { preamble: preamble.join('\n').trim(), parts: out, format };
}

/* Fills a makeDefaultPersona persona from a split; answers how many items got text.
   Unmatched titles become new items at the end. The heading format falls back to the
   default, or plain over none, as dropping titles would take item names out of the prompt. */
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
                appendSection(persona, { name: part.title }, makeIdFn, '', 0);
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

// How many items carry text in the live combination, reported after adopting.
export function itemsWithText(persona) {
    return (persona?.sections ?? []).filter(section => {
        return !!liveVariant(persona, section)?.text?.trim();
    }).length;
}

/* ── Split by title, for a persona already managed ──────────────────────────
   Moves titled parts of each live body to the items they name (or new ones). Nothing
   is lost or leaves the prompt: moved text is appended, a target with no live pick
   gets its first choice picked, and every changed body is snapshotted. */

// Removes an item's own title from the first line of its body; nothing else changes.
export function stripSelfTitle(text, name) {
    const source = String(text ?? '');
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const first = lines.findIndex(line => line.trim());
    if (first === -1) return source;
    const line = lines[first].trim();
    const wanted = normalizeTitle(name);
    if (!wanted) return source;
    for (const form of STANDALONE) {
        const m = form.re.exec(line);
        if (!m) continue;
        if (normalizeTitle(m[2]) !== wanted) return source;
        return lines.slice(first + 1).join('\n').replace(/^\s*\n/, '');
    }
    return source;
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

// Applies a fresh plan (callers re-plan after confirming). snapshotFn is history.js's
// snapshot, passed in to keep history settings out of here. Returns changed variant ids.
export function applyResplit(persona, plan, makeIdFn, now, defaultFormat, snapshotFn) {
    const before = new Map();
    const touch = variant => {
        if (!before.has(variant.id)) before.set(variant.id, variant.text ?? '');
        variant.updatedAt = now;
    };
    const created = new Map();
    const appends = new Map();
    const pushTo = (index, body, source) => {
        if (!appends.has(index)) appends.set(index, []);
        appends.get(index).push({ body, source });
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
                    const { sectionId, variantId } = appendSection(persona, { name: part.title }, makeIdFn, '', now);
                    // Every saved version picks it too, or applying one would drop
                    // the moved text from the prompt.
                    for (const version of Array.isArray(persona.versions) ? persona.versions : []) {
                        if (version && typeof version === 'object') version.picks = { ...(version.picks ?? {}), [sectionId]: variantId };
                    }
                    created.set(key, persona.sections.length - 1);
                }
                index = created.get(key);
            }
            pushTo(index, part.body, source);
        }
        const home = liveVariant(persona, persona.sections[source.index]);
        if (!home) continue;
        touch(home);
        home.text = keep.filter(Boolean).join('\n\n');
    }
    const versions = Array.isArray(persona.versions) ? persona.versions : [];
    for (const [index, moved] of appends) {
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
        target.text = [String(target.text ?? '').trim(), ...moved.map(m => m.body)].filter(Boolean).join('\n\n');
        // A saved version picking the source body lost the moved text too: add it to
        // that version's own pick for this item, if different.
        const extra = new Map();
        for (const { body, source } of moved) {
            const sourceId = persona.sections[source.index]?.id;
            for (const version of versions) {
                if (!version?.picks || version.picks[sourceId] !== source.variantId) continue;
                const pickId = version.picks[section.id];
                if (!pickId || pickId === target.id) continue;
                if (!extra.has(pickId)) extra.set(pickId, []);
                if (!extra.get(pickId).includes(body)) extra.get(pickId).push(body);
            }
        }
        for (const [pickId, bodies] of extra) {
            const variant = (persona.variants?.[section.id] ?? []).find(entry => entry?.id === pickId);
            if (!variant) continue;
            touch(variant);
            variant.text = [String(variant.text ?? '').trim(), ...bodies].filter(Boolean).join('\n\n');
        }
    }
    // Titles leave the bodies, so a format of none would drop item names from the prompt.
    if (persona.headingFormat !== 'markdown' && persona.headingFormat !== 'plain' && persona.headingFormat !== 'own') {
        const written = plan.sources.map(source => source.split.format).find(Boolean);
        persona.headingFormat = written ?? (defaultFormat && defaultFormat !== 'none' ? defaultFormat : 'plain');
        // A body starting with its own title would print it twice; compose writes it now.
        for (const section of persona.sections) {
            for (const variant of persona.variants?.[section.id] ?? []) {
                if (typeof variant?.text !== 'string') continue;
                const stripped = stripSelfTitle(variant.text, section.name);
                if (stripped === variant.text) continue;
                touch(variant);
                variant.text = stripped;
            }
        }
    }
    for (const [variantId, text] of before) {
        if (text && typeof snapshotFn === 'function') snapshotFn(variantId, text);
    }
    return [...before.keys()];
}

/* ── A description's own division ──────────────────────────────────────────
   Its own titles become the items, as written and in order. Only the first style in
   OWN_ORDER used at least twice counts (markdown at its shallowest such level).
   Returns null or { preamble, parts, template }; callers require a round trip (sameText). */
const OWN_FORMS = [
    { kind: 'markdown', re: /^(#{1,6})\s+(.+?)\s*$/ },
    { kind: 'angle', re: /^()<\s*([^<>/=]+?)\s*>$/ },
    { kind: 'bracket', re: /^()\[\s*([^\][:：,，{}]+?)\s*\]$/ },
    { kind: 'bracket', re: /^()【\s*(.+?)\s*】$/ },
    { kind: 'bold', re: /^()\*\*\s*([^*:：]+?)\s*[:：]?\s*\*\*$/ },
    { kind: 'plain', re: /^()([^:：#*\[\]<>]{1,30}?)\s*[:：]$/ },
];
const OWN_ORDER = ['markdown', 'angle', 'bracket', 'bold', 'plain'];

function ownTitle(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    for (const form of OWN_FORMS) {
        const m = form.re.exec(trimmed);
        if (!m) continue;
        const name = m[2].trim();
        if (!name || name.length > TITLE_MAX) return null;
        return { kind: form.kind, level: m[1].length, name, raw: trimmed };
    }
    return null;
}

export function splitOwnSections(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const titles = lines.map(ownTitle);
    const closes = lines.map(line => /^<\/\s*([^<>]+?)\s*>$/.exec(line.trim())?.[1]?.trim() ?? null);
    const isTitle = (title, kind, level) => !!title && title.kind === kind && (kind !== 'markdown' || title.level === level);
    let chosen = null;
    for (const kind of OWN_ORDER) {
        if (kind === 'markdown') {
            const levels = [...new Set(titles.filter(t => t?.kind === 'markdown').map(t => t.level))].sort((a, b) => a - b);
            const level = levels.find(l => titles.filter(t => isTitle(t, 'markdown', l)).length >= 2);
            if (level) { chosen = { kind, level }; break; }
            continue;
        }
        let count = titles.filter(t => isTitle(t, kind)).length;
        // An opening tag counts only when its closing tag follows.
        if (kind === 'angle') {
            count = titles.filter((t, i) => isTitle(t, 'angle') && closes.slice(i + 1).includes(t.name)).length;
        }
        if (count >= 2) { chosen = { kind }; break; }
    }
    if (!chosen) return null;

    const preamble = [];
    const parts = [];
    let current = null;
    lines.forEach((line, i) => {
        const title = titles[i];
        if (isTitle(title, chosen.kind, chosen.level)) {
            current = { name: title.name, raw: title.raw, lines: [], closed: false, closeRaw: null };
            parts.push(current);
            return;
        }
        if (current && !current.closed && chosen.kind === 'angle' && closes[i] === current.name) {
            current.closed = true;
            current.closeRaw = line.trim();
            return;
        }
        (current ? current.lines : preamble).push(line);
    });
    // The pattern is read off the first title, with its name taken out.
    const first = parts[0];
    const template = {
        open: first.raw.replace(first.name, '{name}'),
        close: first.closeRaw ? first.closeRaw.replace(first.name, '{name}') : '',
    };
    return {
        preamble: preamble.join('\n').trim(),
        parts: parts.map(part => ({ name: part.name, body: part.lines.join('\n').trim() })),
        template,
    };
}

// Replaces the persona's items with the description's own, one picked choice each; text
// before the first title becomes an untitled first item.
export function seedOwnSections(persona, split, makeIdFn, now = Date.now()) {
    persona.sections = [];
    persona.variants = {};
    persona.activePicks = {};
    if (split.preamble) appendSection(persona, { name: STRINGS.classify.preambleName, untitled: true }, makeIdFn, split.preamble, now);
    for (const part of split.parts) appendSection(persona, { name: part.name }, makeIdFn, part.body, now);
    persona.headingFormat = 'own';
    persona.headingTemplate = { open: split.template.open, close: split.template.close ?? '' };
    return persona.sections.length;
}

// Line-for-line equality ignoring blank lines and trailing spaces, which the prompt does
// not care about and the composer normalises anyway.
export function sameText(a, b) {
    const lines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
        .map(line => line.replace(/[ \t]+$/, '')).filter(line => line.trim() !== '');
    const left = lines(a);
    const right = lines(b);
    return left.length === right.length && left.every((line, i) => line === right[i]);
}
