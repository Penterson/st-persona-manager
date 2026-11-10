// Persona image assets on top of SillyTavern's sprites API.
import { findVersion, fnv1a } from './store.js';
import { validCrop, cropPixels, writtenKey, cropFromView, viewFromCrop } from './framing.js';

const PREFIX = 'persona_';
// sanitize-filename truncates to 255 bytes, counted over the whole key, prefix included.
const MAX_KEY_BYTES = 255;

function truncateBytes(text, maxBytes) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= maxBytes) return text;
    // Back to a UTF-8 boundary: a split character would decode to U+FFFD, which the server
    // sanitizes differently.
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
}

// Mirrors the server's sanitize-filename, never looser: otherwise two avatars share a folder
// and deleting one's assets wipes both.
export function sanitizeKey(avatarId) {
    const cleaned = labelOf(avatarId)
        .replace(/[/\\?%*:|"<>]/g, '')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        // Trailing dots and spaces go, as on the server; leading whitespace stays.
        .replace(/[. ]+$/, '');
    return truncateBytes(PREFIX + (cleaned || 'unnamed'), MAX_KEY_BYTES);
}

export function resolveFolderKey(root, avatarId) {
    const persona = root?.personas?.[avatarId];
    if (persona?.assetFolderKey) return persona.assetFolderKey;

    const base = sanitizeKey(avatarId);
    const taken = new Set();
    for (const [id, p] of Object.entries(root?.personas ?? {})) {
        if (id !== avatarId && p?.assetFolderKey) taken.add(p.assetFolderKey);
    }
    // Two different avatars can sanitize to the same string.
    return taken.has(base) ? `${base}-${fnv1a(avatarId).toString(36).slice(0, 6)}` : base;
}

// The only place a key is assigned; persisted at once and never recomputed, because
// resolveFolderKey can only avoid keys it sees stored.
export function claimFolderKey(root, avatarId, saveFn) {
    const persona = root?.personas?.[avatarId];
    if (!persona) throw new Error(`claimFolderKey needs an existing persona entry for ${avatarId}`);
    if (persona.assetFolderKey) return persona.assetFolderKey;
    const key = resolveFolderKey(root, avatarId);
    persona.assetFolderKey = key;
    if (typeof saveFn === 'function') saveFn();
    return key;
}

export function parseTag(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    const parts = value.split('/');
    if (parts.length > 2) return null;
    const filename = parts[parts.length - 1];
    const folderKey = parts.length === 2 ? parts[0] : null;
    if (!filename || filename === '.' || filename === '..') return null;
    if (folderKey !== null && (!folderKey || folderKey === '.' || folderKey === '..')) return null;
    return { folderKey, filename };
}

export function labelOf(filename) {
    return String(filename ?? '').replace(/\.[^.]*$/, '');
}

/* The asset's real name: the file name without extension, from the server's path. The server's
   own label is lowercased and cut at the first dash or dot (grouping for the expressions
   extension), so it is no identity. */
export function assetNameFromPath(path) {
    const raw = String(path ?? '').split('?')[0].split('#')[0];
    const file = raw.slice(raw.lastIndexOf('/') + 1);
    if (!file) return null;
    let decoded = file;
    // SillyTavern does not encode the path, but a proxy that does leaves %XX.
    if (/%[0-9a-f]{2}/i.test(file)) {
        try { decoded = decodeURIComponent(file); } catch { decoded = file; }
    }
    return labelOf(decoded) || null;
}

// SillyTavern's grouping of a file name, for names that 0.2.0 and earlier saved under it.
export function groupLabelOf(name) {
    const lower = String(name ?? '').toLowerCase();
    return lower.match(/^(.+?)(?:[-.].*?)?$/)?.[1] ?? lower;
}

/* The files of allNames a stored selection covers. Case-insensitive, because 0.2.0 and
   earlier stored the server's label, which can name a group (pose for pose-1.png and
   pose-2.png); a group match applies only when no file has that name. */
export function selectedNames(selection, allNames) {
    const names = (Array.isArray(allNames) ? allNames : []).filter(name => typeof name === 'string');
    const exact = new Set(names.map(name => name.toLowerCase()));
    const out = new Set();
    for (const entry of Array.isArray(selection) ? selection : []) {
        const wanted = String(entry ?? '').toLowerCase();
        const covers = exact.has(wanted)
            ? name => name.toLowerCase() === wanted
            : name => groupLabelOf(name) === wanted;
        for (const name of names) if (covers(name)) out.add(name);
    }
    return out;
}

/* Exact name first; then, for bindings from 0.2.0 and earlier, case-insensitive, then by
   server label. An ambiguous match means none. exactOnly (bindings from 0.3.3 on) skips both
   fallbacks. */
export function findAsset(list, label, exactOnly = false) {
    if (!Array.isArray(list) || !label) return null;
    const wanted = String(label);
    const exact = list.find(asset => asset?.label === wanted);
    if (exact || exactOnly) return exact ?? null;
    const lower = wanted.toLowerCase();
    const folded = list.filter(asset => String(asset?.label ?? '').toLowerCase() === lower);
    if (folded.length === 1) return folded[0];
    const grouped = list.filter(asset => asset?.serverLabel === lower);
    return grouped.length === 1 ? grouped[0] : null;
}

/* Resolves a {{pimg::}} name in a label-keyed listing: as written first (labels may contain
   dots), then without extension, then one case-insensitive match. */
export function lookupLabel(map, filename) {
    if (!map || typeof map.get !== 'function') return null;
    const raw = String(filename ?? '');
    const direct = map.get(raw) ?? map.get(labelOf(raw));
    if (direct) return direct;
    const wanted = [raw.toLowerCase(), labelOf(raw).toLowerCase()];
    let found = null;
    for (const [label, path] of map) {
        if (!wanted.includes(String(label).toLowerCase())) continue;
        if (found) return null;
        found = path;
    }
    return found;
}

/* Avatar backups share the sprite folder with the user's pictures, so everything that shows
   the folder or sends it to the model filters this prefix (ASCII, so sanitizing keeps it). */
const BACKUP_PREFIX = 'pm-backup-';
// Written by 0.1.12 to 0.1.14.
const LEGACY_BACKUP_PREFIX = 'pm-원본-';

function isBackupLabel(label) {
    const name = String(label ?? '');
    return name.startsWith(BACKUP_PREFIX) || name.startsWith(LEGACY_BACKUP_PREFIX);
}

// The folder as the user and the model should see it.
export function withoutBackups(list) {
    return (list ?? []).filter(item => !isBackupLabel(typeof item === 'string' ? item : item?.label));
}

// What a folder-qualified tag can do now, given the listings so far. An unseen key is worth
// one listing request; a key present without a listing is in flight or failed.
export function assetLookup(folders, folderKey, filename) {
    const listing = folders?.get(folderKey);
    if (listing instanceof Map) return { path: lookupLabel(listing, filename), fetch: false };
    return { path: null, fetch: !(folders?.has(folderKey) ?? false) };
}

// FormData sets its own Content-Type, with the multipart boundary.
function formHeaders(ctx) {
    const headers = { ...ctx.getRequestHeaders() };
    delete headers['Content-Type'];
    delete headers['content-type'];
    return headers;
}

// fetch has no timeout, and CHAT_CHANGED awaits this listing before rendering image tags.
const LISTING_TIMEOUT_MS = 10000;

/* Per folder, when this session last wrote into it: a cache-busting token for pictures
   replaced under the same name. A timestamp, so no earlier session's address repeats. */
const folderStamps = new Map();

export function markFolderChanged(folderKey) {
    if (folderKey) folderStamps.set(folderKey, Date.now());
}

// Our cache-busting query parameter, appended to an address.
export function withToken(url, token) {
    return `${url}${url.includes('?') ? '&' : '?'}pmv=${token}`;
}

export function normalizeListing(data, folderKey) {
    if (!Array.isArray(data)) return [];
    const stamp = folderStamps.get(folderKey);
    const out = [];
    for (const entry of data) {
        if (!entry || typeof entry.path !== 'string' || !entry.path) continue;
        const serverLabel = String(entry.label ?? '').toLowerCase();
        const label = assetNameFromPath(entry.path) ?? (entry.label ? String(entry.label) : null);
        if (!label) continue;
        out.push({ label, serverLabel, path: stamp ? withToken(entry.path, stamp) : entry.path });
    }
    return out;
}

export async function listAssets(ctx, folderKey) {
    const timeout = globalThis.AbortSignal?.timeout;
    const signal = typeof timeout === 'function' ? timeout.call(globalThis.AbortSignal, LISTING_TIMEOUT_MS) : undefined;
    const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(folderKey)}`, {
        headers: ctx.getRequestHeaders(),
        signal,
    });
    if (!res.ok) throw new Error(`sprites/get ${res.status}`);
    const data = await res.json();
    return normalizeListing(data, folderKey);
}

/* The upload's file field name is unverified, so each is tried in turn (a rejected attempt
   writes nothing) and the one that works is kept for the session. */
const SPRITE_FILE_FIELDS = Object.freeze(['file', 'avatar', 'spriteFile', 'image']);
let spriteFileField = null;

function spriteBody(field, folderKey, file) {
    const body = new FormData();
    body.append('name', folderKey);
    body.append('label', labelOf(file.name));
    body.append(field, file);
    return body;
}

/* batch is shared by the files of one selection: after one file exhausts every field name,
   the rest try once. Not set when the loop broke early: a 401 says nothing about fields. */
export async function uploadAsset(ctx, folderKey, file, batch = {}) {
    const fields = spriteFileField ? [spriteFileField]
        : batch.exhausted ? [SPRITE_FILE_FIELDS[0]]
            : SPRITE_FILE_FIELDS;
    let lastStatus = 0;
    let ranOut = true;
    for (const field of fields) {
        const res = await fetch('/api/sprites/upload', {
            method: 'POST',
            headers: formHeaders(ctx),
            body: spriteBody(field, folderKey, file),
        });
        if (res.ok) {
            spriteFileField = field;
            batch.exhausted = false;
            markFolderChanged(folderKey);
            return field;
        }
        lastStatus = res.status;
        // Only 400, 422 and 5xx may be about the field name.
        if (res.status !== 400 && res.status !== 422 && res.status < 500) { ranOut = false; break; }
    }
    // Forgotten, so the next call probes again.
    spriteFileField = null;
    if (ranOut && fields.length > 1) batch.exhausted = true;
    throw new Error(`sprites/upload ${lastStatus} [fields=${fields.length}, folder=${folderKey}]`);
}

// Teardown leaves nothing behind, including what was learned about the server.
export function resetAssetProbes() {
    backedUpThisSession.clear();
    spriteFileField = null;
    shownSizes.clear();
    folderStamps.clear();
}

export async function deleteAsset(ctx, folderKey, label) {
    const res = await fetch('/api/sprites/delete', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name: folderKey, spriteName: label }),
    });
    if (!res.ok) throw new Error(`sprites/delete ${res.status}`);
    markFolderChanged(folderKey);
}

const TAG_RE = /\{\{pimg::(.*?)\}\}/gi;

export function findTags(text) {
    const hits = [];
    for (const m of String(text ?? '').matchAll(TAG_RE)) {
        const parsed = parseTag(m[1]);
        if (parsed) hits.push({ raw: m[0], start: m.index, end: m.index + m[0].length, parsed });
    }
    return hits;
}

export function assetClass(style) {
    return `pm-asset pm-asset-${String(style || 'plain').replace(/[^a-z]/gi, '')}`;
}

// For the regex export's replaceString, which SillyTavern splices as HTML; hence the escaping.
export function buildImgHtml(path, style) {
    const safe = String(path).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<img class="${assetClass(style)}" src="${safe}" loading="lazy" alt="" />`;
}

// What one text node should become, DOM-free. resolved 0 means: leave the node alone.
export function planRender(text, resolvePath) {
    const source = String(text ?? '');
    const parts = [];
    let cursor = 0;
    let resolved = 0;
    for (const hit of findTags(source)) {
        const path = typeof resolvePath === 'function' ? resolvePath(hit.parsed) : null;
        // An unresolved tag stays in the literal text.
        if (!path) continue;
        parts.push({ type: 'text', text: source.slice(cursor, hit.start) });
        parts.push({ type: 'image', path });
        cursor = hit.end;
        resolved++;
    }
    parts.push({ type: 'text', text: source.slice(cursor) });
    return { parts, resolved };
}

/* Loaded size per path. SillyTavern refills messages on scroll, so a known size is set on
   rebuilt <img>s to keep the text from jumping. */
const shownSizes = new Map();

function rememberSize(img, path) {
    img.onload = () => {
        img.onload = null;
        if (img.naturalWidth > 0) shownSizes.set(path, [img.naturalWidth, img.naturalHeight]);
    };
}

// No "already processed" flag: SillyTavern replaces .mes_text innerHTML on edit, bringing raw
// tags back on the same element, and a rendered tag no longer matches.
export function renderInElement(el, resolvePath, style) {
    if (!el) return 0;
    let replaced = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
        const text = walker.currentNode.nodeValue;
        if (text.includes('{{') && findTags(text).length) targets.push(walker.currentNode);
    }

    for (const node of targets) {
        const plan = planRender(node.nodeValue, resolvePath);
        // A rewrite with nothing resolved would still be a mutation, and the #chat observer in
        // index.js would render again at frame rate, forever.
        if (!plan.resolved) continue;
        const frag = document.createDocumentFragment();
        for (const part of plan.parts) {
            if (part.type === 'text') {
                if (part.text) frag.append(part.text);
                continue;
            }
            // The server-listed path goes into a property, never into markup.
            const img = document.createElement('img');
            img.className = assetClass(style);
            const known = shownSizes.get(part.path);
            if (known) { img.width = known[0]; img.height = known[1]; }
            else rememberSize(img, part.path);
            img.src = part.path;
            img.loading = 'lazy';
            img.alt = '';
            frag.append(img);
        }
        node.replaceWith(frag);
        replaced += plan.resolved;
    }
    return replaced;
}

