// Composes items into one description and writes it into SillyTavern. The prompt reads only the
// singular persona_description, so for the active persona both it and the persona_descriptions map
// are written.
import { textSignature, liveVariant, linesOf } from './store.js';

// The fingerprint compared against; a pre-schema-2 lastComposed copy is read until migrated.
export function baselineSignature(persona) {
    if (typeof persona?.composedSig === 'string') return persona.composedSig;
    if (typeof persona?.lastComposed === 'string') return textSignature(persona.lastComposed);
    return textSignature('');
}

export function markComposed(persona, text) {
    persona.composedSig = textSignature(text);
    delete persona.lastComposed;
}

/* The 'own' format keeps an adopted description's title pattern: template.open is the title line
   with {name} (### {name}), template.close an optional closing line. An unreadable template
   prints the markdown title, never nothing. */
export function validTemplate(template) {
    return !!template && typeof template.open === 'string' && template.open.includes('{name}')
        && (template.close === undefined || typeof template.close === 'string');
}

const fill = (pattern, name) => String(pattern ?? '').split('{name}').join(name);

// Whether a line is the wanted title line, trailing spaces aside.
const sameLine = (line, wanted) => !!wanted && line.replace(/[ \t]+$/, '') === wanted;

// Items printed without a title line: an own-format preamble or the whole-text item.
export function untitledIds(persona) {
    return new Set((persona?.sections ?? []).filter(section => section?.untitled === true).map(section => section.id));
}

// The title line for a section, or '' when the format adds none. Exported so screens
// showing the composed text share the prompt's rule.
export function headingLine(format, name, template) {
    if (format === 'plain') return `${name}:`;
    if (format === 'markdown') return `## ${name}`;
    if (format === 'own') return validTemplate(template) ? fill(template.open, name) : `## ${name}`;
    return '';
}

// The line that closes a block, for the own format only.
function closingLine(format, name, template) {
    if (format !== 'own' || !validTemplate(template) || !template.close) return '';
    return fill(template.close, name);
}

// The one join rule for every renderer and the write. An empty body contributes nothing,
// heading included; an untitled part (text before the first own-format title) prints alone.
function joinBlocks(persona, parts) {
    const format = persona?.headingFormat;
    const template = persona?.headingTemplate;
    const out = [];
    for (const part of parts) {
        const body = (part?.text ?? '').trim();
        if (!body) continue;
        const name = part?.name ?? '';
        const head = part?.untitled ? '' : headingLine(format, name, template);
        const close = part?.untitled ? '' : closingLine(format, name, template);
        out.push([head, body, close].filter(Boolean).join('\n'));
    }
    return out.join('\n\n');
}

// SillyTavern's prompt placement on persona_descriptions[avatar]. Position is its enum, kept as an
// opaque number: a mismatched label is visible, an invented mapping would silently move the
// description in the prompt.
export function readPlacement(ctx, avatarId) {
    const d = ctx?.powerUserSettings?.persona_descriptions?.[avatarId];
    if (!d) return null;
    return {
        position: d.position ?? null,
        depth: typeof d.depth === 'number' ? d.depth : null,
        role: d.role ?? null,
        lorebook: d.lorebook ?? '',
    };
}

// Writes only the keys given, plus the active persona's singular mirrors. activeAvatar
// comes from state.js (a name lookup can miss); omitted, only the map entry is written.
export function writePlacement(ctx, avatarId, patch, activeAvatar = null) {
    const pu = ctx?.powerUserSettings;
    if (!pu) return false;
    const d = pu.persona_descriptions?.[avatarId];
    if (!d) return false;
    const active = !!avatarId && avatarId === activeAvatar;
    // World info reads the singular lorebook key too, which SillyTavern mirrors the same way.
    for (const key of ['position', 'depth', 'role', 'lorebook']) {
        if (!Object.hasOwn(patch, key)) continue;
        d[key] = patch[key];
        if (active) pu[`persona_description_${key}`] = patch[key];
    }
    return true;
}

export function compose(persona) {
    return composePicked(persona, persona?.activePicks);
}

/* An outside edit divided back into its items: joinBlocks reversed over the live picks.
   Returns [{ sectionId, text }] when every printed item's title (and closing) line is still
   there in order, else null. A title added in SillyTavern stays in the body above it. */
