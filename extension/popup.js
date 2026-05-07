const SERVER_URL = window.CLOUDDROP_SERVER_URL || '';
const socket = SERVER_URL ? io(SERVER_URL, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling']
}) : io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling']
});
const isHost = Boolean(document.getElementById('qrcode'));
const remoteLabel = isHost ? 'Phone' : 'PC';
const localLabel = 'Me';
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];
const CHUNK_SIZE = 32 * 1024;
const RECONNECT_DELAY_MS = 2000;

const outgoingTransfers = new Map();
const incomingTransfers = new Map();
const transferCards = new Map();

const statusEl = document.getElementById('status');
const chatEl = document.getElementById('chat');
const textInput = document.getElementById('textInput');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');
const openChatBtn = document.getElementById('openChatBtn');
const showQrBtn = document.getElementById('showQrBtn');
const endSessionBtn = document.getElementById('endSessionBtn');

let roomId = isHost ? localStorage.getItem('clouddrop_room') : new URLSearchParams(window.location.search).get('room');
let isNewSession = false;
let peer = null;
let peerConnected = false;
let roomPeerCount = isHost ? 1 : 0;
let leaveRequested = false;
let reconnectTimer = null;
let pendingSignals = [];

if (isHost && !roomId) {
    roomId = createRoomId();
    localStorage.setItem('clouddrop_room', roomId);
    isNewSession = true;
}

function logTransfer(...args) {
    console.log('[CloudDrop]', ...args);
}

function createRoomId() {
    return Math.random().toString(36).slice(2, 10);
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

function uint8ArrayToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;

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

function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function showPage(pageName) {
    document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
    const target = document.getElementById(pageName);
    if (target) {
        target.classList.add('active');
    }
}

function setControlsEnabled(enabled) {
    [textInput, fileInput, sendBtn].forEach((element) => {
        if (element) {
            element.disabled = !enabled;
        }
    });
}

function updateStatus() {
    if (!statusEl) return;

    if (!roomId) {
        statusEl.textContent = 'No room available';
        return;
    }

    if (peerConnected) {
        statusEl.textContent = `Connected: ${roomId}`;
        return;
    }

    if (isHost) {
        statusEl.innerHTML = `Session: <b>${roomId}</b> - Waiting for receiver`;
    } else {
        statusEl.textContent = `Room: ${roomId} - Waiting for host`;
    }
}

function renderQRCode() {
    const qrcodeEl = document.getElementById('qrcode');
    if (!qrcodeEl || !roomId) return;

    qrcodeEl.innerHTML = '';
    const baseUrl = SERVER_URL || window.location.origin;
    const mobileUrl = `${baseUrl}/?room=${encodeURIComponent(roomId)}`;
    new QRCode(qrcodeEl, {
        text: mobileUrl,
        width: 128,
        height: 128
    });
}

function scrollChatToBottom() {
    if (chatEl) {
        chatEl.scrollTop = chatEl.scrollHeight;
    }
}

function addMessage(side, content, opts = {}) {
    if (!chatEl) return;

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
        const fileLink = document.createElement('a');
        fileLink.href = opts.file;
        fileLink.download = opts.name || 'file';
        fileLink.className = 'file-link';
        fileLink.textContent = opts.name || 'Download file';
        msgContent.appendChild(fileLink);
    } else {
        const textNode = document.createElement('div');
        textNode.textContent = content;
        msgContent.appendChild(textNode);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.title = 'Copy message';
        copyBtn.innerText = 'Copy';
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(content);
                copyBtn.innerText = 'Copied';
                setTimeout(() => {
                    copyBtn.innerText = 'Copy';
                }, 1200);
            } catch (error) {
                console.error('Copy failed', error);
            }
        });
        msgContent.appendChild(copyBtn);
    }

    wrapper.appendChild(msgContent);
    row.appendChild(wrapper);
    chatEl.appendChild(row);
    scrollChatToBottom();
}

