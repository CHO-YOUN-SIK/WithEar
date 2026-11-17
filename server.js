const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// In-memory room state store
// roomCode -> {
//   code: string,
//   hostId: string,
//   participants: Map<clientId, { id, nickname, isHost, joinedAt }>,
//   presets: Array,
//   selectedPresetIndex: number,
//   playback: { isPlaying: boolean, startServerTime: number, presetIndex: number }
// }
const rooms = new Map();
const clients = new Map(); // socket -> { id, roomCode, nickname }

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = reqUrl.pathname;

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeRooms: rooms.size, serverTime: Date.now() }));
    return;
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// Minimal RFC 6455 WebSocket implementation using built-in Node crypto
function encodeWsFrame(payloadObj) {
  const str = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let headerLen = 2;

    if (opcode === 0x8) {
      return { messages, close: true, remaining: Buffer.alloc(0) };
    }

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    const totalFrameLen = headerLen + maskLen + payloadLen;
    if (offset + totalFrameLen > buffer.length) break;

    let payload = buffer.subarray(offset + headerLen + maskLen, offset + totalFrameLen);
    if (isMasked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    if (opcode === 0x1) {
      messages.push(payload.toString('utf8'));
    }
    offset += totalFrameLen;
  }

  return { messages, close: false, remaining: buffer.subarray(offset) };
}

function sendWs(socket, data) {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(encodeWsFrame(data));
  } catch (_) {}
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    participants: Array.from(room.participants.values()),
    presets: room.presets,
    selectedPresetIndex: room.selectedPresetIndex,
    playback: room.playback,
    serverTime: Date.now()
  };
}

function broadcastRoom(roomCode, messageObj) {
  for (const [sock, info] of clients.entries()) {
    if (info.roomCode === roomCode) {
      sendWs(sock, messageObj);
    }
  }
}

