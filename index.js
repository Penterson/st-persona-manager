// Entry point. Wires events and exposes a destroy hook.
import { MODULE_NAME } from './modules/store.js';
import { initPrecise, refresh, refreshAssets, getState, resetState, autoAbsorbOutside } from './modules/state.js';
import { freshContext } from './modules/ctx.js';
import {
    resolveFolderKey, renderInElement, registerAssetMacros, unregisterAssetMacros,
    listAssets, assetLookup, lookupLabel, resetAssetProbes, assetNameFromPath,
} from './modules/assets.js';
import { mountQuickbar, unmountQuickbar, notify, scheduleAutoName } from './modules/quickbar.js';
import { STRINGS } from './modules/strings.js';
import { mountManager, unmountManager } from './modules/manager.js';
import { mountSettings, unmountSettings } from './modules/settings-ui.js';
import { installGestureTracking, resetGestureTracking, debounced } from './modules/dom.js';
import { syncGreetingInContext } from './modules/greeting.js';

const listeners = [];
let chatObserver = null;
// folderKey -> Map(label -> path), for folder-qualified tags naming another persona's folder.
const folders = new Map();

// Nothing here keeps a context (see freshContext): every handler asks for its own.
function on(typeName, fn) {
    const ctx = freshContext();
    const type = ctx?.event_types?.[typeName];
    if (!type) { console.warn(`[${MODULE_NAME}] event ${typeName} is unavailable on this build`); return; }
    ctx.eventSource.on(type, fn);
    listeners.push([type, fn]);
}

// One part failing to mount must not take the rest down.
function safely(label, fn) {
    try { fn(); } catch (e) { console.error(`[${MODULE_NAME}] ${label} failed to mount`, e); }
}

// Resolves a {{pimg::}} tag to the path the server listed for it, or null.
function resolveTag({ folderKey, filename }) {
    const s = getState();
    if (!s) return null;
    const own = s.avatar ? resolveFolderKey(s.root, s.avatar) : null;
    // Only paths the server listed: a guessed URL can render as a broken image.
    if (!folderKey || folderKey === own) {
        if (!own) return null;
        return lookupLabel(s.assetPaths, filename);
    }
    const hit = assetLookup(folders, folderKey, filename);
    if (hit.fetch) {
        // Marked before the request so a sweep issues one listing per folder, not per tag.
        folders.set(folderKey, null);
        const ctx = freshContext();
        if (!ctx) { folders.set(folderKey, new Map()); return hit.path; }
        listAssets(ctx, folderKey)
            .then(list => folders.set(folderKey, new Map(list.map(a => [a.label, a.path]))))
            // An unlistable folder stays empty, so its tags stay text and nothing retries in a loop.
            .catch(() => folders.set(folderKey, new Map()))
            // Tags seen while the listing was pending stayed text; the Map stops a new request.
            .then(() => renderAll());
    }
    return hit.path;
}

function render(el) {
    renderInElement(el, resolveTag, getState()?.settings.assetStyle);
}

function renderOne(messageIndex) {
    const el = document.querySelector(`#chat [mesid="${messageIndex}"] .mes_text`);
    if (el) render(el);
}

function renderAll() {
    // Per-message events fire only for new messages; this sweep renders the history.
    for (const el of document.querySelectorAll('#chat .mes_text')) render(el);
}

// SillyTavern refills off-screen messages on scroll-back without message events, so this
// observer re-renders {{pimg::}} tags.
function startChatObserver() {
    const chat = document.getElementById('chat');
    if (!chat || chatObserver) return;

    const pending = new Set();
    let frame = 0;

    const flush = () => {
        frame = 0;
        const batch = [...pending];
        pending.clear();
        for (const el of batch) {
            // A rehydration can replace the node again before the frame runs.
            if (el.isConnected) render(el);
        }
    };

    const collect = node => {
        if (!node || node.nodeType !== 1) return;
        // Before closest(), which counts the node itself.
        if (node.matches?.('.mes_text')) { pending.add(node); return; }
        // Inside a .mes_text, the host is collected via record.target below.
        if (node.closest?.('.mes_text')) return;
        for (const found of node.querySelectorAll?.('.mes_text') ?? []) pending.add(found);
    };

    chatObserver = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) collect(node);
            // A refill that only swaps text nodes reports the .mes_text as the target.
            const host = record.target?.nodeType === 1
                ? record.target.closest?.('.mes_text')
                : record.target?.parentElement?.closest?.('.mes_text');
            if (host) pending.add(host);
        }
        // One pass per frame.
        if (pending.size && !frame) frame = requestAnimationFrame(flush);
    });

    // Scoped to #chat. Loop-safe because renderInElement writes nothing when no tag resolved.
    chatObserver.observe(chat, { childList: true, subtree: true, characterData: true });
}

