# CloudDrop

A real-time peer-to-peer file and text transfer system using WebRTC with a browser extension and mobile web interface.

## 🎯 Project Overview

CloudDrop enables seamless data transfer between desktop and mobile devices without routing files through a server. It uses:

- **Browser Extension**: Creates rooms, generates QR codes, and manages peer connections
- **Signaling Server**: Relays only WebRTC signaling events via Socket.IO
- **WebRTC Data Channels**: Direct peer-to-peer communication for file transfer

The server is no longer in the file-transfer path. Files move directly between the extension popup and the mobile browser using WebRTC data channels.

## 🛠️ Technology Stack

### Frontend

- **Browser Extension**: HTML5, JavaScript (vanilla)
- **Mobile Web**: HTML5, JavaScript
- **QR Code Generation**: qrcode.min.js

### Backend

- **Node.js** - Signaling server runtime
- **Socket.IO** - WebRTC signaling relay and room management

### P2P Communication

- **WebRTC** - Peer-to-peer data channels
- **SimplePeer** - WebRTC abstraction library

## 📁 Project Structure

```
clouddrop-server/
├── README.md                       # Project documentation
├── server/                         # Node.js signaling server
│   ├── package.json                # Dependencies
│   ├── server.js                   # Main server entry point
│   └── public/                     # Mobile web app
│       ├── index.html              # Mobile app interface
│       ├── client.js               # Mobile client logic
│       └── simplepeer.min.js       # WebRTC library
└── extension/                      # Browser extension (Chrome/Chromium)
    ├── manifest.json               # Extension manifest
    ├── config.js                   # Server configuration
    ├── popup.html                  # Extension popup UI
    ├── popup.js                    # Popup logic & QR generation
    ├── qrcode.min.js               # QR code library
    ├── simplepeer.min.js           # WebRTC library
    └── socket.io.min.js            # Socket.IO client
```

## 🚀 Setup Instructions

### ⚡ Quick Start (5 Minutes)

#### 1. Install Server Dependencies

```bash
cd server
npm install
```

#### 2. Configure Server URL

Edit `extension/config.js` and set the server URL:

```js
window.CLOUDDROP_SERVER_URL = 'https://your-domain.example';
```

For local development, use ngrok or similar:

```js
window.CLOUDDROP_SERVER_URL = 'https://your-tunnel.ngrok.io';
```

#### 3. Start the Signaling Server

```bash
cd server
node server.js
```

The server listens on the port defined in `server.js`.

#### 4. Load the Extension

- Open Chrome/Chromium
- Go to `chrome://extensions/`
- Enable "Developer mode"
- Click "Load unpacked"
- Select the `extension/` folder

#### 5. Access the Application

- Click the CloudDrop extension icon
- Scan the QR code with your mobile device
- Start transferring files

## 🔄 How It Works

### Step-by-Step Flow

1. **Open Extension**: Click the CloudDrop icon to open the popup
2. **Create/Join Room**: The popup connects to the signaling server and joins a room
3. **Generate QR Code**: A QR code displays the mobile access URL with the room ID
4. **Scan & Connect**: Mobile device scans the QR code and opens the same room
5. **Establish P2P Connection**: Server relays WebRTC signaling until peers connect
6. **Direct Transfer**: Files and text go directly over WebRTC data channels

### File Transfer Protocol

- Files are read as `ArrayBuffer` using `FileReader` API
- Data is split into **32 KB chunks**
- Each chunk is sent as base64 over the peer connection
- Receiver acknowledges each chunk
- **EOF message** marks the end of transmission
- Receiver reassembles chunks into a `Blob` and downloads locally

### Server Responsibilities

- **Serves** the mobile web app (`server/public/index.html`)
- **Hosts** Socket.IO for signaling
- **Relays** WebRTC events: `send-signal` and `receive-signal`
- **Tracks** room join/leave state
- **Manages** peer discovery (NOT file transfer)

## 🎨 Features

### Extension Popup
- ✅ Create or restore room IDs
- ✅ Generate QR codes for mobile access
- ✅ Real-time file transfer
- ✅ Text sharing capability
- ✅ Connection status display

### Mobile Web App
- ✅ Scan QR code to join room
- ✅ Receive files directly
- ✅ Receive text messages
- ✅ Download transferred files
- ✅ Connection status indicator

## 🔐 Architecture Highlights

- **No Server File Storage**: Files never touch the server
- **Direct P2P Connection**: Low latency, high privacy
- **WebRTC Signaling Only**: Server overhead is minimal
- **Cross-Device**: Works between desktop extension and any mobile browser
- **Room-Based Pairing**: Simple QR code scanning for connection

## 📚 Key Technologies

- **WebRTC**: For encrypted peer-to-peer communication
- **Socket.IO**: For reliable signaling channel
- **Browser Extension API**: For desktop integration
- **QR Codes**: For easy mobile pairing

## 📄 License

This project is created for educational and personal use purposes.

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


## Quick Summary

- Server = signaling + mobile page hosting
- Extension = room setup + QR + peer-to-peer sending
- Files = browser to browser, not through the VPS
