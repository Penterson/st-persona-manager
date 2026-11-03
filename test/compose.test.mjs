import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compose, composePicked, composeFrom, headingLine, writeDescription, hasDiverged, markComposed,
    baselineSignature, readPlacement, writePlacement,
} from '../modules/compose.js';
import { makeDefaultPersona, textSignature } from '../modules/store.js';

let counter = 0;
const ids = () => `id-${++counter}`;

function personaWith(texts, format = 'none') {
    const p = makeDefaultPersona(ids, format);
    p.sections = p.sections.slice(0, texts.length);
    p.sections.forEach((section, i) => { p.variants[section.id][0].text = texts[i]; });
    return p;
}

function fakeContext(overrides = {}) {
    const emitted = [];
    return {
        powerUserSettings: { persona_descriptions: {}, persona_description: '', ...overrides },
        saveSettingsDebounced() { this.saved = (this.saved ?? 0) + 1; },
        eventSource: { emit(type, arg) { emitted.push([type, arg]); } },
        event_types: { PERSONA_UPDATED: 'pu' },
        emitted,
    };
}

test('headingLine renders the three formats', () => {
    assert.equal(headingLine('none', '외모'), '');
    assert.equal(headingLine('plain', '외모'), '외모:');
    assert.equal(headingLine('markdown', '외모'), '## 외모');
});

test('compose joins non-empty bodies, skips empty ones heading included, reports dead picks', () => {
    const p = personaWith(['a', '', 'c'], 'markdown');
    const { text, missing } = compose(p);
    assert.equal(text, `## ${p.sections[0].name}\na\n\n## ${p.sections[2].name}\nc`);
    assert.deepEqual(missing, []);
    p.activePicks[p.sections[1].id] = 'gone';
    assert.deepEqual(compose(p).missing, [p.sections[1].name]);
});

test('composePicked and composeFrom agree with compose', () => {
    const p = personaWith(['x', 'y'], 'plain');
    assert.equal(composePicked(p, p.activePicks).text, compose(p).text);
    const blocks = p.sections.map(s => ({ sectionName: s.name, text: p.variants[s.id][0].text }));
    assert.equal(composeFrom(p, blocks, ['x', 'y']), compose(p).text);
    assert.equal(composeFrom(p, blocks, [undefined, 'z']), `${p.sections[0].name}:\nx\n\n${p.sections[1].name}:\nz`);
});

test('writeDescription writes the map always and the singular field only for the active persona', () => {
    const p = personaWith(['body']);
    const ctx = fakeContext();
    const result = writeDescription(ctx, 'a.png', p, 'a.png');
    assert.equal(result.text, 'body');
    assert.equal(ctx.powerUserSettings.persona_descriptions['a.png'].description, 'body');
    assert.equal(ctx.powerUserSettings.persona_description, 'body');
    assert.equal(ctx.saved, 1);
    assert.deepEqual(ctx.emitted, [['pu', 'a.png']]);
    assert.equal(hasDiverged(ctx, 'a.png', p), false);

    const other = personaWith(['other']);
    writeDescription(ctx, 'b.png', other, 'a.png');
    assert.equal(ctx.powerUserSettings.persona_descriptions['b.png'].description, 'other');
    assert.equal(ctx.powerUserSettings.persona_description, 'body');
});

test('hasDiverged sees an outside edit and markComposed clears it', () => {
    const p = personaWith(['body']);
    const ctx = fakeContext();
    writeDescription(ctx, 'a.png', p, 'a.png');
    ctx.powerUserSettings.persona_descriptions['a.png'].description = 'edited outside';
    assert.equal(hasDiverged(ctx, 'a.png', p), true);
    markComposed(p, 'edited outside');
    assert.equal(hasDiverged(ctx, 'a.png', p), false);
    assert.equal(baselineSignature({ lastComposed: 'old' }), textSignature('old'));
    assert.equal(baselineSignature({}), textSignature(''));
});

test('ensureDescriptor mirrors active placement without inventing values', () => {
    const p = personaWith(['x']);
    const ctx = fakeContext({ persona_description_position: 4, persona_description_depth: 2 });
    writeDescription(ctx, 'n.png', p, null);
    const d = ctx.powerUserSettings.persona_descriptions['n.png'];
    assert.equal(d.position, 4);
    assert.equal(d.depth, 2);
    assert.equal('role' in d, false);
});

test('readPlacement and writePlacement touch only the keys given', () => {
    const ctx = fakeContext({ persona_descriptions: { 'a.png': { description: '', position: 1, depth: 3, role: 0, lorebook: 'L' } } });
    assert.deepEqual(readPlacement(ctx, 'a.png'), { position: 1, depth: 3, role: 0, lorebook: 'L' });
    assert.equal(readPlacement(ctx, 'none.png'), null);
    assert.equal(writePlacement(ctx, 'a.png', { depth: 7 }, 'a.png'), true);
    assert.equal(ctx.powerUserSettings.persona_descriptions['a.png'].depth, 7);
    assert.equal(ctx.powerUserSettings.persona_descriptions['a.png'].position, 1);
    assert.equal(ctx.powerUserSettings.persona_description_depth, 7);
    assert.equal(writePlacement(ctx, 'a.png', { position: 2 }, 'other.png'), true);
    assert.equal(ctx.powerUserSettings.persona_description_position, undefined);
    assert.equal(writePlacement(ctx, 'missing.png', { depth: 1 }), false);
});
