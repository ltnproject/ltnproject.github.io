// ============================================================
//  js/firebase-config.js
//  ⚠️  PASTE YOUR FIREBASE CONFIG HERE
//
//  How to get it:
//  1. Go to https://console.firebase.google.com
//  2. Select your project → ⚙ Project Settings
//  3. Scroll to "Your apps" → click your web app (</>)
//  4. Copy the firebaseConfig object below
// ============================================================

const firebaseConfig = {
  apiKey:            "AIzaSyBQz_prZbvrVNDsfKXznHoc4sWovXD1pKo",
  authDomain:        "ltm-meeting.firebaseapp.com",
  projectId:         "ltm-meeting",
  storageBucket:     "ltm-meeting.firebasestorage.app",
  messagingSenderId: "1012315323739",
  appId:             "1:1012315323739:web:2a0f2ec22efc42bee36e7e"
};

// ── Initialize Firebase (do not edit below this line) ──────
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db   = firebase.firestore();

// ── ICE Servers for WebRTC ─────────────────────────────────
// Using public Google STUN servers (free, no setup needed)
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};
