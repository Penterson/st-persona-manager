// Entry point. Wires events and exposes a destroy hook.
import { MODULE_NAME } from './modules/store.js';
import { initPrecise, refresh, refreshAssets, getState, resetState } from './modules/state.js';
import { freshContext } from './modules/ctx.js';
import {
    resolveFolderKey, renderInElement, registerAssetMacros, unregisterAssetMacros,
    listAssets, assetLookup, lookupLabel, resetAssetProbes,
} from './modules/assets.js';
// cancelAutoName is not imported here: unmountQuickbar already calls it, and an
// import nothing calls reads like a teardown step somebody forgot to wire.
import { mountQuickbar, unmountQuickbar, notify, scheduleAutoName } from './modules/quickbar.js';
// Even this file's one boot warning comes from the same map.
import { STRINGS } from './modules/strings.js';
import { mountManager, unmountManager } from './modules/manager.js';
import { mountSettings, unmountSettings } from './modules/settings-ui.js';

const listeners = [];
let chatObserver = null;
// folderKey to Map(label to path). A folder qualified tag names a folder that is
// often not the current persona's, and the qualified form exists precisely so
// old messages resolve whoever is active now.
const folders = new Map();

// Nothing here keeps a context. getContext() copies name1, chat and characterId by
// value, so a context captured at load describes the persona that was active at load,
// and every handler below outlives that moment. Each one asks for its own.
function on(typeName, fn) {
    const ctx = freshContext();
    const type = ctx?.event_types?.[typeName];
    if (!type) { console.warn(`[${MODULE_NAME}] event ${typeName} is unavailable on this build`); return; }
    ctx.eventSource.on(type, fn);
    listeners.push([type, fn]);
}

// One part failing to mount must not take the rest down with it. init is async
// and a throw here rejected it before a single event listener was registered:
// an icon on screen that never refreshed, and no destroy hook to recover with.
function safely(label, fn) {
    try { fn(); } catch (e) { console.error(`[${MODULE_NAME}] ${label} failed to mount`, e); }
}

function styleNow() { return getState()?.settings.assetStyle; }

function resolvePathFactory(el) {
    return ({ folderKey, filename }) => {
        const s = getState();
        if (!s) return null;
        const own = s.avatar ? resolveFolderKey(s.root, s.avatar) : null;
        // Only ever use the path the server handed back. We do not build these URLs
        // ourselves, and a guessed path for a name the server sanitised differently
        // renders as a broken image, which is worse than leaving the tag as text
        // for the user to see and fix.
        if (!folderKey || folderKey === own) {
            if (!own) return null;
            return lookupLabel(s.assetPaths, filename);
        }
        const hit = assetLookup(folders, folderKey, filename);
        if (hit.fetch) {
            // Mark it before the request so a sweep over many messages naming the
            // same folder issues one listing, not one per tag.
            folders.set(folderKey, null);
            // Fetched with the context of this moment, not of the render that built
            // this closure. getRequestHeaders is the only thing needed here.
            const ctx = freshContext();
            if (!ctx) { folders.set(folderKey, new Map()); return hit.path; }
            listAssets(ctx, folderKey)
                .then(list => folders.set(folderKey, new Map(list.map(a => [a.label, a.path]))))
                // A folder we cannot list stays an empty listing, so its tags remain
                // plain text and we never retry in a render loop.
                .catch(() => folders.set(folderKey, new Map()))
                // Every message naming this folder, not just the one whose render
                // happened to issue the request. The marker above is what makes a
                // sweep over a chat send ONE listing, and the cost of that is that
                // every later element saw fetch:false with no listing to use yet
                // and left its tags as raw text. They are redrawn here, where the
                // listing finally exists. No new request can come of it: the key
                // now holds a Map, so assetLookup answers from it.
                .then(() => renderAll());
        }
        return hit.path;
    };
}

function renderOne(messageIndex) {
    const el = document.querySelector(`#chat [mesid="${messageIndex}"] .mes_text`);
    if (el) renderInElement(el, resolvePathFactory(el), styleNow());
}

function renderAll() {
    // Per message events only fire for new messages. Without this sweep, tags in
    // history stay as raw text after a chat is opened.
    for (const el of document.querySelectorAll('#chat .mes_text')) {
        renderInElement(el, resolvePathFactory(el), styleNow());
    }
}

