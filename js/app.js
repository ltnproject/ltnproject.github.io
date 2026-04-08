// ============================================================
//  js/app.js — Auth helpers + Dashboard logic
// ============================================================

/* ── Shared utilities ──────────────────────────────────────── */

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}

function requireAuth(redirectTo = 'index.html') {
  return new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(user => {
      unsub();
      if (!user) { window.location.href = redirectTo; return; }
      resolve(user);
    });
  });
}

function generateMeetingId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

function getInitials(name = '') {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ── DASHBOARD PAGE LOGIC ──────────────────────────────────── */

if (document.getElementById('dash-root')) {
  let currentUser = null;
  let usePasscode = false;
  let generatedId  = null;

  // ── Init ──────────────────────────────────────────────────
  requireAuth().then(user => {
    currentUser = user;
    renderUserInfo(user);
    loadRecentMeetings(user.uid);
  });

  function renderUserInfo(user) {
    const nameEl   = document.getElementById('dash-name');
    const avatarEl = document.getElementById('dash-avatar');
    if (nameEl) nameEl.textContent = user.displayName || user.email || 'User';
    if (avatarEl) {
      if (user.photoURL) {
        avatarEl.innerHTML = `<img class="dash-avatar" src="${user.photoURL}" alt="avatar" referrerpolicy="no-referrer">`;
      } else {
        avatarEl.innerHTML = `<div class="dash-avatar-placeholder">${getInitials(user.displayName)}</div>`;
      }
    }
    // Nav
    const navUser = document.getElementById('nav-user');
    if (navUser) {
      navUser.innerHTML = user.photoURL
        ? `<img class="nav-avatar" src="${user.photoURL}" referrerpolicy="no-referrer">`
        : `<div class="nav-avatar-initials">${getInitials(user.displayName)}</div>`;
    }
  }

  // ── Sign out ───────────────────────────────────────────────
  document.getElementById('sign-out-btn')?.addEventListener('click', () => {
    auth.signOut().then(() => window.location.href = 'index.html');
  });

  // ── Passcode toggle ───────────────────────────────────────
  const toggle = document.getElementById('passcode-toggle');
  const passField = document.getElementById('passcode-field');
  toggle?.addEventListener('click', () => {
    usePasscode = !usePasscode;
    toggle.classList.toggle('on', usePasscode);
    passField?.classList.toggle('hidden', !usePasscode);
    if (usePasscode) passField?.querySelector('input')?.focus();
  });

  // ── Create Meeting ────────────────────────────────────────
  document.getElementById('create-btn')?.addEventListener('click', async () => {
    if (!currentUser) return;
    const btn = document.getElementById('create-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    generatedId = generateMeetingId();
    const passcode = usePasscode
      ? (document.getElementById('passcode-input')?.value.trim() || '')
      : '';

    try {
      await db.collection('meetings').doc(generatedId).set({
        meetingId:  generatedId,
        hostId:     currentUser.uid,
        hostName:   currentUser.displayName || '',
        hostPhoto:  currentUser.photoURL || '',
        passcode:   passcode,
        hasPasscode: usePasscode && passcode !== '',
        createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
      });

      // Show confirmation modal
      document.getElementById('modal-meeting-id').textContent = generatedId;
      const link = `${window.location.origin}/${window.location.pathname.replace('dash.html', '')}call.html?room=${generatedId}`;
      document.getElementById('modal-meeting-link').value = link;
      openModal('create-modal');
    } catch (e) {
      console.error(e);
      showToast('Failed to create meeting. Check Firebase config.', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '＋ Start New Meeting';
    }
  });

  // Enter meeting from modal
  document.getElementById('modal-enter-btn')?.addEventListener('click', () => {
    if (generatedId) window.location.href = `call.html?room=${generatedId}`;
  });

  // Copy link
  document.getElementById('copy-link-btn')?.addEventListener('click', () => {
    const link = document.getElementById('modal-meeting-link')?.value;
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => showToast('Link copied!', 'success'));
  });

  // ── Join Meeting ──────────────────────────────────────────
  document.getElementById('join-btn')?.addEventListener('click', async () => {
    const idInput = document.getElementById('join-id-input');
    const pcInput = document.getElementById('join-passcode-input');
    const roomId  = idInput?.value.trim().replace(/\s/g, '');
    if (!roomId || roomId.length < 6) { showToast('Enter a valid Meeting ID', 'error'); return; }

    const btn = document.getElementById('join-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    try {
      const snap = await db.collection('meetings').doc(roomId).get();
      if (!snap.exists) { showToast('Meeting not found', 'error'); return; }
      const data = snap.data();
      if (data.hasPasscode) {
        const enteredPc = pcInput?.value.trim();
        if (!enteredPc) { showToast('This meeting requires a passcode', 'error'); return; }
        if (enteredPc !== data.passcode) { showToast('Wrong passcode', 'error'); return; }
      }
      window.location.href = `call.html?room=${roomId}`;
    } catch (e) {
      console.error(e);
      showToast('Error joining meeting', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Join →';
    }
  });

  // Allow pressing Enter in join inputs
  document.getElementById('join-id-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('join-btn')?.click();
  });
  document.getElementById('join-passcode-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('join-btn')?.click();
  });

  // ── Load recent meetings ──────────────────────────────────
  async function loadRecentMeetings(uid) {
    const container = document.getElementById('recent-list');
    if (!container) return;
    try {
      const snap = await db.collection('meetings')
        .where('hostId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();

      if (snap.empty) {
        container.innerHTML = `<p style="font-size:13px;color:var(--text-muted);text-align:center;padding:20px 0">
          No meetings yet — create one above!
        </p>`;
        return;
      }
      container.innerHTML = '';
      snap.forEach(doc => {
        const d = doc.data();
        const row = document.createElement('div');
        row.className = 'meeting-row';
        row.innerHTML = `
          <div>
            <div class="meeting-row-id">${d.meetingId}</div>
            <div class="meeting-row-time">${formatTime(d.createdAt)}</div>
          </div>
          <button class="meeting-row-join" data-id="${d.meetingId}">Rejoin</button>`;
        row.querySelector('.meeting-row-join').addEventListener('click', () => {
          window.location.href = `call.html?room=${d.meetingId}`;
        });
        container.appendChild(row);
      });
    } catch (e) {
      console.error('Recent meetings error:', e);
    }
  }

  // ── Modal helpers ─────────────────────────────────────────
  function openModal(id) {
    document.getElementById(id)?.classList.add('open');
  }
  function closeModal(id) {
    document.getElementById(id)?.classList.remove('open');
  }
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });
}