function removeClientFromRoom(socket) {
  const info = clients.get(socket);
  if (!info || !info.roomCode) return;

  const roomCode = info.roomCode;
  const room = rooms.get(roomCode);
  info.roomCode = null;

  if (!room) return;
  room.participants.delete(info.id);

  if (room.participants.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  // Reassign host if the host left
  if (room.hostId === info.id) {
    const nextParticipant = room.participants.values().next().value;
    if (nextParticipant) {
      nextParticipant.isHost = true;
      room.hostId = nextParticipant.id;
    }
  }

  broadcastRoom(roomCode, {
    type: 'room_state',
    room: serializeRoom(room)
  });
}

function handleClientMessage(socket, msg) {
  const info = clients.get(socket);
  if (!info) return;

  switch (msg.type) {
    case 'ping_clock': {
      sendWs(socket, {
        type: 'pong_clock',
        clientSentAt: msg.clientSentAt,
        serverTime: Date.now()
      });
      break;
    }

    case 'create_room': {
      removeClientFromRoom(socket);
      let code = String(msg.roomCode || '').trim();
      if (!/^\d{4}$/.test(code) || rooms.has(code)) {
        do {
          code = String(Math.floor(1000 + Math.random() * 9000));
        } while (rooms.has(code));
      }

      const nickname = String(msg.nickname || '그룹장').trim().slice(0, 20) || '그룹장';
      info.nickname = nickname;
      info.roomCode = code;

      const participants = new Map();
      participants.set(info.id, {
        id: info.id,
        nickname,
        isHost: true,
        joinedAt: Date.now()
      });

      const room = {
        code,
        hostId: info.id,
        participants,
        presets: Array.isArray(msg.presets) ? msg.presets : [],
        selectedPresetIndex: 0,
        playback: {
          isPlaying: false,
          startServerTime: null,
          presetIndex: 0
        }
      };

      rooms.set(code, room);
      sendWs(socket, {
        type: 'room_joined',
        clientId: info.id,
        room: serializeRoom(room)
      });
      break;
    }

    case 'join_room': {
      removeClientFromRoom(socket);
      const code = String(msg.roomCode || '').trim();
      const nickname = String(msg.nickname || '멤버').trim().slice(0, 20) || '멤버';

      let room = rooms.get(code);
      if (!room) {
        // Allow creating or joining seamlessly by room number if it doesn't exist yet
        const participants = new Map();
        const isFirst = true;
        participants.set(info.id, {
          id: info.id,
          nickname,
          isHost: isFirst,
          joinedAt: Date.now()
        });
        room = {
          code,
          hostId: info.id,
          participants,
          presets: Array.isArray(msg.presets) ? msg.presets : [],
          selectedPresetIndex: 0,
          playback: {
            isPlaying: false,
            startServerTime: null,
            presetIndex: 0
          }
        };
        rooms.set(code, room);
      } else {
        room.participants.set(info.id, {
          id: info.id,
          nickname,
          isHost: room.hostId === info.id,
          joinedAt: Date.now()
        });
      }

      info.nickname = nickname;
      info.roomCode = code;

      sendWs(socket, {
        type: 'room_joined',
        clientId: info.id,
        room: serializeRoom(room)
      });

      broadcastRoom(code, {
        type: 'room_state',
        room: serializeRoom(room)
      });
      break;
    }

    case 'leave_room': {
      removeClientFromRoom(socket);
      break;
    }

    case 'select_preset': {
      const room = rooms.get(info.roomCode);
      if (!room) return;
      const idx = Number(msg.presetIndex);
      if (Number.isInteger(idx) && idx >= 0 && idx < 6) {
        room.selectedPresetIndex = idx;
        if (room.playback.isPlaying) {
          room.playback = {
            isPlaying: true,
            startServerTime: Date.now() + 120,
            presetIndex: idx
          };
        } else {
          room.playback.presetIndex = idx;
        }
        broadcastRoom(room.code, {
          type: 'room_state',
          room: serializeRoom(room)
        });
      }
      break;
    }

    case 'update_presets': {
      const room = rooms.get(info.roomCode);
      if (!room) return;
      if (Array.isArray(msg.presets) && msg.presets.length === 6) {
        room.presets = msg.presets;
        broadcastRoom(room.code, {
          type: 'room_state',
          room: serializeRoom(room)
        });
      }
      break;
    }

    case 'toggle_play': {
      const room = rooms.get(info.roomCode);
      if (!room) return;
      const shouldPlay = typeof msg.isPlaying === 'boolean' ? msg.isPlaying : !room.playback.isPlaying;
      if (shouldPlay) {
        room.playback = {
          isPlaying: true,
          startServerTime: Date.now() + 100, // 100ms lookahead for tight multi-client sync
          presetIndex: room.selectedPresetIndex
        };
      } else {
        room.playback = {
          isPlaying: false,
          startServerTime: null,
          presetIndex: room.selectedPresetIndex
        };
      }
      broadcastRoom(room.code, {
        type: 'room_state',
        room: serializeRoom(room)
      });
      break;
    }

    case 'add_simulated_member': {
      const room = rooms.get(info.roomCode);
      if (!room) return;
      const simId = 'sim_' + crypto.randomBytes(4).toString('hex');
      const simName = String(msg.nickname || '세션 멤버').trim().slice(0, 20);
      room.participants.set(simId, {
        id: simId,
        nickname: simName,
        isHost: false,
        isSimulated: true,
        joinedAt: Date.now()
      });
      broadcastRoom(room.code, {
        type: 'room_state',
        room: serializeRoom(room)
      });
      break;
    }
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );

  const clientId = 'usr_' + crypto.randomBytes(5).toString('hex');
  clients.set(socket, { id: clientId, roomCode: null, nickname: null });

  sendWs(socket, {
    type: 'welcome',
    clientId,
    serverTime: Date.now()
  });

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { messages, close, remaining } = decodeWsFrames(buffer);
    buffer = remaining;

    for (const raw of messages) {
      try {
        const parsed = JSON.parse(raw);
        handleClientMessage(socket, parsed);
      } catch (_) {}
    }

    if (close) {
      removeClientFromRoom(socket);
      clients.delete(socket);
      socket.end();
    }
  });

  socket.on('close', () => {
    removeClientFromRoom(socket);
    clients.delete(socket);
  });

  socket.on('error', () => {
    removeClientFromRoom(socket);
    clients.delete(socket);
  });
});

server.listen(PORT, () => {
  console.log(`WithEar In-Ear Metronome Server running on http://localhost:${PORT}`);
});
