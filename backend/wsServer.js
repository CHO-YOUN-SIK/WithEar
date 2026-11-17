const crypto = require('crypto');

function encodeWsFrame(payloadObj) {
  const str = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
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

function attachWebSocketServer({ server, store, onRoomUpdated }) {
  const clients = new Map();

  function broadcastRoom(roomCode, messageObj) {
    for (const [sock, info] of clients.entries()) {
      if (info.roomCode === roomCode) {
        sendWs(sock, messageObj);
      }
    }
  }

  function disconnectClient(socket) {
    const info = clients.get(socket);
    if (!info) return;
    if (info.roomCode) {
      const updatedRoom = store.leaveRoom(info.roomCode, info.id);
      info.roomCode = null;
      if (updatedRoom && typeof onRoomUpdated === 'function') {
        onRoomUpdated(updatedRoom);
      }
    }
    clients.delete(socket);
  }

  function handleMessage(socket, msg) {
    const info = clients.get(socket);
    if (!info || !msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ping_clock': {
        sendWs(socket, {
          type: 'pong_clock',
          clientSentAt: msg.clientSentAt,
          serverTime: Date.now()
        });
        break;
      }

      case 'rtc_offer':
      case 'rtc_answer':
      case 'rtc_ice': {
        const targetRoom = msg.roomCode || info.roomCode;
        if (targetRoom) {
          broadcastRoom(targetRoom, msg);
        }
        break;
      }

      case 'create_room': {
        if (info.roomCode) {
          store.leaveRoom(info.roomCode, info.id);
        }
        if (msg.clientId) info.id = String(msg.clientId);
        const room = store.createRoom({
          roomCode: msg.roomCode,
          clientId: info.id,
          nickname: msg.nickname,
          presets: msg.presets
        });
        info.roomCode = room.code;
        info.nickname = msg.nickname;

        sendWs(socket, {
          type: 'room_joined',
          clientId: info.id,
          room: store.serializeRoom(room)
        });
        if (typeof onRoomUpdated === 'function') onRoomUpdated(room);
        break;
      }

      case 'join_room': {
        if (msg.clientId) info.id = String(msg.clientId);
        try {
          const room = store.joinRoom({
            roomCode: msg.roomCode,
            clientId: info.id,
            nickname: msg.nickname
          });
          if (info.roomCode && info.roomCode !== room.code) {
            const prev = store.leaveRoom(info.roomCode, info.id);
            if (prev && typeof onRoomUpdated === 'function') onRoomUpdated(prev);
          }
          info.roomCode = room.code;
          info.nickname = msg.nickname;

          sendWs(socket, {
            type: 'room_joined',
            clientId: info.id,
            room: store.serializeRoom(room)
          });
          if (typeof onRoomUpdated === 'function') onRoomUpdated(room);
        } catch (err) {
          sendWs(socket, {
            type: 'join_error',
            message: err.message || '존재하지 않는 방입니다.'
          });
        }
        break;
      }

      case 'leave_room': {
        if (info.roomCode) {
          const room = store.leaveRoom(info.roomCode, info.id);
          info.roomCode = null;
          if (room && typeof onRoomUpdated === 'function') onRoomUpdated(room);
        }
        break;
      }

      case 'select_preset': {
        if (!info.roomCode) return;
        const room = store.selectRoomPreset(info.roomCode, msg.presetIndex);
        if (room && typeof onRoomUpdated === 'function') onRoomUpdated(room);
        break;
      }

      case 'update_presets': {
        if (!info.roomCode) return;
        const room = store.updateRoomPresets(info.roomCode, msg.presets, info.id);
        if (room && typeof onRoomUpdated === 'function') onRoomUpdated(room);
        break;
      }

      case 'toggle_play': {
        if (!info.roomCode) return;
        const room = store.toggleRoomPlayback(info.roomCode, msg.isPlaying);
        if (room && typeof onRoomUpdated === 'function') onRoomUpdated(room);
        break;
      }

      case 'heartbeat': {
        if (info.roomCode) {
          store.touchParticipant(info.roomCode, info.id);
        }
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
          handleMessage(socket, JSON.parse(raw));
        } catch (_) {}
      }

      if (close) {
        disconnectClient(socket);
        socket.end();
      }
    });

    socket.on('close', () => disconnectClient(socket));
    socket.on('error', () => disconnectClient(socket));
  });

  return {
    broadcastRoom
  };
}

module.exports = {
  attachWebSocketServer
};
