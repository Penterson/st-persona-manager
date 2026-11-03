// Entry point. Wires events and exposes a destroy hook.
import { MODULE_NAME } from './modules/store.js';
import { initPrecise, refresh, refreshAssets, getState, resetState } from './modules/state.js';
import { freshContext } from './modules/ctx.js';
import {
    resolveFolderKey, renderInElement, registerAssetMacros, unregisterAssetMacros,
    listAssets, assetLookup, lookupLabel, resetAssetProbes, assetNameFromPath,
} from './modules/assets.js';
import { mountQuickbar, unmountQuickbar, notify, scheduleAutoName } from './modules/quickbar.js';
import { STRINGS } from './modules/strings.js';
import { mountManager, unmountManager } from './modules/manager.js';
import { mountSettings, unmountSettings } from './modules/settings-ui.js';
import { installGestureTracking, resetGestureTracking } from './modules/dom.js';
import { syncGreetingInContext } from './modules/greeting.js';

const listeners = [];
let chatObserver = null;
// folderKey -> Map(label -> path). Folder-qualified tags exist so old messages resolve
// whichever persona is active, so they often name a folder other than the current one.
const folders = new Map();

// Nothing here keeps a context (see freshContext): every handler asks for its own.
function on(typeName, fn) {
    const ctx = freshContext();
    const type = ctx?.event_types?.[typeName];
    if (!type) { console.warn(`[${MODULE_NAME}] event ${typeName} is unavailable on this build`); return; }
    ctx.eventSource.on(type, fn);
    listeners.push([type, fn]);
}

// One part failing to mount must not take the rest down: a throw would reject init
// before any event listener is registered.
function safely(label, fn) {
    try { fn(); } catch (e) { console.error(`[${MODULE_NAME}] ${label} failed to mount`, e); }
}

// Resolves a {{pimg::}} tag to the path the server listed for it, or null.
function resolveTag({ folderKey, filename }) {
    const s = getState();
    if (!s) return null;
    const own = s.avatar ? resolveFolderKey(s.root, s.avatar) : null;
    // Only paths the server listed: a guessed URL for a name the server sanitised
    // differently renders as a broken image, worse than leaving the tag as text.
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
            // A folder we cannot list stays an empty listing, so its tags remain
            // plain text and we never retry in a render loop.
            .catch(() => folders.set(folderKey, new Map()))
            // Redraw all: while the listing was pending, later tags saw fetch:false and
            // stayed text. The key now holds a Map, so this cannot issue a new request.
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

// SillyTavern empties off-screen messages and refills them on scroll-back without
// firing message events, so this observer re-renders {{pimg::}} tags on refill.
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
        // Before closest(), which counts the node itself: a new .mes_text would take that
        // early return, and its addition targets the parent .mes, so it would be lost.
        if (node.matches?.('.mes_text')) { pending.add(node); return; }
        // Inside a .mes_text (a streaming refill), the host is collected via record.target
        // below; walking the subtree for every appended node would be wasted work.
        if (node.closest?.('.mes_text')) return;
        for (const found of node.querySelectorAll?.('.mes_text') ?? []) pending.add(found);
    };

    chatObserver = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) collect(node);
            // A refill that only swaps text nodes reports the .mes_text itself as the
            // target, and that node is not in addedNodes.
            const host = record.target?.nodeType === 1
                ? record.target.closest?.('.mes_text')
                : record.target?.parentElement?.closest?.('.mes_text');
            if (host) pending.add(host);
        }
        // One pass per frame, not one per node SillyTavern appends while filling a message.
        if (pending.size && !frame) frame = requestAnimationFrame(flush);
    });

    // Scoped to #chat for cost. Not loop-safe by idempotence (unresolved tags stay matchable):
    // it relies on renderInElement writing nothing when no tag resolved.
    chatObserver.observe(chat, { childList: true, subtree: true, characterData: true });
}

/* A picture replaced under the same name: rendered tags are already <img>s, so a new listing
   changes nothing on screen. Repoint them, dropping the old size (the shape may differ). */
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
   seenUserNames: every name1 seen this session, i.e. what a baked greeting can hold. */
const seenUserNames = new Set();
let greetingTimer = 0;

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