/* A picture replaced under the same name: rendered <img>s are repointed, dropping the old size. */
function repointChatAssets() {
    const s = getState();
    if (!s?.assetPaths?.size) return;
    for (const img of document.querySelectorAll('#chat img.pm-asset')) {
        const src = img.getAttribute('src') ?? '';
        const fresh = lookupLabel(s.assetPaths, assetNameFromPath(src));
        if (!fresh || fresh === src) continue;
        if (fresh.split('?')[0] !== src.split('?')[0]) continue;
        img.removeAttribute('width');
        img.removeAttribute('height');
        img.setAttribute('src', fresh);
    }
}

/* Keeps {{user}} in an unanswered greeting on the playing persona (greeting.js says why).
   seenUserNames: every name1 seen this session, what a baked greeting can hold. */
const seenUserNames = new Set();

function noteUserName() {
    const name = freshContext()?.name1;
    if (typeof name === 'string' && name.trim()) seenUserNames.add(name.trim());
}

function greetingNames(ctx) {
    const s = getState();
    const own = new Set(seenUserNames);
    for (const name of Object.values(s?.persona?.names ?? {})) if (typeof name === 'string') own.add(name);
    const mapped = ctx?.powerUserSettings?.personas?.[s?.avatar];
    if (typeof mapped === 'string') own.add(mapped);
    const broad = new Set(own);
    for (const name of Object.values(ctx?.powerUserSettings?.personas ?? {})) if (typeof name === 'string') broad.add(name);
    for (const persona of Object.values(s?.root?.personas ?? {})) {
        for (const name of Object.values(persona?.names ?? {})) if (typeof name === 'string') broad.add(name);
    }
    return { narrow: [...own], broad: [...broad] };
}

function syncGreeting() {
    const ctx = freshContext();
    if (!ctx) return;
    syncGreetingInContext(ctx, greetingNames(ctx));
    noteUserName();
}

// After SillyTavern's own reaction to a persona event, so this acts on the result.
const greetingSync = debounced(() => syncGreeting(), 120);

/* SillyTavern's persona box saves and emits PERSONA_UPDATED on every keystroke
   (onPersonaDescriptionInput), so an edit there is taken in after a pause, not per key. */
const absorb = debounced(() => {
    if (autoAbsorbOutside()?.ok) document.dispatchEvent(new CustomEvent('pm:changed'));
}, 700);

function absorbIfDiverged() {
    const s = getState();
    if (s?.diverged && s.settings?.autoAbsorbOutside !== false) absorb.schedule();
}

function stopChatObserver() {
    chatObserver?.disconnect();
    chatObserver = null;
}

