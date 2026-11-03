// roster, search, history, framing, ctx and the two screen-pure modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortEntries, createdAtFromAvatar, filterByLabel, livingLabels, recordUse, toggleMember, SORT_KEYS } from '../modules/roster.js';
import { scoreOf, rankOf, matchRanges, textContains, detectLanguage, pageOf, toChosung } from '../modules/search-pure.js';
import { addLog, snapshot, historyBytes, expireOldHistory, enforceGlobalBudget, restore, diffWords } from '../modules/history.js';
import { validCrop, coverSize, clampView, cropFromView, viewFromCrop, cropPixels, writtenKey } from '../modules/framing.js';
import { resolveAvatar, findDuplicateNames } from '../modules/ctx.js';
import {
    canDeleteSection, removeSection, moveSection, deleteVariant, versionSummary, rowKey, draftKey,
    putDraft, peekDraft, takeDraft, clearDrafts, previewText, historyView, clampSetting, parseImportedRoot,
    buildReplaceBlocks, planFullTextSave, applyReplacement, makeReplaceVersion, replaceVersionUndo, undoReplaceVersion,
    duplicatePersona, copyPersonaOnto, bindAsset, boundAsset, versionImageState, toggleAssetSelection,
    insertAtCursor, insertTagText, readSelectOptions, parseDepth, missingDefaultSections, fillDefaultSections,
    setLocalName, localName, countSize, duplicateVersionIn, reorderSection, addTag, removeTag,
} from '../modules/manager-pure.js';
import {
    waitFor, popupVerdict, shouldSelfCorrect, pickPersonaCommand, quoteArg, isTextEntry,
    versionApplicable, versionAlreadyApplied, describeSelection, buildRosterView, rosterVersionLine,
    pickAutoName, nameCollides, sortLabel, NO_VERSION_LABEL, MODIFIED_SUFFIX,
} from '../modules/quickbar-pure.js';
import { sanitizeKey, resolveFolderKey, parseTag, labelOf, lookupLabel, findTags, planRender, withoutBackups, assetLookup, buildImgHtml, assetClass } from '../modules/assets.js';
import { makeDefaultPersona, emptyRoot, SCHEMA_VERSION, DEFAULT_SETTINGS } from '../modules/store.js';
import { STRINGS } from '../modules/strings.js';

let counter = 0;
const ids = () => `id-${++counter}`;

/* roster */

test('sortEntries: every key sorts, reversed keys flip, ties break by name then avatar', () => {
    const entries = [{ avatar: '1700000000002-b.png', name: 'b' }, { avatar: '1700000000001-a.png', name: 'a' }, { avatar: 'x.png', name: 'a' }];
    const deps = { lastUsed: { 'x.png': 5 }, personas: {} };
    for (const key of SORT_KEYS) assert.equal(sortEntries(entries, key, deps).length, 3);
    assert.deepEqual(sortEntries(entries, 'name', deps).map(e => e.avatar), ['1700000000001-a.png', 'x.png', '1700000000002-b.png']);
    assert.deepEqual(sortEntries(entries, 'nameDesc', deps).map(e => e.name), ['b', 'a', 'a']);
    assert.equal(sortEntries(entries, 'recent', deps)[0].avatar, 'x.png');
    assert.equal(sortEntries(entries, 'created', deps)[0].avatar, '1700000000002-b.png');
    // No created time sorts last in BOTH directions, not first when reversed.
    assert.equal(sortEntries(entries, 'createdOld', deps)[0].avatar, '1700000000001-a.png');
    assert.equal(sortEntries(entries, 'createdOld', deps)[2].avatar, 'x.png');
    assert.equal(sortEntries(entries, 'recentOld', deps)[2].avatar, '1700000000002-b.png');
    const edited = { ...deps, personas: { 'x.png': { variants: { s: [{ updatedAt: 100 }] } } } };
    assert.equal(sortEntries(entries, 'modified', edited)[0].avatar, 'x.png');
    assert.equal(sortEntries(entries, 'modifiedOld', edited)[0].avatar, 'x.png', 'the only edited persona is first, the untouched ones last');
    assert.equal(sortEntries(entries, 'nope', deps)[0].name, 'a');
    assert.equal(createdAtFromAvatar('123-a.png'), null);
    assert.equal(createdAtFromAvatar('1700000000001-a.png'), 1700000000001);
});

