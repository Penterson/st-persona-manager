// Regression tests for the 0.3.0 audit: each one reproduces a defect that was
// found in 0.2.0 and fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, makeDefaultPersona, isEmptyPersona, DEFAULT_SECTION_NAMES, DEFAULT_SETTINGS } from '../modules/store.js';
import { parseImportedRoot, copyPersonaOnto, fillDefaultSections, assetSelected, toggleAssetSelection } from '../modules/manager-pure.js';
import { splitDescription, applyResplit, planResplit, stripSelfTitle } from '../modules/classify.js';
import { versionAlreadyApplied, describeSelection } from '../modules/quickbar-pure.js';
import { missingDefaultSections } from '../modules/manager-pure.js';

let n = 0;
const ids = () => `a-${++n}`;

test('a newer schema root is shown through a copy and never rewritten', () => {
    const stored = { schemaVersion: 99, personas: { a: { versions: { byId: {} }, tags: { work: true } } }, labels: { g: {} } };
    const view = migrate(stored);
    assert.equal(view.readOnly, true);
    assert.deepEqual(view.personas.a.versions, []);
    assert.deepEqual(stored.personas.a.versions, { byId: {} }, 'stored object untouched');
    assert.equal('readOnly' in stored, false);
    assert.equal(migrate(stored), view, 'cached per stored object');
});

test('import refuses array-shaped containers and holds caps and columns to their ranges', () => {
    assert.equal(parseImportedRoot('{"schemaVersion":2,"personas":[],"settings":{}}').ok, false);
    assert.equal(parseImportedRoot('{"schemaVersion":2,"personas":{},"settings":[]}').ok, false);
    const ok = parseImportedRoot('{"schemaVersion":2,"personas":{},"settings":{"lastUsedCap":-1,"rosterTileColumns":40},"labels":[null]}');
    assert.equal(ok.ok, true);
    assert.equal(ok.root.settings.lastUsedCap, 10);
    assert.equal(ok.root.settings.rosterTileColumns, 0);
    assert.deepEqual(ok.root.labels, []);
});

test('copying a persona keeps the destination names', () => {
    const root = { personas: { src: makeDefaultPersona(ids), dst: makeDefaultPersona(ids) } };
    root.personas.src.names = { en: 'Miro' };
    root.personas.dst.names = { en: 'Dana' };
    const copy = copyPersonaOnto(root, 'src', 'dst', ids, 1, '');
    assert.deepEqual(copy.names, { en: 'Dana' });
});

test('a deleted item does not mark the active version modified, and new items join every version', () => {
    const p = makeDefaultPersona(ids);
    p.sections = p.sections.slice(0, 2);
    const version = { id: 'v', name: 'V', picks: { ...p.activePicks, gone: 'x' } };
    p.versions = [version];
    p.activeVersionId = 'v';
    assert.equal(versionAlreadyApplied(p, 'v'), true);
    assert.equal(describeSelection(p), 'V');
    fillDefaultSections(p, ids, 1);
    for (const section of p.sections) assert.ok(version.picks[section.id], `version picks ${section.name}`);
});

test('item names that shadow Object.prototype do not crash', () => {
    const names = ['constructor', 'toString', ...DEFAULT_SECTION_NAMES];
    assert.doesNotThrow(() => splitDescription('## constructor\n본문\n## 외모\n키 큼', names));
    assert.doesNotThrow(() => missingDefaultSections({ sections: [{ name: 'constructor' }] }));
});

test('an inline "이름: 내용" line inside a markdown section stays in that section', () => {
    const names = [...DEFAULT_SECTION_NAMES];
    const split = splitDescription('## 성격\n착하다\n메모: 커피를 좋아함\n잘 웃는다\n## 외모\n키 큼', names);
    const personality = split.parts.find(part => part.title === '성격');
    assert.equal(personality.body, '착하다\n메모: 커피를 좋아함\n잘 웃는다');
});

test('resplit keeps moved text for versions picking another choice, and drops duplicated self titles', () => {
    const p = makeDefaultPersona(ids, 'none');
    const home = p.sections[0];
    const looks = p.sections.find(section => section.name === '외모');
    const personality = p.sections.find(section => section.name === '성격');
    p.variants[home.id][0].text = '소개\n## 외모\n키가 크다';
    const other = { id: 'alt', label: '다른', text: '다른 외모', updatedAt: 0 };
    p.variants[looks.id].push(other);
    p.variants[personality.id][0].text = '## 성격\n착하다';
    p.versions = [{ id: 'v', name: 'V', picks: { ...p.activePicks, [looks.id]: 'alt' } }];
    const plan = planResplit(p);
    applyResplit(p, plan, ids, 1, 'markdown', () => {});
    assert.match(other.text, /키가 크다/);
    assert.equal(p.variants[personality.id][0].text, '착하다');
    assert.equal(stripSelfTitle('외모: 키 큼', '외모'), '외모: 키 큼', 'an inline fact is not a title line');
});

test('asset selections match without case, in the box and in the toggle', () => {
    const version = { assetSelection: ['smile'] };
    assert.equal(assetSelected(version, 'Smile'), true);
    toggleAssetSelection(version, 'Smile', ['Smile', 'Walk']);
    assert.deepEqual(version.assetSelection, []);
});

