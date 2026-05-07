# CloudDrop

CloudDrop is split into two separate parts:

1. A Node.js server that only handles signaling and serves the mobile page.
2. A browser extension that creates the room, shows the QR code, and sends data peer to peer.

The server is no longer in the file-transfer path. Files move directly between the extension popup and the mobile browser using WebRTC data channels.

## What Runs Where

### Server side: `server/`

Run this on your VPS or on your local machine during development.

Key files:

- `server/server.js`
- `server/package.json`
- `server/public/index.html`
- `server/public/client.js`

What it does:

- Serves the mobile web app
- Hosts Socket.IO
- Relays only WebRTC signaling events like `send-signal` and `receive-signal`
- Tracks room join/leave state

### Extension side: `extension/`

Load this folder unpacked in Chrome or Chromium.

Key files:

- `extension/manifest.json`
- `extension/config.js`
- `extension/popup.html`
- `extension/popup.js`
- `extension/simplepeer.min.js`
- `extension/socket.io.min.js`
- `extension/qrcode.min.js`

What it does:

- Opens the CloudDrop popup
- Creates or restores a room id
- Generates the QR code for the mobile device
- Sends text and file chunks directly over WebRTC

## How It Works

1. You open the extension popup.
2. The popup joins a room on the signaling server.
3. The popup shows a QR code for the mobile page URL.
4. The phone scans the QR code and opens `server/public/index.html` with the same room id.
5. The server relays WebRTC signals until the two browsers connect.
6. After the peer connection is established, text and files go directly over the data channel.

File transfer details:

- Files are read with `FileReader` as `ArrayBuffer`
- Data is split into 32 KB chunks
- Each chunk is sent as base64 data over the peer connection
- The receiver acknowledges each chunk
- An EOF message marks the end of the file
- The receiver reassembles the chunks into a `Blob` and downloads it locally

## How To Run It

### 1. Install server dependencies

```bash
cd server
npm install
```

### 2. Start the signaling server

```bash
cd server
node server.js
```

By default the server listens on the port defined in `server.js`.

### 3. Point the extension at the server

The extension reads the server URL from `window.CLOUDDROP_SERVER_URL` in `extension/config.js`.

For local development, set it to your local server or an HTTPS tunnel such as ngrok:

```js
window.CLOUDDROP_SERVER_URL = 'https://your-tunnel-or-domain.example';
```

If you use a VPS, set it to your public HTTPS domain.

### 4. Load the extension

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Click Load unpacked
4. Select the `extension/` folder

### 5. Open the mobile side

Open the QR code from the extension popup on your phone. The phone loads the mobile page from the server and joins the same room.

## Running Server And Extension Separately

If you want to run them as separate deployments:

- Server machine: run `server/server.js` and expose it over HTTPS.
- Browser machine: load the `extension/` folder unpacked and point `window.CLOUDDROP_SERVER_URL` in `extension/config.js` to the server URL.
- Mobile device: open the QR code or the room URL shown by the extension.

This is the intended production setup.

## Production Notes

- `server/server.js` currently allows all Socket.IO origins with `cors: { origin: "*" }`. Restrict that before going live.
- WebRTC uses Google STUN servers for NAT traversal. For stricter networks, add a TURN server.
- `server/public/index.html` is only the mobile client entry point. It does not handle file relay anymore.

## Folder Layout

```text
clouddrop-server/
  extension/
    config.js
    manifest.json
    popup.html
    popup.js
    qrcode.min.js
    simplepeer.min.js
    socket.io.min.js
  server/
    package.json
    package-lock.json
    server.js
    public/
      client.js
      index.html
      simplepeer.min.js
```

## Quick Summary

- Server = signaling + mobile page hosting
- Extension = room setup + QR + peer-to-peer sending
- Files = browser to browser, not through the VPS