test('labels: filter, living members, toggle and recordUse cap', () => {
    const labels = [{ id: 'l', name: 'L', members: ['a', 'gone'] }];
    assert.deepEqual(livingLabels(labels, { a: 'A' })[0].members, ['a']);
    assert.deepEqual(filterByLabel([{ avatar: 'a' }, { avatar: 'b' }], labels, 'l').map(e => e.avatar), ['a']);
    assert.equal(filterByLabel([{ avatar: 'a' }], labels, 'missing').length, 1);
    assert.equal(toggleMember(labels, 'l', 'b'), true);
    assert.equal(toggleMember(labels, 'l', 'b'), false);
    const root = { lastUsed: {} };
    for (let i = 0; i < 5; i++) recordUse(root, `p${i}`, i, 3);
    assert.deepEqual(Object.keys(root.lastUsed).sort(), ['p2', 'p3', 'p4']);
});

/* search */

test('search grades, highlights and body matching', () => {
    assert.equal(scoreOf('북부 왕국', '북부'), 100);
    assert.equal(scoreOf('대북부', '북부'), 90);
    assert.equal(scoreOf('북부 왕국', 'ㅂㅂ'), 80);
    assert.ok(scoreOf('북부 왕국', '북국') > 0);
    assert.equal(scoreOf('abc', 'zzz'), 0);
    assert.ok(rankOf('북부', '북부') > rankOf('대북부', '북부'));
    assert.deepEqual(matchRanges('북부 왕국', '왕국'), [[3, 4]]);
    assert.deepEqual(matchRanges('북부 왕국', '북부왕국'), [[0, 4]]);
    assert.equal(textContains('긴 본문 안의 문장', '본문'), true);
    assert.equal(textContains('긴 본문 안의 문장', '문장본'), false);
    assert.equal(toChosung('한글abc'), 'ㅎㄱabc');
});

test('language detection of a description', () => {
    assert.equal(detectLanguage('안녕하세요 반갑습니다'), 'ko');
    assert.equal(detectLanguage('こんにちは、元気ですか'), 'ja');
    assert.equal(detectLanguage('你好，今天天气很好'), 'zh');
    assert.equal(detectLanguage('Hello there, how are you'), 'en');
    assert.equal(detectLanguage('123 !!!'), null);
});

test('pageOf clamps and sizes', () => {
    const list = [1, 2, 3, 4, 5];
    assert.deepEqual(pageOf(list, 1, 0), { slice: list, page: 1, pages: 1 });
    assert.deepEqual(pageOf(list, 9, 2), { slice: [5], page: 3, pages: 3 });
    assert.deepEqual(pageOf(list, 0, 2).slice, [1, 2]);
});

/* history */

test('snapshot caps, coalesces, forces, and restore is itself undoable', () => {
    const p = makeDefaultPersona(ids);
    const sid = p.sections[0].id;
    const v = p.variants[sid][0];
    const settings = { historyPerVariant: 2, historyCoalesceMinutes: 5 };
    assert.equal(snapshot(p, v.id, 'a', 0, settings), true);
    assert.equal(snapshot(p, v.id, 'b', 1000, settings), false);
    assert.equal(snapshot(p, v.id, 'b', 1000, settings, { force: true }), true);
    assert.equal(snapshot(p, v.id, 'c', 10 * 60_000, settings), true);
    assert.deepEqual(p.history[v.id].map(e => e.text), ['b', 'c']);
    v.text = 'now';
    assert.equal(restore(p, v.id, 0, 20 * 60_000, settings), 'b');
    assert.equal(v.text, 'b');
    assert.equal(p.history[v.id][p.history[v.id].length - 1].text, 'now');
    assert.throws(() => restore(p, v.id, 99, 0, settings), RangeError);
    assert.equal(snapshot(p, v.id, 'x', 0, { historyPerVariant: 0 }), false);
});

