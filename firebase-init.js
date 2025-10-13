// firebase-init.js
(function () {
  if (window.firebaseInitialized) return;

  // Keep your config here (don’t remove)
  const firebaseConfig = {
    apiKey: "AIzaSyCwCjmcUTTz8S34svqAxmhHmhO8QNnz5t8",
    authDomain: "t-echmed.firebaseapp.com",
    databaseURL: "https://t-echmed-default-rtdb.firebaseio.com",
    projectId: "t-echmed",
    storageBucket: "t-echmed.appspot.com",
    messagingSenderId: "290352510024",
    appId: "1:290352510024:web:c9e2fbdec8d36f35ca547d"
  };

  const app = (firebase.apps && firebase.apps.length)
    ? firebase.app()
    : firebase.initializeApp(firebaseConfig);

  // Expose compat instances
  window.auth = app.auth();
  window.db = app.firestore();
  try { window.storage = app.storage(); } catch { window.storage = null; }

  // Apply Firestore settings once; use merge to avoid overriding host/emulator
  try {
    if (!window.__dbSettingsApplied && window.db?.settings) {
      window.db.settings({ ignoreUndefinedProperties: true, merge: true });
      window.__dbSettingsApplied = true;
    }
  } catch (e) {
    console.warn('db.settings skipped:', e);
  }

  window.firebaseInitialized = true;
})();
