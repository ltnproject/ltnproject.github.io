# LtM Meeting — Complete Setup Guide
> Browser-only · Firebase Free Plan · iPad Optimized

---

## 📁 File Structure

```
ltm-meeting/
├── index.html          → Landing page  (/)
├── dash.html           → Dashboard     (/dash)
├── call.html           → Meeting room  (/call?room=XXXXXXXX)
├── 404.html            → Error page
├── css/
│   └── style.css       → All styles
└── js/
    ├── firebase-config.js  ← ⚠️ YOU EDIT THIS
    ├── app.js              → Auth + dashboard logic
    └── webrtc.js           → WebRTC + signaling
```

---

## STEP 1 — Create a Firebase Project

1. Go to https://console.firebase.google.com
2. Click **"Add project"**
3. Name it (e.g. `ltm-meeting`) → Continue
4. Disable Google Analytics (optional) → **Create project**

---

## STEP 2 — Enable Google Sign-In

1. In your Firebase project → **Build → Authentication**
2. Click **"Get started"**
3. Under "Sign-in method" → click **Google**
4. Enable it → enter your support email → **Save**

---

## STEP 3 — Create Firestore Database

1. Go to **Build → Firestore Database**
2. Click **"Create database"**
3. Choose **"Start in test mode"** (we'll secure it after)
4. Pick a region close to you → **Enable**

### Firestore Security Rules

After creating, go to **Firestore → Rules** tab and replace with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Meeting metadata
    match /meetings/{meetingId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null;
      allow update, delete: if request.auth != null
        && request.auth.uid == resource.data.hostId;
    }

    // Room signaling, participants, chat, events
    match /rooms/{roomId}/{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Click **Publish**.

---

## STEP 4 — Register Your Web App

1. In Firebase console → click the ⚙️ gear → **Project settings**
2. Scroll to **"Your apps"** → click `</>` (Web)
3. App nickname: `LtM Web` → click **"Register app"**
4. You'll see a config object like this:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

---

## STEP 5 — Paste Your Config

Open **`js/firebase-config.js`** and replace the placeholder values:

```javascript
const firebaseConfig = {
  apiKey:            "PASTE_YOUR_apiKey_HERE",
  authDomain:        "PASTE_YOUR_authDomain_HERE",
  projectId:         "PASTE_YOUR_projectId_HERE",
  storageBucket:     "PASTE_YOUR_storageBucket_HERE",
  messagingSenderId: "PASTE_YOUR_messagingSenderId_HERE",
  appId:             "PASTE_YOUR_appId_HERE"
};
```

**That's the only file you need to edit.**

---

## STEP 6 — Add Authorized Domain

For Google Sign-In to work on your custom domain:

1. Firebase → **Authentication → Settings → Authorized domains**
2. Click **"Add domain"**
3. Add: `drk.qzz.io`
4. Also ensure `localhost` is listed (for testing)

---

## STEP 7 — Upload to GitHub (Browser)

1. Go to https://github.com → **New repository**
2. Name it `ltm-meeting` → Public → **Create**
3. Click **"uploading an existing file"**
4. Drag & drop ALL your files, maintaining the folder structure:
   - Drag `css/` folder contents into `css/` path
   - Drag `js/` folder contents into `js/` path
   - Drag all HTML files to root
5. Commit message: `Initial deploy` → **Commit changes**

> **Tip for folders:** GitHub web UI doesn't support nested folders well.
> Create each subfolder first by clicking **"Create new file"** and
> typing `css/placeholder.txt` — this creates the `css/` folder.
> Then upload the real file. Delete the placeholder after.

---

## STEP 8 — Enable Firebase Hosting via GitHub

1. In Firebase console → **Build → Hosting**
2. Click **"Get started"**
3. When asked "Connect to GitHub" → authorize Firebase
4. Select your repository `ltm-meeting`
5. Branch: `main`
6. For "build command": leave blank
7. For "public directory": `.` (just a dot)
8. Click **"Finish"**

Firebase will now auto-deploy every time you push to GitHub.

---

## STEP 9 — Connect Custom Domain `drk.qzz.io`

1. Firebase Hosting → **"Add custom domain"**
2. Enter: `drk.qzz.io`
3. Firebase shows you a **CNAME record** like:
   ```
   CNAME  drk  →  ltm-meeting.web.app
   ```
4. Go to your DNS provider (where `qzz.io` is registered)
5. Add that CNAME record
6. Wait 10–30 min → Firebase verifies → SSL issues automatically

---

## 🧪 Test Locally (No Server Needed)

Open the HTML files directly in Safari on iPad or use a simple local server:
- On Mac: `python3 -m http.server 8080` in the project folder
- Then visit: `http://localhost:8080`

> **Important:** Camera/mic access requires HTTPS or localhost.
> Firebase Hosting provides HTTPS automatically.

---

## 📊 Firebase Free Plan Limits

| Feature | Free Limit |
|---------|-----------|
| Auth users | Unlimited |
| Firestore reads | 50,000/day |
| Firestore writes | 20,000/day |
| Firestore storage | 1 GB |
| Hosting bandwidth | 10 GB/month |
| Hosting storage | 10 GB |

For a small team (< 20 meetings/day), the free plan is more than enough.

---

## 🔧 How WebRTC Works in LtM

```
Participant A (host)          Firestore (signaling)          Participant B (joiner)
      |                              |                               |
      |── Creates meeting ──────────>|                               |
      |                              |                               |
      |<─ Joins room ────────────────────────────────────────────────|
      |                              |                               |
      |── Listens for new peers ─────|                               |
      |                              |<─── B writes presence ────────|
      |                              |                               |
      |── Creates RTCPeerConnection ─|                               |
      |── Creates OFFER ─────────────> stored as signals/A_B/offer   |
      |                              |                               |
      |                              |─── B reads offer ────────────>|
      |                              |                               |── Sets remote desc
      |                              |                               |── Creates ANSWER
      |                              |<─── stores signals/A_B/answer ─|
      |                              |                               |
      |<── A reads answer ───────────|                               |
      |── Sets remote desc           |                               |
      |                              |                               |
      |<──── ICE candidates exchanged via subcollections ────────────>|
      |                              |                               |
      |<══════════ Direct P2P video/audio connection ════════════════>|
```

---

## ❓ Troubleshooting

**"Sign in failed" / popup blocked**
→ On iPad Safari, allow pop-ups: Settings → Safari → turn off "Block Pop-ups"

**Camera/mic not working**
→ Safari → Settings → Camera/Microphone → Allow for this site

**Black video tiles / no video**
→ Check browser console. Usually a camera permission issue.

**Peers can't connect**
→ WebRTC sometimes fails on very restrictive networks. STUN-only (no TURN) may not traverse all NATs.
  For production, add a TURN server (e.g. Twilio, Metered.ca).

**Firebase auth domain error**
→ Make sure your domain (`drk.qzz.io`) is in Firebase Auth → Authorized domains.

---

*LtM Meeting — Built with ❤️ using Firebase + WebRTC*