test('expiry and budget evict with a log line per persona', () => {
    const root = emptyRoot();
    const p = makeDefaultPersona(ids);
    root.personas.a = p;
    p.history = { v: [{ at: 0, text: 'old' }, { at: 10_000, text: 'new' }] };
    assert.equal(expireOldHistory(root, { historyMaxDays: 1 }, 2 * 86400000), 2);
    assert.equal(p.log.at(-1).kind, 'history-expired');
    p.history = { v: Array.from({ length: 10 }, (_, i) => ({ at: i, text: 'x'.repeat(100) })) };
    const before = historyBytes(root);
    const evicted = enforceGlobalBudget(root, { historyMaxBytes: 300 }, 0);
    assert.ok(evicted > 0 && historyBytes(root) <= 300 && historyBytes(root) < before);
    assert.equal(p.log.at(-1).kind, 'history-evicted');
    assert.equal(p.log.at(-1).detail, STRINGS.manager.logDetails.evicted(evicted));
});

test('addLog collapses repeated system lines and caps at 200', () => {
    const p = { log: [] };
    addLog(p, 'compose-missing', 'x', 1);
    addLog(p, 'compose-missing', 'x', 2);
    assert.equal(p.log.length, 1);
    assert.equal(p.log[0].at, 2);
    for (let i = 0; i < 300; i++) addLog(p, 'pick', String(i), i);
    assert.equal(p.log.length, 200);
});

test('diffWords round-trips a one-word change', () => {
    const parts = diffWords('a b c', 'a x c');
    assert.equal(parts.map(p => p.type !== 'add' ? p.text : '').join(''), 'a b c');
    assert.equal(parts.map(p => p.type !== 'del' ? p.text : '').join(''), 'a x c');
    assert.equal(parts.truncated, false);
    assert.equal(Object.keys(parts).includes('truncated'), false);
});

/* framing */

test('framing: crops validate, clamp and round-trip', () => {
    assert.equal(validCrop({ x: 0, y: 0, w: 1.1, h: 1 }), null);
    assert.deepEqual(validCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }), { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    assert.deepEqual(coverSize(1000, 1000), { w: 1000 * 512 / 768, h: 1000 });
    const view = clampView(1000, 1000, { zoom: 99, cx: 0, cy: 0 });
    assert.equal(view.zoom, 5);
    const crop = cropFromView(1000, 1000, { zoom: 2, cx: 0.5, cy: 0.5 });
    const back = viewFromCrop(1000, 1000, crop);
    assert.ok(Math.abs(back.zoom - 2) < 1e-9 && Math.abs(back.cx - 0.5) < 1e-9);
    const px = cropPixels(crop, 1000, 1000);
    assert.ok(px.x >= 0 && px.width >= 1 && px.x + px.width <= 1000);
    assert.equal(writtenKey('a', null), 'a');
    assert.notEqual(writtenKey('a', crop), 'a');
    assert.equal(writtenKey('', crop), null);
});

/* ctx */

test('resolveAvatar prefers direct sources and refuses duplicate names by deduction', () => {
    const personas = { 'a.png': 'Mira', 'b.png': 'Mira', 'c.png': 'Solo' };
    assert.deepEqual(resolveAvatar({ preciseAvatar: 'b.png', name1: 'Mira', personas }), { avatar: 'b.png', source: 'precise', ambiguous: false });
    assert.deepEqual(resolveAvatar({ domAvatar: 'a.png', name1: 'Mira', personas }), { avatar: 'a.png', source: 'dom', ambiguous: false });
    assert.equal(resolveAvatar({ lockedAvatar: 'a.png', name1: 'Mira', personas }).ambiguous, true);
    assert.deepEqual(resolveAvatar({ name1: 'Solo', personas }), { avatar: 'c.png', source: 'name', ambiguous: false });
    assert.deepEqual(resolveAvatar({ name1: 'Nobody', personas }), { avatar: null, source: 'none', ambiguous: false });
    assert.deepEqual(resolveAvatar({ preciseAvatar: 'stale.png', name1: 'Mira', personas }), { avatar: null, source: 'none', ambiguous: true });
    assert.deepEqual(findDuplicateNames(personas), ['Mira']);
});

