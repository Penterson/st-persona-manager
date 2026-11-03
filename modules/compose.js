// Composing sections into one description and writing it into SillyTavern.
//
// Two fields receive the text (the "dual field"): persona_descriptions[avatar]
// holds every persona's description, and the singular persona_description is
// what the prompt builder reads for the ACTIVE persona. Writing only the map is
// a no-op as far as generation is concerned, so writeDescription writes both
// when the target is the active persona.
import { textSignature } from './store.js';

// The fingerprint a persona's description is compared against. A record from
// before schema 2 that still holds the copy is read through it until migrate
// converts it.
export function baselineSignature(persona) {
    if (typeof persona?.composedSig === 'string') return persona.composedSig;
    if (typeof persona?.lastComposed === 'string') return textSignature(persona.lastComposed);
    return textSignature('');
}

export function markComposed(persona, text) {
    persona.composedSig = textSignature(text);
    delete persona.lastComposed;
}

// The line a section's body is printed under, or an empty string when the format
// adds none. Exported because the 전문 screen shows the composed text the way the
// prompt receives it, and a second copy of this rule over there would be free to
// drift away from the one the prompt actually uses.
/* 'own' is the description's own title pattern, kept when 관리 시작 found the
   description already divided (classify.js splitOwnSections): template.open is
   the title line with the name replaced by {name} ("[{name}]", "### {name}",
   "<{name}>"), template.close the line that ends a block ("</{name}>") or ''.
   A template that cannot be read prints the markdown title, never nothing. */
export function validTemplate(template) {
    return !!template && typeof template.open === 'string' && template.open.includes('{name}')
        && (template.close === undefined || typeof template.close === 'string');
}

const fill = (pattern, name) => String(pattern ?? '').split('{name}').join(name);

export function headingLine(format, name, template) {
    if (format === 'plain') return `${name}:`;
    if (format === 'markdown') return `## ${name}`;
    if (format === 'own') return validTemplate(template) ? fill(template.open, name) : `## ${name}`;
    return '';
}

// The line that closes a block, for the own format only.
export function closingLine(format, name, template) {
    if (format !== 'own' || !validTemplate(template) || !template.close) return '';
    return fill(template.close, name);
}

// The one join rule, so nothing that renders the composed description can
// disagree with what gets written into SillyTavern. parts are {name, text,
// untitled} in prompt order, and an empty body contributes nothing at all,
// heading included. An untitled part (the text before the first title, under
// the own format) prints its body alone.
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

// The persona descriptor's prompt-placement fields, read and written where the
// description already is. These are SillyTavern's own, measured present on this
// build: position, depth, role and lorebook all live on
// persona_descriptions[avatar] next to the description this extension composes.
//
// The VALUES of position are SillyTavern's enum and were never measured, so they
// are treated as opaque numbers: the screen offers the six the user named, stores
// whatever number the option carries, and never reasons about what a number means.
// A build whose enum differs shows the user a label that does not match, which is
// visible and fixable; inventing a mapping would silently place the description
// somewhere else in the prompt, which is not.
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

// Writes only the keys given, so a screen that offers three of the four cannot
// blank the fourth. The active persona's mirrored singletons are updated too, for
// the same reason writeDescription does it: the prompt builder reads those.
/* activeAvatar is handed in, exactly as writeDescription takes it, and for the
   same reason: the caller resolves who is active through state.js, which asks
   SillyTavern for the avatar itself. Working it out here from the NAME was fine
   while the two could not differ; [목록] makes them differ on purpose, and then a
   name lookup answers nobody and the placement quietly stops reaching the prompt.

   Passing nothing still means not the active persona, which is the safe reading:
   the map entry is written and the singular keys are left alone. */
