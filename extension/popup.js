// Connect to your deployed server (use ngrok for local testing)
const SERVER_URL = 'https://04ba-203-106-65-238.ngrok-free.app'; 
const socket = io(SERVER_URL);

const CHUNK_SIZE = 16 * 1024;
const ACK_TIMEOUT_MS = 15000;
const MAX_CHUNK_RETRY = 3;
const outgoingTransfers = new Map();
const incomingTransfers = new Map();
const transferCards = new Map();

function logTransfer(...args) {
    console.log('[CloudDrop Transfer]', ...args);
}

function normalizeChunkToUint8Array(chunk) {
    if (!chunk) return null;

    if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
    }

    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }

    // Node-style Buffer JSON shape: { type: 'Buffer', data: number[] }
    if (chunk.type === 'Buffer' && Array.isArray(chunk.data)) {
        return new Uint8Array(chunk.data);
    }

    return null;
}

function uint8ArrayToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x1000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, i + chunkSize);
        let chunk = '';
        for (let j = 0; j < slice.length; j += 1) {
            chunk += String.fromCharCode(slice[j]);
        }
        binary += chunk;
    }

    return btoa(binary);
}

function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

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

function createTransferId() {
    return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cancelTransfer(transferId, reason = 'cancelled_by_user', notifyRemote = true) {
    const outgoing = outgoingTransfers.get(transferId);
    const incoming = incomingTransfers.get(transferId);

    if (outgoing) {
        clearTimeout(outgoing.timer);
        outgoingTransfers.delete(transferId);
    }

    if (incoming) {
        incomingTransfers.delete(transferId);
    }

    if (notifyRemote) {
        socket.emit('file-cancel', {
            room: roomId,
            transferId,
            reason
        });
    }

    setTransferFinalState(transferId, 'Cancelled', 'System', 'Cancelled');
}

function createProgressMessage(side, title, transferId, initialText, options = {}) {
    const chat = document.getElementById('chat');
    const row = document.createElement('div');
    row.className = `msg-row ${side === 'me' ? 'me' : 'them'}`;

    const wrapper = document.createElement('div');
    wrapper.className = `message ${side === 'me' ? 'me' : 'them'}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = title;

    const body = document.createElement('div');
    body.className = 'progress-body';
    body.textContent = initialText;

    const status = document.createElement('div');
    status.className = 'progress-status';
    status.textContent = options.statusText || 'Queued';

    const barOuter = document.createElement('div');
    barOuter.className = 'progress-bar-outer';

    const barInner = document.createElement('div');
    barInner.className = 'progress-bar-inner';
    barInner.style.width = '0%';

    const pct = document.createElement('div');
    pct.className = 'progress-pct';
    pct.textContent = '0%';

    const actions = document.createElement('div');
    actions.className = 'progress-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'progress-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => cancelTransfer(transferId));

    if (options.cancelable !== false) {
        actions.appendChild(cancelBtn);
    }

    barOuter.appendChild(barInner);
    wrapper.appendChild(meta);
    wrapper.appendChild(status);
    wrapper.appendChild(body);
    wrapper.appendChild(barOuter);
    wrapper.appendChild(pct);
    if (actions.childNodes.length) wrapper.appendChild(actions);
    row.appendChild(wrapper);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;

    const card = { row, wrapper, body, status, barInner, pct, meta, cancelBtn };
    transferCards.set(transferId, card);
    return card;
}

function updateProgressMessage(transferId, percent, text, statusText) {
    const card = transferCards.get(transferId);
    if (!card) return;
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    card.barInner.style.width = `${safePercent}%`;
    card.pct.textContent = `${safePercent}%`;
    if (text) card.body.textContent = text;
    if (statusText) card.status.textContent = statusText;
}

function setTransferFinalState(transferId, title, metaLabel, finalText) {
    const card = transferCards.get(transferId);
    if (!card) return;

    card.wrapper.innerHTML = '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = metaLabel;

    const content = document.createElement('div');
    content.className = 'msg-content';
    const text = document.createElement('div');
    text.textContent = finalText || title;
    content.appendChild(text);

    card.wrapper.appendChild(meta);
    card.wrapper.appendChild(content);
    transferCards.delete(transferId);
}

function finalizeProgressMessage(transferId, fileName, fileUrl, side, metaLabel) {
    const card = transferCards.get(transferId);
    if (!card) return;

    card.wrapper.innerHTML = '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = metaLabel;

    const content = document.createElement('div');
    content.className = 'msg-content';

    if (fileUrl) {
        const link = document.createElement('a');
        link.href = fileUrl;
        link.download = fileName;
        link.className = 'file-link';
        link.textContent = fileName;
        content.appendChild(link);
    } else {
        const text = document.createElement('div');
        text.textContent = `Sent ${fileName}`;
        content.appendChild(text);
    }

    card.wrapper.appendChild(meta);
    card.wrapper.appendChild(content);
    transferCards.delete(transferId);
}

function sendChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer) return;

    const index = transfer.nextIndex;
    if (index >= transfer.totalChunks) return;

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.bytes.length);
    const slice = transfer.bytes.slice(start, end);
    const chunkBase64 = uint8ArrayToBase64(slice);
    logTransfer('send-chunk', { transferId, index, totalChunks: transfer.totalChunks, bytes: slice.length });
    updateProgressMessage(transferId, ((index + 1) / transfer.totalChunks) * 100, `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks})`, transfer.retrying ? `Retry ${transfer.retries[index] || 0}/${MAX_CHUNK_RETRY}` : `Sending chunk ${index + 1} of ${transfer.totalChunks}`);

    transfer.inFlightIndex = index;
    transfer.awaitingAck = true;

    socket.emit('file-chunk', {
        room: roomId,
        transferId,
        index,
        chunkBase64
    });

    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => {
        transfer.retries[index] = (transfer.retries[index] || 0) + 1;
        if (transfer.retries[index] > MAX_CHUNK_RETRY) {
            outgoingTransfers.delete(transferId);
            logTransfer('chunk-failed', { transferId, index, name: transfer.name });
            addMessage('me', `File failed: ${transfer.name}`, { meta: 'System' });
            transferCards.delete(transferId);
            socket.emit('file-error', {
                room: roomId,
                transferId,
                reason: 'ack_timeout'
            });
            return;
        }
        transfer.retrying = true;
        transfer.awaitingAck = false;
        updateProgressMessage(transferId, ((index + 1) / transfer.totalChunks) * 100, `Retrying ${transfer.name} (${index + 1}/${transfer.totalChunks})`, `Retry ${transfer.retries[index]}/${MAX_CHUNK_RETRY}`);
        sendChunk(transferId);
    }, ACK_TIMEOUT_MS);
}

function startChunkTransfer(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const transferId = createTransferId();
        const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);

        logTransfer('file-init', { transferId, name: file.name, size: file.size, totalChunks });
        createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, { statusText: 'Queued', cancelable: true });

        outgoingTransfers.set(transferId, {
            name: file.name,
            type: file.type,
            size: file.size,
            bytes,
            totalChunks,
            nextIndex: 0,
            inFlightIndex: null,
            awaitingAck: false,
            retries: {},
            timer: null
        });

        socket.emit('file-init', {
            room: roomId,
            transferId,
            name: file.name,
            type: file.type,
            size: file.size,
            chunkSize: CHUNK_SIZE,
            totalChunks
        });

        sendChunk(transferId);
    };
    reader.readAsArrayBuffer(file);
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

// Chunk protocol: receiver creates transfer state
socket.on('file-init', (data) => {
    incomingTransfers.set(data.transferId, {
        name: data.name,
        type: data.type,
        totalChunks: data.totalChunks,
        chunks: new Array(data.totalChunks),
        received: 0
    });
    createProgressMessage('them', data.name, data.transferId, `Receiving ${data.name} (${formatBytes(data.size || 0)})`, { statusText: 'Queued', cancelable: true });
});

// Chunk protocol: receiver gets chunk and acks it
socket.on('file-chunk', (data) => {
    const transfer = incomingTransfers.get(data.transferId);
    if (!transfer) return;

    const normalizedChunk = normalizeChunkToUint8Array(data.chunk)
        || (typeof data.chunkBase64 === 'string' ? base64ToUint8Array(data.chunkBase64) : null);
    if (!normalizedChunk) {
        logTransfer('invalid-chunk-format', { transferId: data.transferId, index: data.index });
        socket.emit('file-error', {
            room: roomId,
            transferId: data.transferId,
            reason: 'invalid_chunk_format'
        });
        return;
    }

    if (!transfer.chunks[data.index]) {
        transfer.chunks[data.index] = normalizedChunk;
        transfer.received += 1;
        logTransfer('recv-chunk', { transferId: data.transferId, index: data.index, received: transfer.received, totalChunks: transfer.totalChunks, bytes: normalizedChunk.length });
    }

    updateProgressMessage(data.transferId, (transfer.received / transfer.totalChunks) * 100, `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks})`, `Receiving chunk ${transfer.received} of ${transfer.totalChunks}`);

    socket.emit('file-ack', {
        room: roomId,
        transferId: data.transferId,
        index: data.index
    });

    if (transfer.received === transfer.totalChunks) {
        const blob = new Blob(transfer.chunks, {
            type: transfer.type || 'application/octet-stream'
        });
        const objectUrl = URL.createObjectURL(blob);
        logTransfer('file-complete-local', { transferId: data.transferId, name: transfer.name, size: blob.size });
        finalizeProgressMessage(data.transferId, transfer.name, objectUrl, 'them', 'Phone');
        socket.emit('file-complete', {
            room: roomId,
            transferId: data.transferId
        });
        incomingTransfers.delete(data.transferId);
    }
});

// Chunk protocol: sender processes ack and sends next chunk
socket.on('file-ack', (data) => {
    const transfer = outgoingTransfers.get(data.transferId);
    if (!transfer) return;
    if (transfer.inFlightIndex === null) return;
    if (data.index !== transfer.inFlightIndex) return;

    clearTimeout(transfer.timer);
    transfer.nextIndex += 1;
    transfer.inFlightIndex = null;
    transfer.awaitingAck = false;
    transfer.retrying = false;
    logTransfer('ack', { transferId: data.transferId, index: data.index, nextIndex: transfer.nextIndex });

    if (transfer.nextIndex < transfer.totalChunks) {
        sendChunk(data.transferId);
    }
});

socket.on('file-complete', (data) => {
    const transfer = outgoingTransfers.get(data.transferId);
    if (!transfer) return;

    clearTimeout(transfer.timer);
    outgoingTransfers.delete(data.transferId);
    logTransfer('file-complete-remote', { transferId: data.transferId, name: transfer.name });
    finalizeProgressMessage(data.transferId, transfer.name, '', 'me', 'System');
});

socket.on('file-error', (data) => {
    if (data.transferId && outgoingTransfers.has(data.transferId)) {
        const transfer = outgoingTransfers.get(data.transferId);
        clearTimeout(transfer.timer);
        outgoingTransfers.delete(data.transferId);
    }
    logTransfer('remote-error', data);
    transferCards.delete(data.transferId);
    addMessage('them', `Transfer error: ${data.reason || 'unknown'}`, { meta: 'System' });
});

socket.on('file-cancel', (data) => {
    if (data.transferId && outgoingTransfers.has(data.transferId)) {
        const transfer = outgoingTransfers.get(data.transferId);
        clearTimeout(transfer.timer);
        outgoingTransfers.delete(data.transferId);
    }
    if (data.transferId && incomingTransfers.has(data.transferId)) {
        incomingTransfers.delete(data.transferId);
    }
    logTransfer('remote-cancel', data);
    setTransferFinalState(data.transferId, 'Cancelled', 'System', 'Cancelled');
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
    if (!file) return;
    startChunkTransfer(file);
    e.target.value = '';
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