/* manager-pure */

test('sections and variants: delete, move, keep the last one', () => {
    const p = makeDefaultPersona(ids);
    const [first, second] = p.sections;
    assert.equal(canDeleteSection(p, first.id), true);
    const gone = removeSection(p, first.id, 1);
    assert.equal(gone.name, first.name);
    assert.equal(p.variants[first.id], undefined);
    assert.equal(p.activePicks[first.id], undefined);
    assert.equal(moveSection(p, second.id, -1), false);
    assert.equal(moveSection(p, second.id, 1), true);
    assert.equal(p.sections[1].id, second.id);
    assert.equal(reorderSection(p, second.id, 0), true);
    assert.equal(p.sections[0].id, second.id);
    assert.equal(deleteVariant(p, second.id, p.variants[second.id][0].id, 1), null);
    p.variants[second.id].push({ id: 'v2', label: 'two', text: '' });
    const removed = deleteVariant(p, second.id, p.activePicks[second.id], 2);
    assert.equal(removed.movedTo, 'v2');
    assert.equal(p.activePicks[second.id], 'v2');
    while (p.sections.length > 1) removeSection(p, p.sections[0].id, 3);
    assert.equal(canDeleteSection(p, p.sections[0].id), false);
});

test('versions: summary, applicability, applied state, duplicate', () => {
    const p = makeDefaultPersona(ids);
    const sid = p.sections[0].id;
    const version = { id: 'v', name: 'V', picks: { ...p.activePicks } };
    p.versions.push(version);
    assert.equal(versionSummary(p, version)[0].label, STRINGS.manager.defaultChoiceLabel);
    assert.equal(versionApplicable(p, 'v'), true);
    version.picks[sid] = 'dead';
    assert.equal(versionSummary(p, version)[0].dead, true);
    assert.equal(versionApplicable(p, 'v'), false);
    version.picks = { ...p.activePicks, ghost: 'x' };
    assert.equal(versionApplicable(p, 'v'), true, 'a pick for a deleted section is skipped');
    p.activeVersionId = 'v';
    assert.equal(versionAlreadyApplied(p, 'v'), true, 'a pick for a deleted section does not make it modified');
    assert.equal(describeSelection(p), 'V', 'nor does it show (수정 있음)');
    version.picks = { ...p.activePicks, [sid]: 'elsewhere' };
    assert.equal(versionAlreadyApplied(p, 'v'), false);
    version.picks = { ...p.activePicks };
    assert.equal(versionAlreadyApplied(p, 'v'), true);
    assert.equal(describeSelection(p), 'V');
    p.activePicks[sid] = 'other';
    assert.equal(describeSelection(p), 'V' + MODIFIED_SUFFIX);
    assert.equal(describeSelection(null), NO_VERSION_LABEL);
    const copy = duplicateVersionIn(p, 'v', undefined, 5);
    assert.ok(copy.id && copy.id !== 'v');
    assert.equal(p.versions[1], copy);
    assert.notEqual(copy.picks, version.picks);
});

test('drafts and keys', () => {
    clearDrafts();
    assert.equal(rowKey('a', null), JSON.stringify(['a', null]));
    assert.notEqual(rowKey('a', ''), rowKey('a', null));
    assert.equal(draftKey('x', 's', 'v'), JSON.stringify(['x', 's', 'v']));
    putDraft('x', 's', 'v', 'text');
    assert.equal(peekDraft('x', 's', 'v'), 'text');
    assert.equal(takeDraft('x', 's', 'v'), 'text');
    assert.equal(peekDraft('x', 's', 'v'), null);
    assert.equal(putDraft('x', 's', 'v', null), false);
});

test('previewText and historyView', () => {
    assert.equal(previewText('  a\n\nb  '), 'a b');
    assert.equal(previewText(''), STRINGS.manager.previewEmpty);
    assert.equal(previewText('😀'.repeat(50), 3), '😀😀😀...');
    const p = makeDefaultPersona(ids);
    const v = p.variants[p.sections[0].id][0];
    p.history = { [v.id]: [{ at: 1, text: 'old' }, { at: 2, text: 'newer' }] };
    const view = historyView(p, p.sections[0].id);
    assert.equal(view[0].variants[0].count, 2);
    assert.deepEqual(view[0].variants[0].snapshots.map(s => s.index), [1, 0]);
    assert.deepEqual(historyView(p, null, null)[0].variants[0].snapshots, []);
});

