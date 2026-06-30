// Service worker minimal — sert uniquement à satisfaire les critères
// d'installabilité (« Ajouter à l'écran d'accueil ») des navigateurs.
// Il ne met rien en cache : l'application a de toute façon besoin du
// réseau pour Firebase et Google Agenda, un mode hors-ligne n'aurait
// pas de sens ici.

self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event){
  event.respondWith(fetch(event.request));
});
