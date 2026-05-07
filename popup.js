// Connect to your deployed server (use ngrok for local testing)
const SERVER_URL = 'https://04ba-203-106-65-238.ngrok-free.app'; 
const socket = io(SERVER_URL);

// Try to reuse existing session stored in localStorage
let roomId = localStorage.getItem('clouddrop_room');
let isNewSession = false;
if (!roomId) {
    roomId = Math.random().toString(36).substring(2, 10);
    localStorage.setItem('clouddrop_room', roomId);
    isNewSession = true;
}

// Always join the room when popup opens so UI can interact
socket.emit('join-room', roomId);

// Tell server to persist or refresh the session record
socket.emit('create-session', roomId);

// Page switching functions
function showPage(pageName) {
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    document.getElementById(pageName).classList.add('active');
}

// Generate QR Code pointing to your mobile web app
function renderQRCode() {
    const qEl = document.getElementById('qrcode');
    qEl.innerHTML = '';
    const mobileUrl = `${SERVER_URL}/?room=${roomId}`;
    new QRCode(qEl, {
        text: mobileUrl,
        width: 128,
        height: 128
    });
}

// Update status
function updateStatus() {
    const statusEl = document.getElementById('status');
    statusEl.innerHTML = `Session: <b>${roomId}</b> - ${isNewSession ? 'New' : 'Active'}`;
}

// Initial render
renderQRCode();
updateStatus();

// Page navigation
document.getElementById('openChatBtn').addEventListener('click', () => {
    showPage('chatPage');
});

document.getElementById('showQrBtn').addEventListener('click', () => {
    showPage('qrPage');
});

// Handle incoming text
// Render a message (text or file) into chat as conversation bubble
function addMessage(side, content, opts = {}) {
    // side: 'me' or 'them'
    const chat = document.getElementById('chat');
    const row = document.createElement('div');
    row.className = `msg-row ${side === 'me' ? 'me' : 'them'}`;

    const wrapper = document.createElement('div');
    wrapper.className = `message ${side === 'me' ? 'me' : 'them'}`;

    if (opts.meta) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = opts.meta;
        wrapper.appendChild(meta);
    }

    const msgContent = document.createElement('div');
    msgContent.className = 'msg-content';

    if (opts.file) {
        const a = document.createElement('a');
        a.href = opts.file;
        a.download = opts.name || 'file';
        a.className = 'file-link';
        a.textContent = opts.name || 'Download file';
        msgContent.appendChild(a);
    } else {
        const textNode = document.createElement('div');
        textNode.textContent = content;
        msgContent.appendChild(textNode);

        // add copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.title = 'Copy message';
        copyBtn.innerText = 'Copy';
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(content);
                copyBtn.innerText = 'Copied';
                setTimeout(() => copyBtn.innerText = 'Copy', 1200);
            } catch (e) {
                console.error('Copy failed', e);
            }
        });
        msgContent.appendChild(copyBtn);
    }

    wrapper.appendChild(msgContent);
    row.appendChild(wrapper);
    chat.appendChild(row);
    // scroll to bottom
    chat.scrollTop = chat.scrollHeight;
}

// Handle incoming text
socket.on('receive-text', (text) => {
    addMessage('them', text, { meta: 'Phone' });
});

// Handle incoming files
socket.on('receive-file', (data) => {
    addMessage('them', '', { file: data.file, name: data.name, meta: 'Phone' });
});

// Send Text
document.getElementById('sendBtn').addEventListener('click', () => {
    const text = document.getElementById('textInput').value;
    socket.emit('send-text', { room: roomId, text: text });
    addMessage('me', text, { meta: 'Me' });
    document.getElementById('textInput').value = '';
});

// Send File
document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = function(event) {
        socket.emit('send-file', {
            room: roomId,
            name: file.name,
            type: file.type,
            file: event.target.result // Base64 string
        });
        addMessage('me', '', { file: event.target.result, name: file.name, meta: 'Me' });
    };
    reader.readAsDataURL(file);
});

// End session explicitly
document.getElementById('endSessionBtn').addEventListener('click', () => {
    // Ask server to destroy persisted session
    socket.emit('destroy-session', roomId);
    // Clear local storage so next open creates a new session
    localStorage.removeItem('clouddrop_room');
    // Provide UI feedback
    document.getElementById('status').innerHTML = `Session ended: <b>${roomId}</b>`;
    // Clear chat so old messages aren't confusing
    document.getElementById('chat').innerHTML = '';
    // Optionally refresh UI: regenerate new room for continued use
    setTimeout(() => {
        isNewSession = true;
        roomId = Math.random().toString(36).substring(2, 10);
        localStorage.setItem('clouddrop_room', roomId);
        socket.emit('join-room', roomId);
        socket.emit('create-session', roomId);
        renderQRCode();
        updateStatus();
        showPage('qrPage');
    }, 800);
});