// After SillyTavern has finished its own reaction to a persona event (a switch
// re-sends an untouched greeting on some builds), so this acts on the result.
function scheduleGreetingSync() {
    if (greetingTimer) clearTimeout(greetingTimer);
    greetingTimer = setTimeout(() => { greetingTimer = 0; syncGreeting(); }, 120);
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
    // UI mounts before the awaits: anything that appears seconds late looks broken. None
    // needs what they bring: paintButton copes with no avatar yet, the manager waits for
    // pm:open-manager, and the settings drawer reads getRoot() when opened.
    safely('quickbar', mountQuickbar);
    safely('manager', mountManager);
    safely('settings', mountSettings);

    await initPrecise();
    // Torn down while waiting (a newer load of this file took over): stop here, or
    // the rest of init would register listeners that nothing can take back off.
    if (!alive) return;
    // Again, now that the precise api has landed: name1 alone cannot tell apart two
    // personas with the same name. Cheap: no request, no DOM.
    refresh();
    // Read before the fetch, because the listing is for this persona: read after, a move
    // mid-fetch would seed lastAvatar wrongly and the first event would skip its refetch.
    const assetsAvatar = getState()?.avatar ?? null;
    await refreshAssets();
    if (!alive) return;
    // Used only to register; the macro callbacks read getState, not this context.
    const ctx = freshContext();
    if (ctx) {
        // Without registerMacro only the asset macros are lost, and registerAssetMacros
        // returns quietly, so warn here or {{persona_assets}} sits in prompts unexplained.
        if (typeof ctx.registerMacro !== 'function') {
            notify('warning', STRINGS.common.noRegisterMacro);
        }
        safely('macros', () => registerAssetMacros(ctx, getState));
    }

    // Assets are refetched only on an avatar change (PERSONA_UPDATED fires on every version
    // switch). Seeded so the first event, usually init's own settings save, does not refetch.
    let lastAvatar = assetsAvatar;
    /* SETTINGS_UPDATED echoes every save, ours included, a second later, and a redraw
       replaces the scroll box mid-gesture, so an echo that changes nothing shown is dropped.
       view lists the SillyTavern data screens show; our own writes redraw on their own. */
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
        if (origin !== 'settings') scheduleGreetingSync();
        const avatar = getState()?.avatar ?? null;
        if (avatar !== lastAvatar) {
            lastAvatar = avatar;
            /* Repaint first: the listing is a round trip that can be slow or fail, and
               nothing that reacts to pm:changed reads it. */
            document.dispatchEvent(new CustomEvent('pm:changed'));
            await refreshAssets();
            /* Tags that resolved to nothing under the previous persona may resolve now;
               a sweep that finds nothing changes no node. */
            renderAll();
        }
        if (!viewChanged() && origin === 'settings') return;
        document.dispatchEvent(new CustomEvent('pm:changed'));
    };
    // Per-language auto-naming; a no-op unless enabled, and debounced inside. Not on
    // USER_MESSAGE_RENDERED: that fires as generation begins and this ends in a
    // /persona-set; the character's reply carries the same language signal at turn end.
    const onChatText = () => scheduleAutoName();
    on('PERSONA_CHANGED', onPersona);
    on('SETTINGS_UPDATED', () => onPersona('settings'));
    on('PERSONA_UPDATED', onPersona);
    on('PERSONA_RENAMED', onPersona);
    on('PERSONA_CREATED', onPersona);
    on('PERSONA_DELETED', onPersona);
    on('CHAT_CHANGED', async () => {
        // Opening a chat happens once, by choice, outside any render loop, so failed
        // listings (cached as empty) are retried here.
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
    // A greeting swipe shows a stored alternate that may carry an old user name. Only
    // message 0: a swipe on a reply starts a generation and is not ours.
    on('MESSAGE_SWIPED', i => {
        if (Number(i) !== 0) return;
        syncGreeting();
        renderOne(0);
        onChatText();
    });
    document.addEventListener('pm:assets-changed', repointChatAssets);

    renderAll();
    startChatObserver();
    // Repaints the icon painted before the precise api, and catches a persona switch made
    // during the awaits, before these listeners existed.
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
    if (greetingTimer) clearTimeout(greetingTimer);
    greetingTimer = 0;
    seenUserNames.clear();
    resetAssetProbes();
    resetGestureTracking();
    resetState();
    document.getElementById(`${MODULE_NAME}_settings`)?.remove();
    if (globalThis.__personaManagerDestroy === destroy) delete globalThis.__personaManagerDestroy;
}

function boot() {
    // A re-evaluation (extension reload without page reload) tears down the previous
    // instance first. Published here, not after init, so one awaiting APP_READY is reachable.
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