function createProgressMessage(side, title, transferId, initialText, options = {}) {
    if (!chatEl) return null;

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

    if (options.cancelable !== false) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'progress-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => cancelTransfer(transferId));
        actions.appendChild(cancelBtn);
    }

    barOuter.appendChild(barInner);
    wrapper.appendChild(meta);
    wrapper.appendChild(status);
    wrapper.appendChild(body);
    wrapper.appendChild(barOuter);
    wrapper.appendChild(pct);
    if (actions.childNodes.length) {
        wrapper.appendChild(actions);
    }

    row.appendChild(wrapper);
    chatEl.appendChild(row);
    scrollChatToBottom();

    const card = { row, wrapper, body, status, barInner, pct, meta };
    transferCards.set(transferId, card);
    return card;
}

function updateProgressMessage(transferId, percent, text, statusText) {
    const card = transferCards.get(transferId);
    if (!card) return;

    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    card.barInner.style.width = `${safePercent}%`;
    card.pct.textContent = `${safePercent}%`;

    if (text) {
        card.body.textContent = text;
    }

    if (statusText) {
        card.status.textContent = statusText;
    }
}

function setTransferFinalState(transferId, metaLabel, finalText) {
    const card = transferCards.get(transferId);
    if (!card) return;

    card.wrapper.innerHTML = '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = metaLabel;

    const content = document.createElement('div');
    content.className = 'msg-content';

    const text = document.createElement('div');
    text.textContent = finalText;
    content.appendChild(text);

    card.wrapper.appendChild(meta);
    card.wrapper.appendChild(content);
    transferCards.delete(transferId);
}