export function splitByComposition(persona, text) {
    const format = persona?.headingFormat;
    const template = persona?.headingTemplate;
    const blocks = [];
    for (const section of persona?.sections ?? []) {
        const variant = liveVariant(persona, section);
        if (!variant || !String(variant.text ?? '').trim()) continue;
        const untitled = section.untitled === true;
        blocks.push({
            sectionId: section.id,
            head: untitled ? '' : headingLine(format, section.name ?? '', template),
            close: untitled ? '' : closingLine(format, section.name ?? '', template),
        });
    }
    if (!blocks.length) return null;
    const lines = linesOf(text);
    // Each block's title line; an untitled block can only be the first.
    const starts = [];
    let cursor = 0;
    for (const [index, block] of blocks.entries()) {
        if (!block.head) {
            if (index !== 0) return null;
            starts.push(-1);
            continue;
        }
        let at = cursor;
        while (at < lines.length && !sameLine(lines[at], block.head)) at++;
        if (at >= lines.length) return null;
        starts.push(at);
        cursor = at + 1;
    }
    const out = [];
    for (const [index, block] of blocks.entries()) {
        const from = starts[index] + 1;
        const to = index + 1 < blocks.length ? starts[index + 1] : lines.length;
        let body = lines.slice(from, to);
        if (block.close) {
            const last = body.map(line => line.trim()).lastIndexOf(block.close.trim());
            if (last === -1 || body.slice(last + 1).some(line => line.trim())) return null;
            body = body.slice(0, last);
        }
        out.push({ sectionId: block.sectionId, text: body.join('\n').trim() });
    }
    // Text in front of the first title belongs to nobody unless an untitled
    // block starts at the top.
    if (starts[0] > 0 && lines.slice(0, starts[0]).some(line => line.trim())) return null;
    return out;
}

// The own-format closing line at the very end, stripped like the leading heading.
function stripTrailingLine(text, closing) {
    const source = String(text ?? '');
    if (!closing) return source;
    const trimmed = source.replace(/\s+$/, '');
    if (!trimmed.endsWith(closing)) return source;
    const rest = trimmed.slice(0, -closing.length);
    if (rest && !/\n[ \t]*$/.test(rest)) return source;
    return rest.replace(/\s+$/, '');
}

function stripLeadingHeading(text, heading) {
    const source = String(text ?? '');
    if (!heading) return source;
    const trimmed = source.replace(/^\s+/, '');
    if (!trimmed.startsWith(heading)) return source;
    const rest = trimmed.slice(heading.length);
    // Whole lines only, so a heading never eats the start of text beginning with it.
    if (rest && !/^[ \t]*(\r?\n|$)/.test(rest)) return source;
    return rest.replace(/^[ \t]*\r?\n/, '');
}

/* An outside edit (SillyTavern's own persona box) mapped back onto the items without changing
   anything: { ok: true, writes: [{ sectionId, text }] } or { ok: false, reason }. Several filled
   items split along the composed title lines, refused when one is missing or out of order
   ('noMatch') or none are printed ('noTitles'); otherwise it all goes to the filled item, or the
   first, its own title stripped. */
export function planAbsorb(persona, text) {
    const sections = persona?.sections ?? [];
    const filled = sections.filter(section => !!(liveVariant(persona, section)?.text ?? '').trim());
    if (filled.length > 1) {
        if (!headingLine(persona.headingFormat, 'x', persona.headingTemplate)) return { ok: false, reason: 'noTitles' };
        const parts = splitByComposition(persona, text);
        if (!parts) return { ok: false, reason: 'noMatch' };
        return { ok: true, writes: parts.map(part => ({ sectionId: part.sectionId, text: part.text })) };
    }
    const target = filled[0] ?? sections[0] ?? null;
    if (!target || !liveVariant(persona, target)) return { ok: false, reason: 'noItem' };
    const format = persona.headingFormat;
    const name = target.name ?? '';
    const body = target.untitled ? String(text ?? '') : stripTrailingLine(
        stripLeadingHeading(text, headingLine(format, name, persona.headingTemplate)),
        closingLine(format, name, persona.headingTemplate));
    return { ok: true, writes: [{ sectionId: target.id, text: body }] };
}

/* Whether the full-text screen's joined view can be divided back: every block after the first
   needs a title line to be found by. */
export function fullTextSplittable(persona, blocks) {
    const untitled = untitledIds(persona);
    return (blocks ?? []).every((block, index) => index === 0
        || (!untitled.has(block?.sectionId) && !!headingLine(persona?.headingFormat, block?.sectionName ?? '', persona?.headingTemplate)));
}

/* The joined view, edited, divided back into its blocks (buildReplaceBlocks', empty bodies
   included). current holds the working texts the view was joined from: a block printed there must
   keep its title line; an empty one is filled only if its title line is typed in, in item order.
   Untouched blocks keep their text. Answers { ok: true, texts } or
   { ok: false, reason: 'missing'|'order'|'stray', name }. */
