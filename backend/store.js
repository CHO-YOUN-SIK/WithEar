const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

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

function clampBpm(val) {
  const n = Math.round(Number(val) || 120);
  return Math.min(300, Math.max(30, n));
}

function sanitizePresets(presets) {
  if (!Array.isArray(presets) || presets.length === 0) {
    return JSON.parse(JSON.stringify(DEFAULT_PRESETS));
  }
  const result = [];
  for (let i = 0; i < 6; i++) {
    const src = presets[i] || DEFAULT_PRESETS[i];
    const sections = Array.isArray(src.sections) && src.sections.length > 0
      ? src.sections.slice(0, 16).map((s, sIdx) => ({
          name: String(s.name || `구간 ${sIdx + 1}`).trim().slice(0, 24) || `구간 ${sIdx + 1}`,
          bpm: clampBpm(s.bpm),
          bars: Math.max(1, Math.min(256, parseInt(s.bars, 10) || 4))
        }))
      : [{ name: '구간 1', bpm: clampBpm(src.bpm), bars: 4 }];

    const totalSectionBars = sections.reduce((acc, s) => acc + s.bars, 0);
    const weightedBpm = sections.reduce((acc, s) => acc + s.bpm * s.bars, 0);
    const avgVarBpm = totalSectionBars > 0 ? clampBpm(weightedBpm / totalSectionBars) : clampBpm(src.bpm);

    result.push({
      id: i,
      name: String(src.name || `${i + 1}번 곡`).trim().slice(0, 28) || `${i + 1}번 곡`,
      beatsPerBar: [2, 3, 4, 6].includes(Number(src.beatsPerBar)) ? Number(src.beatsPerBar) : 4,
      mode: src.mode === 'variable' ? 'variable' : 'fixed',
      bpm: src.mode === 'variable' ? avgVarBpm : clampBpm(src.bpm),
      bars: Math.max(0, Math.min(999, parseInt(src.bars, 10) || 0)),
      loopVariable: src.loopVariable !== false,
      sections
    });
  }
  return result;
}

