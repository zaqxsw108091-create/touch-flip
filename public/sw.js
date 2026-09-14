/* 최소 서비스 워커 — 태블릿 홈화면 추가 + 오프라인 실행용.
   게임은 완전한 정적 사이트라 앱 셸만 캐시하면 오프라인에서도 그대로 돌아간다. */
const CACHE = 'touch-flip-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg']))
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // 네트워크 우선, 실패 시 캐시. 배포 직후 옛 번들이 남는 문제를 피한다.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(async () => {
        const hit = (await caches.match(request)) || (await caches.match('./index.html'));
        return hit || new Response('오프라인 상태이고 캐시도 없습니다.', { status: 503 });
      }),
  );
});