export function splitFullText(persona, blocks, text, current) {
    const format = persona?.headingFormat;
    const template = persona?.headingTemplate;
    const untitled = untitledIds(persona);
    const list = (blocks ?? []).map((block, index) => {
        const name = block?.sectionName ?? '';
        const bare = untitled.has(block?.sectionId);
        const body = typeof current?.[index] === 'string' ? current[index] : (block?.text ?? '');
        return {
            name,
            head: bare ? '' : headingLine(format, name, template),
            close: bare ? '' : closingLine(format, name, template),
            required: !!body.trim(),
        };
    });
    if (!list.length) return { ok: true, texts: [] };
    // Everything cleared, titles included: every item is emptied.
    if (!String(text ?? '').trim()) return { ok: true, texts: list.map(() => '') };
    // A block with no title line can only be the first, holding the text above every title.
    const headless = list.find((block, index) => index > 0 && !block.head);
    if (headless) return { ok: false, reason: 'missing', name: headless.name };
    const lines = linesOf(text);
    const starts = list.map(() => -1);
    let last = -1;
    for (const [at, line] of lines.entries()) {
        const next = list.findIndex((block, index) => index > last && sameLine(line, block.head));
        if (next === -1) {
            // A title already passed, seen again: moved or doubled, so the division is unsure.
            const back = list.findIndex((block, index) => index <= last && sameLine(line, block.head));
            if (back !== -1) return { ok: false, reason: 'order', name: list[back].name };
            continue;
        }
        const skipped = list.slice(last + 1, next).find(block => block.required && block.head);
        if (skipped) return { ok: false, reason: 'missing', name: skipped.name };
        starts[next] = at;
        last = next;
    }
    const lost = list.find((block, index) => index > last && block.required && block.head);
    if (lost) return { ok: false, reason: 'missing', name: lost.name };
    const firstTitle = starts.find(at => at !== -1) ?? lines.length;
    const above = lines.slice(0, firstTitle).join('\n').trim();
    if (above && list[0].head) return { ok: false, reason: 'stray', name: '' };
    const texts = list.map((block, index) => {
        if (index === 0 && !block.head) return above;
        if (starts[index] === -1) return typeof current?.[index] === 'string' ? current[index] : (blocks[index]?.text ?? '');
        const following = starts.slice(index + 1).find(at => at !== -1) ?? lines.length;
        let body = lines.slice(starts[index] + 1, following);
        if (block.close) {
            // A removed closing line costs nothing: the next title still ends the block.
            const end = body.map(line => line.trim()).lastIndexOf(block.close.trim());
            if (end !== -1 && !body.slice(end + 1).some(line => line.trim())) body = body.slice(0, end);
        }
        return body.join('\n').trim();
    });
    return { ok: true, texts };
}

// Composition over any pick set, e.g. a version's own picks rather than the live ones.
export function composePicked(persona, picks) {
    const parts = [];
    const missing = [];
    for (const section of persona?.sections ?? []) {
        const pick = picks?.[section.id];
        const variant = (persona.variants?.[section.id] ?? []).find(v => v.id === pick);
        if (!variant) { missing.push(section.name); continue; }
        parts.push({ name: section.name, text: variant.text ?? '', untitled: section.untitled === true });
    }
    return { text: joinBlocks(persona, parts), missing };
}

// Composition over an editing screen's unsaved working copies: blocks from
// buildReplaceBlocks, texts index-aligned (missing = stored text).
export function composeFrom(persona, blocks, texts) {
    const untitled = untitledIds(persona);
    const parts = (blocks ?? []).map((block, index) => ({
        name: block?.sectionName ?? '',
        text: typeof texts?.[index] === 'string' ? texts[index] : (block?.text ?? ''),
        untitled: untitled.has(block?.sectionId),
    }));
    return joinBlocks(persona, parts);
}

function ensureDescriptor(pu, avatarId) {
    if (!pu.persona_descriptions) pu.persona_descriptions = {};
    let descriptor = pu.persona_descriptions[avatarId];
    if (!descriptor) {
        // No invented values: SillyTavern falls back to its defaults for missing
        // position, depth and role. The active settings are mirrored when present.
        descriptor = { description: '', lorebook: '', title: '' };
        if (pu.persona_description_position !== undefined) descriptor.position = pu.persona_description_position;
        if (pu.persona_description_depth !== undefined) descriptor.depth = pu.persona_description_depth;
        if (pu.persona_description_role !== undefined) descriptor.role = pu.persona_description_role;
        pu.persona_descriptions[avatarId] = descriptor;
    }
    return descriptor;
}

export function writeDescription(ctx, avatarId, persona, activeAvatar) {
    const result = compose(persona);
    const pu = ctx.powerUserSettings;

    const descriptor = ensureDescriptor(pu, avatarId);
    descriptor.description = result.text;

    if (avatarId === activeAvatar) pu.persona_description = result.text;

    // Baseline before emitting, so our own event cannot read as an outside edit.
    markComposed(persona, result.text);

    ctx.saveSettingsDebounced();
    ctx.eventSource.emit(ctx.event_types.PERSONA_UPDATED, avatarId);

    const box = typeof document !== 'undefined' ? document.getElementById('persona_description') : null;
    if (box && avatarId === activeAvatar) box.value = result.text;

    return result;
}

export function hasDiverged(ctx, avatarId, persona) {
    const descriptor = ctx.powerUserSettings?.persona_descriptions?.[avatarId];
    if (!descriptor) return false;
    return textSignature(descriptor.description ?? '') !== baselineSignature(persona);
}
