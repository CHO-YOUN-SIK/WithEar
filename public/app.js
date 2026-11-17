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
      let id = sessionStorage.getItem(STORAGE_KEY_CLIENT_ID);
      if (!id) {
        id = 'usr_' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(STORAGE_KEY_CLIENT_ID, id);
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

    // Clock synchronization state (best min-RTT NTP sample relative to server/host)
    serverClockOffsetMs: 0,
    bestClockRttMs: Infinity,
    backendAvailable: false,
    cloudRelayConnected: false,
    clickSound: 'studio'
  };

  // Monotonic wall-clock epoch so OS NTP jumps don't cause sudden beat skips
  const MONOTONIC_EPOCH_MS = Date.now() - performance.now();

  function getMonotonicWallNowMs() {
    return MONOTONIC_EPOCH_MS + performance.now();
  }

  function getSynchronizedNowMs() {
    return getMonotonicWallNowMs() + state.serverClockOffsetMs;
  }

  function recordClockSample(clientSentAt, remoteTime, clientReceivedAt) {
    const rtt = clientReceivedAt - clientSentAt;
    if (rtt < 0 || rtt > 3000) return;
    const estimatedRemoteNow = remoteTime + rtt / 2;
    const offset = estimatedRemoteNow - clientReceivedAt;
    if (rtt <= state.bestClockRttMs) {
      state.bestClockRttMs = rtt;
      state.serverClockOffsetMs = offset;
    } else if (rtt < state.bestClockRttMs * 1.5) {
      // Gently track oscillator drift only from low-jitter samples
      state.serverClockOffsetMs = state.serverClockOffsetMs * 0.85 + offset * 0.15;
    }
  }

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
  // TIER 1: BACKEND REST API + SSE + WEBSOCKET
  // ==========================================
  let ws = null;
  let wsConnected = false;
  let sseSource = null;
  let broadcastChannel = null;
  let pendingJoinCallback = null;

  if ('BroadcastChannel' in window) {
    broadcastChannel = new BroadcastChannel('withear_sync_v2');
    broadcastChannel.onmessage = (ev) => {
      handlePeerBroadcastMessage(ev.data);
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async function syncServerClockBurst() {
    for (let i = 0; i < 5; i++) {
      try {
        const t0 = Date.now();
        const data = await apiRequest(`/api/clock?clientSentAt=${t0}`, 'GET');
        const t3 = Date.now();
        recordClockSample(t0, data.serverSentAt, t3);
        state.backendAvailable = true;
        updateSyncTag(true, 'ONLINE SYNC');
      } catch (_) {
        break;
      }
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
    // Always connect to Global Cloud Relay in parallel so online devices on GitHub Pages work immediately
    connectCloudMqttRelay();

    if (window.location.protocol === 'file:') return;

    syncServerClockBurst();

    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws.onopen = () => {
        wsConnected = true;
        state.backendAvailable = true;
        updateSyncTag(true, 'ONLINE SYNC');
        for (let i = 0; i < 5; i++) {
          setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping_clock', clientSentAt: Date.now() }));
            }
          }, i * 100);
        }
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong_clock') {
            recordClockSample(msg.clientSentAt, msg.serverTime, Date.now());
          }
          if (msg.type === 'join_error') {
            if (pendingJoinCallback) {
              const cb = pendingJoinCallback;
              pendingJoinCallback = null;
              cb({ ok: false, message: msg.message || '존재하지 않는 방입니다.' });
            } else {
              showModalError(msg.message || '존재하지 않는 방입니다.');
            }
            return;
          }
          if (msg.type === 'room_joined') {
            if (pendingJoinCallback) {
              const cb = pendingJoinCallback;
              pendingJoinCallback = null;
              cb({ ok: true, room: msg.room });
            } else {
              applyRoomStateSnapshot(msg.room);
            }
            return;
          }
          if (msg.type === 'room_state') {
            applyRoomStateSnapshot(msg.room);
          }
          if (msg.type === 'rtc_offer' || msg.type === 'rtc_answer' || msg.type === 'rtc_ice') {
            handleIncomingRtcSignal(msg);
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
  // TIER 2: ONLINE GLOBAL WEBSOCKET BROKER (MQTT OVER WSS)
  // Enables full cross-device online room creation, room existence verification,
  // participant tracking, and NTP host-member clock sync on GitHub Pages!
  // ==========================================
  let mqttSocket = null;
  let mqttKeepAliveTimer = null;
  let pendingOnlineProbe = null; // { roomCode, timerId, resolve }

  function encodeMqttLength(len) {
    const out = [];
    do {
      let byte = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) byte |= 128;
      out.push(byte);
    } while (len > 0);
    return out;
  }

  function encodeMqttUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
  }

  function buildMqttConnectPacket(clientId) {
    const variableHeader = [
      0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
      0x04,
      0x02,
      0x00, 0x3c
    ];
    const payload = encodeMqttUtf8(clientId);
    const remLen = variableHeader.length + payload.length;
    return new Uint8Array([0x10, ...encodeMqttLength(remLen), ...variableHeader, ...payload]);
  }

  function buildMqttSubscribePacket(topic, packetId = 1) {
    const variableHeader = [packetId >> 8, packetId & 0xff];
    const payload = [...encodeMqttUtf8(topic), 0x00];
    const remLen = variableHeader.length + payload.length;
    return new Uint8Array([0x82, ...encodeMqttLength(remLen), ...variableHeader, ...payload]);
  }

  function buildMqttPublishPacket(topic, messageObj, retain = false) {
    const topicBytes = encodeMqttUtf8(topic);
    const bodyBytes = messageObj === null
      ? new Uint8Array(0)
      : new TextEncoder().encode(JSON.stringify(messageObj));
    const remLen = topicBytes.length + bodyBytes.length;
    const headerByte = retain ? 0x31 : 0x30;
    return new Uint8Array([headerByte, ...encodeMqttLength(remLen), ...topicBytes, ...bodyBytes]);
  }

  function connectCloudMqttRelay() {
    if (mqttSocket) return;
    try {
      const wsRelay = new WebSocket('wss://broker.emqx.io:8084/mqtt', 'mqtt');
      wsRelay.binaryType = 'arraybuffer';

      wsRelay.onopen = () => {
        mqttSocket = wsRelay;
        wsRelay.send(buildMqttConnectPacket('we_' + state.clientId + '_' + Math.random().toString(36).slice(2, 6)));
      };

      wsRelay.onmessage = (ev) => {
        const bytes = new Uint8Array(ev.data);
        if (bytes.length < 2) return;
        const packetType = bytes[0] >> 4;

        if (packetType === 2) {
          state.cloudRelayConnected = true;
          updateSyncTag(true, 'ONLINE SYNC');
          if (state.roomCode) {
            subscribeCloudRelayRoom(state.roomCode);
          }
          clearInterval(mqttKeepAliveTimer);
          mqttKeepAliveTimer = setInterval(() => {
            if (mqttSocket && mqttSocket.readyState === WebSocket.OPEN) {
              mqttSocket.send(new Uint8Array([0xc0, 0x00]));
            }
          }, 25000);
        } else if (packetType === 3) {
          // Parse potentially multiple MQTT packets in a single WebSocket message
          let offset = 0;
          while (offset < bytes.length) {
            const pType = bytes[offset] >> 4;
            let multiplier = 1;
            let remLen = 0;
            let idx = offset + 1;
            let encodedByte;
            do {
              if (idx >= bytes.length) return;
              encodedByte = bytes[idx++];
              remLen += (encodedByte & 127) * multiplier;
              multiplier *= 128;
            } while ((encodedByte & 128) !== 0);

            const packetEnd = idx + remLen;
            if (pType === 3 && idx + 2 <= packetEnd) {
              const topicLen = (bytes[idx] << 8) | bytes[idx + 1];
              const payloadStart = idx + 2 + topicLen;
              if (payloadStart < packetEnd) {
                const payloadBytes = bytes.subarray(payloadStart, packetEnd);
                try {
                  const text = new TextDecoder().decode(payloadBytes);
                  if (text) {
                    handleCloudRelayMessage(JSON.parse(text));
                  }
                } catch (_) {}
              }
            }
            offset = packetEnd;
          }
        }
      };

      wsRelay.onclose = () => {
        state.cloudRelayConnected = false;
        mqttSocket = null;
        clearInterval(mqttKeepAliveTimer);
        setTimeout(connectCloudMqttRelay, 2500);
      };

      wsRelay.onerror = () => {
        state.cloudRelayConnected = false;
      };
    } catch (_) {}
  }

  function subscribeCloudRelayRoom(roomCode) {
    if (!mqttSocket || mqttSocket.readyState !== WebSocket.OPEN) return;
    mqttSocket.send(buildMqttSubscribePacket(`withear/v2/room/${roomCode}`));
  }

  function publishCloudRelayRoom(roomCode, payloadObj, retain = false) {
    if (!mqttSocket || mqttSocket.readyState !== WebSocket.OPEN) return;
    mqttSocket.send(buildMqttPublishPacket(`withear/v2/room/${roomCode}`, payloadObj, retain));
  }

  // ==========================================
  // TIER 3: DIRECT LOCAL P2P (WEBRTC DATACHANNEL OVER LAN/WIFI)
  // Bypasses internet broker latency completely for 1~4ms local sync!
  // ==========================================
  const rtcPeers = new Map(); // peerId -> { pc, dc, isOpen }
  const RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  function closeAllRtcPeers() {
    for (const entry of rtcPeers.values()) {
      try { if (entry.dc) entry.dc.close(); } catch (_) {}
      try { if (entry.pc) entry.pc.close(); } catch (_) {}
    }
    rtcPeers.clear();
  }

  function setupDataChannelHandlers(peerId, dc) {
    const entry = rtcPeers.get(peerId) || {};
    entry.dc = dc;
    rtcPeers.set(peerId, entry);

    dc.onopen = () => {
      entry.isOpen = true;
      updateSyncTag(true, 'P2P LOCAL SYNC');
      // Run 12 rapid local P2P clock pings (35ms apart) for <2ms local LAN lock
      if (!state.isHost) {
        state.bestClockRttMs = Infinity;
        for (let i = 0; i < 12; i++) {
          setTimeout(() => {
            if (dc.readyState === 'open') {
              dc.send(JSON.stringify({
                type: 'rtc_ping',
                clientId: state.clientId,
                clientSentAt: getMonotonicWallNowMs()
              }));
            }
          }, i * 35);
        }
      }
    };

    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'rtc_ping' && state.isHost) {
          if (dc.readyState === 'open') {
            dc.send(JSON.stringify({
              type: 'rtc_pong',
              clientSentAt: msg.clientSentAt,
              hostTime: getMonotonicWallNowMs()
            }));
          }
          return;
        }
        if (msg.type === 'rtc_pong') {
          recordClockSample(msg.clientSentAt, msg.hostTime, getMonotonicWallNowMs());
          return;
        }
        if (msg.type === 'room_state' && msg.room && msg.room.code === state.roomCode) {
          saveLocalRoomSnapshot(msg.room);
          applyRoomStateSnapshot(msg.room);
        }
      } catch (_) {}
    };

    dc.onclose = () => {
      entry.isOpen = false;
    };
  }

  function sendRtcSignal(roomCode, signalObj) {
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(signalObj)); } catch (_) {}
    }
    if (broadcastChannel) {
      try { broadcastChannel.postMessage(signalObj); } catch (_) {}
    }
    publishCloudRelayRoom(roomCode, signalObj, false);
  }

  async function initiateRtcToHost(hostId, roomCode) {
    if (!hostId || hostId === state.clientId || rtcPeers.has(hostId)) return;
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const dc = pc.createDataChannel('withear-sync', { ordered: false, maxRetransmits: 0 });
      rtcPeers.set(hostId, { pc, dc, isOpen: false });
      setupDataChannelHandlers(hostId, dc);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendRtcSignal(roomCode, {
            type: 'rtc_ice',
            roomCode,
            fromId: state.clientId,
            toId: hostId,
            candidate: ev.candidate
          });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendRtcSignal(roomCode, {
        type: 'rtc_offer',
        roomCode,
        fromId: state.clientId,
        toId: hostId,
        sdp: pc.localDescription
      });
    } catch (_) {}
  }

  async function handleIncomingRtcSignal(msg) {
    if (!msg || msg.toId !== state.clientId || msg.roomCode !== state.roomCode) return;
    try {
      if (msg.type === 'rtc_offer') {
        const existing = rtcPeers.get(msg.fromId);
        if (existing) {
          try { existing.pc.close(); } catch (_) {}
        }
        const pc = new RTCPeerConnection(RTC_CONFIG);
        rtcPeers.set(msg.fromId, { pc, dc: null, isOpen: false });

        pc.ondatachannel = (ev) => {
          setupDataChannelHandlers(msg.fromId, ev.channel);
        };

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            sendRtcSignal(msg.roomCode, {
              type: 'rtc_ice',
              roomCode: msg.roomCode,
              fromId: state.clientId,
              toId: msg.fromId,
              candidate: ev.candidate
            });
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendRtcSignal(msg.roomCode, {
          type: 'rtc_answer',
          roomCode: msg.roomCode,
          fromId: state.clientId,
          toId: msg.fromId,
          sdp: pc.localDescription
        });
      } else if (msg.type === 'rtc_answer') {
        const entry = rtcPeers.get(msg.fromId);
        if (entry && entry.pc) {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
      } else if (msg.type === 'rtc_ice') {
        const entry = rtcPeers.get(msg.fromId);
        if (entry && entry.pc && msg.candidate) {
          await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      }
    } catch (_) {}
  }

  function broadcastToAllPeers(roomCode, payloadObj, retain = false) {
    // 1. Send immediately over direct local WebRTC P2P DataChannels (1~4ms LAN)
    const serialized = JSON.stringify(payloadObj);
    for (const entry of rtcPeers.values()) {
      if (entry.dc && entry.dc.readyState === 'open') {
        try { entry.dc.send(serialized); } catch (_) {}
      }
    }
    // 2. Same-browser multi-tab sync
    if (broadcastChannel) {
      broadcastChannel.postMessage(payloadObj);
    }
    // 3. Cloud MQTT relay backup
    publishCloudRelayRoom(roomCode, payloadObj, retain);
  }

  function handlePeerBroadcastMessage(msg) {
    if (!msg) return;
    handleCloudRelayMessage(msg);
  }

  function handleCloudRelayMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // 0. WebRTC P2P signaling
    if (msg.type === 'rtc_offer' || msg.type === 'rtc_answer' || msg.type === 'rtc_ice') {
      handleIncomingRtcSignal(msg);
      return;
    }

    // 1. Handle NTP clock ping/pong between Room Host and Members
    if (msg.type === 'peer_clock_ping' && state.roomCode && msg.roomCode === state.roomCode && state.isHost) {
      broadcastToAllPeers(state.roomCode, {
        type: 'peer_clock_pong',
        roomCode: state.roomCode,
        targetClientId: msg.clientId,
        clientSentAt: msg.clientSentAt,
        hostTime: getMonotonicWallNowMs()
      }, false);
      return;
    }

    if (msg.type === 'peer_clock_pong' && msg.targetClientId === state.clientId) {
      recordClockSample(msg.clientSentAt, msg.hostTime, getMonotonicWallNowMs());
      return;
    }

    // 2. If we are waiting to verify whether a room exists (`pendingOnlineProbe`)
    if (pendingOnlineProbe && msg.room && msg.room.code === pendingOnlineProbe.roomCode) {
      if (msg.room.closed || !Array.isArray(msg.room.participants) || msg.room.participants.length === 0) {
        return;
      }
      // Check room freshness (within last 6 hours)
      if (msg.room.updatedAt && (Date.now() - msg.room.updatedAt > 6 * 3600 * 1000)) {
        return;
      }
      const probe = pendingOnlineProbe;
      pendingOnlineProbe = null;
      clearTimeout(probe.timerId);
      probe.resolve({ ok: true, room: msg.room });
      return;
    }

    // 3. If we are inside a room and someone requests to join (`peer_join_request`)
    if (msg.type === 'peer_join_request' && state.roomCode && msg.roomCode === state.roomCode) {
      const all = getLocalRoomsMap();
      const currentRoom = all[state.roomCode] || {
        code: state.roomCode,
        hostId: state.isHost ? state.clientId : (state.participants[0]?.id || state.clientId),
        updatedAt: Date.now(),
        participants: [...state.participants],
        presets: state.presets,
        selectedPresetIndex: state.selectedPresetIndex,
        playback: {
          isPlaying: state.isPlaying,
          startServerTime: state.playStartTimeMs,
          presetIndex: state.selectedPresetIndex,
          seq: state.playbackSeq
        }
      };

      const existingIdx = currentRoom.participants.findIndex((p) => p.id === msg.clientId);
      if (existingIdx >= 0) {
        currentRoom.participants[existingIdx].nickname = msg.nickname;
      } else {
        currentRoom.participants.push({
          id: msg.clientId,
          nickname: msg.nickname,
          isHost: currentRoom.hostId === msg.clientId
        });
      }
      currentRoom.updatedAt = Date.now();
      currentRoom.serverTime = getSynchronizedNowMs();

      saveLocalRoomSnapshot(currentRoom);
      applyRoomStateSnapshot(currentRoom);

      if (state.isHost) {
        broadcastToAllPeers(state.roomCode, { type: 'room_state', room: currentRoom }, true);
      }
      return;
    }

    // 4. Member leave notification
    if (msg.type === 'peer_leave' && state.roomCode && msg.roomCode === state.roomCode) {
      const all = getLocalRoomsMap();
      const currentRoom = all[state.roomCode];
      if (!currentRoom) return;
      currentRoom.participants = (currentRoom.participants || []).filter((p) => p.id !== msg.clientId);

      if (currentRoom.participants.length === 0) {
        delete all[state.roomCode];
        try { localStorage.setItem(STORAGE_KEY_ROOMS, JSON.stringify(all)); } catch (_) {}
        publishCloudRelayRoom(state.roomCode, null, true);
        return;
      }

      if (currentRoom.hostId === msg.clientId) {
        currentRoom.participants[0].isHost = true;
        currentRoom.hostId = currentRoom.participants[0].id;
      }
      currentRoom.updatedAt = Date.now();
      saveLocalRoomSnapshot(currentRoom);
      applyRoomStateSnapshot(currentRoom);
      if (state.isHost) {
        broadcastToAllPeers(state.roomCode, { type: 'room_state', room: currentRoom }, true);
      }
      return;
    }

    // 5. Room state update
    if (msg.type === 'room_state' && msg.room && msg.room.code === state.roomCode) {
      if (msg.room.closed) return;
      saveLocalRoomSnapshot(msg.room);
      applyRoomStateSnapshot(msg.room);
    }
  }

  let peerClockIntervalId = null;

  function startPeerClockSyncWithHost(roomCode) {
    if (peerClockIntervalId) {
      clearInterval(peerClockIntervalId);
      peerClockIntervalId = null;
    }
    if (state.isHost) {
      state.serverClockOffsetMs = 0;
      state.bestClockRttMs = 0;
      return;
    }
    const sendPing = () => {
      if (state.roomCode !== roomCode) return;
      for (const entry of rtcPeers.values()) {
        if (entry.dc && entry.dc.readyState === 'open') {
          try {
            entry.dc.send(JSON.stringify({
              type: 'rtc_ping',
              clientId: state.clientId,
              clientSentAt: getMonotonicWallNowMs()
            }));
            return;
          } catch (_) {}
        }
      }
      broadcastToAllPeers(roomCode, {
        type: 'peer_clock_ping',
        roomCode,
        clientId: state.clientId,
        clientSentAt: getMonotonicWallNowMs()
      }, false);
    };
    for (let i = 0; i < 5; i++) {
      setTimeout(sendPing, i * 140);
    }
    // Continuous background drift re-calibration every 3s
    peerClockIntervalId = setInterval(() => {
      if (state.roomCode === roomCode) sendPing();
      else {
        clearInterval(peerClockIntervalId);
        peerClockIntervalId = null;
      }
    }, 3000);
  }

  // ==========================================
  // PHASE-LOCKED WEB AUDIO METRONOME ENGINE (WITH HARDWARE PLL + WAKE LOCK)
  // ==========================================
  let audioCtx = null;
  let schedulerTimerId = null;
  let scheduledStepIndex = 0;
  let wakeLockSentinel = null;

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLockSentinel) {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
      }
    } catch (_) {}
  }

  function releaseWakeLock() {
    try {
      if (wakeLockSentinel) {
        wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
    } catch (_) {}
  }

  let audioWarmupStarted = false;

  function ensureAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    if (!audioWarmupStarted) {
      audioWarmupStarted = true;
      try {
        const silentOsc = audioCtx.createOscillator();
        const silentGain = audioCtx.createGain();
        silentOsc.frequency.value = 1;
        silentGain.gain.value = 0.00001;
        silentOsc.connect(silentGain);
        silentGain.connect(audioCtx.destination);
        silentOsc.start();
      } catch (_) {}
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
      const bpm = clampBpm(preset.bpm);
      return {
        finished: false,
        bpm,
        beatDurationMs: 60000 / bpm,
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
    const bpm = clampBpm(activeSec.bpm);
    return {
      finished: false,
      bpm,
      beatDurationMs: 60000 / bpm,
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

  function getCumulativeBeatOffsetMs(preset, targetBeatIndex) {
    if (targetBeatIndex <= 0) return 0;
    if (preset.mode === 'fixed') {
      const bpm = clampBpm(preset.bpm);
      return targetBeatIndex * (60000 / bpm);
    }

    const beatsPerBar = Number(preset.beatsPerBar) || 4;
    const sections = Array.isArray(preset.sections) && preset.sections.length > 0
      ? preset.sections
      : [{ name: '구간 1', bpm: preset.bpm || 120, bars: 4 }];

    let cycleBeats = 0;
    let cycleDurationMs = 0;
    for (const s of sections) {
      const sBeats = (Math.max(1, Number(s.bars) || 4)) * beatsPerBar;
      const sBpm = clampBpm(s.bpm);
      cycleBeats += sBeats;
      cycleDurationMs += sBeats * (60000 / sBpm);
    }

    const fullCycles = Math.floor(targetBeatIndex / cycleBeats);
    let remBeats = targetBeatIndex % cycleBeats;
    let offsetMs = fullCycles * cycleDurationMs;

    for (const s of sections) {
      if (remBeats <= 0) break;
      const sBeats = (Math.max(1, Number(s.bars) || 4)) * beatsPerBar;
      const sBpm = clampBpm(s.bpm);
      const take = Math.min(remBeats, sBeats);
      offsetMs += take * (60000 / sBpm);
      remBeats -= take;
    }

    return offsetMs;
  }

  function findInitialBeatIndex(preset, anchorStartMs, syncNowMs) {
    if (syncNowMs <= anchorStartMs) return 0;
    const elapsedMs = syncNowMs - anchorStartMs;

    if (preset.mode === 'fixed') {
      const beatMs = 60000 / clampBpm(preset.bpm);
      return Math.ceil((elapsedMs - 15) / beatMs);
    }

    let k = 0;
    while (k < 100000 && getCumulativeBeatOffsetMs(preset, k) < elapsedMs - 15) {
      k++;
    }
    return k;
  }

  function startMetronomeEngine(activePreset, scheduledServerStartTime = null) {
    stopMetronomeEngine(false);
    const ctx = ensureAudioContext();
    acquireWakeLock();

    const syncNow = getSynchronizedNowMs();
    const anchorStartMs = scheduledServerStartTime || (syncNow + 40);

    // Hardware output latency compensation
    const hwOutputLatencySec = Number(ctx.outputLatency || ctx.baseLatency || 0);
    const getTotalOffsetSec = () => -hwOutputLatencySec;

    // Lock hardware audio clock (ctx.currentTime) to global server start time (PLL anchor)
    let audioAnchorTimeSec = ctx.currentTime + ((anchorStartMs - syncNow) / 1000) + getTotalOffsetSec();
    scheduledStepIndex = findInitialBeatIndex(activePreset, anchorStartMs, syncNow);

    const lookaheadHorizonSec = 0.12;

    schedulerTimerId = window.setInterval(() => {
      if (!state.isPlaying && !state.isPreviewPlaying) return;

      // Gentle Phase-Locked Loop (PLL): compare hardware audio clock vs synchronized server clock
      const nowSyncMs = getSynchronizedNowMs();
      const expectedAudioAnchorSec = ctx.currentTime + ((anchorStartMs - nowSyncMs) / 1000) + getTotalOffsetSec();
      const driftSec = expectedAudioAnchorSec - audioAnchorTimeSec;
      if (Math.abs(driftSec) > 0.006) {
        // Nudge smoothly (25%) so audio never glitches, or snap if > 60ms
        audioAnchorTimeSec += Math.abs(driftSec) > 0.06 ? driftSec : driftSec * 0.25;
      }

      while (true) {
        const beatOffsetSec = getCumulativeBeatOffsetMs(activePreset, scheduledStepIndex) / 1000;
        const noteAudioTime = audioAnchorTimeSec + beatOffsetSec;
        const secUntilBeat = noteAudioTime - ctx.currentTime;

        if (secUntilBeat > lookaheadHorizonSec) {
          break;
        }

        const meta = resolveBeatMetadata(activePreset, scheduledStepIndex);
        if (meta.finished) {
          if (state.isPreviewPlaying) stopPreviewPlay();
          else if (state.isPlaying) triggerRoomPlayState(false);
          return;
        }

        if (secUntilBeat >= -0.02) {
          playClickSound(noteAudioTime, meta.beatInBar === 0, state.clickSound);
          const visualDelayMs = Math.max(0, secUntilBeat * 1000);
          const capturedMeta = { ...meta };
          window.setTimeout(() => {
            if (!state.isPlaying && !state.isPreviewPlaying) return;
            updateVisualBeatUI(capturedMeta);
          }, visualDelayMs);
        }

        scheduledStepIndex++;
      }
    }, 20);
  }

  function stopMetronomeEngine(resetUI = true) {
    if (schedulerTimerId !== null) {
      clearInterval(schedulerTimerId);
      schedulerTimerId = null;
    }
    releaseWakeLock();
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
  }

  function applyRoomStateSnapshot(room) {
    if (!room) return;

    const wasPlaying = state.isPlaying;
    const prevPresetIdx = state.selectedPresetIndex;
    const prevSeq = state.playbackSeq;
    const prevStartTime = state.playStartTimeMs;

    state.roomCode = room.code;
    state.isHost = room.hostId === state.clientId;
    state.participants = Array.isArray(room.participants) ? room.participants : [];

    if (!state.isHost && room.hostId && room.hostId !== state.clientId) {
      initiateRtcToHost(room.hostId, room.code);
    }

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
      if (
        !wasPlaying ||
        prevPresetIdx !== state.selectedPresetIndex ||
        prevSeq !== state.playbackSeq ||
        prevStartTime !== state.playStartTimeMs
      ) {
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
    showToast._timer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  function showModalError(msg) {
    const errEl = document.getElementById('modal-error-banner');
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
    showToast(msg);
  }

  function hideModalError() {
    const errEl = document.getElementById('modal-error-banner');
    if (errEl) errEl.style.display = 'none';
  }

  // ==========================================
  // MODAL (방 만들기 / 방 접속하기 — 방 존재 여부 검증 포함)
  // ==========================================
  function openRoomModal(mode) {
    state.modalMode = mode;
    hideModalError();

    const backdrop = document.getElementById('room-modal-backdrop');
    const titleEl = document.getElementById('modal-title-text');
    const codeInput = document.getElementById('input-room-code');
    const nickInput = document.getElementById('input-nickname');
    const submitBtn = document.getElementById('btn-submit-modal');

    if (mode === 'create') {
      titleEl.textContent = '방 만들기';
      codeInput.value = String(Math.floor(1000 + Math.random() * 9000));
      submitBtn.textContent = '방 만들기 →';
    } else {
      titleEl.textContent = '방 접속하기';
      codeInput.value = '';
      submitBtn.textContent = '방 접속하기 →';
    }
    submitBtn.disabled = false;

    nickInput.value = state.nickname || (mode === 'create' ? '그룹장' : '');
    backdrop.classList.add('open');
    setTimeout(() => {
      if (mode === 'join') codeInput.focus();
      else nickInput.focus();
    }, 50);
  }

  function closeRoomModal() {
    hideModalError();
    if (pendingOnlineProbe) {
      clearTimeout(pendingOnlineProbe.timerId);
      pendingOnlineProbe = null;
    }
    document.getElementById('room-modal-backdrop').classList.remove('open');
  }

  function verifyRoomOnCloudOrLocal(roomCode, timeoutMs = 1300) {
    return new Promise((resolve) => {
      // 1. Check same-device active room first
      const allLocal = getLocalRoomsMap();
      const localRoom = allLocal[roomCode];
      if (localRoom && !localRoom.closed && Array.isArray(localRoom.participants) && localRoom.participants.length > 0) {
        resolve({ ok: true, room: localRoom });
        return;
      }

      // 2. Check online MQTT broker retained room state / host response
      if (!mqttSocket || mqttSocket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, message: '존재하지 않는 방입니다! 방 번호를 확인해주세요.' });
        return;
      }

      if (pendingOnlineProbe) {
        clearTimeout(pendingOnlineProbe.timerId);
      }

      const timerId = setTimeout(() => {
        pendingOnlineProbe = null;
        resolve({ ok: false, message: '존재하지 않는 방입니다! 방 번호를 확인해주세요.' });
      }, timeoutMs);

      pendingOnlineProbe = { roomCode, timerId, resolve };
      subscribeCloudRelayRoom(roomCode);
    });
  }

  async function handleRoomEntrySubmit(e) {
    e.preventDefault();
    ensureAudioContext();
    hideModalError();

    const codeInput = document.getElementById('input-room-code');
    const nickInput = document.getElementById('input-nickname');
    const submitBtn = document.getElementById('btn-submit-modal');
    const rawCode = String(codeInput.value || '').replace(/\D/g, '').slice(0, 4);
    const nickname = String(nickInput.value || '').trim() || '멤버';

    if (rawCode.length !== 4) {
      showModalError('4자리 숫자 방 번호를 입력해주세요!');
      codeInput.focus();
      return;
    }

    state.nickname = nickname;
    try { localStorage.setItem(STORAGE_KEY_NICKNAME, nickname); } catch (_) {}

    // CASE 1: CREATE ROOM (방 만들기)
    if (state.modalMode === 'create') {
      submitBtn.disabled = true;
      submitBtn.textContent = '방 생성 중...';

      if (state.backendAvailable) {
        try {
          const data = await apiRequest('/api/rooms', 'POST', {
            roomCode: rawCode,
            clientId: state.clientId,
            nickname,
            presets: state.presets
          });
          if (data.room) {
            saveLocalRoomSnapshot(data.room);
            applyRoomStateSnapshot(data.room);
            subscribeRoomSse(data.room.code);
            subscribeCloudRelayRoom(data.room.code);
            if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'join_room',
                clientId: state.clientId,
                roomCode: data.room.code,
                nickname
              }));
            }
            publishCloudRelayRoom(data.room.code, { type: 'room_state', room: data.room }, true);
            closeRoomModal();
            switchScreen('room');
            return;
          }
        } catch (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = '방 만들기 →';
          showModalError(err.message || '방 생성에 실패했습니다.');
          return;
        }
      }

      // Online Cloud Relay + Local Room Creation
      const newRoom = {
        code: rawCode,
        hostId: state.clientId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        participants: [{ id: state.clientId, nickname, isHost: true }],
        presets: state.presets,
        selectedPresetIndex: 0,
        playback: { isPlaying: false, startServerTime: null, presetIndex: 0, seq: 1 },
        serverTime: Date.now()
      };

      saveLocalRoomSnapshot(newRoom);
      applyRoomStateSnapshot(newRoom);
      subscribeCloudRelayRoom(rawCode);
      broadcastToAllPeers(rawCode, { type: 'room_state', room: newRoom }, true);
      closeRoomModal();
      switchScreen('room');
      return;
    }

    // CASE 2: JOIN ROOM (방 접속하기 — 방이 없으면 "존재하지 않는 방입니다" 에러 표시!)
    submitBtn.disabled = true;
    submitBtn.textContent = '방 확인 중...';

    if (state.backendAvailable) {
      try {
        const data = await apiRequest(`/api/rooms/${encodeURIComponent(rawCode)}/join`, 'POST', {
          clientId: state.clientId,
          nickname
        });
        if (data.room) {
          saveLocalRoomSnapshot(data.room);
          applyRoomStateSnapshot(data.room);
          subscribeRoomSse(data.room.code);
          subscribeCloudRelayRoom(data.room.code);
          if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'join_room',
              clientId: state.clientId,
              roomCode: rawCode,
              nickname
            }));
          }
          closeRoomModal();
          switchScreen('room');
          return;
        }
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = '방 접속하기 →';
        showModalError(err.message || '존재하지 않는 방입니다! 방 번호를 확인해주세요.');
        return;
      }
    }

    // Online Cloud Relay Verification (GitHub Pages / Cross-Device)
    const verifyResult = await verifyRoomOnCloudOrLocal(rawCode, 1300);
    submitBtn.disabled = false;
    submitBtn.textContent = '방 접속하기 →';

    if (!verifyResult.ok || !verifyResult.room) {
      showModalError(verifyResult.message || '존재하지 않는 방입니다! 방 번호를 확인해주세요.');
      return;
    }

    const foundRoom = verifyResult.room;
    if (!foundRoom.participants.some((p) => p.id === state.clientId)) {
      foundRoom.participants.push({
        id: state.clientId,
        nickname,
        isHost: false
      });
    }
    foundRoom.updatedAt = Date.now();

    saveLocalRoomSnapshot(foundRoom);
    applyRoomStateSnapshot(foundRoom);
    subscribeCloudRelayRoom(rawCode);

    // Announce join to host and other peers & sync clock with host
    broadcastToAllPeers(rawCode, {
      type: 'peer_join_request',
      roomCode: rawCode,
      clientId: state.clientId,
      nickname
    }, false);
    broadcastToAllPeers(rawCode, { type: 'room_state', room: foundRoom }, true);
    startPeerClockSyncWithHost(rawCode);

    closeRoomModal();
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
        room.updatedAt = Date.now();
        if (room.playback.isPlaying) {
          room.playback.startServerTime = getSynchronizedNowMs() + 800;
          room.playback.seq = (room.playback.seq || 0) + 1;
        }
        saveLocalRoomSnapshot(room);
        applyRoomStateSnapshot(room);
        broadcastToAllPeers(state.roomCode, { type: 'room_state', room }, true);
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
          startServerTime: targetPlay ? (getSynchronizedNowMs() + 800) : null,
          presetIndex: state.selectedPresetIndex,
          seq: (room.playback?.seq || 0) + 1
        };
        room.updatedAt = Date.now();
        saveLocalRoomSnapshot(room);
        applyRoomStateSnapshot(room);
        broadcastToAllPeers(state.roomCode, { type: 'room_state', room }, true);
      } else {
        state.isPlaying = targetPlay;
        if (targetPlay) startMetronomeEngine(state.presets[state.selectedPresetIndex]);
        else stopMetronomeEngine(true);
        renderRoomScreen();
      }
    }
  }

  function leaveCurrentRoom() {
    if (!state.roomCode) return;
    const leavingCode = state.roomCode;

    if (state.isPlaying) {
      stopMetronomeEngine(true);
      state.isPlaying = false;
    }
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }

    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave_room' }));
    } else if (state.backendAvailable) {
      apiRequest(`/api/rooms/${encodeURIComponent(leavingCode)}/leave`, 'POST', {
        clientId: state.clientId
      }).catch(() => {});
    }

    // Update local and cloud relay state
    const all = getLocalRoomsMap();
    const room = all[leavingCode];
    if (room) {
      room.participants = (room.participants || []).filter((p) => p.id !== state.clientId);
      if (room.participants.length === 0) {
        delete all[leavingCode];
        try { localStorage.setItem(STORAGE_KEY_ROOMS, JSON.stringify(all)); } catch (_) {}
        publishCloudRelayRoom(leavingCode, null, true);
      } else {
        if (room.hostId === state.clientId) {
          room.participants[0].isHost = true;
          room.hostId = room.participants[0].id;
        }
        room.updatedAt = Date.now();
        saveLocalRoomSnapshot(room);
        broadcastToAllPeers(leavingCode, { type: 'room_state', room }, true);
      }
    }

    broadcastToAllPeers(leavingCode, {
      type: 'peer_leave',
      roomCode: leavingCode,
      clientId: state.clientId
    }, false);

    closeAllRtcPeers();
    state.roomCode = null;
    state.participants = [];
  }

  window.addEventListener('pagehide', () => {
    leaveCurrentRoom();
  });

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initEventListeners() {
    document.getElementById('brand-home-trigger').addEventListener('click', () => {
      leaveCurrentRoom();
      switchScreen('home');
    });

    document.getElementById('btn-open-create-room').addEventListener('click', () => openRoomModal('create'));
    document.getElementById('btn-open-join-room').addEventListener('click', () => openRoomModal('join'));
    document.getElementById('btn-open-presets').addEventListener('click', () => switchScreen('presets'));

    document.getElementById('btn-close-modal').addEventListener('click', closeRoomModal);
    document.getElementById('input-room-code').addEventListener('input', hideModalError);
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
      } else if (state.roomCode) {
        const all = getLocalRoomsMap();
        const room = all[state.roomCode];
        if (room) {
          room.presets = state.presets;
          room.updatedAt = Date.now();
          saveLocalRoomSnapshot(room);
          broadcastToAllPeers(state.roomCode, { type: 'room_state', room }, true);
        }
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

    document.getElementById('btn-leave-room').addEventListener('click', () => {
      leaveCurrentRoom();
      switchScreen('home');
    });

    document.getElementById('btn-room-play-toggle').addEventListener('click', () => triggerRoomPlayState(!state.isPlaying));
  }

  initEventListeners();
  connectWebSocket();
})();