test('clampSetting and parseImportedRoot', () => {
    assert.equal(clampSetting('historyPerVariant', ''), DEFAULT_SETTINGS.historyPerVariant);
    assert.equal(clampSetting('historyPerVariant', '999'), 50);
    assert.equal(clampSetting('historyMaxBytes', 0), 65536);
    assert.equal(clampSetting('unknown', 'x'), 'x');
    assert.equal(parseImportedRoot('nope').ok, false);
    assert.equal(parseImportedRoot('[]').ok, false);
    assert.equal(parseImportedRoot(JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 })).ok, false);
    assert.equal(parseImportedRoot(JSON.stringify({ personas: { a: 'bad' } })).ok, false);
    const ok = parseImportedRoot(JSON.stringify({ settings: { historyMaxBytes: 0 } }));
    assert.equal(ok.ok, true);
    assert.equal(ok.root.settings.historyMaxBytes, 65536);
});

test('full text and revise planning', () => {
    const p = makeDefaultPersona(ids);
    p.sections = p.sections.slice(0, 2);
    const [s0, s1] = p.sections;
    p.variants[s0.id][0].text = 'one';
    assert.equal(buildReplaceBlocks(p).length, 1);
    const blocks = buildReplaceBlocks(p, true);
    assert.equal(blocks.length, 2);
    const plan = planFullTextSave(p, blocks, ['one', 'two']);
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.writes[0].sectionId, s1.id);
    p.activePicks[s1.id] = 'moved';
    assert.deepEqual(planFullTextSave(p, blocks, ['one', 'two']).skipped, [s1.name]);
    p.activePicks[s1.id] = blocks[1].variantId;

    assert.equal(applyReplacement('a b c', 2, 3, ''), 'a c');
    assert.equal(applyReplacement('line\n\npara', 0, 4, ''), 'para');
    assert.equal(applyReplacement('end x', 4, 5, ''), 'end');
    assert.equal(applyReplacement('abc', 1, 2, 'XY'), 'aXYc');

    const undo = replaceVersionUndo(p);
    const result = makeReplaceVersion(p, buildReplaceBlocks(p), ['ONE'], 'rev', ids, 9);
    assert.equal(result.changed.length, 1);
    assert.equal(p.versions.length, 1);
    assert.equal(p.activeVersionId, result.version.id);
    assert.equal(p.variants[s0.id].length, 2);
    undoReplaceVersion(p, result, undo);
    assert.equal(p.versions.length, 0);
    assert.equal(p.variants[s0.id].length, 1);
    assert.equal(p.activeVersionId, null);
});

test('duplicatePersona regenerates ids and copyPersonaOnto keeps the destination picture', () => {
    const root = emptyRoot();
    const src = makeDefaultPersona(ids);
    src.versions.push({ id: 'v', name: 'V', picks: { ...src.activePicks }, avatarAsset: 'pic', assetSelection: ['a'] });
    src.activeVersionId = 'v';
    root.personas.src = src;
    root.personas.dst = { avatarBackup: { label: 'keep' }, assetFolderKey: 'persona_dst', avatarWritten: 'w' };
    const copy = copyPersonaOnto(root, 'src', 'dst', ids, 1, 'detail');
    assert.ok(copy);
    assert.notEqual(copy.sections[0].id, src.sections[0].id);
    assert.equal(copy.versions[0].avatarAsset, null);
    assert.equal(copy.versions[0].assetSelection, null);
    assert.equal(copy.activeVersionId, copy.versions[0].id);
    assert.equal(copy.avatarBackup.label, 'keep');
    assert.equal(copy.assetFolderKey, 'persona_dst');
    assert.equal(copy.log[0].kind, 'persona-copy');
    assert.equal(copyPersonaOnto(root, 'src', 'src', ids, 1), null);
    assert.equal(duplicatePersona(null), null);
});