/* Per-version persona images: bytes between our sprite folder and SillyTavern's avatar file.
   Nothing here talks to the user; callers decide what to say. */

async function fetchBlob(url) {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? res.blob() : null;
}

// The persona's full-size file and, where the build has one, its thumbnail address.
function avatarUrls(ctx, avatarId) {
    let thumb = null;
    try { thumb = ctx?.getThumbnailUrl?.('persona', avatarId) ?? null; } catch { /* the file alone */ }
    return { full: `User Avatars/${encodeURIComponent(avatarId)}`, thumb };
}

// A served sprite turned back into a File, so it can be posted as an avatar.
async function fetchAssetFile(path, label) {
    if (!path) return null;
    try {
        const blob = await fetchBlob(path);
        if (!blob) return null;
        const name = /\.[a-z0-9]+$/i.test(label ?? '') ? label : `${label || 'image'}.png`;
        return new File([blob], name, { type: blob.type || 'image/png' });
    } catch { return null; }
}

/* The avatar's current picture, for the backup: the original file first, the resized
   thumbnail as fallback. Stamped, so a second backup cannot replace the first. */
async function captureAvatarFile(ctx, avatarId, stamp) {
    const { full, thumb } = avatarUrls(ctx, avatarId);
    const urls = [{ url: full, source: 'original' }];
    if (thumb) urls.push({ url: thumb, source: 'thumbnail' });
    const label = `${BACKUP_PREFIX}${stamp}`;
    for (const { url, source } of urls) {
        try {
            const blob = await fetchBlob(url);
            // A server that answers a missing file with a page is not a picture.
            if (!blob || !blob.size || (blob.type && !blob.type.startsWith('image/'))) continue;
            return { file: new File([blob], `${label}.png`, { type: blob.type || 'image/png' }), label, source };
        } catch { /* the next address */ }
    }
    return null;
}