class BackendStore {
  constructor() {
    this.rooms = new Map();
    this.presetProfiles = new Map();
    this._saveTimer = null;
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (Array.isArray(raw.rooms)) {
            for (const r of raw.rooms) {
              if (r && r.code) {
                const participants = new Map();
                if (Array.isArray(r.participants)) {
                  for (const p of r.participants) {
                    participants.set(p.id, p);
                  }
                }
                if (participants.size > 0) {
                  this.rooms.set(r.code, {
                    ...r,
                    participants,
                    presets: sanitizePresets(r.presets)
                  });
                }
              }
            }
          }
          if (raw.presetProfiles && typeof raw.presetProfiles === 'object') {
            for (const [k, v] of Object.entries(raw.presetProfiles)) {
              this.presetProfiles.set(k, sanitizePresets(v));
            }
          }
        }
      }
    } catch (_) {}
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushToDisk();
    }, 300);
  }

  flushToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const serializedRooms = [];
      for (const room of this.rooms.values()) {
        serializedRooms.push(this.serializeRoom(room));
      }
      const profilesObj = {};
      for (const [k, v] of this.presetProfiles.entries()) {
        profilesObj[k] = v;
      }
      fs.writeFileSync(
        DB_FILE,
        JSON.stringify({ updatedAt: Date.now(), rooms: serializedRooms, presetProfiles: profilesObj }, null, 2),
        'utf8'
      );
    } catch (_) {}
  }

  generateUniqueRoomCode(preferredCode) {
    const clean = String(preferredCode || '').replace(/\D/g, '');
    if (/^\d{4}$/.test(clean) && !this.rooms.has(clean)) {
      return clean;
    }
    let code;
    let attempts = 0;
    do {
      code = String(Math.floor(1000 + Math.random() * 9000));
      attempts++;
    } while (this.rooms.has(code) && attempts < 500);
    return code;
  }

  createRoom({ roomCode, clientId, nickname, presets }) {
    const code = this.generateUniqueRoomCode(roomCode);
    const hostId = clientId || 'usr_' + crypto.randomBytes(5).toString('hex');
    const cleanNick = String(nickname || '그룹장').trim().slice(0, 20) || '그룹장';
    const sanitized = sanitizePresets(presets);

    const participants = new Map();
    participants.set(hostId, {
      id: hostId,
      nickname: cleanNick,
      isHost: true,
      joinedAt: Date.now(),
      lastSeenAt: Date.now()
    });

    const room = {
      code,
      hostId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      participants,
      presets: sanitized,
      selectedPresetIndex: 0,
      playback: {
        isPlaying: false,
        startServerTime: null,
        presetIndex: 0,
        seq: 1
      }
    };

    this.rooms.set(code, room);
    this.presetProfiles.set(hostId, sanitized);
    this._scheduleSave();
    return room;
  }

  joinRoom({ roomCode, clientId, nickname }) {
    const cleanCode = String(roomCode || '').replace(/\D/g, '').slice(0, 4);
    if (!/^\d{4}$/.test(cleanCode)) {
      const err = new Error('4자리 숫자 방 번호를 입력해주세요.');
      err.statusCode = 400;
      throw err;
    }

    const room = this.rooms.get(cleanCode);
    if (!room || room.participants.size === 0) {
      const err = new Error('존재하지 않는 방입니다. 방 번호를 확인해주세요.');
      err.statusCode = 404;
      throw err;
    }

    const memberId = clientId || 'usr_' + crypto.randomBytes(5).toString('hex');
    const cleanNick = String(nickname || '멤버').trim().slice(0, 20) || '멤버';

    const existing = room.participants.get(memberId);
    room.participants.set(memberId, {
      id: memberId,
      nickname: cleanNick,
      isHost: room.hostId === memberId,
      joinedAt: existing ? existing.joinedAt : Date.now(),
      lastSeenAt: Date.now()
    });
    room.updatedAt = Date.now();
    this._scheduleSave();
    return room;
  }

  leaveRoom(roomCode, clientId) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    room.participants.delete(clientId);
    room.updatedAt = Date.now();

    if (room.participants.size === 0) {
      this.rooms.delete(roomCode);
      this._scheduleSave();
      return null;
    }

    if (room.hostId === clientId) {
      const nextHost = room.participants.values().next().value;
      if (nextHost) {
        nextHost.isHost = true;
        room.hostId = nextHost.id;
      }
    }

    this._scheduleSave();
    return room;
  }

  updateRoomPresets(roomCode, presets, clientId) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    room.presets = sanitizePresets(presets);
    room.updatedAt = Date.now();
    if (clientId) {
      this.presetProfiles.set(clientId, room.presets);
    }
    this._scheduleSave();
    return room;
  }

  selectRoomPreset(roomCode, presetIndex) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    const idx = Number(presetIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= 6) return room;

    room.selectedPresetIndex = idx;
    if (room.playback.isPlaying) {
      room.playback = {
        isPlaying: true,
        startServerTime: Date.now() + 250,
        presetIndex: idx,
        seq: (room.playback.seq || 0) + 1
      };
    } else {
      room.playback.presetIndex = idx;
    }
    room.updatedAt = Date.now();
    this._scheduleSave();
    return room;
  }

  toggleRoomPlayback(roomCode, shouldPlay) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    const nextState = typeof shouldPlay === 'boolean' ? shouldPlay : !room.playback.isPlaying;

    if (nextState) {
      room.playback = {
        isPlaying: true,
        startServerTime: Date.now() + 250,
        presetIndex: room.selectedPresetIndex,
        seq: (room.playback.seq || 0) + 1
      };
    } else {
      room.playback = {
        isPlaying: false,
        startServerTime: null,
        presetIndex: room.selectedPresetIndex,
        seq: (room.playback.seq || 0) + 1
      };
    }

    room.updatedAt = Date.now();
    this._scheduleSave();
    return room;
  }

  touchParticipant(roomCode, clientId) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    const p = room.participants.get(clientId);
    if (p) {
      p.lastSeenAt = Date.now();
    }
    return room;
  }

  getProfilePresets(profileId) {
    if (profileId && this.presetProfiles.has(profileId)) {
      return this.presetProfiles.get(profileId);
    }
    return sanitizePresets(DEFAULT_PRESETS);
  }

  saveProfilePresets(profileId, presets) {
    const sanitized = sanitizePresets(presets);
    if (profileId) {
      this.presetProfiles.set(profileId, sanitized);
      this._scheduleSave();
    }
    return sanitized;
  }

  serializeRoom(room) {
    if (!room) return null;
    return {
      code: room.code,
      hostId: room.hostId,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      participants: Array.from(room.participants.values()),
      presets: room.presets,
      selectedPresetIndex: room.selectedPresetIndex,
      playback: room.playback,
      serverTime: Date.now()
    };
  }
}

function calculateTapBpmStats(tapTimestamps = [], bars = 4, beatsPerBar = 4) {
  const validTaps = Array.isArray(tapTimestamps)
    ? tapTimestamps.map(Number).filter((n) => Number.isFinite(n))
    : [];

  if (validTaps.length < 2) {
    return {
      tapCount: validTaps.length,
      averageBpm: 120,
      intervalsMs: [],
      barDurationSec: (60 / 120) * beatsPerBar,
      totalDurationSec: bars > 0 ? (60 / 120) * beatsPerBar * bars : null
    };
  }

  const intervals = [];
  for (let i = 1; i < validTaps.length; i++) {
    const diff = validTaps[i] - validTaps[i - 1];
    if (diff > 150 && diff < 2500) {
      intervals.push(diff);
    }
  }

  if (intervals.length === 0) {
    return {
      tapCount: validTaps.length,
      averageBpm: 120,
      intervalsMs: [],
      barDurationSec: (60 / 120) * beatsPerBar,
      totalDurationSec: bars > 0 ? (60 / 120) * beatsPerBar * bars : null
    };
  }

  const avgIntervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const averageBpm = clampBpm(60000 / avgIntervalMs);
  const beatDurationSec = 60 / averageBpm;
  const barDurationSec = Number((beatDurationSec * beatsPerBar).toFixed(3));
  const totalDurationSec = bars > 0 ? Number((barDurationSec * bars).toFixed(3)) : null;

  return {
    tapCount: validTaps.length,
    averageBpm,
    avgIntervalMs: Math.round(avgIntervalMs),
    intervalsMs: intervals.map((n) => Math.round(n)),
    barDurationSec,
    totalDurationSec
  };
}

module.exports = {
  BackendStore,
  DEFAULT_PRESETS,
  clampBpm,
  sanitizePresets,
  calculateTapBpmStats
};