test('asset bindings and selections', () => {
    const v = { id: 'v', assetSelection: null };
    assert.equal(bindAsset(v, ' pic ', 1), true);
    assert.equal(boundAsset(v), 'pic');
    assert.equal(bindAsset(v, 'pic', 2), false);
    assert.equal(bindAsset(v, '', 3), true);
    assert.equal(boundAsset(v), null);
    assert.deepEqual(versionImageState({ avatarAsset: 'x' }, ['x'], true), { label: 'x', state: 'ok' });
    assert.equal(versionImageState({ avatarAsset: 'x' }, [], false).state, 'unknown');
    assert.equal(versionImageState({ avatarAsset: 'x' }, [], true).state, 'missing');
    assert.deepEqual(toggleAssetSelection(v, 'a', ['a', 'b']), ['b']);
    assert.equal(toggleAssetSelection(v, 'a', ['a', 'b']), null);
    assert.equal(v.assetSelection, null);
});

test('send box insertion, tags and select reading', () => {
    assert.deepEqual(insertAtCursor('ab', 1, 1, 'X'), { value: 'aXb', caret: 2 });
    assert.deepEqual(insertAtCursor('ab', null, null, 'X'), { value: 'abX', caret: 3 });
    assert.equal(insertTagText('f', 'n'), '{{pimg::f/n}}');
    assert.deepEqual(readSelectOptions({ options: [{ value: '0', textContent: 'A' }, { value: '1', textContent: 'B' }] }), [{ value: 0, label: 'A' }, { value: 1, label: 'B' }]);
    assert.equal(readSelectOptions({ options: [{ value: 'x', textContent: 'A' }, { value: '1', textContent: 'B' }] }), null);
    assert.equal(readSelectOptions({ options: [{ value: '0', textContent: 'A' }] }), null);
    assert.equal(parseDepth('3'), 3);
    assert.equal(parseDepth('2.5'), null);
    const o = { tags: [] };
    assert.equal(addTag(o, ' x '), 'x');
    assert.equal(addTag(o, 'x'), null);
    assert.equal(removeTag(o, 'x'), true);
    assert.equal(removeTag(o, 'x'), false);
});

test('default sections, local names and size', () => {
    const p = makeDefaultPersona(ids);
    p.sections = p.sections.filter(s => s.name !== '외모');
    p.sections.push({ id: 'legacy', name: '외형' });
    assert.deepEqual(missingDefaultSections(p), []);
    p.sections = p.sections.filter(s => s.id !== 'legacy');
    assert.deepEqual(fillDefaultSections(p, ids, 1), ['외모']);
    assert.equal(setLocalName(p, 'en', ' Mira '), true);
    assert.equal(localName(p, 'en', 'x'), 'Mira');
    assert.equal(setLocalName(p, 'en', 'Mira'), false);
    assert.equal(setLocalName(p, 'en', ''), true);
    assert.equal(localName(p, 'en', 'fallback'), 'fallback');
    assert.deepEqual(countSize('가나😀', t => t.length), { chars: 3, tokens: 4, bytes: 10 });
    assert.equal(countSize('a', () => { throw new Error('x'); }).tokens, null);
});

/* quickbar-pure */

test('waitFor, popups and commands', async () => {
    let n = 0;
    assert.equal(await waitFor(() => ++n >= 3, resolve => resolve(), 5), true);
    assert.equal(await waitFor(() => false, resolve => resolve(), 2), false);
    assert.equal(popupVerdict({ before: ['x'], during: ['x', 'y'], openAtEnd: ['y'] }), true);
    assert.equal(popupVerdict({ before: [], during: ['flash'], openAtEnd: [] }), false);
    assert.equal(shouldSelfCorrect({ needsDrop: false, elapsedMs: 4000, foreignOpen: false }), true);
    assert.equal(shouldSelfCorrect({ needsDrop: true, elapsedMs: 4000, foreignOpen: false }), false);
    assert.equal(pickPersonaCommand({ persona: {}, 'persona-set': {} }), 'persona-set');
    assert.equal(pickPersonaCommand({ constructor: {} }), null);
    assert.equal(quoteArg('a"b|c{d}\ne'), '"a\\"b\\|c\\{d\\} e"');
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'search' }), true);
    assert.equal(sortLabel('constructor'), STRINGS.quick.sortNames.name);
});

