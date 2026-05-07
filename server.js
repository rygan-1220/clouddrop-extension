const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
    cors: { origin: "*" } // Allow the extension and mobile app to connect
});

// Serve the mobile web app (Part 3) from a 'public' folder
app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('A device connected:', socket.id);

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
        socket.to(data.room).emit('receive-text', data.text);
    });

    // Relay files (Sent as Base64 for simplicity in this MVP)
    socket.on('send-file', (data) => {
        socket.to(data.room).emit('receive-file', {
            name: data.name,
            file: data.file,
            type: data.type
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));