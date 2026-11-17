(() => {
  'use strict';

  const STORAGE_KEY_PRESETS = 'withear_presets_v1';
  const STORAGE_KEY_NICKNAME = 'withear_nickname_v1';
  const STORAGE_KEY_CLIENT_ID = 'withear_client_id_v1';
  const STORAGE_KEY_ROOMS = 'withear_shared_rooms_v1';

  const STICKER_COLORS = ['#FFE156', '#FF7EB6', '#6EE7B7', '#70D6FF', '#FF9F5A', '#E9FFB8'];

  const DEFAULT_PRESETS = [
    {
      id: 0,
      name: '1번 곡 · 오프닝',
      beatsPerBar: 4,
      mode: 'fixed',
      bpm: 120,
      bars: 0,
      loopVariable: true,
      sections: [
        { name: '인트로', bpm: 110, bars: 4 },
        { name: '메인', bpm: 124, bars: 8 }
      ]
    },
    {
      id: 1,
      name: '2번 곡 · 빌드업',
      beatsPerBar: 4,
      mode: 'variable',
      bpm: 112,
      bars: 16,
      loopVariable: true,
      sections: [
        { name: '인트로', bpm: 96, bars: 4 },
        { name: '벌스', bpm: 112, bars: 8 },
        { name: '후렴', bpm: 132, bars: 4 }
      ]
    },
    {
      id: 2,
      name: '3번 곡 · 발라드',
      beatsPerBar: 4,
      mode: 'fixed',
      bpm: 76,
      bars: 16,
      loopVariable: true,
      sections: [
        { name: '1절', bpm: 76, bars: 8 },
        { name: '후렴', bpm: 82, bars: 8 }
      ]
    },
    {
      id: 3,
      name: '4번 곡 · 질주 락',
      beatsPerBar: 4,
      mode: 'variable',
      bpm: 144,
      bars: 12,
      loopVariable: true,
      sections: [
        { name: '리프', bpm: 136, bars: 4 },
        { name: '하이라이트', bpm: 152, bars: 8 }
      ]
    },
    {
      id: 4,
      name: '5번 곡 · 왈츠',
      beatsPerBar: 3,
      mode: 'fixed',
      bpm: 105,
      bars: 8,
      loopVariable: true,
      sections: [
        { name: 'A파트', bpm: 105, bars: 8 }
      ]
    },
    {
      id: 5,
      name: '6번 곡 · 앵콜',
      beatsPerBar: 4,
      mode: 'fixed',
      bpm: 128,
      bars: 0,
      loopVariable: true,
      sections: [
        { name: '오프닝', bpm: 128, bars: 8 }
      ]
    }
  ];

  function getOrCreateClientId() {
    try {
      let id = localStorage.getItem(STORAGE_KEY_CLIENT_ID);
      if (!id) {
        id = 'usr_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(STORAGE_KEY_CLIENT_ID, id);
      }
      return id;
    } catch (_) {
      return 'usr_' + Math.random().toString(36).slice(2, 10);
    }
  }

  const state = {
    currentScreen: 'home',
    modalMode: 'create',
    clientId: getOrCreateClientId(),
    nickname: localStorage.getItem(STORAGE_KEY_NICKNAME) || '',
    presets: loadPresets(),
    editingSlotIndex: 0,
    editingSectionIndex: 0,
    tapTimestamps: [],
    isPreviewPlaying: false,

    roomCode: null,
    isHost: false,
    participants: [],
    selectedPresetIndex: 0,
    isPlaying: false,
    playStartTimeMs: null,
    playbackSeq: 0,
    serverClockOffsetMs: 0,
    backendAvailable: false,
    clickSound: 'studio'
  };

  function loadPresets() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PRESETS);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PRESETS));
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === 6) {
        return parsed.map((p, idx) => ({
          id: idx,
          name: String(p.name || `${idx + 1}번 프리셋`),
          beatsPerBar: Number(p.beatsPerBar) || 4,
          mode: p.mode === 'variable' ? 'variable' : 'fixed',
          bpm: clampBpm(p.bpm || 120),
          bars: Math.max(0, parseInt(p.bars, 10) || 0),
          loopVariable: true,
          sections: Array.isArray(p.sections) && p.sections.length > 0
            ? p.sections.map((s, sIdx) => ({
                name: String(s.name || `구간 ${sIdx + 1}`),
                bpm: clampBpm(s.bpm || 120),
                bars: Math.max(1, parseInt(s.bars, 10) || 4)
              }))
            : [{ name: '구간 1', bpm: clampBpm(p.bpm || 120), bars: 4 }]
        }));
      }
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_PRESETS));
  }

  function savePresetsToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(state.presets));
    } catch (_) {}
    if (state.backendAvailable) {
      apiRequest(`/api/presets/${encodeURIComponent(state.clientId)}`, 'PUT', {
        presets: state.presets
      }).catch(() => {});
    }
  }

  function clampBpm(val) {
    const n = Math.round(Number(val) || 120);
    return Math.min(300, Math.max(30, n));
  }

  // ==========================================
  // BACKEND REST API + SSE + WEBSOCKET CLIENT
  // ==========================================
  let ws = null;
  let wsConnected = false;
  let sseSource = null;
  let broadcastChannel = null;

  if ('BroadcastChannel' in window) {
    broadcastChannel = new BroadcastChannel('withear_sync_v1');
    broadcastChannel.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'room_state' && ev.data.room && ev.data.room.code === state.roomCode) {
        applyRoomStateSnapshot(ev.data.room);
      }
    };
  }

  window.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_KEY_ROOMS && state.roomCode) {
      const all = getLocalRoomsMap();
      if (all[state.roomCode]) applyRoomStateSnapshot(all[state.roomCode]);
    }
  });

  async function apiRequest(path, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': state.clientId
      }
    };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function syncServerClock() {
    try {
      const t0 = Date.now();
      const data = await apiRequest(`/api/clock?clientSentAt=${t0}`, 'GET');
      const t3 = Date.now();
      const rtt = t3 - t0;
      const estimatedServerTime = data.serverSentAt + rtt / 2;
      state.serverClockOffsetMs = estimatedServerTime - t3;
      state.backendAvailable = true;
      updateSyncTag(true, 'SERVER SYNC');
    } catch (_) {
      state.backendAvailable = false;
    }
  }

  function updateSyncTag(online, labelText) {
    const dot = document.getElementById('sync-status-dot');
    const txt = document.getElementById('sync-status-text');
    if (dot) dot.style.background = online ? '#6EE7B7' : '#FFE156';
    if (txt) txt.textContent = labelText;
  }

  function subscribeRoomSse(roomCode) {
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
    if (!state.backendAvailable || !('EventSource' in window)) return;
    try {
      sseSource = new EventSource(`/api/rooms/${encodeURIComponent(roomCode)}/events`);
      sseSource.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          if (parsed && parsed.type === 'room_state' && parsed.room) {
            applyRoomStateSnapshot(parsed.room);
          }
        } catch (_) {}
      };
    } catch (_) {}
  }

  function connectWebSocket() {
    if (window.location.protocol === 'file:') return;
    syncServerClock();

    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws.onopen = () => {
        wsConnected = true;
        state.backendAvailable = true;
        updateSyncTag(true, 'LIVE SYNC');
        ws.send(JSON.stringify({ type: 'ping_clock', clientSentAt: Date.now() }));
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong_clock') {
            const now = Date.now();
            const rtt = now - msg.clientSentAt;
            state.serverClockOffsetMs = (msg.serverTime + rtt / 2) - now;
          }
          if (msg.type === 'room_joined' || msg.type === 'room_state') {
            applyRoomStateSnapshot(msg.room);
          }
        } catch (_) {}
      };
      ws.onclose = () => {
        wsConnected = false;
      };
      ws.onerror = () => {
        wsConnected = false;
      };
    } catch (_) {}
  }

  // ==========================================
  // WEB AUDIO METRONOME ENGINE (CLOCK-SYNCED)
  // ==========================================
  let audioCtx = null;
  let schedulerTimerId = null;
  let nextNoteAudioTime = 0;
  let sequenceStepIndex = 0;

  function ensureAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playClickSound(time, isDownbeat, soundType) {
    const ctx = ensureAudioContext();
    const t = Math.max(ctx.currentTime, time);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    if (soundType === 'woodblock') {
      osc.type = 'triangle';
      const baseFreq = isDownbeat ? 1180 : 820;
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.55, t + 0.045);
      gain.gain.setValueAtTime(isDownbeat ? 0.95 : 0.65, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.06);
    } else if (soundType === 'digital') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(isDownbeat ? 1760 : 880, t);
      gain.gain.setValueAtTime(isDownbeat ? 0.45 : 0.28, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.05);
    } else if (soundType === 'soft') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(isDownbeat ? 740 : 520, t);
      gain.gain.setValueAtTime(isDownbeat ? 0.85 : 0.5, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.075);
    } else {
      osc.type = 'sine';
      const startFreq = isDownbeat ? 1480 : 980;
      osc.frequency.setValueAtTime(startFreq, t);
      osc.frequency.exponentialRampToValueAtTime(isDownbeat ? 620 : 420, t + 0.035);
      gain.gain.setValueAtTime(isDownbeat ? 0.95 : 0.62, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.042);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.045);
    }
  }

  function resolveBeatMetadata(preset, beatIndex) {
    const beatsPerBar = Number(preset.beatsPerBar) || 4;
    const globalBarZeroBased = Math.floor(beatIndex / beatsPerBar);
    const beatInBar = beatIndex % beatsPerBar;

    if (preset.mode === 'fixed') {
      const maxBars = Number(preset.bars) || 0;
      if (maxBars > 0 && globalBarZeroBased >= maxBars) {
        return { finished: true };
      }
      return {
        finished: false,
        bpm: clampBpm(preset.bpm),
        beatInBar,
        globalBar: globalBarZeroBased + 1,
        totalBars: maxBars > 0 ? maxBars : '∞',
        sectionName: null
      };
    }

    const sections = Array.isArray(preset.sections) && preset.sections.length > 0
      ? preset.sections
      : [{ name: '구간 1', bpm: preset.bpm || 120, bars: 4 }];

    const totalCycleBars = sections.reduce((acc, s) => acc + (Math.max(1, Number(s.bars) || 4)), 0);
    const effectiveBarInCycle = globalBarZeroBased % totalCycleBars;

    let accumulatedBars = 0;
    let chosenSectionIndex = 0;
    let barInsideSection = 1;

    for (let i = 0; i < sections.length; i++) {
      const secBars = Math.max(1, Number(sections[i].bars) || 4);
      if (effectiveBarInCycle < accumulatedBars + secBars) {
        chosenSectionIndex = i;
        barInsideSection = (effectiveBarInCycle - accumulatedBars) + 1;
        break;
      }
      accumulatedBars += secBars;
    }

    const activeSec = sections[chosenSectionIndex];
    return {
      finished: false,
      bpm: clampBpm(activeSec.bpm),
      beatInBar,
      globalBar: effectiveBarInCycle + 1,
      totalBars: totalCycleBars,
      sectionIndex: chosenSectionIndex,
      sectionCount: sections.length,
      sectionName: activeSec.name,
      sectionBar: barInsideSection,
      sectionTotalBars: activeSec.bars
    };
  }

  function startMetronomeEngine(activePreset, scheduledServerStartTime = null) {
    stopMetronomeEngine(false);
    const ctx = ensureAudioContext();
    sequenceStepIndex = 0;

    if (scheduledServerStartTime) {
      const estimatedServerNow = Date.now() + state.serverClockOffsetMs;
      const deltaSec = (scheduledServerStartTime - estimatedServerNow) / 1000;
      nextNoteAudioTime = ctx.currentTime + Math.max(0.02, Math.min(0.5, deltaSec));
    } else {
      nextNoteAudioTime = ctx.currentTime + 0.04;
    }

    schedulerTimerId = window.setInterval(() => {
      if (!state.isPlaying && !state.isPreviewPlaying) return;

      while (nextNoteAudioTime < ctx.currentTime + 0.1) {
        const meta = resolveBeatMetadata(activePreset, sequenceStepIndex);
        if (meta.finished) {
          if (state.isPreviewPlaying) stopPreviewPlay();
          else if (state.isPlaying) triggerRoomPlayState(false);
          return;
        }

        playClickSound(nextNoteAudioTime, meta.beatInBar === 0, state.clickSound);

        const delayMs = Math.max(0, (nextNoteAudioTime - ctx.currentTime) * 1000);
        const capturedMeta = { ...meta };
        window.setTimeout(() => {
          if (!state.isPlaying && !state.isPreviewPlaying) return;
          updateVisualBeatUI(capturedMeta);
        }, delayMs);

        nextNoteAudioTime += 60.0 / meta.bpm;
        sequenceStepIndex++;
      }
    }, 25);
  }

  function stopMetronomeEngine(resetUI = true) {
    if (schedulerTimerId !== null) {
      clearInterval(schedulerTimerId);
      schedulerTimerId = null;
    }
    document.body.classList.remove('beat-flash-downbeat', 'beat-flash-normal');
    if (resetUI) resetRoomBeatLEDs();
  }

  function getLocalRoomsMap() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_ROOMS) || '{}');
    } catch (_) {
      return {};
    }
  }

  function saveLocalRoomSnapshot(roomSnapshot) {
    try {
      const all = getLocalRoomsMap();
      all[roomSnapshot.code] = roomSnapshot;
      localStorage.setItem(STORAGE_KEY_ROOMS, JSON.stringify(all));
    } catch (_) {}
    if (broadcastChannel) {
      broadcastChannel.postMessage({ type: 'room_state', room: roomSnapshot });
    }
  }

  function applyRoomStateSnapshot(room) {
    if (!room) return;
    const wasPlaying = state.isPlaying;
    const prevPresetIdx = state.selectedPresetIndex;
    const prevSeq = state.playbackSeq;

    state.roomCode = room.code;
    state.isHost = room.hostId === state.clientId;
    state.participants = Array.isArray(room.participants) ? room.participants : [];

    if (Array.isArray(room.presets) && room.presets.length === 6) {
      state.presets = room.presets;
    }
    if (typeof room.selectedPresetIndex === 'number') {
      state.selectedPresetIndex = room.selectedPresetIndex;
    }

    const playback = room.playback || { isPlaying: false };
    state.isPlaying = Boolean(playback.isPlaying);
    state.playStartTimeMs = playback.startServerTime || null;
    state.playbackSeq = playback.seq || 0;

    renderRoomScreen();

    if (state.isPlaying) {
      if (!wasPlaying || prevPresetIdx !== state.selectedPresetIndex || prevSeq !== state.playbackSeq) {
        const preset = state.presets[state.selectedPresetIndex] || state.presets[0];
        startMetronomeEngine(preset, state.playStartTimeMs);
      }
    } else if (wasPlaying) {
      stopMetronomeEngine(true);
    }
  }

  function switchScreen(screenName) {
    if (state.isPreviewPlaying) stopPreviewPlay();
    state.currentScreen = screenName;
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    const target = document.getElementById(`screen-${screenName}`);
    if (target) target.classList.add('active');

    if (screenName === 'presets') renderPresetSettingsScreen();
    if (screenName === 'room') renderRoomScreen();
  }

  function showToast(message) {
    const toast = document.getElementById('toast-msg');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  // ==========================================
  // MODAL (방 만들기 / 방 접속하기)
  // ==========================================
  function openRoomModal(mode) {
    state.modalMode = mode;
    const backdrop = document.getElementById('room-modal-backdrop');
    const titleEl = document.getElementById('modal-title-text');
    const codeInput = document.getElementById('input-room-code');
    const nickInput = document.getElementById('input-nickname');

    if (mode === 'create') {
      titleEl.textContent = '방 만들기';
      codeInput.value = String(Math.floor(1000 + Math.random() * 9000));
    } else {
      titleEl.textContent = '방 접속하기';
      codeInput.value = state.roomCode || '';
    }

    nickInput.value = state.nickname || (mode === 'create' ? '그룹장' : '');
    backdrop.classList.add('open');
    setTimeout(() => {
      if (mode === 'join' && !codeInput.value) codeInput.focus();
      else nickInput.focus();
    }, 50);
  }

  function closeRoomModal() {
    document.getElementById('room-modal-backdrop').classList.remove('open');
  }

  async function handleRoomEntrySubmit(e) {
    e.preventDefault();
    ensureAudioContext();

    const codeInput = document.getElementById('input-room-code');
    const nickInput = document.getElementById('input-nickname');
    const rawCode = String(codeInput.value || '').replace(/\D/g, '').slice(0, 4);
    const nickname = String(nickInput.value || '').trim() || '멤버';

    if (rawCode.length !== 4) {
      showToast('4자리 숫자를 입력해주세요!');
      codeInput.focus();
      return;
    }

    state.nickname = nickname;
    try { localStorage.setItem(STORAGE_KEY_NICKNAME, nickname); } catch (_) {}
    closeRoomModal();

    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: state.modalMode === 'create' ? 'create_room' : 'join_room',
        clientId: state.clientId,
        roomCode: rawCode,
        nickname,
        presets: state.presets
      }));
      subscribeRoomSse(rawCode);
    } else if (state.backendAvailable) {
      try {
        const endpoint = state.modalMode === 'create'
          ? '/api/rooms'
          : `/api/rooms/${encodeURIComponent(rawCode)}/join`;
        const data = await apiRequest(endpoint, 'POST', {
          roomCode: rawCode,
          clientId: state.clientId,
          nickname,
          presets: state.presets
        });
        if (data.room) {
          applyRoomStateSnapshot(data.room);
          subscribeRoomSse(data.room.code);
        }
      } catch (err) {
        showToast(err.message);
      }
    } else {
      const allRooms = getLocalRoomsMap();
      let room = allRooms[rawCode];
      if (state.modalMode === 'create' || !room) {
        room = {
          code: rawCode,
          hostId: state.clientId,
          participants: [{ id: state.clientId, nickname, isHost: true }],
          presets: state.presets,
          selectedPresetIndex: 0,
          playback: { isPlaying: false, startServerTime: null, presetIndex: 0, seq: 1 }
        };
      } else {
        if (!room.participants.some((p) => p.id === state.clientId)) {
          room.participants.push({ id: state.clientId, nickname, isHost: false });
        }
      }
      saveLocalRoomSnapshot(room);
      applyRoomStateSnapshot(room);
    }

    switchScreen('room');
  }

  // ==========================================
  // PRESET SETTINGS
  // ==========================================
  function getActiveEditingPreset() {
    return state.presets[state.editingSlotIndex];
  }

  function renderPresetSettingsScreen() {
    const preset = getActiveEditingPreset();
    if (!preset) return;

    const tabsEl = document.getElementById('preset-slot-tabs');
    tabsEl.innerHTML = '';
    state.presets.forEach((p, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `slot-num-btn ${idx === state.editingSlotIndex ? 'active' : ''}`;
      btn.style.background = idx === state.editingSlotIndex ? STICKER_COLORS[idx] : '';
      btn.textContent = `${idx + 1}`;
      btn.addEventListener('click', () => {
        state.editingSlotIndex = idx;
        state.editingSectionIndex = 0;
        state.tapTimestamps = [];
        if (state.isPreviewPlaying) stopPreviewPlay();
        renderPresetSettingsScreen();
      });
      tabsEl.appendChild(btn);
    });

    document.getElementById('input-preset-name').value = preset.name;
    document.getElementById('select-preset-beats').value = String(preset.beatsPerBar || 4);

    const isVariable = preset.mode === 'variable';
    document.getElementById('btn-mode-fixed').classList.toggle('active', !isVariable);
    document.getElementById('btn-mode-variable').classList.toggle('active', isVariable);
    document.getElementById('fixed-bars-panel').style.display = isVariable ? 'none' : 'flex';
    document.getElementById('variable-sections-panel').style.display = isVariable ? 'flex' : 'none';

    const tapTitle = document.getElementById('tap-pad-target-title');
    const calcLabel = document.getElementById('calc-bpm-label');
    const calcValueEl = document.getElementById('calc-bpm-value');
    const directBpmInput = document.getElementById('input-direct-bpm');

    if (!isVariable) {
      tapTitle.textContent = '연속으로 눌러 평균 BPM 계산';
      calcLabel.textContent = '고정 평균 BPM';
      calcValueEl.textContent = preset.bpm;
      directBpmInput.value = preset.bpm;
    } else {
      if (state.editingSectionIndex >= preset.sections.length) state.editingSectionIndex = 0;
      const activeSec = preset.sections[state.editingSectionIndex];
      tapTitle.textContent = `[${activeSec.name}] 탭하여 평균 BPM 측정`;
      calcLabel.textContent = `${activeSec.name} 평균 BPM`;
      calcValueEl.textContent = activeSec.bpm;
      directBpmInput.value = activeSec.bpm;
    }

    document.getElementById('input-fixed-bars').value = preset.bars;
    document.querySelectorAll('#fixed-bars-panel .bar-pill-btn').forEach((chip) => {
      chip.classList.toggle('active', Number(chip.getAttribute('data-bars')) === Number(preset.bars));
    });

    if (isVariable) {
      renderVariableSectionsEditor(preset);
    }
  }

  function renderVariableSectionsEditor(preset) {
    const listEl = document.getElementById('variable-section-list');
    const totalBars = preset.sections.reduce((acc, s) => acc + (Number(s.bars) || 4), 0);
    document.getElementById('variable-summary-text').textContent = `구간 ${preset.sections.length}개 · 총 ${totalBars}마디`;

    listEl.innerHTML = '';
    preset.sections.forEach((sec, idx) => {
      const card = document.createElement('div');
      card.className = `var-section-row ${idx === state.editingSectionIndex ? 'active-section' : ''}`;
      card.innerHTML = `
        <span style="padding: 6px 10px; border-radius: 999px; border: 2px solid #141414; background: ${STICKER_COLORS[idx % STICKER_COLORS.length]}; font-size: 0.85rem;">
          #${idx + 1}
        </span>
        <input type="text" class="var-mini-input js-sec-name" value="${escapeHtml(sec.name)}" maxlength="16" placeholder="구간 이름" />
        <div style="display:flex; align-items:center; gap:4px;">
          <input type="number" class="var-mini-input js-sec-bpm" min="30" max="300" value="${sec.bpm}" />
          <span style="font-size:0.8rem;">BPM</span>
        </div>
        <div style="display:flex; align-items:center; gap:4px;">
          <input type="number" class="var-mini-input js-sec-bars" min="1" max="256" value="${sec.bars}" />
          <span style="font-size:0.8rem;">마디</span>
        </div>
        ${preset.sections.length > 1 ? `<button type="button" class="neo-btn js-sec-delete" style="padding:6px 10px; background:#FF5D5D; color:#fff; font-size:0.8rem;">✕</button>` : '<span></span>'}
      `;

      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.classList.contains('js-sec-delete')) return;
        state.editingSectionIndex = idx;
        state.tapTimestamps = [];
        renderPresetSettingsScreen();
      });

      card.querySelector('.js-sec-name').addEventListener('input', (e) => {
        sec.name = e.target.value.trim() || `구간 ${idx + 1}`;
        savePresetsToStorage();
      });

      card.querySelector('.js-sec-bpm').addEventListener('change', (e) => {
        sec.bpm = clampBpm(e.target.value);
        state.editingSectionIndex = idx;
        savePresetsToStorage();
        renderPresetSettingsScreen();
      });

      card.querySelector('.js-sec-bars').addEventListener('change', (e) => {
        sec.bars = Math.max(1, parseInt(e.target.value, 10) || 4);
        savePresetsToStorage();
        renderPresetSettingsScreen();
      });

      const delBtn = card.querySelector('.js-sec-delete');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          preset.sections.splice(idx, 1);
          state.editingSectionIndex = 0;
          savePresetsToStorage();
          renderPresetSettingsScreen();
        });
      }

      listEl.appendChild(card);
    });
  }

  function handleTapTempo() {
    ensureAudioContext();
    playClickSound(audioCtx.currentTime, true, state.clickSound);

    const padBtn = document.getElementById('btn-tap-tempo-pad');
    if (padBtn) {
      padBtn.classList.add('tapped');
      setTimeout(() => padBtn.classList.remove('tapped'), 90);
    }

    const now = performance.now();
    if (state.tapTimestamps.length > 0 && now - state.tapTimestamps[state.tapTimestamps.length - 1] > 2400) {
      state.tapTimestamps = [];
    }
    state.tapTimestamps.push(now);
    if (state.tapTimestamps.length > 10) state.tapTimestamps.shift();

    if (state.tapTimestamps.length >= 2) {
      let totalInterval = 0;
      for (let i = 1; i < state.tapTimestamps.length; i++) {
        totalInterval += state.tapTimestamps[i] - state.tapTimestamps[i - 1];
      }
      const avgIntervalMs = totalInterval / (state.tapTimestamps.length - 1);
      applyEditedBpmValue(clampBpm(60000 / avgIntervalMs));
    }
  }

  function applyEditedBpmValue(newBpm) {
    const preset = getActiveEditingPreset();
    if (!preset) return;
    const clamped = clampBpm(newBpm);
    if (preset.mode === 'fixed') {
      preset.bpm = clamped;
    } else {
      const sec = preset.sections[state.editingSectionIndex] || preset.sections[0];
      if (sec) sec.bpm = clamped;
    }
    savePresetsToStorage();
    renderPresetSettingsScreen();
  }

  function togglePreviewPlay() {
    if (state.isPreviewPlaying) stopPreviewPlay();
    else {
      ensureAudioContext();
      state.isPreviewPlaying = true;
      document.getElementById('preset-test-play-label').textContent = '■ 정지';
      startMetronomeEngine(getActiveEditingPreset());
    }
  }

  function stopPreviewPlay() {
    state.isPreviewPlaying = false;
    stopMetronomeEngine(false);
    document.getElementById('preset-test-play-label').textContent = '▶ 테스트';
  }

  // ==========================================
  // ROOM SCREEN
  // ==========================================
  function renderRoomScreen() {
    document.getElementById('room-code-display').textContent = state.roomCode || '0000';

    const participants = state.participants.length > 0
      ? state.participants
      : [{ id: state.clientId, nickname: state.nickname || '그룹장', isHost: true }];

    const listEl = document.getElementById('participants-list');
    listEl.innerHTML = '';
    participants.forEach((p, idx) => {
      const pill = document.createElement('div');
      pill.className = 'member-sticker js-member-sticker';
      pill.style.background = STICKER_COLORS[idx % STICKER_COLORS.length];
      pill.innerHTML = `<span>${p.isHost ? '👑' : '🎧'}</span><span>${escapeHtml(p.nickname)}</span>`;
      listEl.appendChild(pill);
    });

    const activePreset = state.presets[state.selectedPresetIndex] || state.presets[0];
    const slotBadge = document.getElementById('room-active-slot-badge');
    slotBadge.textContent = `PRESET ${state.selectedPresetIndex + 1} · ${activePreset.mode === 'variable' ? '가변' : '고정'}`;
    slotBadge.style.background = STICKER_COLORS[state.selectedPresetIndex % STICKER_COLORS.length];

    document.getElementById('room-active-preset-name').textContent = activePreset.name;

    if (!state.isPlaying) {
      if (activePreset.mode === 'variable' && activePreset.sections.length > 0) {
        const firstSec = activePreset.sections[0];
        const totalVarBars = activePreset.sections.reduce((acc, s) => acc + (Number(s.bars) || 4), 0);
        document.getElementById('room-active-bpm').textContent = String(firstSec.bpm);
        document.getElementById('room-current-bar').textContent = '1';
        document.getElementById('room-total-bars').textContent = String(totalVarBars);
        const secPill = document.getElementById('room-section-pill');
        secPill.style.display = 'inline-flex';
        document.getElementById('room-current-section-label').textContent = `${firstSec.name} (${firstSec.bars}마디)`;
      } else {
        document.getElementById('room-active-bpm').textContent = String(activePreset.bpm);
        document.getElementById('room-current-bar').textContent = '1';
        document.getElementById('room-total-bars').textContent = activePreset.bars > 0 ? String(activePreset.bars) : '∞';
        document.getElementById('room-section-pill').style.display = 'none';
      }
    }

    const bpb = Number(activePreset.beatsPerBar) || 4;
    document.getElementById('room-timesig-text').textContent = bpb === 6 ? '6/8' : `${bpb}/4`;
    renderRoomBeatLEDsContainer(bpb);

    const playBtn = document.getElementById('btn-room-play-toggle');
    playBtn.classList.toggle('is-playing', state.isPlaying);
    document.getElementById('room-play-btn-icon').textContent = state.isPlaying ? '■' : '▶';
    document.getElementById('room-play-btn-text').textContent = state.isPlaying ? 'STOP' : 'PLAY';

    const gridEl = document.getElementById('room-presets-grid');
    gridEl.innerHTML = '';
    state.presets.forEach((p, idx) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `preset-color-btn p-color-${idx} ${idx === state.selectedPresetIndex ? 'selected' : ''}`;
      const bpmSummary = p.mode === 'variable'
        ? `${p.sections.map((s) => s.bpm).join('→')}`
        : `${p.bpm} BPM`;
      card.innerHTML = `
        <span class="pcb-num">#${idx + 1} · ${p.mode === 'variable' ? '가변' : '고정'}</span>
        <span class="pcb-title">${escapeHtml(p.name)}</span>
        <span class="pcb-bpm">${bpmSummary}</span>
      `;
      card.addEventListener('click', () => selectRoomPreset(idx));
      gridEl.appendChild(card);
    });
  }

  function renderRoomBeatLEDsContainer(beatsPerBar) {
    const container = document.getElementById('room-beat-leds');
    if (container.children.length === beatsPerBar) return;
    container.innerHTML = '';
    for (let i = 0; i < beatsPerBar; i++) {
      const item = document.createElement('div');
      item.className = 'beat-block';
      item.textContent = String(i + 1);
      container.appendChild(item);
    }
  }

  function resetRoomBeatLEDs() {
    const container = document.getElementById('room-beat-leds');
    if (!container) return;
    Array.from(container.children).forEach((el) => {
      el.classList.remove('active-downbeat', 'active-beat');
    });
  }

  function updateVisualBeatUI(meta) {
    if (state.currentScreen !== 'room') return;
    document.getElementById('room-active-bpm').textContent = String(meta.bpm);
    document.getElementById('room-current-bar').textContent = String(meta.globalBar);
    document.getElementById('room-total-bars').textContent = String(meta.totalBars);

    const sectionPill = document.getElementById('room-section-pill');
    if (meta.sectionName) {
      sectionPill.style.display = 'inline-flex';
      document.getElementById('room-current-section-label').textContent = `${meta.sectionName} (${meta.sectionBar}/${meta.sectionTotalBars}마디)`;
    } else {
      sectionPill.style.display = 'none';
    }

    const container = document.getElementById('room-beat-leds');
    Array.from(container.children).forEach((el, idx) => {
      el.classList.remove('active-downbeat', 'active-beat');
      if (idx === meta.beatInBar) {
        el.classList.add(idx === 0 ? 'active-downbeat' : 'active-beat');
      }
    });

    document.querySelectorAll('.js-member-sticker').forEach((s) => {
      s.classList.add('pulse');
      setTimeout(() => s.classList.remove('pulse'), 100);
    });

    document.body.classList.remove('beat-flash-downbeat', 'beat-flash-normal');
    void document.body.offsetWidth;
    document.body.classList.add(meta.beatInBar === 0 ? 'beat-flash-downbeat' : 'beat-flash-normal');
    setTimeout(() => {
      document.body.classList.remove('beat-flash-downbeat', 'beat-flash-normal');
    }, 90);
  }

  async function selectRoomPreset(index) {
    ensureAudioContext();
    state.selectedPresetIndex = index;

    if (wsConnected && ws && ws.readyState === WebSocket.OPEN && state.roomCode) {
      ws.send(JSON.stringify({ type: 'select_preset', presetIndex: index }));
    } else if (state.backendAvailable && state.roomCode) {
      try {
        const res = await apiRequest(`/api/rooms/${encodeURIComponent(state.roomCode)}/select-preset`, 'POST', {
          presetIndex: index
        });
        if (res.room) applyRoomStateSnapshot(res.room);
      } catch (_) {}
    } else if (state.roomCode) {
      const all = getLocalRoomsMap();
      const room = all[state.roomCode];
      if (room) {
        room.selectedPresetIndex = index;
        room.playback.presetIndex = index;
        if (room.playback.isPlaying) {
          room.playback.startServerTime = Date.now();
          room.playback.seq = (room.playback.seq || 0) + 1;
        }
        saveLocalRoomSnapshot(room);
        applyRoomStateSnapshot(room);
      } else renderRoomScreen();
    } else renderRoomScreen();
  }

  async function triggerRoomPlayState(nextPlayBool) {
    ensureAudioContext();
    const targetPlay = typeof nextPlayBool === 'boolean' ? nextPlayBool : !state.isPlaying;

    if (wsConnected && ws && ws.readyState === WebSocket.OPEN && state.roomCode) {
      ws.send(JSON.stringify({ type: 'toggle_play', isPlaying: targetPlay }));
    } else if (state.backendAvailable && state.roomCode) {
      try {
        const res = await apiRequest(`/api/rooms/${encodeURIComponent(state.roomCode)}/playback`, 'POST', {
          isPlaying: targetPlay
        });
        if (res.room) applyRoomStateSnapshot(res.room);
      } catch (_) {}
    } else {
      const all = getLocalRoomsMap();
      const room = state.roomCode ? all[state.roomCode] : null;
      if (room) {
        room.playback = {
          isPlaying: targetPlay,
          startServerTime: targetPlay ? Date.now() : null,
          presetIndex: state.selectedPresetIndex,
          seq: (room.playback?.seq || 0) + 1
        };
        saveLocalRoomSnapshot(room);
        applyRoomStateSnapshot(room);
      } else {
        state.isPlaying = targetPlay;
        if (targetPlay) startMetronomeEngine(state.presets[state.selectedPresetIndex]);
        else stopMetronomeEngine(true);
        renderRoomScreen();
      }
    }
  }

  async function addSimulatedBandMember() {
    const sampleNames = ['드럼 지훈', '베이스 현우', '기타 준영', '건반 수빈', '보컬 하은'];
    const existingNames = new Set(state.participants.map((p) => p.nickname));
    const available = sampleNames.filter((n) => !existingNames.has(n));
    const chosen = available.length > 0 ? available[0] : `멤버 ${state.participants.length + 1}`;

    if (wsConnected && ws && ws.readyState === WebSocket.OPEN && state.roomCode) {
      ws.send(JSON.stringify({ type: 'add_simulated_member', nickname: chosen }));
    } else if (state.backendAvailable && state.roomCode) {
      try {
        const res = await apiRequest(`/api/rooms/${encodeURIComponent(state.roomCode)}/simulate-member`, 'POST', {
          nickname: chosen
        });
        if (res.room) applyRoomStateSnapshot(res.room);
      } catch (_) {}
    } else if (state.roomCode) {
      const all = getLocalRoomsMap();
      const room = all[state.roomCode];
      if (room) {
        room.participants.push({ id: 'sim_' + Math.random().toString(36).slice(2, 7), nickname: chosen, isHost: false });
        saveLocalRoomSnapshot(room);
        applyRoomStateSnapshot(room);
      }
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initEventListeners() {
    document.getElementById('brand-home-trigger').addEventListener('click', () => {
      if (state.isPlaying) triggerRoomPlayState(false);
      switchScreen('home');
    });

    document.getElementById('btn-open-create-room').addEventListener('click', () => openRoomModal('create'));
    document.getElementById('btn-open-join-room').addEventListener('click', () => openRoomModal('join'));
    document.getElementById('btn-open-presets').addEventListener('click', () => switchScreen('presets'));

    document.getElementById('btn-close-modal').addEventListener('click', closeRoomModal);
    document.getElementById('form-room-entry').addEventListener('submit', handleRoomEntrySubmit);

    document.getElementById('btn-preset-back-home').addEventListener('click', async () => {
      savePresetsToStorage();
      if (wsConnected && ws && ws.readyState === WebSocket.OPEN && state.roomCode) {
        ws.send(JSON.stringify({ type: 'update_presets', presets: state.presets }));
      } else if (state.backendAvailable && state.roomCode) {
        try {
          await apiRequest(`/api/rooms/${encodeURIComponent(state.roomCode)}/presets`, 'PUT', {
            clientId: state.clientId,
            presets: state.presets
          });
        } catch (_) {}
      }
      showToast('저장 완료!');
      switchScreen(state.roomCode ? 'room' : 'home');
    });

    document.getElementById('btn-preset-test-play').addEventListener('click', togglePreviewPlay);

    document.getElementById('input-preset-name').addEventListener('input', (e) => {
      getActiveEditingPreset().name = e.target.value || `${state.editingSlotIndex + 1}번 곡`;
      savePresetsToStorage();
    });

    document.getElementById('select-preset-beats').addEventListener('change', (e) => {
      getActiveEditingPreset().beatsPerBar = Number(e.target.value) || 4;
      savePresetsToStorage();
    });

    document.getElementById('btn-mode-fixed').addEventListener('click', () => {
      getActiveEditingPreset().mode = 'fixed';
      state.tapTimestamps = [];
      savePresetsToStorage();
      renderPresetSettingsScreen();
    });

    document.getElementById('btn-mode-variable').addEventListener('click', () => {
      getActiveEditingPreset().mode = 'variable';
      state.editingSectionIndex = 0;
      state.tapTimestamps = [];
      savePresetsToStorage();
      renderPresetSettingsScreen();
    });

    document.getElementById('btn-tap-tempo-pad').addEventListener('click', handleTapTempo);

    window.addEventListener('keydown', (e) => {
      if (state.currentScreen === 'presets' && e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        handleTapTempo();
      }
    });

    document.getElementById('btn-bpm-minus-5').addEventListener('click', () => {
      applyEditedBpmValue((Number(document.getElementById('input-direct-bpm').value) || 120) - 5);
    });
    document.getElementById('btn-bpm-minus-1').addEventListener('click', () => {
      applyEditedBpmValue((Number(document.getElementById('input-direct-bpm').value) || 120) - 1);
    });
    document.getElementById('btn-bpm-plus-1').addEventListener('click', () => {
      applyEditedBpmValue((Number(document.getElementById('input-direct-bpm').value) || 120) + 1);
    });
    document.getElementById('btn-bpm-plus-5').addEventListener('click', () => {
      applyEditedBpmValue((Number(document.getElementById('input-direct-bpm').value) || 120) + 5);
    });
    document.getElementById('input-direct-bpm').addEventListener('change', (e) => applyEditedBpmValue(e.target.value));

    document.querySelectorAll('#fixed-bars-panel .bar-pill-btn').forEach((chip) => {
      chip.addEventListener('click', () => {
        getActiveEditingPreset().bars = Number(chip.getAttribute('data-bars')) || 0;
        savePresetsToStorage();
        renderPresetSettingsScreen();
      });
    });

    document.getElementById('input-fixed-bars').addEventListener('change', (e) => {
      getActiveEditingPreset().bars = Math.max(0, parseInt(e.target.value, 10) || 0);
      savePresetsToStorage();
      renderPresetSettingsScreen();
    });

    document.getElementById('btn-add-section').addEventListener('click', () => {
      const preset = getActiveEditingPreset();
      const nextNum = preset.sections.length + 1;
      preset.sections.push({ name: `구간 ${nextNum}`, bpm: 120, bars: 4 });
      state.editingSectionIndex = preset.sections.length - 1;
      state.tapTimestamps = [];
      savePresetsToStorage();
      renderPresetSettingsScreen();
    });

    document.getElementById('btn-copy-room-code').addEventListener('click', () => {
      if (state.roomCode && navigator.clipboard) {
        navigator.clipboard.writeText(state.roomCode).catch(() => {});
      }
      showToast(`방 번호 #${state.roomCode} 복사됨!`);
    });

    document.getElementById('select-click-sound').addEventListener('change', (e) => {
      state.clickSound = e.target.value;
      ensureAudioContext();
      playClickSound(audioCtx.currentTime, true, state.clickSound);
    });

    document.getElementById('btn-room-edit-presets').addEventListener('click', () => {
      if (state.isPlaying) triggerRoomPlayState(false);
      state.editingSlotIndex = state.selectedPresetIndex;
      switchScreen('presets');
    });

    document.getElementById('btn-leave-room').addEventListener('click', async () => {
      if (state.isPlaying) triggerRoomPlayState(false);
      if (sseSource) {
        sseSource.close();
        sseSource = null;
      }
      if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'leave_room' }));
      } else if (state.backendAvailable && state.roomCode) {
        apiRequest(`/api/rooms/${encodeURIComponent(state.roomCode)}/leave`, 'POST', {
          clientId: state.clientId
        }).catch(() => {});
      }
      state.roomCode = null;
      state.participants = [];
      switchScreen('home');
    });

    document.getElementById('btn-add-sim-member').addEventListener('click', addSimulatedBandMember);
    document.getElementById('btn-room-play-toggle').addEventListener('click', () => triggerRoomPlayState(!state.isPlaying));
  }

  initEventListeners();
  connectWebSocket();
})();
