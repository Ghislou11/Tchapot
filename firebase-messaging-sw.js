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