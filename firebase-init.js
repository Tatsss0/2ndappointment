(function () {
  'use strict';

  // Ensure Firebase SDK is loaded
  if (typeof window === 'undefined' || typeof window.firebase === 'undefined') {
    // SDK not present; nothing to initialize
    return;
  }

  // Allow config injection via global to avoid committing secrets
  // Set window.TECHMED_FIREBASE_CONFIG = { apiKey: '...', authDomain: '...', projectId: '...', ... }
  var injectedConfig = (typeof window !== 'undefined' && window.TECHMED_FIREBASE_CONFIG) ? window.TECHMED_FIREBASE_CONFIG : null;

  // Fallback placeholder config; replace with your real Firebase config
  var placeholderConfig = {
    apiKey: 'REPLACE_ME',
    authDomain: 'REPLACE_ME.firebaseapp.com',
    projectId: 'REPLACE_ME',
    storageBucket: 'REPLACE_ME.appspot.com',
    messagingSenderId: 'REPLACE_ME',
    appId: 'REPLACE_ME',
  };

  var config = injectedConfig || placeholderConfig;

  try {
    if (!firebase.apps || firebase.apps.length === 0) {
      firebase.initializeApp(config);
    }
  } catch (err) {
    // Avoid throwing on repeated loads or invalid config in dev
    console.warn('[firebase-init] Initialization warning:', err && err.message ? err.message : err);
  }

  // Optionally enable Firestore; this does not create a connection until used
  try {
    if (firebase.firestore) {
      // Ensure settings are default; you can customize if needed
      firebase.firestore();
    }
  } catch (_) {
    // ignore
  }
})();