/* Avatars backed up this session. The caller records persona.avatarBackup only after its
   await, so without this two quick taps would both back up. */
const backedUpThisSession = new Set();

// One picture write at a time, so a burst of version taps ends with the last one winning.
let imageChain = Promise.resolve();
function queueImageWrite(job) {
    const run = imageChain.then(job, job);
    // Never rejects, so one failure cannot poison every later write.
    imageChain = run.then(() => undefined, () => undefined);
    return run;
}

// The picked picture onto the avatar, crop optional; onWritten runs inside the queue turn.
export function replacePersonaAvatar(ctx, avatarId, file, crop, onWritten) {
    return queueImageWrite(async () => {
        const result = await uploadPersonaAvatar(ctx, avatarId, file, crop);
        if (result?.ok) onWritten?.();
        return result;
    });
}

export async function restoreAvatarBackup({ ctx, root, avatarId, label }) {
    if (!label) return { error: 'missing', detail: '' };
    return queueImageWrite(async () => {
        try {
            const key = resolveFolderKey(root, avatarId);
            let list;
            try { list = await listAssets(ctx, key); } catch (e) {
                return { error: 'listing', detail: String(e?.message ?? e) };
            }
            const hit = findAsset(list, label);
            if (!hit) return { error: 'missing', detail: label };
            const file = await fetchAssetFile(hit.path, label);
            if (!file) return { error: 'fetch', detail: label };
            const wrote = await uploadPersonaAvatar(ctx, avatarId, file);
            if (!wrote.ok) return { error: 'upload', detail: wrote.detail ?? wrote.reason };
            return { ok: true };
        } catch (e) {
            return { error: 'upload', detail: String(e?.message ?? e) };
        }
    });
}