test('roster view, version line, auto name and collisions', () => {
    const root = emptyRoot();
    root.labels = [{ id: 'l', name: 'L', members: ['gone'] }];
    root.settings.activeLabelId = 'l';
    const view = buildRosterView({ personas: { a: 'A', b: 'B' } }, root);
    assert.equal(view.activeLabelId, null, 'a label with no living member falls back to everyone');
    assert.equal(view.entries.length, 2);
    assert.deepEqual(rosterVersionLine({ versions: [{ name: 'x' }, { name: ' ' }] }, { count: true, names: true }), { badge: STRINGS.quick.versionBadge(2), line: 'x' });
    assert.deepEqual(rosterVersionLine({ versions: [] }, { count: true }), { badge: null, line: null });
    const personas = { a: 'Mira', b: 'Other' };
    assert.equal(pickAutoName({ persona: { names: { en: 'Mira' } }, lang: 'en', avatar: 'a', personas }), null);
    assert.equal(pickAutoName({ persona: { names: { en: 'Other' } }, lang: 'en', avatar: 'a', personas }), null);
    assert.equal(pickAutoName({ persona: { names: { en: 'New' } }, lang: 'en', avatar: 'a', personas }), 'New');
    assert.equal(nameCollides({ name: 'Char', characterName: 'Char' }), 'Char');
    assert.equal(nameCollides({ name: 'Me', chat: [{ name: 'Me', is_user: true }] }), null);
    assert.equal(nameCollides({ name: 'Bob', chat: [{ name: 'Bob', is_user: false }] }), 'Bob');
});

/* assets (pure parts) */

test('folder keys, tags and render plans', () => {
    assert.equal(sanitizeKey('a/b:c?.png'), 'persona_abc');
    assert.equal(sanitizeKey('trail. '), 'persona_trail');
    assert.equal(sanitizeKey(''), 'persona_unnamed');
    const root = { personas: { 'x.png': { assetFolderKey: 'persona_x' } } };
    assert.equal(resolveFolderKey(root, 'x.png'), 'persona_x');
    assert.ok(resolveFolderKey(root, 'x.jpg').startsWith('persona_x-'), 'a colliding key gets a hash suffix');
    assert.deepEqual(parseTag('f/n'), { folderKey: 'f', filename: 'n' });
    assert.equal(parseTag('a/b/c'), null);
    assert.equal(parseTag('../x'), null);
    assert.equal(labelOf('a.b.png'), 'a.b');
    const map = new Map([['포즈 1.5', '/p'], ['walk', '/w']]);
    assert.equal(lookupLabel(map, '포즈 1.5'), '/p');
    assert.equal(lookupLabel(map, 'walk.png'), '/w');
    assert.equal(findTags('x {{pimg::a}} y {{pimg::}}').length, 1);
    const plan = planRender('hi {{pimg::a}} and {{pimg::b}}', ({ filename }) => (filename === 'a' ? '/a' : null));
    assert.equal(plan.resolved, 1);
    assert.deepEqual(plan.parts, [{ type: 'text', text: 'hi ' }, { type: 'image', path: '/a' }, { type: 'text', text: ' and {{pimg::b}}' }]);
    assert.deepEqual(withoutBackups(['a', 'pm-backup-1', 'pm-원본-2']), ['a']);
    const folders = new Map([['k', null]]);
    assert.deepEqual(assetLookup(folders, 'k', 'a'), { path: null, fetch: false });
    assert.deepEqual(assetLookup(folders, 'new', 'a'), { path: null, fetch: true });
    assert.equal(assetClass('polaroid'), 'pm-asset pm-asset-polaroid');
    assert.ok(buildImgHtml('/x?a=1&b="2"', 'plain').includes('&amp;') && !buildImgHtml('/x"', 'plain').includes('src="/x"'));
});