function finalizeProgressMessage(transferId, fileName, fileUrl, metaLabel) {
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

function triggerBrowserDownload(fileUrl, fileName) {
    // Skip auto-download on mobile devices; let users click the link in conversation
    if (isMobileDevice()) {
        return;
    }
    
    const anchor = document.createElement('a');
    anchor.href = fileUrl;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

function sendPeerMessage(message) {
    if (!peer || !peerConnected) {
        return false;
    }

    try {
        peer.send(JSON.stringify(message));
        return true;
    } catch (error) {
        console.error('Failed to send peer message', error);
        return false;
    }
}

function resetOutgoingTransfer(transferId, statusText, metaLabel) {
    const transfer = outgoingTransfers.get(transferId);
    if (transfer && transfer.timer) {
        clearTimeout(transfer.timer);
    }
    outgoingTransfers.delete(transferId);
    if (statusText) {
        setTransferFinalState(transferId, metaLabel || 'System', statusText);
    }
}

function cancelTransfer(transferId, reason = 'cancelled_by_user', notifyRemote = true) {
    const outgoing = outgoingTransfers.get(transferId);
    const incoming = incomingTransfers.get(transferId);

    if (outgoing) {
        if (outgoing.timer) {
            clearTimeout(outgoing.timer);
        }
        outgoingTransfers.delete(transferId);
    }

    if (incoming) {
        incomingTransfers.delete(transferId);
    }

    if (notifyRemote) {
        sendPeerMessage({ type: 'file-cancel', transferId, reason });
    }

    setTransferFinalState(transferId, 'System', 'Cancelled');
}

function cleanupTransfers(message) {
    for (const [transferId, transfer] of outgoingTransfers.entries()) {
        if (transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(transferId);
        setTransferFinalState(transferId, 'System', message);
    }

    for (const [transferId] of incomingTransfers.entries()) {
        incomingTransfers.delete(transferId);
        setTransferFinalState(transferId, 'System', message);
    }
}

function destroyPeer(silent = true) {
    if (!peer) return;

    try {
        peer.removeAllListeners();
        peer.destroy();
    } catch (error) {
        if (!silent) {
            console.error('Peer destroy failed', error);
        }
    }

    peer = null;
    peerConnected = false;
    pendingSignals = [];
}

function flushPendingSignals() {
    if (!peer || !pendingSignals.length) return;

    const queuedSignals = pendingSignals.slice();
    pendingSignals = [];

    queuedSignals.forEach((signal) => {
        try {
            peer.signal(signal);
        } catch (error) {
            console.error('Failed to apply queued signal', error);
        }
    });
}

function createPeer(initiator) {
    destroyPeer(true);

    peer = new SimplePeer({
        initiator,
        trickle: true,
        config: {
            iceServers: ICE_SERVERS
        }
    });

    peer.on('signal', (signal) => {
        socket.emit('send-signal', {
            roomId,
            signal
        });
    });

    peer.on('connect', () => {
        peerConnected = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        setControlsEnabled(Boolean(roomId));
        updateStatus();
        logTransfer('peer-connected', { roomId, initiator });
    });

    peer.on('data', (data) => {
        handlePeerData(data);
    });

    peer.on('close', () => {
        handlePeerDrop('closed');
    });

    peer.on('error', (error) => {
        console.error('Peer error', error);
        handlePeerDrop(error && error.message ? error.message : 'error');
    });

    flushPendingSignals();
}

function ensurePeer(initiator) {
    if (!roomId || leaveRequested) return;
    if (peer) return;
    createPeer(initiator);
}

function handlePeerDrop(reason) {
    peerConnected = false;
    cleanupTransfers('Connection lost');
    destroyPeer(false);
    updateControlsAfterConnectionChange();

    if (leaveRequested || !roomId) {
        updateStatus();
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!leaveRequested && roomId) {
            if (isHost) {
                if (roomPeerCount >= 2) {
                    ensurePeer(true);
                }
            } else {
                ensurePeer(false);
            }
        }
    }, RECONNECT_DELAY_MS);

    addMessage('them', `Peer disconnected: ${reason || 'unknown'}`, { meta: 'System' });
    updateStatus();
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function handlePeerData(data) {
    let message = null;

    if (typeof data === 'string') {
        try {
            message = JSON.parse(data);
        } catch (error) {
            message = { type: 'text', text: data };
        }
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const text = new TextDecoder().decode(view);
        try {
            message = JSON.parse(text);
        } catch (error) {
            return;
        }
    }

    if (!message || !message.type) return;

    switch (message.type) {
        case 'text':
            addMessage('them', message.text || '', { meta: remoteLabel });
            break;
        case 'file-start':
            handleFileStart(message);
            break;
        case 'file-chunk':
            handleFileChunk(message);
            break;
        case 'file-eof':
            handleFileEof(message);
            break;
        case 'file-ack':
            handleFileAck(message);
            break;
        case 'file-complete':
            handleFileComplete(message);
            break;
        case 'file-cancel':
            handleFileCancel(message);
            break;
        case 'file-error':
            handleFileError(message);
            break;
        default:
            break;
    }
}

function handleFileStart(message) {
    if (incomingTransfers.has(message.transferId)) {
        return;
    }

    incomingTransfers.set(message.transferId, {
        name: message.name,
        type: message.mimeType || message.type || 'application/octet-stream',
        size: message.size || 0,
        totalChunks: message.totalChunks || 0,
        chunks: new Array(message.totalChunks || 0),
        received: 0,
        eofReceived: false,
        completed: false
    });

    createProgressMessage('them', message.name, message.transferId, `Receiving ${message.name} (${formatBytes(message.size || 0)})`, {
        statusText: 'Queued',
        cancelable: false
    });
}

function handleFileChunk(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    const chunkBytes = base64ToUint8Array(message.chunkBase64 || '');
    if (!transfer.chunks[message.index]) {
        transfer.chunks[message.index] = chunkBytes;
        transfer.received += 1;
    }

    updateProgressMessage(
        message.transferId,
        transfer.totalChunks ? (transfer.received / transfer.totalChunks) * 100 : 0,
        `Receiving ${transfer.name} (${transfer.received}/${transfer.totalChunks || 0})`,
        `Receiving chunk ${message.index + 1}`
    );

    sendPeerMessage({
        type: 'file-ack',
        transferId: message.transferId,
        index: message.index
    });

    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileEof(message) {
    const transfer = incomingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    transfer.eofReceived = true;
    maybeFinalizeIncomingTransfer(message.transferId);
}

function handleFileAck(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.completed) return;

    if (message.index !== transfer.nextIndex) {
        return;
    }

    if (transfer.timer) {
        clearTimeout(transfer.timer);
        transfer.timer = null;
    }

    transfer.nextIndex += 1;

    if (transfer.nextIndex < transfer.totalChunks) {
        sendNextChunk(message.transferId);
    } else {
        transfer.eofSent = true;
        sendPeerMessage({
            type: 'file-eof',
            transferId: message.transferId
        });
        updateProgressMessage(message.transferId, 100, `Finalizing ${transfer.name}`, 'EOF sent');
    }
}

function handleFileComplete(message) {
    const transfer = outgoingTransfers.get(message.transferId);
    if (!transfer) return;

    if (transfer.timer) {
        clearTimeout(transfer.timer);
    }

    outgoingTransfers.delete(message.transferId);
    finalizeProgressMessage(message.transferId, transfer.name, '', 'System');
}

function handleFileCancel(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Cancelled: ${message.reason || 'unknown'}`);
}

function handleFileError(message) {
    if (outgoingTransfers.has(message.transferId)) {
        const transfer = outgoingTransfers.get(message.transferId);
        if (transfer && transfer.timer) {
            clearTimeout(transfer.timer);
        }
        outgoingTransfers.delete(message.transferId);
    }

    if (incomingTransfers.has(message.transferId)) {
        incomingTransfers.delete(message.transferId);
    }

    setTransferFinalState(message.transferId, 'System', `Transfer error: ${message.reason || 'unknown'}`);
}

function maybeFinalizeIncomingTransfer(transferId) {
    const transfer = incomingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;

    if (!transfer.eofReceived || transfer.received < transfer.totalChunks) {
        return;
    }

    transfer.completed = true;
    const blob = new Blob(transfer.chunks, {
        type: transfer.type || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);

    triggerBrowserDownload(objectUrl, transfer.name);
    finalizeProgressMessage(transferId, transfer.name, objectUrl, remoteLabel);
    sendPeerMessage({
        type: 'file-complete',
        transferId
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000);

    incomingTransfers.delete(transferId);
}

function sendNextChunk(transferId) {
    const transfer = outgoingTransfers.get(transferId);
    if (!transfer || transfer.completed) return;
    if (!peerConnected) return;

    if (transfer.nextIndex >= transfer.totalChunks) {
        if (!transfer.eofSent) {
            transfer.eofSent = true;
            sendPeerMessage({ type: 'file-eof', transferId });
        }
        return;
    }

    const index = transfer.nextIndex;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const reader = new FileReader();

    transfer.reader = reader;

    reader.onerror = () => {
        resetOutgoingTransfer(transferId, 'Read failure', 'System');
        sendPeerMessage({
            type: 'file-error',
            transferId,
            reason: 'file_read_failed'
        });
    };

    reader.onload = (event) => {
        const bytes = new Uint8Array(event.target.result);
        const chunkBase64 = uint8ArrayToBase64(bytes);

        if (!sendPeerMessage({
            type: 'file-chunk',
            transferId,
            index,
            chunkBase64
        })) {
            resetOutgoingTransfer(transferId, 'Peer disconnected', 'System');
            return;
        }

        updateProgressMessage(
            transferId,
            transfer.totalChunks ? ((index + 1) / transfer.totalChunks) * 100 : 100,
            `Sending ${transfer.name} (${index + 1}/${transfer.totalChunks || 0})`,
            `Sending chunk ${index + 1}`
        );

        transfer.timer = setTimeout(() => {
            resetOutgoingTransfer(transferId, 'Transfer timed out', 'System');
            sendPeerMessage({
                type: 'file-error',
                transferId,
                reason: 'ack_timeout'
            });
        }, 15000);
    };

    reader.readAsArrayBuffer(transfer.file.slice(start, end));
}

function startFileTransfer(file) {
    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    const transferId = createTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        totalChunks,
        nextIndex: 0,
        eofSent: false,
        completed: false,
        timer: null,
        reader: null
    };

    outgoingTransfers.set(transferId, transfer);
    createProgressMessage('me', file.name, transferId, `Sending ${file.name} (${formatBytes(file.size)})`, {
        statusText: 'Queued',
        cancelable: true
    });

    if (!sendPeerMessage({
        type: 'file-start',
        transferId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
    })) {
        resetOutgoingTransfer(transferId, 'Unable to start transfer', 'System');
        return;
    }

    if (totalChunks === 0) {
        transfer.eofSent = true;
        sendPeerMessage({ type: 'file-eof', transferId });
        updateProgressMessage(transferId, 100, `Finalizing ${file.name}`, 'EOF sent');
        return;
    }

    sendNextChunk(transferId);
}

function sendTextMessage() {
    if (!textInput) return;

    const text = textInput.value.trim();
    if (!text) return;

    if (!peerConnected) {
        addMessage('me', 'Peer is not connected yet.', { meta: 'System' });
        return;
    }

    if (sendPeerMessage({
        type: 'text',
        text
    })) {
        addMessage('me', text, { meta: localLabel });
        textInput.value = '';
    }
}

function updateControlsAfterConnectionChange() {
    const enabled = Boolean(roomId) && peerConnected;
    setControlsEnabled(enabled);
}

function maybeStartHostPeer() {
    if (!isHost || !roomId || leaveRequested) return;
    if (roomPeerCount >= 2) {
        ensurePeer(true);
    }
}

function maybeStartReceiverPeer() {
    if (isHost || !roomId || leaveRequested) return;
    ensurePeer(false);
}

function sendPeerMessage(message) {
    if (!peer || !peerConnected) {
        return false;
    }

    try {
        peer.send(JSON.stringify(message));
        return true;
    } catch (error) {
        console.error('Failed to send peer message', error);
        return false;
    }
}

function destroyPeer(silent = true) {
    if (!peer) return;

    try {
        peer.removeAllListeners();
        peer.destroy();
    } catch (error) {
        if (!silent) {
            console.error('Peer destroy failed', error);
        }
    }

    peer = null;
    peerConnected = false;
    pendingSignals = [];
}

function flushPendingSignals() {
    if (!peer || !pendingSignals.length) return;

    const queuedSignals = pendingSignals.slice();
    pendingSignals = [];

    queuedSignals.forEach((signal) => {
        try {
            peer.signal(signal);
        } catch (error) {
            console.error('Failed to apply queued signal', error);
        }
    });
}

function createPeer(initiator) {
    destroyPeer(true);

    peer = new SimplePeer({
        initiator,
        trickle: true,
        config: {
            iceServers: ICE_SERVERS
        }
    });

    peer.on('signal', (signal) => {
        socket.emit('send-signal', {
            roomId,
            signal
        });
    });

    peer.on('connect', () => {
        peerConnected = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        setControlsEnabled(Boolean(roomId));
        updateStatus();
        logTransfer('peer-connected', { roomId, initiator });
    });

    peer.on('data', (data) => {
        handlePeerData(data);
    });

    peer.on('close', () => {
        handlePeerDrop('closed');
    });

    peer.on('error', (error) => {
        console.error('Peer error', error);
        handlePeerDrop(error && error.message ? error.message : 'error');
    });

    flushPendingSignals();
}

function ensurePeer(initiator) {
    if (!roomId || leaveRequested) return;
    if (peer) return;
    createPeer(initiator);
}

function handlePeerDrop(reason) {
    peerConnected = false;
    cleanupTransfers('Connection lost');
    destroyPeer(false);
    updateControlsAfterConnectionChange();

    if (leaveRequested || !roomId) {
        updateStatus();
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!leaveRequested && roomId) {
            if (isHost) {
                if (roomPeerCount >= 2) {
                    ensurePeer(true);
                }
            } else {
                ensurePeer(false);
            }
        }
    }, RECONNECT_DELAY_MS);

    addMessage('them', `Peer disconnected: ${reason || 'unknown'}`, { meta: 'System' });
    updateStatus();
}

socket.on('room-state', (data) => {
    roomPeerCount = data && Number.isFinite(data.peerCount) ? data.peerCount : roomPeerCount;
    updateStatus();
    if (isHost) {
        maybeStartHostPeer();
    } else {
        maybeStartReceiverPeer();
    }
});

socket.on('peer-joined', (data) => {
    roomPeerCount = data && Number.isFinite(data.peerCount) ? data.peerCount : Math.max(roomPeerCount, 2);
    if (isHost) {
        maybeStartHostPeer();
    } else {
        maybeStartReceiverPeer();
    }
    updateStatus();
});

socket.on('peer-left', () => {
    handlePeerDrop('peer left the room');
});

socket.on('receive-signal', (data) => {
    if (!data || !data.signal) return;

    if (peer) {
        try {
            peer.signal(data.signal);
        } catch (error) {
            console.error('Failed to apply signal', error);
        }
        return;
    }

    pendingSignals.push(data.signal);
});

socket.on('signal-error', (data) => {
    addMessage('them', `Signaling error: ${data && data.reason ? data.reason : 'unknown'}`, { meta: 'System' });
});

socket.on('disconnect', () => {
    if (!peerConnected) {
        updateStatus();
    }
});

function initializeRoom() {
    if (!roomId) {
        if (statusEl) {
            statusEl.textContent = 'No room. Scan the QR code from the extension.';
        }
        setControlsEnabled(false);
        return;
    }

    if (isHost) {
        renderQRCode();
        if (openChatBtn) {
            openChatBtn.addEventListener('click', () => showPage('chatPage'));
        }
        if (showQrBtn) {
            showQrBtn.addEventListener('click', () => showPage('qrPage'));
        }
        if (endSessionBtn) {
            endSessionBtn.addEventListener('click', resetHostSession);
        }
    } else {
        maybeStartReceiverPeer();
    }

    updateStatus();
    updateControlsAfterConnectionChange();
}

function resetHostSession() {
    leaveRequested = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (roomId) {
        socket.emit('leave-room', roomId);
    }

    destroyPeer(true);
    cleanupTransfers('Session ended');
    localStorage.removeItem('clouddrop_room');

    roomId = createRoomId();
    localStorage.setItem('clouddrop_room', roomId);
    isNewSession = true;
    leaveRequested = false;
    roomPeerCount = 1;
    peerConnected = false;

    renderQRCode();
    updateStatus();
    socket.emit('join-room', roomId);
}

function handleSocketReady() {
    if (!roomId) {
        updateStatus();
        return;
    }

    socket.emit('join-room', roomId);
    if (!isHost) {
        maybeStartReceiverPeer();
    }
    updateStatus();
}

if (roomId) {
    if (socket.connected) {
        handleSocketReady();
    } else {
        socket.on('connect', handleSocketReady);
    }
}

if (textInput) {
    textInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            sendTextMessage();
        }
    });
}

if (sendBtn) {
    sendBtn.addEventListener('click', (event) => {
        event.preventDefault();
        sendTextMessage();
    });
}

if (fileInput) {
    fileInput.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        startFileTransfer(file);
        event.target.value = '';
    });
}

window.addEventListener('beforeunload', () => {
    leaveRequested = true;
    if (roomId) {
        socket.emit('leave-room', roomId);
    }
    destroyPeer(true);
});

initializeRoom();

if (isHost) {
    renderQRCode();
    updateStatus();
}
