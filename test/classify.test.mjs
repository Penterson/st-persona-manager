import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDescription, seedFromSplit, normalizeTitle, itemsWithText, planResplit, applyResplit } from '../modules/classify.js';
import { makeDefaultPersona, DEFAULT_SECTION_NAMES } from '../modules/store.js';

let counter = 0;
const ids = () => `id-${++counter}`;
const names = [...DEFAULT_SECTION_NAMES];

test('normalizeTitle folds case, spaces and joining marks', () => {
    assert.equal(normalizeTitle('버릇 & 습관'), normalizeTitle('버릇&습관'));
    assert.equal(normalizeTitle('버릇/습관'), normalizeTitle('버릇·습관'));
    assert.equal(normalizeTitle('Basic Info'), 'basicinfo');
});

test('splitDescription answers null when there is nothing to split', () => {
    assert.equal(splitDescription('그냥 문장입니다.\n나이: 27', names), null);
    assert.equal(splitDescription('', names), null);
    // Every title lands in the home item, so the old behaviour is kept.
    assert.equal(splitDescription('## 기본 정보\n본문', names), null);
});

test('splitDescription reads markdown, bracket, bold, angle and plain titles', () => {
    const text = [
        '서문입니다.',
        '## 외모', '검은 머리',
        '[성격]', '조용함',
        '**배경**', '시골 출신',
        '<관계>', '친구 많음', '</관계>',
        '말투 & 대사:', '존댓말',
        '취미: 독서',
    ].join('\n');
    const split = splitDescription(text, names);
    assert.equal(split.preamble, '서문입니다.');
    const byTitle = Object.fromEntries(split.parts.map(p => [p.title, [p.index, p.body]]));
    assert.deepEqual(byTitle['외모'], [names.indexOf('외모'), '검은 머리']);
    assert.deepEqual(byTitle['성격'], [names.indexOf('성격'), '조용함']);
    assert.deepEqual(byTitle['배경'], [names.indexOf('배경'), '시골 출신']);
    assert.deepEqual(byTitle['관계'], [names.indexOf('관계'), '친구 많음']);
    // The inline fact line stays inside the item above it rather than becoming a title.
    assert.deepEqual(byTitle['말투 & 대사'], [names.indexOf('말투 & 대사'), '존댓말\n취미: 독서']);
    assert.equal(split.format, null);
});

test('splitDescription keeps the shallowest named markdown level and names unknown titles', () => {
    const split = splitDescription('# 아영\n## 외모\n키 큼\n## 기타\n잡담', names);
    const titles = split.parts.map(p => p.title);
    assert.deepEqual(titles, ['외모', '기타']);
    assert.equal(split.parts[1].index, -1);
    assert.equal(split.format, 'markdown');
});

test('splitDescription matches English aliases and numbered titles', () => {
    const split = splitDescription('1. Appearance:\ntall\n2) Personality (성격):\nkind', names);
    assert.deepEqual(split.parts.map(p => p.index), [names.indexOf('외모'), names.indexOf('성격')]);
});

test('seedFromSplit fills items, creates unknown ones and picks a heading format', () => {
    const p = makeDefaultPersona(ids, 'none');
    const split = splitDescription('머리말\n## 외모\n키 큼\n## 외모\n눈 큼\n## 취미\n독서', names);
    const filled = seedFromSplit(p, split, ids, 'none');
    assert.equal(filled, 3);
    const body = name => p.variants[p.sections.find(s => s.name === name).id][0].text;
    assert.equal(body('기본 정보'), '머리말');
    assert.equal(body('외모'), '키 큼\n\n눈 큼');
    assert.equal(body('취미'), '독서');
    assert.equal(p.sections.length, names.length + 1);
    assert.equal(p.headingFormat, 'markdown');
    assert.equal(itemsWithText(p), 3);
});

test('planResplit and applyResplit move titled parts out of the home item', () => {
    const p = makeDefaultPersona(ids, 'none');
    const home = p.sections[0].id;
    p.variants[home][0].text = '소개\n## 외모\n키 큼\n## 새 항목\n내용';
    p.versions.push({ id: 'v1', name: 'v', picks: { ...p.activePicks } });
    const plan = planResplit(p);
    assert.equal(plan.targets, 1);
    assert.equal(plan.created, 1);
    const snapshots = [];
    const changed = applyResplit(p, plan, ids, 100, 'none', (id, text) => snapshots.push([id, text]));
    assert.equal(p.variants[home][0].text, '소개');
    const appearance = p.sections.find(s => s.name === '외모');
    assert.equal(p.variants[appearance.id][0].text, '키 큼');
    const made = p.sections[p.sections.length - 1];
    assert.equal(made.name, '새 항목');
    assert.equal(p.variants[made.id][0].text, '내용');
    assert.equal(p.versions[0].picks[made.id], p.variants[made.id][0].id);
    assert.equal(p.headingFormat, 'markdown');
    // The home body, the target body and the body of the item that was made.
    assert.equal(changed.length, 3);
    assert.equal(snapshots.length, 1);
    assert.equal(planResplit(p), null);
});
