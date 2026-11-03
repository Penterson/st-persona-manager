import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    migrate, emptyRoot, makeDefaultPersona, isEmptyPersona, pruneEmpty, textSignature,
    DEFAULT_SETTINGS, DEFAULT_SECTION_NAMES, SCHEMA_VERSION, makeId, ensurePersona, usageBytes,
} from '../modules/store.js';
import { STRINGS } from '../modules/strings.js';

let counter = 0;
const ids = () => `id-${++counter}`;

test('migrate fills containers and defaults on an empty object', () => {
    const root = migrate({});
    assert.equal(root.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(root.personas, {});
    assert.deepEqual(root.labels, []);
    assert.deepEqual(root.lastUsed, {});
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) assert.deepEqual(root.settings[k], v);
});

test('migrate keeps a user-set value and only backfills missing ones', () => {
    const root = migrate({ settings: { historyPerVariant: 9 } });
    assert.equal(root.settings.historyPerVariant, 9);
    assert.equal(root.settings.pageSizeRoster, DEFAULT_SETTINGS.pageSizeRoster);
});

test('migrate marks a newer schema read-only without rewriting it', () => {
    const stored = { schemaVersion: SCHEMA_VERSION + 1, personas: { a: { versions: 3 } } };
    const root = migrate(stored);
    assert.equal(root.readOnly, true);
    assert.equal(stored.personas.a.versions, 3, 'the stored object keeps its own value');
    assert.equal('readOnly' in stored, false);
    assert.equal(root.schemaVersion, SCHEMA_VERSION + 1);
    // Containers are still backfilled so read-only screens cannot throw.
    assert.deepEqual(root.personas.a.versions, []);
    assert.deepEqual(root.personas.a.tags, []);
});

test('migrate converts schema 1 lastComposed into composedSig', () => {
    const root = migrate({ schemaVersion: 1, personas: { a: { lastComposed: 'hello' } } });
    assert.equal(root.personas.a.composedSig, textSignature('hello'));
    assert.equal('lastComposed' in root.personas.a, false);
    assert.equal(root.schemaVersion, SCHEMA_VERSION);
});

test('migrate replaces a shipped asset prompt default but keeps a user-written one', () => {
    const legacy = STRINGS.settings.legacyAssetPrompts[0];
    assert.equal(migrate({ settings: { assetPromptTemplate: legacy } }).settings.assetPromptTemplate, DEFAULT_SETTINGS.assetPromptTemplate);
    assert.equal(migrate({ settings: { assetPromptTemplate: 'mine' } }).settings.assetPromptTemplate, 'mine');
});

test('migrate seeds pickerViewMode from rosterViewMode once', () => {
    const root = migrate({ settings: { rosterViewMode: 'tiles' } });
    assert.equal(root.settings.pickerViewMode, 'tiles');
});

test('migrate drops stale readOnly and malformed avatar fields', () => {
    const root = migrate({ readOnly: true, personas: { a: { avatarWritten: 5, avatarBackup: 'x', versions: [{ avatarAsset: 1, avatarCrop: { x: 2 } }] } } });
    assert.equal(root.readOnly, undefined);
    assert.equal(root.personas.a.avatarWritten, null);
    assert.equal(root.personas.a.avatarBackup, null);
    assert.equal(root.personas.a.versions[0].avatarAsset, null);
    assert.equal(root.personas.a.versions[0].avatarCrop, null);
});

test('makeDefaultPersona seeds every default section with one picked choice', () => {
    const p = makeDefaultPersona(ids, 'markdown');
    assert.equal(p.sections.length, DEFAULT_SECTION_NAMES.length);
    assert.equal(p.headingFormat, 'markdown');
    for (const section of p.sections) {
        assert.equal(p.variants[section.id].length, 1);
        assert.equal(p.activePicks[section.id], p.variants[section.id][0].id);
        assert.equal(p.variants[section.id][0].label, STRINGS.manager.defaultChoiceLabel);
    }
    assert.equal(makeDefaultPersona(ids, 'bogus').headingFormat, 'none');
});

test('isEmptyPersona: untouched shell is empty, any content is not', () => {
    const shell = makeDefaultPersona(ids);
    assert.equal(isEmptyPersona(shell), true);
    const withText = makeDefaultPersona(ids);
    withText.variants[withText.sections[0].id][0].text = 'x';
    assert.equal(isEmptyPersona(withText), false);
    const renamed = makeDefaultPersona(ids);
    renamed.sections[0].name = '다른 이름';
    assert.equal(isEmptyPersona(renamed), false);
    const tagged = makeDefaultPersona(ids);
    tagged.tags.push('t');
    assert.equal(isEmptyPersona(tagged), false);
    const named = makeDefaultPersona(ids);
    named.names = { en: 'Mira' };
    assert.equal(isEmptyPersona(named), false);
    const folder = makeDefaultPersona(ids);
    folder.assetFolderKey = 'persona_x';
    assert.equal(isEmptyPersona(folder), false);
    assert.equal(isEmptyPersona({ sections: [] }), true);
    assert.equal(isEmptyPersona(null), true);
});

test('pruneEmpty removes only shells', () => {
    const root = emptyRoot();
    ensurePersona(root, 'a', ids);
    const b = ensurePersona(root, 'b', ids);
    b.log.push({ at: 1, kind: 'import', detail: '' });
    assert.deepEqual(pruneEmpty(root), ['a']);
    assert.deepEqual(Object.keys(root.personas), ['b']);
});

test('textSignature is stable and carries the length', () => {
    assert.equal(textSignature('abc'), textSignature('abc'));
    assert.notEqual(textSignature('abc'), textSignature('abd'));
    assert.ok(textSignature('abc').startsWith('3:'));
    assert.equal(textSignature(null), textSignature(''));
});

test('makeId falls back when no generator is given and usageBytes measures JSON', () => {
    assert.ok(makeId(undefined).startsWith('pm-'));
    assert.equal(makeId(() => 'x'), 'x');
    assert.equal(usageBytes({ a: 1 }), 7);
});
