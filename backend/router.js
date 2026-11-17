const { calculateTapBpmStats } = require('./store');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id');
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 512 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function createApiRouter({ store, broadcastRoom }) {
  const sseSubscribers = new Map();

  function broadcastSse(roomCode, payload) {
    const subs = sseSubscribers.get(roomCode);
    if (!subs || subs.size === 0) return;
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of subs) {
      try {
        res.write(msg);
      } catch (_) {}
    }
  }

  function notifyRoomUpdated(room) {
    if (!room) return;
    const snapshot = store.serializeRoom(room);
    const eventPayload = { type: 'room_state', room: snapshot };
    if (typeof broadcastRoom === 'function') {
      broadcastRoom(room.code, eventPayload);
    }
    broadcastSse(room.code, eventPayload);
  }

  async function handleApiRequest(req, res, pathname, searchParams) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        activeRooms: store.rooms.size,
        serverTime: Date.now()
      });
      return true;
    }

    if (pathname === '/api/clock' && req.method === 'GET') {
      const serverReceivedAt = Date.now();
      const clientSentAt = Number(searchParams.get('clientSentAt')) || serverReceivedAt;
      sendJson(res, 200, {
        clientSentAt,
        serverReceivedAt,
        serverSentAt: Date.now()
      });
      return true;
    }

    if (pathname === '/api/presets/calculate-bpm' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (body.mode === 'variable' && Array.isArray(body.sections)) {
          const calculatedSections = body.sections.map((sec, idx) => {
            const stats = calculateTapBpmStats(sec.tapTimestamps, sec.bars || 4, body.beatsPerBar || 4);
            return {
              name: sec.name || `구간 ${idx + 1}`,
              bpm: Array.isArray(sec.tapTimestamps) && sec.tapTimestamps.length >= 2
                ? stats.averageBpm
                : (sec.bpm || 120),
              bars: Math.max(1, parseInt(sec.bars, 10) || 4),
              stats
            };
          });
          const totalBars = calculatedSections.reduce((a, s) => a + s.bars, 0);
          const weightedBpm = calculatedSections.reduce((a, s) => a + s.bpm * s.bars, 0);
          sendJson(res, 200, {
            mode: 'variable',
            overallAverageBpm: totalBars > 0 ? Math.round(weightedBpm / totalBars) : 120,
            totalBars,
            sections: calculatedSections
          });
        } else {
          const stats = calculateTapBpmStats(body.tapTimestamps, body.bars || 0, body.beatsPerBar || 4);
          sendJson(res, 200, {
            mode: 'fixed',
            ...stats
          });
        }
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return true;
    }

    const presetProfileMatch = pathname.match(/^\/api\/presets\/([a-zA-Z0-9_-]+)$/);
    if (presetProfileMatch) {
      const profileId = presetProfileMatch[1];
      if (req.method === 'GET') {
        sendJson(res, 200, {
          profileId,
          presets: store.getProfilePresets(profileId)
        });
        return true;
      }
      if (req.method === 'PUT') {
        try {
          const body = await readJsonBody(req);
          const saved = store.saveProfilePresets(profileId, body.presets);
          sendJson(res, 200, { profileId, presets: saved });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return true;
      }
    }

    if (pathname === '/api/rooms') {
      if (req.method === 'GET') {
        const list = [];
        for (const r of store.rooms.values()) {
          list.push({
            code: r.code,
            memberCount: r.participants.size,
            isPlaying: r.playback.isPlaying,
            selectedPresetIndex: r.selectedPresetIndex,
            activePresetName: r.presets[r.selectedPresetIndex]?.name || '1번 곡'
          });
        }
        sendJson(res, 200, { rooms: list, serverTime: Date.now() });
        return true;
      }

      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const room = store.createRoom({
            roomCode: body.roomCode,
            clientId: body.clientId,
            nickname: body.nickname,
            presets: body.presets
          });
          notifyRoomUpdated(room);
          sendJson(res, 201, {
            room: store.serializeRoom(room)
          });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return true;
      }
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/(\d{4})(?:\/([a-z-]+))?$/);
    if (roomMatch) {
      const code = roomMatch[1];
      const action = roomMatch[2] || '';

      if (!action && req.method === 'GET') {
        const room = store.rooms.get(code);
        if (!room || room.participants.size === 0) {
          sendJson(res, 404, { error: '존재하지 않는 방입니다.' });
          return true;
        }
        sendJson(res, 200, { room: store.serializeRoom(room) });
        return true;
      }

      if (action === 'events' && req.method === 'GET') {
        const room = store.rooms.get(code);
        if (!room) {
          sendJson(res, 404, { error: '존재하지 않는 방입니다.' });
          return true;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        if (!sseSubscribers.has(code)) {
          sseSubscribers.set(code, new Set());
        }
        sseSubscribers.get(code).add(res);

        res.write(`data: ${JSON.stringify({ type: 'room_state', room: store.serializeRoom(room) })}\n\n`);

        const keepAlive = setInterval(() => {
          try {
            res.write(`: ping ${Date.now()}\n\n`);
          } catch (_) {}
        }, 15000);

        req.on('close', () => {
          clearInterval(keepAlive);
          const subs = sseSubscribers.get(code);
          if (subs) {
            subs.delete(res);
            if (subs.size === 0) sseSubscribers.delete(code);
          }
        });
        return true;
      }

      if (action === 'join' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const room = store.joinRoom({
            roomCode: code,
            clientId: body.clientId,
            nickname: body.nickname
          });
          notifyRoomUpdated(room);
          sendJson(res, 200, { room: store.serializeRoom(room) });
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message });
        }
        return true;
      }

      if (action === 'leave' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const room = store.leaveRoom(code, body.clientId);
          if (room) notifyRoomUpdated(room);
          sendJson(res, 200, { ok: true, room: store.serializeRoom(room) });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return true;
      }

      if (action === 'presets' && (req.method === 'PUT' || req.method === 'POST')) {
        try {
          const body = await readJsonBody(req);
          const room = store.updateRoomPresets(code, body.presets, body.clientId);
          if (!room) {
            sendJson(res, 404, { error: '존재하지 않는 방입니다.' });
            return true;
          }
          notifyRoomUpdated(room);
          sendJson(res, 200, { room: store.serializeRoom(room) });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return true;
      }

      if (action === 'select-preset' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const room = store.selectRoomPreset(code, body.presetIndex);
          if (!room) {
            sendJson(res, 404, { error: '존재하지 않는 방입니다.' });
            return true;
          }
          notifyRoomUpdated(room);
          sendJson(res, 200, { room: store.serializeRoom(room) });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return true;
      }

      if (action === 'playback' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const room = store.toggleRoomPlayback(code, body.isPlaying);
          if (!room) {
            sendJson(res, 404, { error: '존재하지 않는 방입니다.' });
            return true;
          }
          notifyRoomUpdated(room);
          sendJson(res, 200, { room: store.serializeRoom(room) });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return true;
      }
    }

    return false;
  }

  return {
    handleApiRequest,
    notifyRoomUpdated,
    broadcastSse
  };
}

module.exports = {
  createApiRouter
};
