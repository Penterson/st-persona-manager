// The confirm-dialog rule strings.js states at its top, checked rather than
// remembered. The clause-ending rules are in wording.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../modules/strings.js';

// Every string a function in the map can produce, rendered with sample arguments.
function* leaves(node, path = []) {
    for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string') yield [[...path, key].join('.'), value];
        else if (typeof value === 'function') yield [[...path, key].join('.'), value('예시', 3)];
        else if (value && typeof value === 'object' && !Array.isArray(value)) yield* leaves(value, [...path, key]);
    }
}

test('confirm dialogs name the act and stop: no 까?, at most 60 characters', () => {
    for (const [path, text] of leaves(STRINGS)) {
        // Anywhere in the key: copyConfirm and fullTextConfirmLeave are confirms
        // too, and a word boundary in front skipped them.
        if (!/confirm/i.test(path)) continue;
        assert.equal(/까\?/.test(text), false, `${path} asks a question: ${text}`);
        assert.ok(text.length <= 60, `${path} is ${text.length} characters: ${text}`);
    }
});

test('the strings table is frozen and every log kind reads as Korean', () => {
    assert.ok(Object.isFrozen(STRINGS) && Object.isFrozen(STRINGS.manager.logKinds));
    for (const [kind, label] of Object.entries(STRINGS.manager.logKinds)) {
        assert.ok(/[가-힣]/.test(label), `${kind} has no Korean label`);
    }
});

test('the shipped asset prompt is not on the legacy list, and the legacy list stays', () => {
    assert.equal(STRINGS.settings.legacyAssetPrompts.includes(STRINGS.settings.assetPromptDefault), false);
    assert.ok(STRINGS.settings.legacyAssetPrompts.length >= 2);
});