async function init() {
    if (!freshContext()) { console.warn(`[${MODULE_NAME}] getContext unavailable, extension disabled`); return; }

    refresh();
    noteUserName();
    // Before any screen mounts, so the first tap is already tracked (see afterGesture in dom.js).
    installGestureTracking();
    // UI mounts before the awaits, none of which it needs: late UI looks broken.
    safely('quickbar', mountQuickbar);
    safely('manager', mountManager);
    safely('settings', mountSettings);

    await initPrecise();
    // Torn down while waiting: stop, or listeners would outlive the instance.
    if (!alive) return;
    // Again, now that the precise api can tell same-named personas apart.
    refresh();
    // Edited in SillyTavern while the extension was off.
    absorbIfDiverged();
    // Read before the fetch, whose listing is for this persona.
    const assetsAvatar = getState()?.avatar ?? null;
    await refreshAssets();
    if (!alive) return;
    // Used only to register; the macro callbacks read getState, not this context.
    const ctx = freshContext();
    if (ctx) {
        // registerAssetMacros returns quietly without registerMacro, so the warning is here.
        if (typeof ctx.registerMacro !== 'function') {
            notify('warning', STRINGS.common.noRegisterMacro);
        }
        safely('macros', () => registerAssetMacros(ctx, getState));
    }

    // Assets are refetched only on an avatar change, seeded so the first event does not refetch.
    let lastAvatar = assetsAvatar;
    /* SETTINGS_UPDATED echoes every save a second later, and a redraw replaces the scroll box
       mid-gesture, so an echo that changes nothing shown (view) is dropped. */
    let lastView = null;
    const viewChanged = () => {
        const ctx = freshContext();
        const pu = ctx?.powerUserSettings ?? {};
        const s = getState();
        const view = [s?.avatar ?? null, s?.source ?? null, !!s?.ambiguous, !!s?.readOnly,
            s?.persona ?? null, s?.root ?? null, ctx?.name1, pu.persona_description, pu.default_persona];
        const descriptors = pu.persona_descriptions ?? {};
        for (const [avatar, name] of Object.entries(pu.personas ?? {})) {
            const d = descriptors[avatar];
            view.push(avatar, name, d?.description, d?.lorebook, d?.position, d?.depth, d?.role, d?.title);
        }
        const same = lastView !== null && lastView.length === view.length
            && view.every((value, i) => Object.is(value, lastView[i]));
        lastView = view;
        return !same;
    };
    const onPersona = async origin => {
        refresh();
        absorbIfDiverged();
        if (origin !== 'settings') greetingSync.schedule();
        const avatar = getState()?.avatar ?? null;
        if (avatar !== lastAvatar) {
            lastAvatar = avatar;
            // Repaint first: the listing is a slow round trip nothing on pm:changed reads.
            document.dispatchEvent(new CustomEvent('pm:changed'));
            await refreshAssets();
            // Tags unresolved under the previous persona may resolve now.
            renderAll();
        }
        if (!viewChanged() && origin === 'settings') return;
        document.dispatchEvent(new CustomEvent('pm:changed'));
    };
    // Per-language auto-naming (debounced, a no-op unless enabled). Not on USER_MESSAGE_RENDERED,
    // which fires as generation begins; the reply carries the same signal.
    const onChatText = () => scheduleAutoName();
    on('PERSONA_CHANGED', onPersona);
    on('SETTINGS_UPDATED', () => onPersona('settings'));
    on('PERSONA_UPDATED', onPersona);
    on('PERSONA_RENAMED', onPersona);
    on('PERSONA_CREATED', onPersona);
    on('PERSONA_DELETED', onPersona);
    on('CHAT_CHANGED', async () => {
        // Outside any render loop, so failed listings (cached as empty) are retried here.
        folders.clear();
        await onPersona();
        // Our own folder too: onPersona refetches only when the persona changed.
        if (getState()?.assetError) await refreshAssets();
        renderAll();
        onChatText();
    });
    on('USER_MESSAGE_RENDERED', i => renderOne(i));
    on('CHARACTER_MESSAGE_RENDERED', i => { renderOne(i); onChatText(); });
    on('MESSAGE_UPDATED', i => renderOne(i));
    // A greeting swipe shows an alternate that may carry an old user name (message 0 only).
    on('MESSAGE_SWIPED', i => {
        if (Number(i) !== 0) return;
        syncGreeting();
        renderOne(0);
        onChatText();
    });
    document.addEventListener('pm:assets-changed', repointChatAssets);

    renderAll();
    startChatObserver();
    // Repaints the icon and catches a persona switch made during the awaits.
    void onPersona();
}

// False once destroy() has run, so an init still waiting on its awaits stops.
let alive = true;

function destroy() {
    alive = false;
    stopChatObserver();
    document.removeEventListener('pm:assets-changed', repointChatAssets);
    unmountQuickbar();
    unmountManager();
    // The id sweep at the end also catches a panel built by a previous load of this file.
    unmountSettings();
    const ctx = freshContext();
    if (ctx) {
        for (const [type, fn] of listeners) ctx.eventSource.removeListener(type, fn);
        unregisterAssetMacros(ctx);
    }
    listeners.length = 0;
    folders.clear();
    greetingSync.cancel();
    absorb.cancel();
    seenUserNames.clear();
    resetAssetProbes();
    resetGestureTracking();
    resetState();
    document.getElementById(`${MODULE_NAME}_settings`)?.remove();
    if (globalThis.__personaManagerDestroy === destroy) delete globalThis.__personaManagerDestroy;
}

function boot() {
    // An extension reload tears down the previous instance first. Published before init, so an
    // instance awaiting APP_READY is reachable.
    const previous = globalThis.__personaManagerDestroy;
    if (typeof previous === 'function') {
        try { previous(); } catch (e) { console.warn(`[${MODULE_NAME}] previous instance teardown`, e); }
    }
    globalThis.__personaManagerDestroy = destroy;
    // Through on() so destroy() can remove it.
    if (freshContext()?.event_types?.APP_READY) on('APP_READY', init);
    else init();
}

boot();
