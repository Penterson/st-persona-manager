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

test('automatic title split is off by default, and the old always-on switch is retired', () => {
    assert.equal(DEFAULT_SETTINGS.autoSplitOnAdopt, false);
    const root = migrate({ schemaVersion: 2, settings: { splitOnAdopt: true }, personas: {} });
    assert.equal('splitOnAdopt' in root.settings, false);
    assert.equal(root.settings.autoSplitOnAdopt, false);
    const chosen = migrate({ schemaVersion: 2, settings: { autoSplitOnAdopt: true }, personas: {} });
    assert.equal(chosen.settings.autoSplitOnAdopt, true, 'a choice made on the new switch is kept');
});
