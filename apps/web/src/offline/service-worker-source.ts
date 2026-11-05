export function serviceWorkerSource(version: string, assets: string[]): string {
  return `
const CACHE='aiwb-shell-v1-'+${JSON.stringify(version)};
const FILES=${JSON.stringify(assets)};const ALLOWED=new Set(FILES);
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).catch(async error=>{await caches.delete(CACHE);throw error;}));});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=(await caches.keys()).filter(k=>k.startsWith('aiwb-shell-v1-'));const previous=keys.filter(k=>k!==CACHE).at(-1);await Promise.all(keys.filter(k=>k!==CACHE&&k!==previous).map(k=>caches.delete(k)));await self.clients.claim();})());});
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_SAVED_VERSION')self.skipWaiting();});
self.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||['/invite','/reset-password','/login'].includes(url.pathname))return;
if(request.mode==='navigate'){event.respondWith(caches.open(CACHE).then(cache=>cache.match('/index.html')).then(shell=>shell||fetch(request)));return;}
if(!ALLOWED.has(url.pathname)&&!/^\\/assets\\/[^/]+-[A-Za-z0-9_-]{8,}\\.(js|css|woff2?)$/.test(url.pathname))return;
event.respondWith((async()=>{const current=await caches.open(CACHE),cached=await current.match(url.pathname);if(cached)return cached;const keys=(await caches.keys()).filter(k=>k.startsWith('aiwb-shell-v1-'));for(const key of keys){const old=await (await caches.open(key)).match(url.pathname);if(old)return old;}return fetch(request);})());
});
`;
}
