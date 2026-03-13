const CACHE_NAME = 'hisho-v1';

// インストール時にキャッシュ
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/manifest.json', '/icon.svg'])
    )
  );
  self.skipWaiting();
});

// 古いキャッシュを削除
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワーク優先、失敗時はキャッシュ
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Push通知受信
self.addEventListener('push', (e) => {
  let data = { title: '秘書室', body: '新しいメッセージがあります', badge: 1 };
  try {
    data = e.data.json();
  } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' },
      actions: [
        { action: 'open', title: '開く' },
        { action: 'close', title: '閉じる' }
      ]
    }).then(() => {
      // バッジを更新
      if ('setAppBadge' in self.navigator) {
        return self.navigator.setAppBadge(data.badge || 1);
      }
    })
  );
});

// 通知クリック
self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  if (e.action === 'close') return;

  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // 既存のウィンドウがあればフォーカス
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          // バッジをクリア
          if ('clearAppBadge' in self.navigator) self.navigator.clearAppBadge();
          return;
        }
      }
      // なければ新しく開く
      if (clients.openWindow) {
        if ('clearAppBadge' in self.navigator) self.navigator.clearAppBadge();
        return clients.openWindow(url);
      }
    })
  );
});

// バックグラウンドメッセージ（アプリからSWへ）
self.addEventListener('message', (e) => {
  if (e.data?.type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator) self.navigator.clearAppBadge();
  }
});
