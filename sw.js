/**
 * StockSense Progressive Web App (PWA) Service Worker
 * Cache Strategy: Stale-While-Revalidate for app shell and assets.
 * Supabase database and authentication requests bypass cache to guarantee fresh live data.
 */

const CACHE_NAME = 'stocksense-v1.0.3';
const APP_SHELL = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/manifest.webmanifest',
    '/icon-192.png',
    '/icon-512.png',
    '/icon.svg'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(APP_SHELL).catch(err => {
                console.warn('[SW] Pre-caching warning:', err);
            });
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // Bypass caching for Supabase API, authentication, external analytics, non-GET
    if (req.method !== 'GET' || url.origin.includes('supabase.co') || url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) {
        return;
    }

    event.respondWith(
        caches.match(req).then(cachedResponse => {
            const fetchPromise = fetch(req).then(networkResponse => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(req, responseClone));
                }
                return networkResponse;
            }).catch(() => {
                // If offline and navigating to a page, serve cached index.html
                if (req.mode === 'navigate') {
                    return caches.match('/index.html');
                }
            });

            return cachedResponse || fetchPromise;
        })
    );
});
