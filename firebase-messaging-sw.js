importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBKbFSyO293N2ovfjw1NzlNBN28qgaUI3E",
  authDomain: "tchapot-de-ghislain.firebaseapp.com",
  projectId: "tchapot-de-ghislain",
  storageBucket: "tchapot-de-ghislain.firebasestorage.app",
  messagingSenderId: "317977253522",
  appId: "1:317977253522:web:bec4af0edec1949174384b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('📩 Message reçu en arrière-plan:', payload);
  
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/favicon.png',
    badge: '/favicon.png',
    vibrate: [200, 100, 200],
    tag: 'tchapot-notification',
    requireInteraction: true
  };
  
  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Gestion du clic sur notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});