test('an unreadable choice list is not taken for an empty persona', () => {
    assert.equal(isEmptyPersona({ variants: { s: {} } }), false);
});

test('adopt takes the description whole by default; old switches fold into the mode', () => {
    assert.equal(DEFAULT_SETTINGS.adoptSplitMode, 'whole');
    const legacy = migrate({ schemaVersion: 2, settings: { splitOnAdopt: true }, personas: {} });
    assert.equal('splitOnAdopt' in legacy.settings, false);
    assert.equal(legacy.settings.adoptSplitMode, 'whole', 'the old always-on value says nothing');
    const chose = migrate({ schemaVersion: 2, settings: { autoSplitOnAdopt: true }, personas: {} });
    assert.equal(chose.settings.adoptSplitMode, 'defaults', '0.3.1 on meant the shipped names');
    assert.equal('autoSplitOnAdopt' in chose.settings, false);
    const off = migrate({ schemaVersion: 2, settings: { autoSplitOnAdopt: false }, personas: {} });
    assert.equal(off.settings.adoptSplitMode, 'whole');
    const bad = migrate({ schemaVersion: 2, settings: { adoptSplitMode: 'x' }, personas: {} });
    assert.equal(bad.settings.adoptSplitMode, 'whole');
    // The old default saved into every root moves once; chosen after the move, it stays.
    const old = migrate({ schemaVersion: 3, settings: { adoptSplitMode: 'own' }, personas: {} });
    assert.equal(old.settings.adoptSplitMode, 'whole');
    old.settings.adoptSplitMode = 'own';
    assert.equal(migrate(old).settings.adoptSplitMode, 'own');
    const picked = migrate({ schemaVersion: 3, settings: { adoptSplitMode: 'defaults' }, personas: {} });
    assert.equal(picked.settings.adoptSplitMode, 'defaults');
});

/* 원래 항목 그대로 */
import { splitOwnSections, seedOwnSections, sameText } from '../modules/classify.js';
import { compose } from '../modules/compose.js';

function ownRoundTrip(text) {
    const split = splitOwnSections(text);
    if (!split) return null;
    const p = makeDefaultPersona(ids);
    seedOwnSections(p, split, ids, 1);
    return { p, composed: compose(p).text };
}

test('a description already divided keeps its own item names, order and title style', () => {
    const cases = [
        '소개 한 줄\n\n### Look\n키가 크다\n\n### Mind\n차분하다',
        '[Profile]\n27세\n[Habits]\n손톱을 깨문다',
        '<appearance>\n검은 머리\n</appearance>\n<speech>\n존댓말\n</speech>',
        '**특징:**\n조용함\n\n**취미:**\n독서',
        '나이:\n27\n직업:\n사서',
    ];
    for (const text of cases) {
        const r = ownRoundTrip(text);
        assert.ok(r, `split ${JSON.stringify(text)}`);
        assert.equal(r.p.headingFormat, 'own');
        assert.ok(sameText(r.composed, text), `round trip ${JSON.stringify(r.composed)}`);
    }
    const r = ownRoundTrip('소개 한 줄\n\n### Look\n키가 크다\n\n### Mind\n차분하다');
    assert.deepEqual(r.p.sections.map(s => s.name), ['머리말', 'Look', 'Mind']);
    assert.equal(r.p.sections[0].untitled, true);
    assert.equal(r.p.headingTemplate.open, '### {name}');
});

test('own split: renaming an item renames its printed title, and new items follow the style', () => {
    const r = ownRoundTrip('<appearance>\n검은 머리\n</appearance>\n<speech>\n존댓말\n</speech>');
    r.p.sections[0].name = 'looks';
    assert.match(compose(r.p).text, /^<looks>\n검은 머리\n<\/looks>/);
});

test('own split: one title or plain prose stays whole, nested markdown splits at its repeated level, mixed styles split by the first repeated style', () => {
    // Mixed title styles: the first style used twice, in the order markdown,
    // <tag>, [ ], **, 이름:, divides the text; the other titles stay as text.
    const mixed = splitOwnSections('[A]\na\n[B]\nb\n## C\nc\n## D\nd');
    assert.deepEqual(mixed.parts.map(p => p.name), ['C', 'D']);
    assert.equal(mixed.preamble, '[A]\na\n[B]\nb');
    assert.equal(splitOwnSections('## 외모\n키 큼'), null);
    assert.equal(splitOwnSections('그냥 문장입니다.\n두 번째 문장.'), null);
    // One level-1 heading over two level-2 ones splits at level 2, keeping the
    // level-1 line as text before the first item.
    const nested = splitOwnSections('# 아영\n## 외모\n키 큼\n## 성격\n착함');
    assert.deepEqual(nested.parts.map(p => p.name), ['외모', '성격']);
    assert.equal(nested.preamble, '# 아영');
    // A title with nothing under it cannot be reproduced (empty items print
    // nothing), so the round trip check fails and the caller keeps it whole.
    const r = ownRoundTrip('## 외모\n키 큼\n## 메모\n## 성격\n착함');
    assert.equal(sameText(r.composed, '## 외모\n키 큼\n## 메모\n## 성격\n착함'), false);
});