export function writePlacement(ctx, avatarId, patch, activeAvatar = null) {
    const pu = ctx?.powerUserSettings;
    if (!pu) return false;
    const d = pu.persona_descriptions?.[avatarId];
    if (!d) return false;
    if (Object.hasOwn(patch, 'position')) d.position = patch.position;
    if (Object.hasOwn(patch, 'depth')) d.depth = patch.depth;
    if (Object.hasOwn(patch, 'role')) d.role = patch.role;
    if (Object.hasOwn(patch, 'lorebook')) d.lorebook = patch.lorebook;
    // The dual field, applied to placement: the singular keys are
    // what the prompt builder actually reads for the ACTIVE persona.
    //
    // One way of asking, not two. There used to be a `ctx.name1Avatar` in front of
    // this, and 접점 진단 5 answered that question directly: the only key in the
    // whole context whose name contains "avatar" is getThumbnailUrl. It was never
    // a field, so it was never anything but undefined, and a condition that can
    // only ever be false is worse than no condition - it reads like a second,
    // better way of identifying the active persona that somebody should prefer.
    if (avatarId && avatarId === activeAvatar) {
        if (Object.hasOwn(patch, 'position')) pu.persona_description_position = patch.position;
        if (Object.hasOwn(patch, 'depth')) pu.persona_description_depth = patch.depth;
        if (Object.hasOwn(patch, 'role')) pu.persona_description_role = patch.role;
        // SillyTavern mirrors the lorebook the same way (personas.js
        // selectCurrentPersona), and world info reads the singular key. Without
        // it a lorebook attached here reached the prompt only after the persona
        // was selected again.
        if (Object.hasOwn(patch, 'lorebook')) pu.persona_description_lorebook = patch.lorebook;
    }
    return true;
}

export function compose(persona) {
    return composePicked(persona, persona?.activePicks);
}

/* An outside edit, divided back into the items it was composed from: the
   reverse of joinBlocks over the live picks. [가져오기] could only take an
   outside edit into a persona with ONE item holding text, and a description
   adopted with its own titles (the default since 0.3.2) has several, so the
   button refused in the common case.

   Answers [{ sectionId, text }] for every item the composition prints, when the
   text still carries each of their title lines in the same order (and each
   closing line, for a format that has one); null when it does not, or when text
   in front of the first title has no untitled item to hold it. A title the user
   added in SillyTavern stays inside the body of the item above it, so composing
   the result gives the same text back. Bodies are trimmed, as joinBlocks trims
   them. Items with an empty body print nothing and are not read. */
export function splitByComposition(persona, text) {
    const format = persona?.headingFormat;
    const template = persona?.headingTemplate;
    const blocks = [];
    for (const section of persona?.sections ?? []) {
        const pick = persona?.activePicks?.[section.id];
        const variant = (persona?.variants?.[section.id] ?? []).find(v => v?.id === pick);
        if (!variant || !String(variant.text ?? '').trim()) continue;
        const untitled = section.untitled === true;
        blocks.push({
            sectionId: section.id,
            head: untitled ? '' : headingLine(format, section.name ?? '', template),
            close: untitled ? '' : closingLine(format, section.name ?? '', template),
        });
    }
    if (!blocks.length) return null;
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const same = (line, wanted) => line.replace(/[ \t]+$/, '') === wanted;
    // Where each block's title line sits. An untitled block is only ever the
    // first one, the text in front of every title.
    const starts = [];
    let cursor = 0;
    for (const [index, block] of blocks.entries()) {
        if (!block.head) {
            if (index !== 0) return null;
            starts.push(-1);
            continue;
        }
        let at = cursor;
        while (at < lines.length && !same(lines[at], block.head)) at++;
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

// The same composition over an arbitrary pick set: a version's
// language is judged from the text ITS picks produce, which is not necessarily
// the live combination. compose() above is this with the live picks.
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

// The same composition over the working copies held by a screen that is editing
// the bodies (the 전문 window). blocks are buildReplaceBlocks output and texts
// the index aligned working copies; a missing working copy leaves that block as
// it was stored. The answer is what the prompt would carry if the screen saved
// right now, which is the number the size line reports.
export function composeFrom(persona, blocks, texts) {
    const untitled = new Set((persona?.sections ?? []).filter(section => section?.untitled === true).map(section => section.id));
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
        // Do not invent values for fields we do not own. SillyTavern reads position,
        // depth and role with a "?? DEFAULT" fallback, so omitting them is correct and
        // hardcoding guessed numbers would silently move the persona description to a
        // different place in the prompt. Mirror the active settings when they exist.
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

    // The prompt builder reads the singular field. Writing only the map is a no-op
    // as far as generation is concerned.
    if (avatarId === activeAvatar) pu.persona_description = result.text;

    // Update our baseline BEFORE emitting, so the event we are about to fire
    // cannot be mistaken for an outside edit. Idempotence, not a flag.
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
