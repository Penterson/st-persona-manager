// The full-text screen's joined view, edited as one text and divided back into items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeFrom, splitFullText, fullTextSplittable } from '../modules/compose.js';
import { buildReplaceBlocks } from '../modules/manager-pure.js';

function persona(format, template, untitled) {
    return {
        headingFormat: format,
        headingTemplate: template,
        sections: [...(untitled ? [{ id: 'u', name: '머리말', untitled: true }] : []), { id: 'a', name: '외모' }, { id: 'b', name: '성격' }, { id: 'c', name: '빈칸' }],
        variants: { u: [{ id: 'u1', text: '소개' }], a: [{ id: 'a1', text: '검은 머리\n큰 키' }], b: [{ id: 'b1', text: '조용함' }], c: [{ id: 'c1', text: '' }] },
        activePicks: { u: 'u1', a: 'a1', b: 'b1', c: 'c1' },
    };
}

const setup = (...args) => {
    const p = persona(...args);
    const blocks = buildReplaceBlocks(p, true);
    const texts = blocks.map(block => block.text);
    return { p, blocks, texts, joined: composeFrom(p, blocks, texts) };
};
const byId = (blocks, texts) => Object.fromEntries(blocks.map((block, i) => [block.sectionId, texts[i]]));

test('edits across several items in the joined text land in their own items, in every title format', () => {
    const cases = [['markdown', null, false], ['plain', null, false], ['own', { open: '<{name}>', close: '</{name}>' }, true], ['own', { open: '[{name}]' }, true]];
    for (const [format, template, untitled] of cases) {
        const { p, blocks, texts, joined } = setup(format, template, untitled);
        const edited = joined.replace('조용함', '조용하고 침착함').replace('큰 키', '큰 키\n흉터');
        const split = splitFullText(p, blocks, edited, texts);
        assert.ok(split.ok, `${format} ${JSON.stringify(template)}`);
        const got = byId(blocks, split.texts);
        assert.equal(got.a, '검은 머리\n큰 키\n흉터');
        assert.equal(got.b, '조용하고 침착함');
        assert.equal(got.c, '');
        if (untitled) assert.equal(got.u, '소개');
    }
});

test('an unchanged joined text divides back to exactly the texts it came from', () => {
    const { p, blocks, texts, joined } = setup('markdown', null, true);
    assert.deepEqual(splitFullText(p, blocks, joined, texts), { ok: true, texts });
});

test('an empty item is filled by typing its title line in item order', () => {
    const { p, blocks, texts, joined } = setup('markdown', null, false);
    const split = splitFullText(p, blocks, `${joined}\n\n## 빈칸\n새 내용`, texts);
    assert.ok(split.ok);
    assert.equal(byId(blocks, split.texts).c, '새 내용');
});

test('a body cleared under its kept title empties the item', () => {
    const { p, blocks, texts } = setup('markdown', null, false);
    const split = splitFullText(p, blocks, '## 외모\n검은 머리\n\n## 성격\n', texts);
    assert.ok(split.ok);
    assert.equal(byId(blocks, split.texts).b, '');
});

test('a removed, moved or doubled title, or text above the first title, is refused with the item named', () => {
    const { p, blocks, texts } = setup('markdown', null, false);
    assert.deepEqual(splitFullText(p, blocks, '## 외모\n검은 머리\n\n조용함', texts), { ok: false, reason: 'missing', name: '성격' });
    assert.deepEqual(splitFullText(p, blocks, '## 성격\n조용함\n\n## 외모\n검은 머리', texts), { ok: false, reason: 'missing', name: '외모' });
    assert.deepEqual(splitFullText(p, blocks, '## 외모\nx\n\n## 성격\ny\n\n## 외모\nz', texts), { ok: false, reason: 'order', name: '외모' });
    assert.deepEqual(splitFullText(p, blocks, '서문\n## 외모\nx\n\n## 성격\ny', texts), { ok: false, reason: 'stray', name: '' });
});

test('a removed closing line costs nothing, the next title still ends the block', () => {
    const { p, blocks, texts } = setup('own', { open: '<{name}>', close: '</{name}>' }, false);
    const split = splitFullText(p, blocks, '<외모>\n검은 머리\n<성격>\n조용함\n</성격>', texts);
    assert.ok(split.ok);
    assert.equal(byId(blocks, split.texts).a, '검은 머리');
    assert.equal(byId(blocks, split.texts).b, '조용함');
});

test('the joined view is editable only when every item after the first prints a title', () => {
    const titled = setup('markdown', null, true);
    assert.equal(fullTextSplittable(titled.p, titled.blocks), true);
    const bare = setup('none', null, false);
    assert.equal(fullTextSplittable(bare.p, bare.blocks), false);
    const single = persona('none', null, false);
    single.sections = [single.sections[0]];
    assert.equal(fullTextSplittable(single, buildReplaceBlocks(single, true)), true);
});

test('a single untitled item takes the whole text', () => {
    const p = persona('none', null, false);
    p.sections = [p.sections[0]];
    const blocks = buildReplaceBlocks(p, true);
    const split = splitFullText(p, blocks, '전부 새로 쓴 글\n둘째 줄', blocks.map(b => b.text));
    assert.deepEqual(split, { ok: true, texts: ['전부 새로 쓴 글\n둘째 줄'] });
});

/* Deleting several items at once */

import { removeSections } from '../modules/manager-pure.js';

const withVersion = () => {
    const p = persona('markdown', null, false);
    p.history = { a1: [{ text: 'old' }], b1: [{ text: 'old' }] };
    p.versions = [{ id: 'v', picks: { a: 'a1', b: 'b1', c: 'c1' } }];
    return p;
};
let seq = 0;
const ids = () => `id${++seq}`;

test('several items go at once, with their choices, history and picks', () => {
    const p = withVersion();
    const { gone, added } = removeSections(p, ['a', 'c', 'nope'], ids, 1);
    assert.deepEqual(gone.map(item => item.id), ['a', 'c']);
    assert.equal(added, null);
    assert.deepEqual(p.sections.map(section => section.id), ['b']);
    assert.equal(p.variants.a, undefined);
    assert.equal(p.history.a1, undefined);
    assert.ok(p.history.b1);
    assert.equal(p.activePicks.a, undefined);
});

test('deleting every item leaves one empty item, picked in every version', () => {
    const p = withVersion();
    const { gone, added } = removeSections(p, ['a', 'b', 'c'], ids, 1);
    assert.equal(gone.length, 3);
    assert.equal(p.sections.length, 1);
    assert.equal(p.sections[0].name, added);
    const only = p.sections[0].id;
    const variant = p.variants[only][0];
    assert.equal(variant.text, '');
    assert.equal(p.activePicks[only], variant.id);
    assert.equal(p.versions[0].picks[only], variant.id);
});

test('nothing selected changes nothing', () => {
    const p = withVersion();
    assert.deepEqual(removeSections(p, [], ids, 1), { gone: [], added: null });
    assert.equal(p.sections.length, 3);
});
