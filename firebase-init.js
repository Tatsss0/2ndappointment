(function () {
  'use strict';

  // Initialize Firebase using compat SDK already loaded via CDN on the page
  if (typeof window === 'undefined') return;
  if (typeof firebase === 'undefined') {
    console.error('[firebase-init] Firebase SDK not loaded. Include firebase-app-compat.js first.');
    return;
  }

  if (firebase.apps && firebase.apps.length > 0) {
    // Already initialized elsewhere
    return;
  }

  // Expect config to be provided globally before this file is loaded
  // e.g., window.__FIREBASE_CONFIG__ = { apiKey: '...', projectId: '...', ... }
  const config = window.__FIREBASE_CONFIG__ || window.FIREBASE_CONFIG || null;
  if (!config) {
    console.error('[firebase-init] Missing Firebase config. Provide window.__FIREBASE_CONFIG__ before including firebase-init.js');
    return;
  }

  try {
    firebase.initializeApp(config);
    // Optional: tweak Firestore settings if needed
    // const db = firebase.firestore();
    // db.settings({ ignoreUndefinedProperties: true });
  } catch (err) {
    if (!(err && /already exists/i.test(String(err.message || '')))) {
      console.error('[firebase-init] Initialization error:', err);
    }
  }
})();
