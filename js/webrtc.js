// ============================================================
//  js/webrtc.js — Full mesh WebRTC + Firestore signaling
//  Architecture: Each joining user makes offers to all existing
//  participants. Firebase Firestore acts as the signaling server.
// ============================================================

(async function () {
  // ── Guard: only run on call page ──────────────────────────
  if (!document.getElementById('call-root')) return;

  // ── URL params ────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const ROOM_ID = params.get('room');
  if (!ROOM_ID) { window.location.href = 'dash.html'; return; }

  // ── Auth check ────────────────────────────────────────────
  let ME = null;
  await new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(user => {
      unsub();
      if (!user) { window.location.href = 'index.html'; return; }
      ME = user;
      resolve();
    });
  });

  // ── DOM references ────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const connectingOverlay = $('connecting-overlay');
  const passcodeGate      = $('passcode-gate');
  const callRoot          = $('call-root');
  const videoGrid         = $('video-grid');
  const chatMessages      = $('chat-messages');
  const chatInput         = $('chat-input');
  const participantsList  = $('participants-list');
  const callClock         = $('call-clock');
  const callRoomId        = $('call-room-id-display');
  const reactionsPicker   = $('reactions-picker');
  const sidebar           = $('call-sidebar');

  // ── Control buttons ───────────────────────────────────────
  const btnMic     = $('btn-mic');
  const btnCam     = $('btn-cam');
  const btnScreen  = $('btn-screen');
  const btnHand    = $('btn-hand');
  const btnReact   = $('btn-react');
  const btnChat    = $('btn-chat');
  const btnPeople  = $('btn-people');
  const btnLeave   = $('btn-leave');
  const chatTabBtn = $('chat-tab');
  const peopleTabBtn = $('people-tab');
  const sendBtn    = $('chat-send');
  const copyBtn    = $('call-copy-btn');

  // ── State ─────────────────────────────────────────────────
  let localStream    = null;
  let screenStream   = null;
  let peers          = {};   // { uid: RTCPeerConnection }
  let micEnabled     = true;
  let camEnabled     = true;
  let handRaised     = false;
  let sidebarOpen    = false;
  let activeTab      = 'chat';
  let callStartTime  = Date.now();
  let unsubscribers  = [];
  let meetingData    = null;

  // ── Firestore refs ────────────────────────────────────────
  const meetingRef     = db.collection('meetings').doc(ROOM_ID);
  const roomRef        = db.collection('rooms').doc(ROOM_ID);
  const participantRef = roomRef.collection('participants').doc(ME.uid);
  const signalsRef     = roomRef.collection('signals');
  const chatRef        = roomRef.collection('chat');
  const eventsRef      = roomRef.collection('events');

  // ── Display room ID ───────────────────────────────────────
  if (callRoomId) callRoomId.innerHTML = `ID: <span>${ROOM_ID}</span>`;

  // ── Clock ─────────────────────────────────────────────────
  function updateClock() {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    if (callClock) callClock.textContent = h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ── Network quality (basic) ───────────────────────────────
  let netQuality = 3; // 1-3
  function updateNetIndicator() {
    const bars = document.querySelectorAll('.net-bar');
    bars.forEach((b, i) => b.classList.toggle('active', i < netQuality));
  }
  updateNetIndicator();

  // ── Step 1: Validate passcode ─────────────────────────────
  async function validateAndEnter() {
    showConnecting('Checking meeting...');
    try {
      const snap = await meetingRef.get();
      if (!snap.exists) {
        alert('Meeting not found. It may have ended.');
        window.location.href = 'dash.html';
        return;
      }
      meetingData = snap.data();

      if (meetingData.hasPasscode) {
        hideConnecting();
        showPasscodeGate();
      } else {
        await initCall();
      }
    } catch (e) {
      console.error('Validate error:', e);
      showConnecting('Connection error. Retrying...');
      setTimeout(validateAndEnter, 3000);
    }
  }

  // ── Passcode gate ─────────────────────────────────────────
  function showPasscodeGate() {
    passcodeGate?.classList.remove('hidden');
    $('passcode-room-id').textContent = ROOM_ID;
  }

  $('passcode-submit')?.addEventListener('click', async () => {
    const entered = $('passcode-entry')?.value?.trim();
    const errEl   = $('passcode-error');
    if (!entered) { if (errEl) errEl.textContent = 'Please enter the passcode.'; return; }
    if (entered !== meetingData?.passcode) {
      if (errEl) errEl.textContent = 'Incorrect passcode. Try again.';
      $('passcode-entry').value = '';
      $('passcode-entry').focus();
      return;
    }
    passcodeGate?.classList.add('hidden');
    showConnecting('Joining meeting...');
    await initCall();
  });

  $('passcode-entry')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('passcode-submit')?.click();
  });

  // ── Step 2: Init call ─────────────────────────────────────
  async function initCall() {
    showConnecting('Getting your camera & mic...');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      console.warn('Camera/mic denied, trying audio only:', e);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        camEnabled = false;
      } catch (e2) {
        console.error('No media access:', e2);
        localStream = new MediaStream(); // empty stream
        micEnabled = false; camEnabled = false;
      }
    }

    addLocalTile();
    updateControlStates();

    showConnecting('Joining room...');
    await joinRoom();
    hideConnecting();
  }

  // ── Local video tile ──────────────────────────────────────
  function addLocalTile() {
    const tile = createTile(ME.uid, ME.displayName || 'You', ME.photoURL, true);
    const video = tile.querySelector('video');
    if (video && localStream) {
      video.srcObject = localStream;
      video.muted = true;
      video.play().catch(() => {});
    }
    updateGridLayout();
  }

  // ── Join room ─────────────────────────────────────────────
  async function joinRoom() {
    // Register presence
    await participantRef.set({
      uid:         ME.uid,
      displayName: ME.displayName || '',
      photoURL:    ME.photoURL || '',
      joinedAt:    firebase.firestore.FieldValue.serverTimestamp(),
      micOn:       micEnabled,
      camOn:       camEnabled,
      handRaised:  false,
    });

    // Remove on disconnect (best-effort)
    window.addEventListener('beforeunload', leaveCleanup);

    // ── Listen for all participants ────────────────────────
    const unsub1 = roomRef.collection('participants').onSnapshot(async snap => {
      const remotePeers = snap.docs.filter(d => d.id !== ME.uid);
      renderParticipantList(snap.docs);

      // Connect to new peers we don't have a connection with
      // Use UID-based deterministic initiation to avoid "glare" (both sides calling both)
      for (const pDoc of remotePeers) {
        const uid = pDoc.id;
        if (!peers[uid] && ME.uid > uid) {
          await connectToPeer(uid, pDoc.data());
        }
      }

      // Remove tiles for peers who left
      const activeUids = new Set(snap.docs.map(d => d.id));
      document.querySelectorAll('.video-tile[data-uid]').forEach(tile => {
        const uid = tile.dataset.uid;
        if (uid !== ME.uid && !activeUids.has(uid)) {
          tile.remove();
          if (peers[uid]) {
            peers[uid].close();
            delete peers[uid];
          }
          updateGridLayout();
        }
      });
    });
    unsubscribers.push(unsub1);

    // ── Listen for incoming signals (offers to me) ─────────
    const unsub2 = signalsRef
      .where('calleeId', '==', ME.uid)
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added' || change.type === 'modified') {
            handleIncomingSignal(change.doc.id, change.doc.data());
          }
        });
      });
    unsubscribers.push(unsub2);

    // ── Chat listener ──────────────────────────────────────
    const unsub3 = chatRef.orderBy('sentAt').onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'added') renderChatMsg(ch.doc.data());
      });
    });
    unsubscribers.push(unsub3);

    // ── Events listener (reactions, hand) ─────────────────
    const fiveSecAgo = new Date(Date.now() - 5000);
    const unsub4 = eventsRef
      .where('sentAt', '>', fiveSecAgo)
      .onSnapshot(snap => {
        snap.docChanges().forEach(ch => {
          if (ch.type === 'added') handleEvent(ch.doc.data());
        });
      });
    unsubscribers.push(unsub4);

    // ── Participant presence updates ───────────────────────
    const unsub5 = roomRef.collection('participants').onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'modified') updateParticipantTileStatus(ch.doc.id, ch.doc.data());
      });
    });
    unsubscribers.push(unsub5);
  }

  // ── Connect to a peer (we make the offer) ─────────────────
  async function connectToPeer(uid, peerData) {
    if (peers[uid]) return;

    const pc = createPeerConnection(uid, peerData);
    peers[uid] = pc;

    // Add our local tracks
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const signalDocId = `${ME.uid}_${uid}`;
    await signalsRef.doc(signalDocId).set({
      callerId:   ME.uid,
      calleeId:   uid,
      callerName: ME.displayName || '',
      offer:      { type: offer.type, sdp: offer.sdp },
      answer:     null,
      updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Listen for answer
    const unsub = signalsRef.doc(signalDocId).onSnapshot(async snap => {
      const data = snap.data();
      if (data?.answer && pc.signalingState === 'have-local-offer') {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (e) { console.warn('Set remote desc error:', e); }
      }
    });
    unsubscribers.push(unsub);

    // Listen for answer ICE candidates
    const unsub2 = signalsRef.doc(signalDocId)
      .collection('answerCandidates').onSnapshot(snap => {
        snap.docChanges().forEach(async ch => {
          if (ch.type === 'added') {
            try { await pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())); }
            catch (e) { console.warn('Add ICE candidate error:', e); }
          }
        });
      });
    unsubscribers.push(unsub2);
  }

  // ── Handle incoming signal (someone offers to us) ─────────
  async function handleIncomingSignal(signalDocId, data) {
    if (!data.offer || peers[data.callerId]) return;
    // Already handled
    if (data.answer) return;

    const callerUid  = data.callerId;
    const peerData   = { uid: callerUid, displayName: data.callerName };

    const pc = createPeerConnection(callerUid, peerData);
    peers[callerUid] = pc;

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Set remote description (offer)
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

    // Create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Store answer
    await signalsRef.doc(signalDocId).update({
      answer:    { type: answer.type, sdp: answer.sdp },
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Listen for caller's ICE candidates
    const unsub = signalsRef.doc(signalDocId)
      .collection('offerCandidates').onSnapshot(snap => {
        snap.docChanges().forEach(async ch => {
          if (ch.type === 'added') {
            try { await pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())); }
            catch (e) { console.warn('Add ICE candidate error:', e); }
          }
        });
      });
    unsubscribers.push(unsub);
  }

  // ── Create RTCPeerConnection ───────────────────────────────
  function createPeerConnection(uid, peerData) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // ICE candidate handler
    pc.onicecandidate = async ({ candidate }) => {
      if (!candidate) return;
      // Figure out if we're the caller or callee for this signal doc
      const asCallerDocId  = `${ME.uid}_${uid}`;
      const asCalleeDocId  = `${uid}_${ME.uid}`;
      try {
        // Try caller path first
        const callerSnap = await signalsRef.doc(asCallerDocId).get();
        if (callerSnap.exists) {
          await signalsRef.doc(asCallerDocId)
            .collection('offerCandidates')
            .add(candidate.toJSON());
        } else {
          await signalsRef.doc(asCalleeDocId)
            .collection('answerCandidates')
            .add(candidate.toJSON());
        }
      } catch (e) { console.warn('ICE write error:', e); }
    };

    // Track handler — add remote audio/video
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;

      let tile = document.querySelector(`.video-tile[data-uid="${uid}"]`);
      if (!tile) {
        tile = createTile(uid, peerData.displayName || uid.slice(0, 6), peerData.photoURL || null, false);
      }
      
      const video = tile.querySelector('video');
      if (video) {
        if (video.srcObject !== stream) {
          video.srcObject = stream;
        }
        
        // Ensure remote video elements are prepared for playback
        video.muted = false;
        video.volume = 1.0;
        
        // Attempt to play
        video.play().catch(err => {
          console.warn('Auto-play blocked or failed:', err);
          // If blocked, we might want to show a 'Click to play' overlay on the tile
          // but usually the "Enter Meeting" gesture covers it.
        });
      }
      updateGridLayout();
    };

    // Connection state tracking
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        netQuality = 3; updateNetIndicator();
      } else if (state === 'connecting') {
        netQuality = 2; updateNetIndicator();
      } else if (state === 'failed') {
        netQuality = 1; updateNetIndicator();
        // Auto reconnect
        setTimeout(() => {
          if (peers[uid]) { peers[uid].close(); delete peers[uid]; }
          roomRef.collection('participants').doc(uid).get().then(d => {
            if (d.exists && ME.uid > uid) connectToPeer(uid, d.data());
          });
        }, 3000);
      }
    };

    return pc;
  }

  // ── Video Tile ────────────────────────────────────────────
  function createTile(uid, name, photoURL, isLocal) {
    // Remove existing
    document.querySelector(`.video-tile[data-uid="${uid}"]`)?.remove();

    const tile = document.createElement('div');
    tile.className = `video-tile${isLocal ? ' local-tile' : ' remote'} ${isLocal ? '' : 'remote-tile'}`;
    tile.dataset.uid = uid;

    const initials = getInitials(name);
    tile.innerHTML = `
      <div class="tile-avatar" id="tile-avatar-${uid}">
        ${photoURL
          ? `<img class="tile-avatar-img" src="${photoURL}" referrerpolicy="no-referrer">`
          : `<div class="tile-avatar-circle">${initials}</div>`}
      </div>
      <video autoplay playsinline></video>
      <div class="tile-label">
        <span class="tile-name">${isLocal ? 'You' : name}</span>
        <span class="tile-icons">
          <span class="tile-icon tile-mic" id="tile-mic-${uid}">🎤</span>
          <span class="tile-icon tile-cam" id="tile-cam-${uid}">📹</span>
        </span>
      </div>`;

    videoGrid.appendChild(tile);
    updateGridLayout();

    // Auto-detect if video is playing (show/hide avatar)
    const video = tile.querySelector('video');
    if (video) {
      video.addEventListener('playing', () => {
        const avatar = tile.querySelector('.tile-avatar');
        if (avatar) avatar.style.display = 'none';
      });
      video.addEventListener('pause', () => {
        // Check if paused intentionally
      });
    }

    return tile;
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  // ── Grid layout ───────────────────────────────────────────
  function updateGridLayout() {
    const count = videoGrid.querySelectorAll('.video-tile').length;
    videoGrid.dataset.count = Math.min(count, 6);
  }

  // ── Control: Mic ──────────────────────────────────────────
  btnMic?.addEventListener('click', () => {
    micEnabled = !micEnabled;
    localStream?.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    btnMic.classList.toggle('muted', !micEnabled);
    $('btn-mic-icon').textContent = micEnabled ? '🎤' : '🔇';
    $('btn-mic-label').textContent = micEnabled ? 'Mute' : 'Unmute';
    participantRef.update({ micOn: micEnabled }).catch(() => {});
    updateLocalTileIcons();
  });

  // ── Control: Camera ──────────────────────────────────────
  btnCam?.addEventListener('click', () => {
    camEnabled = !camEnabled;
    localStream?.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
    btnCam.classList.toggle('muted', !camEnabled);
    $('btn-cam-icon').textContent = camEnabled ? '📹' : '🚫';
    $('btn-cam-label').textContent = camEnabled ? 'Stop Video' : 'Start Video';
    participantRef.update({ camOn: camEnabled }).catch(() => {});

    // Show/hide local avatar
    const localTile = document.querySelector(`.video-tile[data-uid="${ME.uid}"]`);
    if (localTile) {
      const avatar = localTile.querySelector('.tile-avatar');
      if (avatar) avatar.style.display = camEnabled ? 'none' : 'flex';
    }
    updateLocalTileIcons();
  });

  // ── Control: Screen Share ─────────────────────────────────
  btnScreen?.addEventListener('click', async () => {
    if (screenStream) {
      // Stop screen share
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
      btnScreen.classList.remove('active');
      $('btn-screen-label').textContent = 'Share';

      // Restore camera
      if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        if (camTrack) replaceVideoTrack(camTrack);
      }
    } else {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        replaceVideoTrack(screenTrack);
        btnScreen.classList.add('active');
        $('btn-screen-label').textContent = 'Stop Share';
        screenTrack.onended = () => btnScreen.click(); // auto-stop
      } catch (e) { console.warn('Screen share denied:', e); }
    }
  });

  function replaceVideoTrack(newTrack) {
    Object.values(peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(newTrack).catch(() => {});
    });
    // Update local preview
    const localTile = document.querySelector(`.video-tile[data-uid="${ME.uid}"]`);
    const localVideo = localTile?.querySelector('video');
    if (localVideo) {
      const newStream = new MediaStream([newTrack]);
      localStream?.getAudioTracks().forEach(t => newStream.addTrack(t));
      localVideo.srcObject = newStream;
    }
  }

  // ── Control: Raise Hand ───────────────────────────────────
  btnHand?.addEventListener('click', async () => {
    handRaised = !handRaised;
    btnHand.classList.toggle('active', handRaised);
    $('btn-hand-label').textContent = handRaised ? 'Lower Hand' : 'Raise Hand';
    await participantRef.update({ handRaised });
    if (handRaised) {
      await eventsRef.add({
        uid:        ME.uid,
        name:       ME.displayName || 'Someone',
        type:       'hand',
        sentAt:     firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  // ── Control: Emoji Reactions ──────────────────────────────
  btnReact?.addEventListener('click', e => {
    e.stopPropagation();
    reactionsPicker?.classList.toggle('open');
  });
  document.addEventListener('click', () => reactionsPicker?.classList.remove('open'));

  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const emoji = btn.dataset.emoji;
      reactionsPicker?.classList.remove('open');
      await eventsRef.add({
        uid:    ME.uid,
        name:   ME.displayName || 'Someone',
        type:   'reaction',
        emoji,
        sentAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  });

  // ── Control: Chat & People toggles ───────────────────────
  function openSidebar(tab) {
    sidebarOpen = true; activeTab = tab;
    sidebar?.classList.add('open');
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.sidebar-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
    btnChat?.classList.toggle('active', tab === 'chat');
    btnPeople?.classList.toggle('active', tab === 'people');
    if (tab === 'chat') setTimeout(() => chatInput?.focus(), 100);
  }

  function closeSidebar() {
    sidebarOpen = false;
    sidebar?.classList.remove('open');
    btnChat?.classList.remove('active');
    btnPeople?.classList.remove('active');
  }

  btnChat?.addEventListener('click', () => {
    if (sidebarOpen && activeTab === 'chat') { closeSidebar(); }
    else { openSidebar('chat'); }
  });

  btnPeople?.addEventListener('click', () => {
    if (sidebarOpen && activeTab === 'people') { closeSidebar(); }
    else { openSidebar('people'); }
  });

  chatTabBtn?.addEventListener('click', () => openSidebar('chat'));
  peopleTabBtn?.addEventListener('click', () => openSidebar('people'));

  // ── Chat send ─────────────────────────────────────────────
  async function sendChat() {
    const text = chatInput?.value?.trim();
    if (!text) return;
    if (chatInput) chatInput.value = '';
    chatInput?.focus();
    await chatRef.add({
      uid:         ME.uid,
      name:        ME.displayName || 'You',
      photoURL:    ME.photoURL || '',
      text,
      sentAt:      firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  sendBtn?.addEventListener('click', sendChat);
  chatInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // ── Render chat message ───────────────────────────────────
  function renderChatMsg(data) {
    if (!chatMessages) return;
    const isMe = data.uid === ME.uid;
    const initials = getInitials(data.name);
    const time = data.sentAt?.toDate
      ? data.sentAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    const div = document.createElement('div');
    div.className = `chat-msg${isMe ? ' self' : ''}`;
    div.innerHTML = `
      <div class="chat-msg-avatar">
        ${data.photoURL
          ? `<img src="${data.photoURL}" referrerpolicy="no-referrer">`
          : initials}
      </div>
      <div class="chat-msg-body">
        <div class="chat-msg-header">
          <span class="chat-msg-name">${isMe ? 'You' : escapeHTML(data.name)}</span>
          <span class="chat-msg-time">${time}</span>
        </div>
        <div class="chat-msg-text">${escapeHTML(data.text)}</div>
      </div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Handle events (reactions, hand) ──────────────────────
  function handleEvent(data) {
    if (data.type === 'reaction' && data.emoji) {
      floatReaction(data.uid, data.emoji);
    }
    if (data.type === 'hand') {
      const tile = document.querySelector(`.video-tile[data-uid="${data.uid}"]`);
      if (tile) {
        const badge = document.createElement('div');
        badge.className = 'hand-raised-badge'; badge.textContent = '✋';
        tile.appendChild(badge);
        setTimeout(() => badge.remove(), 8000);
      }
      showToast(`✋ ${data.name} raised their hand`, 'info');
    }
  }

  function floatReaction(uid, emoji) {
    const tile = document.querySelector(`.video-tile[data-uid="${uid}"]`) || videoGrid;
    const span = document.createElement('span');
    span.className = 'reaction-float';
    span.textContent = emoji;
    span.style.left = (20 + Math.random() * 60) + '%';
    span.style.bottom = '20%';
    tile.appendChild(span);
    setTimeout(() => span.remove(), 2500);
  }

  // ── Update participant tile status ────────────────────────
  function updateParticipantTileStatus(uid, data) {
    const micIcon = document.getElementById(`tile-mic-${uid}`);
    const camIcon = document.getElementById(`tile-cam-${uid}`);
    if (micIcon) micIcon.classList.toggle('muted', !data.micOn);
    if (camIcon) camIcon.classList.toggle('muted', !data.camOn);

    const tile = document.querySelector(`.video-tile[data-uid="${uid}"]`);
    if (tile) {
      if (data.handRaised) {
        if (!tile.querySelector('.hand-raised-badge')) {
          const badge = document.createElement('div');
          badge.className = 'hand-raised-badge'; badge.textContent = '✋';
          tile.appendChild(badge);
        }
      } else {
        tile.querySelector('.hand-raised-badge')?.remove();
      }
    }
  }

  function updateLocalTileIcons() {
    const micIcon = document.getElementById(`tile-mic-${ME.uid}`);
    const camIcon = document.getElementById(`tile-cam-${ME.uid}`);
    if (micIcon) { micIcon.textContent = micEnabled ? '🎤' : '🔇'; micIcon.classList.toggle('muted', !micEnabled); }
    if (camIcon) { camIcon.textContent = camEnabled ? '📹' : '🚫'; camIcon.classList.toggle('muted', !camEnabled); }
  }

  // ── Render participants list ──────────────────────────────
  function renderParticipantList(docs) {
    if (!participantsList) return;
    participantsList.innerHTML = '';
    docs.forEach(doc => {
      const d = doc.data();
      const isMe = doc.id === ME.uid;
      const initials = getInitials(d.displayName);
      const row = document.createElement('div');
      row.className = 'participant-row';
      row.innerHTML = `
        <div class="participant-avatar">
          ${d.photoURL
            ? `<img src="${d.photoURL}" referrerpolicy="no-referrer">`
            : initials}
        </div>
        <div class="participant-info">
          <div class="participant-name">${escapeHTML(d.displayName || 'User')}${isMe ? ' (You)' : ''}</div>
          <div class="participant-status">${isMe ? 'Host' : 'Participant'}</div>
        </div>
        <div class="participant-icons">
          ${d.micOn !== false ? '🎤' : '🔇'}
          ${d.camOn !== false ? '📹' : '🚫'}
          ${d.handRaised ? '✋' : ''}
        </div>`;
      participantsList.appendChild(row);
    });
  }

  // ── Control: Leave ────────────────────────────────────────
  btnLeave?.addEventListener('click', () => {
    leaveCleanup();
    window.location.href = 'dash.html';
  });

  async function leaveCleanup() {
    unsubscribers.forEach(unsub => { try { unsub(); } catch {} });
    Object.values(peers).forEach(pc => { try { pc.close(); } catch {} });
    localStream?.getTracks().forEach(t => t.stop());
    screenStream?.getTracks().forEach(t => t.stop());
    try {
      await participantRef.delete();
      // Clean up signal docs
      const sigSnap = await signalsRef.where('callerId', '==', ME.uid).get();
      sigSnap.forEach(d => d.ref.delete());
      const sigSnap2 = await signalsRef.where('calleeId', '==', ME.uid).get();
      sigSnap2.forEach(d => d.ref.delete());
    } catch {}
  }

  // ── Copy link ─────────────────────────────────────────────
  copyBtn?.addEventListener('click', () => {
    const link = `${window.location.origin}${window.location.pathname}?room=${ROOM_ID}`;
    navigator.clipboard.writeText(link).then(() => showToast('Meeting link copied!', 'success')).catch(() => {
      // Fallback
      const el = document.createElement('textarea');
      el.value = link; document.body.appendChild(el);
      el.select(); document.execCommand('copy'); el.remove();
      showToast('Meeting link copied!', 'success');
    });
  });

  // ── Connecting overlay ────────────────────────────────────
  function showConnecting(msg = 'Connecting...') {
    if (connectingOverlay) {
      connectingOverlay.classList.remove('hidden');
      const txt = connectingOverlay.querySelector('.connecting-text');
      if (txt) txt.textContent = msg;
    }
    callRoot?.classList.add('hidden');
  }
  function hideConnecting() {
    connectingOverlay?.classList.add('hidden');
    callRoot?.classList.remove('hidden');
  }

  // ── Active speaker detection ──────────────────────────────
  // Basic audio level detection for local
  if (localStream && typeof AudioContext !== 'undefined') {
    try {
      const audioCtx  = new AudioContext();
      const analyser  = audioCtx.createAnalyser();
      const source    = audioCtx.createMediaStreamSource(localStream);
      source.connect(analyser);
      analyser.fftSize = 256;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let speaking = false;
      setInterval(() => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        const nowSpeaking = avg > 20;
        if (nowSpeaking !== speaking) {
          speaking = nowSpeaking;
          const tile = document.querySelector(`.video-tile[data-uid="${ME.uid}"]`);
          tile?.classList.toggle('speaking', speaking);
        }
      }, 200);
    } catch {}
  }

  // ── Control state visual ──────────────────────────────────
  function updateControlStates() {
    btnMic?.classList.toggle('muted', !micEnabled);
    btnCam?.classList.toggle('muted', !camEnabled);
    if ($('btn-mic-icon')) $('btn-mic-icon').textContent = micEnabled ? '🎤' : '🔇';
    if ($('btn-cam-icon')) $('btn-cam-icon').textContent = camEnabled ? '📹' : '🚫';
    if ($('btn-mic-label')) $('btn-mic-label').textContent = micEnabled ? 'Mute' : 'Unmute';
    if ($('btn-cam-label')) $('btn-cam-label').textContent = camEnabled ? 'Stop Video' : 'Start Video';
    updateLocalTileIcons();
  }

  // ── Toast ─────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `toast ${type} show`;
    setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ── Helpers ───────────────────────────────────────────────
  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Kick off ──────────────────────────────────────────────
  await validateAndEnter();
})();