// Measured on the device: .mes carries data-perf-dehydrated and data-perf-height.
// Messages scrolled off screen have their content emptied and refilled when they
// come back.
// The per message events do not fire for that refill and the CHAT_CHANGED sweep is
// long over, so without this observer scrolling up and back turns rendered images
// into raw {{pimg::}} text.
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
            if (el.isConnected) renderInElement(el, resolvePathFactory(el), styleNow());
        }
    };

    const collect = node => {
        if (!node || node.nodeType !== 1) return;
        // Matched first, because closest() counts the node itself and would send a
        // freshly added .mes_text down the early return below, where nothing else
        // would pick it up: its own addition is reported against the parent .mes.
        if (node.matches?.('.mes_text')) { pending.add(node); return; }
        // A node added inside a .mes_text is a streaming refill, and the .mes_text
        // around it is already being collected from record.target below. Without
        // this, every element appended while a message streams walks that whole
        // message's subtree looking for a .mes_text it cannot contain.
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
        // One pass per frame. Reacting per mutation would run the whole tree walk
        // once for every node SillyTavern appends while filling a message.
        if (pending.size && !frame) frame = requestAnimationFrame(flush);
    });

    // Scoped to #chat, never the document. A document wide observer in an earlier
    // project of this user's cost more than it saved.
    // Idempotence alone does NOT make this safe, and the comment that used to say so
    // was wrong. A tag that became an image is no longer matchable, but a tag that
    // resolved to nothing stays matchable forever, so every pass would rewrite the
    // same text node with an identical copy, that write is a childList mutation, and
    // the mutation brings us straight back here. What keeps the loop from running is
    // renderInElement writing nothing when no tag resolved.
    chatObserver.observe(chat, { childList: true, subtree: true, characterData: true });
}

function stopChatObserver() {
    chatObserver?.disconnect();
    chatObserver = null;
}

