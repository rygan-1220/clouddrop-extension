const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
    cors: { origin: "*" },
    pingInterval: 30000,      // Send ping every 30 seconds
    pingTimeout: 60000,       // Wait 60 seconds for pong before timeout
    transports: ['websocket', 'polling'],
    allowUpgrades: true
});

app.use(express.static('public'));
app.set('trust proxy', 1);

function getRoomSocketIds(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    return room ? Array.from(room) : [];
}

function emitRoomState(roomId) {
    const peerCount = getRoomSocketIds(roomId).length;
    io.to(roomId).emit('room-state', { roomId, peerCount });
    return peerCount;
}

io.on('connection', (socket) => {
    console.log('[CloudDrop] connected:', socket.id);

    socket.data.roomId = null;

    const logEvent = (...args) => console.log('[CloudDrop]', socket.id, ...args);

    socket.on('join-room', (roomId) => {
        if (!roomId || typeof roomId !== 'string') {
            socket.emit('room-error', { reason: 'invalid_room' });
            return;
        }

        if (socket.data.roomId && socket.data.roomId !== roomId) {
            socket.leave(socket.data.roomId);
        }

        socket.data.roomId = roomId;
        socket.join(roomId);

        const peerCount = emitRoomState(roomId);
        logEvent('join-room', { roomId, peerCount });

        if (peerCount >= 2) {
            io.to(roomId).emit('peer-joined', { roomId, peerCount, peerId: socket.id });
        }
    });

    socket.on('leave-room', (roomId) => {
        const activeRoom = roomId || socket.data.roomId;
        if (!activeRoom) {
            return;
        }

        socket.leave(activeRoom);
        socket.data.roomId = null;
        socket.to(activeRoom).emit('peer-left', { roomId: activeRoom, peerId: socket.id, reason: 'manual_leave' });
        emitRoomState(activeRoom);
        logEvent('leave-room', { roomId: activeRoom });
    });

    socket.on('send-signal', (data = {}) => {
        const roomId = data.roomId || socket.data.roomId;
        if (!roomId || !data.signal) {
            socket.emit('signal-error', { reason: 'invalid_signal_payload' });
            return;
        }

        socket.to(roomId).emit('receive-signal', {
            roomId,
            signal: data.signal,
            from: socket.id
        });
    });

    socket.on('disconnect', (reason) => {
        const roomId = socket.data.roomId;
        if (roomId) {
            socket.to(roomId).emit('peer-left', { roomId, peerId: socket.id, reason });
            emitRoomState(roomId);
        }

        logEvent('disconnect', { reason });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));