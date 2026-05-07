const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
    cors: { origin: "*" }, // Allow the extension and mobile app to connect
    maxHttpBufferSize: 1e8
});

// Serve the mobile web app (Part 3) from a 'public' folder
app.use(express.static('public'));
app.set('trust proxy', 1);

io.on('connection', (socket) => {
    console.log('A device connected:', socket.id);

    const logTransfer = (...args) => console.log('[CloudDrop Transfer]', socket.id, ...args);

    // Join a specific session room
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`Device joined room: ${roomId}`);
    });

    // Create or refresh a persisted session record
    socket.on('create-session', (roomId) => {
        if (!global.sessions) global.sessions = {};
        global.sessions[roomId] = { createdAt: Date.now(), active: true };
        console.log(`Session created/refreshed: ${roomId}`);
    });

    // Destroy a persisted session (explicit user action)
    socket.on('destroy-session', (roomId) => {
        if (global.sessions && global.sessions[roomId]) {
            delete global.sessions[roomId];
            console.log(`Session destroyed: ${roomId}`);
            // Notify any connected clients in that room
            io.to(roomId).emit('session-destroyed', roomId);
        }
    });

    // Relay text messages
    socket.on('send-text', (data) => {
        logTransfer('send-text', { room: data.room, length: (data.text && data.text.length) || 0 });
        socket.to(data.room).emit('receive-text', data.text);
    });

    // Relay files (Sent as Base64 for simplicity in this MVP)
    socket.on('send-file', (data) => {
        logTransfer('send-file', { room: data.room, name: data.name, type: data.type, size: (data.file && data.file.length) || 0 });
        socket.to(data.room).emit('receive-file', {
            name: data.name,
            file: data.file,
            type: data.type
        });
    });

    // Chunked transfer protocol: init metadata
    socket.on('file-init', (data) => {
        logTransfer('file-init', { room: data.room, transferId: data.transferId, name: data.name, totalChunks: data.totalChunks, size: data.size });
        socket.to(data.room).emit('file-init', data);
    });

    // Chunked transfer protocol: file chunk payload
    socket.on('file-chunk', (data) => {
        logTransfer('file-chunk', { room: data.room, transferId: data.transferId, index: data.index, hasBase64: typeof data.chunkBase64 === 'string' });
        socket.to(data.room).emit('file-chunk', data);
    });

    // Chunked transfer protocol: acknowledge specific chunk index
    socket.on('file-ack', (data) => {
        logTransfer('file-ack', { room: data.room, transferId: data.transferId, index: data.index });
        socket.to(data.room).emit('file-ack', data);
    });

    // Chunked transfer protocol: transfer completed at receiver
    socket.on('file-complete', (data) => {
        logTransfer('file-complete', { room: data.room, transferId: data.transferId });
        socket.to(data.room).emit('file-complete', data);
    });

    // Chunked transfer protocol: structured transfer failure
    socket.on('file-error', (data) => {
        logTransfer('file-error', { room: data.room, transferId: data.transferId, reason: data.reason });
        socket.to(data.room).emit('file-error', data);
    });

    // Chunked transfer protocol: user-cancelled transfer
    socket.on('file-cancel', (data) => {
        logTransfer('file-cancel', { room: data.room, transferId: data.transferId, reason: data.reason });
        socket.to(data.room).emit('file-cancel', data);
    });

    socket.on('disconnect', (reason) => {
        logTransfer('disconnect', { reason });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));