// Pixel size read from the file, or null if undecodable.
export async function imageSize(file) {
    try {
        if (typeof globalThis.createImageBitmap === 'function') {
            const bitmap = await globalThis.createImageBitmap(file);
            const size = { width: bitmap.width, height: bitmap.height };
            bitmap.close?.();
            if (size.width > 0 && size.height > 0) return size;
        }
    } catch { /* falls through to the element */ }
    if (typeof globalThis.Image !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(file);
    try {
        return await new Promise(resolve => {
            const img = new globalThis.Image();
            img.onload = () => resolve(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
            img.onerror = () => resolve(null);
            img.src = url;
        });
    } finally { URL.revokeObjectURL(url); }
}

/* Puts a version's bound asset onto the avatar file. Never throws (callers run it with void), so
   a picture that fails to move cannot undo a version apply. Answers skipped, an error code or
   ok; every answer past the backup step carries backup. */
export async function applyBoundImage({ ctx, root, persona, avatarId, label, exact = false, crop, force, known, now }) {
    if (!label) return { skipped: 'none' };
    // Keyed on label and crop: the same picture framed anew is written again.
    if (!force && persona?.avatarWritten === writtenKey(label, crop)) return { skipped: 'same' };
    return queueImageWrite(async () => {
        try {
            const key = resolveFolderKey(root, avatarId);
            // known: the manager's listing when current, saving a round trip.
            let list = Array.isArray(known) ? known : null;
            if (!list) {
                try { list = await listAssets(ctx, key); } catch (e) {
                    return { error: 'listing', detail: String(e?.message ?? e) };
                }
            }
            const hit = findAsset(list, label, exact);
            if (!hit) return { error: 'missing', detail: label };

            /* Back up the current picture once, before the first overwrite, refusing the write
               if that fails. The record is returned for the caller, which owns the root. */
            let backup = null;
            if (!persona?.avatarBackup && !backedUpThisSession.has(avatarId)) {
                backedUpThisSession.add(avatarId);
                const captured = await captureAvatarFile(ctx, avatarId, now);
                if (!captured) { backedUpThisSession.delete(avatarId); return { error: 'backup', detail: 'capture' }; }
                try {
                    // Saved at once, so the claimed key survives a later failure on this path.
                    const folder = claimFolderKey(root, avatarId, ctx?.saveSettingsDebounced);
                    await uploadAsset(ctx, folder ?? key, captured.file);
                } catch (e) {
                    backedUpThisSession.delete(avatarId);
                    return { error: 'backup', detail: String(e?.message ?? e) };
                }
                backup = { label: captured.label, at: now, source: captured.source };
            }

            // From here the backup is on the server and must be recorded whatever happens.
            const file = await fetchAssetFile(hit.path, label);
            if (!file) return { error: 'fetch', detail: label, backup };
            // A framed picture that cannot be measured is not written whole instead.
            let cropPx = null;
            if (validCrop(crop)) {
                const size = await imageSize(file);
                // Refit to this file: a same-name replacement of another shape keeps centre and zoom.
                const fitted = size ? cropFromView(size.width, size.height, viewFromCrop(size.width, size.height, crop)) : null;
                cropPx = fitted ? cropPixels(fitted, size.width, size.height) : null;
                if (!cropPx) return { error: 'decode', detail: label, backup };
            }
            const wrote = await uploadPersonaAvatar(ctx, avatarId, file, cropPx);
            if (!wrote.ok) return { error: 'upload', detail: wrote.detail ?? wrote.reason, backup };
            return { ok: true, backup };
        } catch (e) {
            return { error: 'upload', detail: String(e?.message ?? e) };
        }
    });
}

const MACROS = ['persona_assets', 'persona_asset_prompt'];

// The active version's selection of the folder (null = all files). Both macros read this; a
// throw here would happen inside SillyTavern's prompt building.
function activeAssetNames(s) {
    const names = withoutBackups(s.assetNames);
    const selection = findVersion(s.persona, s.persona?.activeVersionId)?.assetSelection;
    if (!Array.isArray(selection)) return names;
    const chosen = selectedNames(selection, s.assetNames);
    return names.filter(name => chosen.has(name));
}

export function registerAssetMacros(ctx, getState) {
    if (typeof ctx.registerMacro !== 'function') return;
    // Registered even when injection is off, so raw macro text never reaches a prompt.
    ctx.registerMacro('persona_assets', () => {
        const s = getState();
        if (!s || !s.settings.injectAssetMacros) return '';
        return activeAssetNames(s).join(', ');
    });
    ctx.registerMacro('persona_asset_prompt', () => {
        const s = getState();
        if (!s || !s.settings.injectAssetMacros || !s.assetNames.length) return '';
        const active = activeAssetNames(s);
        // A version excluding every file gets no block, not a template with an empty list.
        if (!active.length) return '';
        const names = active.join(', ');
        // Undefined on a root from a newer build, which migrate does not backfill.
        const template = s.settings.assetPromptTemplate;
        if (typeof template !== 'string') return '';
        // A function replacement keeps $ sequences literal.
        return template.replace(/\{\{persona_assets\}\}/g, () => names);
    });
}

export function unregisterAssetMacros(ctx) {
    if (typeof ctx.unregisterMacro !== 'function') return;
    for (const name of MACROS) ctx.unregisterMacro(name);
}

// Persona avatars: SillyTavern's own persona picture, drawn everywhere for the persona.

/* Drops the browser's cached copy, as SillyTavern does after its own upload; bounded, so a slow
   server cannot hold up the repaint. */
const BUST_TIMEOUT_MS = 3000;

async function bustPersonaImage(ctx, avatarId) {
    const { full, thumb } = avatarUrls(ctx, avatarId);
    const urls = thumb ? [thumb, full] : [full];
    const reloads = urls.map(url => {
        try { return fetch(url, { cache: 'reload' }).catch(() => undefined); } catch { return Promise.resolve(); }
    });
    await Promise.race([
        Promise.all(reloads),
        new Promise(resolve => setTimeout(resolve, BUST_TIMEOUT_MS)),
    ]);
}

/* Posts to the endpoint SillyTavern's persona screen uses. crop is the query its crop dialog
   sends: whole pixels, with want_resize following never_resize_avatars. */
async function uploadPersonaAvatar(ctx, avatarId, file, crop) {
    const body = new FormData();
    // An empty overwrite_name would create a persona instead of replacing one.
    body.append('avatar', file);
    body.append('overwrite_name', avatarId);
    let res;
    try {
        const query = crop
            ? `?crop=${encodeURIComponent(JSON.stringify({ ...crop, want_resize: !ctx?.powerUserSettings?.never_resize_avatars }))}`
            : '';
        res = await fetch(`/api/avatars/upload${query}`, {
            method: 'POST',
            headers: formHeaders(ctx),
            cache: 'no-cache',
            body,
        });
    } catch (e) {
        return { ok: false, reason: 'network', detail: String(e?.message ?? e) };
    }
    if (!res.ok) return { ok: false, reason: 'http', status: res.status, detail: `HTTP ${res.status}` };
    await bustPersonaImage(ctx, avatarId);
    return { ok: true };
}

// Hands the file to SillyTavern's own uploader. Returns the id of whatever is missing, or null.
export function feedPersonaImage(doc, avatarId, file) {
    const overwrite = doc?.getElementById?.('avatar_upload_overwrite');
    const input = doc?.getElementById?.('avatar_upload_file');
    if (!overwrite) return 'avatar_upload_overwrite';
    if (!input) return 'avatar_upload_file';
    if (typeof DataTransfer !== 'function') return 'DataTransfer';
    overwrite.value = avatarId;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
}