async function init() {
    if (!freshContext()) { console.warn(`[${MODULE_NAME}] getContext unavailable, extension disabled`); return; }

    refresh();
    // Before both awaits. The icon used to wait on a dynamic import the device
    // diagnostics record as failing on this build, and then on a sprites request,
    // so it appeared seconds after the send form did. This first refresh has no
    // precise api yet, which only costs the precise path a moment, and paintButton
    // handles a state with no avatar in it.
    safely('quickbar', mountQuickbar);
    // Listens for the quick panel footer's pm:open-manager and nothing else, so
    // it costs nothing until the user opens it. Mounted here rather than after the
    // awaits below for the same reason the icon is: a screen that cannot be opened
    // for the first seconds of a session looks broken.
    safely('manager', mountManager);
    // Mounted before the awaits for the same reason: the drawer is
    // built once into a host SillyTavern has already laid out, and an extension
    // whose settings row appears seconds late reads as one that failed to load.
    // It draws from getRoot() at open time, so it needs nothing that comes later.
    safely('settings', mountSettings);

    await initPrecise();
    // The precise api can name a persona that name1 alone cannot (two personas with
    // the same name resolve to nothing without it), so the cache built above has to
    // be built again now that the import has landed. Cheap: no request, no DOM.
    refresh();
    // Read before the listing is fetched, because this is the persona the listing is
    // for: refreshAssets resolves the avatar at its own first line and publishes only
    // if we are still on it. Read after the await instead, a persona move during the
    // fetch would seed the guard below with the persona we did NOT fetch for, and the
    // first event would then skip the refetch that move actually needs.
    const assetsAvatar = getState()?.avatar ?? null;
    await refreshAssets();
    // Read after the awaits above, and used only to register. The macro callbacks
    // themselves close over getState, not over a context.
    const ctx = freshContext();
    if (ctx) {
        // An older build with no registerMacro loses the two asset
        // macros and nothing else. registerAssetMacros returns quietly in that case,
        // so this is the one place that can say it: without it the user finds
        // {{persona_assets}} sitting in their prompt as raw text with no explanation
        // anywhere. Once per load, because init runs once.
        if (typeof ctx.registerMacro !== 'function') {
            notify('warning', STRINGS.common.noRegisterMacro);
        }
        safely('macros', () => registerAssetMacros(ctx, getState));
    }

    // writeDescription emits PERSONA_UPDATED, so this runs on every version switch.
    // Refetching the sprite list each time would fire a request per tap for no gain,
    // since assets only change when the persona changes.
    //
    // Seeded from the persona the listing above was actually fetched for. Starting at
    // null makes the first event of the session, which is usually the settings save
    // this very init triggers, fetch the same list a second time.
    let lastAvatar = assetsAvatar;
    /* SETTINGS_UPDATED arrives after every settings save, ours included: each
       write already redrew from its own commit, then PERSONA_UPDATED redrew again,
       and a second or so later the save's own echo redrew a third time - landing
       on whatever the thumb was doing by then, a fling through the list or an
       open sort menu, because a redraw replaces the scroll box. An echo that
       changes nothing a screen can show is dropped. What a screen shows of
       SillyTavern's own data is listed here; our own data only changes through our
       own writes, and every one of those redraws on its own. Compared by identity,
       so an unchanged description costs a pointer check, not a text compare. */
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
        const avatar = getState()?.avatar ?? null;
        if (avatar !== lastAvatar) {
            lastAvatar = avatar;
            /* The screen first, the listing after. refreshAssets is a round trip
               to the sprites API, and everything that reacts to pm:changed - the
               icon beside the send box, an open panel, an open manager - was
               queued behind it: on a phone talking to a Termux server the icon
               kept the previous persona's picture for as long as that request
               took, and for the whole session when it failed. Nothing in that
               repaint reads the asset list. */
            document.dispatchEvent(new CustomEvent('pm:changed'));
            await refreshAssets();
            /* And the messages already on screen. The per message events only fire
               for new ones, so a {{pimg::}} tag that resolved to nothing under the
               previous persona - which is every tag naming a file in THIS
               persona's folder - stayed as raw text until the chat was reopened.
               renderInElement writes nothing when no tag resolves, so a sweep that
               finds nothing costs one pass and changes no node. */
            renderAll();
        }
        if (!viewChanged() && origin === 'settings') return;
        document.dispatchEvent(new CustomEvent('pm:changed'));
    };
    // 언어별 이름 자동 적용 (user request). The chat is what decides, so the
    // moments worth looking are the ones where the chat changed. Returns
    // immediately unless the user turned the setting on, and debounces inside,
    // because these events arrive together and the work ends in a persona switch.
    //
    // Deliberately NOT on USER_MESSAGE_RENDERED. That one fires as generation
    // begins, and this ends in a /persona-set: renaming the persona in the middle
    // of a reply is a thing nobody asked for at a moment nobody can see. The
    // character's reply carries the same language signal and arrives at the end
    // of the turn, which is when it is safe to act on.
    const onChatText = () => scheduleAutoName();
    on('PERSONA_CHANGED', onPersona);
    on('SETTINGS_UPDATED', () => onPersona('settings'));
    on('PERSONA_UPDATED', onPersona);
    on('PERSONA_RENAMED', onPersona);
    on('PERSONA_CREATED', onPersona);
    on('PERSONA_DELETED', onPersona);
    on('CHAT_CHANGED', async () => {
        // A folder whose listing failed is remembered as an empty listing, on
        // purpose: retrying it inside a render sweep would put one request per tag
        // per frame on the wire. But nothing ever cleared it either, so a single
        // failure - a server restarting, a phone that lost its connection for a
        // second - left every tag naming that folder as raw text for the rest of
        // the session. Opening a chat is a moment the user chose, it happens once,
        // and it is not inside a render loop, so it is where the answers are asked
        // for again.
        folders.clear();
        await onPersona();
        // Our OWN folder's listing gets the same second chance. onPersona only
        // refetches when the persona changed, so a sprites request that failed
        // during a switch - a Termux server restarting, a phone off the network
        // for a second - left this persona's own tags as raw text with no way
        // back but switching away and switching back. Opening a chat is a moment
        // the user chose, it happens once, and it is not inside a render loop.
        if (getState()?.assetError) await refreshAssets();
        renderAll();
        onChatText();
    });
    on('USER_MESSAGE_RENDERED', i => renderOne(i));
    on('CHARACTER_MESSAGE_RENDERED', i => { renderOne(i); onChatText(); });
    on('MESSAGE_UPDATED', i => renderOne(i));

    renderAll();
    startChatObserver();
    // Not a second mount: the guard inside mountQuickbar makes the call that used to
    // stand here do nothing at all. The icon was painted before both awaits, from a
    // state resolved without the precise api and before the sprite listing, so its
    // label can name a persona the precise path has since resolved differently. One
    // event repaints it through the listener mounted above.
    //
    // Through onPersona rather than a bare event: the listeners above were
    // registered after two awaits, and a persona switch inside that window was
    // heard by nobody, so the cache and the asset listing stayed on the persona
    // the page loaded with until the next event. onPersona refreshes, refetches
    // the listing only if the persona moved, and sends the event.
    void onPersona();
    globalThis.__personaManagerDestroy = destroy;
}

function destroy() {
    stopChatObserver();
    unmountQuickbar();
    // Takes the document listeners back off and closes the dialog if it is open.
    unmountManager();
    // Removes the settings drawer and its listener. The id sweep below stays as a
    // second line of defence for a panel built by a previous load of this file.
    unmountSettings();
    const ctx = freshContext();
    if (ctx) {
        for (const [type, fn] of listeners) ctx.eventSource.removeListener(type, fn);
        unregisterAssetMacros(ctx);
    }
    listeners.length = 0;
    folders.clear();
    // What the upload learned about this server is state like any other, and
    // teardown leaves none behind.
    resetAssetProbes();
    resetState();
    document.getElementById(`${MODULE_NAME}_settings`)?.remove();
    delete globalThis.__personaManagerDestroy;
}

// In a function, so the context read here cannot outlive the decision it is read for.
function boot() {
    // Registered through on() so destroy() can take it back off. A subscription made
    // outside the helper is invisible to the listener list and survives teardown.
    if (freshContext()?.event_types?.APP_READY) on('APP_READY', init);
    else init();
}

boot();
