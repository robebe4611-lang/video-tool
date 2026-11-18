// Service worker: makes the app installable and finishes downloads in the background
// (Background Fetch: the download keeps going even when the app is closed).
const FILES = 'library-files';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

function fileNameFrom(res, fallback) {
    const cd = res.headers.get('content-disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[1]); } catch {} }
    const plain = /filename="([^"]+)"/i.exec(cd);
    return plain ? plain[1] : fallback;
}

async function notifyPages(msg) {
    const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    all.forEach(c => c.postMessage(msg));
}

self.addEventListener('backgroundfetchsuccess', event => {
    const reg = event.registration;
    event.waitUntil((async () => {
        const cache = await caches.open(FILES);
        const pendingRes = await cache.match('/lib-pending/' + reg.id);
        const pending = pendingRes ? await pendingRes.json() : {};
        const records = await reg.matchAll();
        const res = records.length ? await records[0].responseReady : null;
        if (!res || !res.ok) {
            await cache.delete('/lib-pending/' + reg.id);
            await event.updateUI({ title: pending.failText || 'Download failed' });
            return notifyPages({ type: 'bg-fail', id: reg.id });
        }
        let name = fileNameFrom(res, pending.name || 'video.mp4');
        if (pending.suffix) name = name.replace(/(\.[a-z0-9]+)$/i, ' ' + pending.suffix + '$1');
        await cache.put('/lib/' + reg.id, res);
        const meta = {
            id: reg.id, storage: 'cache', key: '/lib/' + reg.id, name,
            bytes: reg.downloaded, date: Date.now(), src: pending.src || '', quality: pending.quality || ''
        };
        await cache.put('/lib-meta/' + reg.id, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
        await cache.delete('/lib-pending/' + reg.id);
        await event.updateUI({ title: (pending.doneText || 'Saved') + ': ' + name });
        notifyPages({ type: 'bg-done', id: reg.id });
    })());
});

self.addEventListener('backgroundfetchfail', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(FILES);
        const pendingRes = await cache.match('/lib-pending/' + event.registration.id);
        const pending = pendingRes ? await pendingRes.json() : {};
        await cache.delete('/lib-pending/' + event.registration.id);
        await event.updateUI({ title: pending.failText || 'Download failed' });
        notifyPages({ type: 'bg-fail', id: event.registration.id });
    })());
});

self.addEventListener('backgroundfetchabort', event => {
    event.waitUntil(caches.open(FILES).then(c => c.delete('/lib-pending/' + event.registration.id)));
});

self.addEventListener('backgroundfetchclick', event => {
    event.waitUntil(self.clients.openWindow('/'));
});
