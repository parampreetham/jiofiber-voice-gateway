# JioFiber Voice Home Gateway & Standalone VoIP Extension

A standalone VoIP/SIP client and home gateway for **JioFiber Landlines**. Allows you to make and receive calls on your JioFiber fixed-line number directly from your **PC (Web Softphone)** and **Amazon Echo Dot (Alexa)** without requiring the JioJoin/JioCall Android application.

## 🌟 Key Features

- **Direct Router SIP-TLS Registration**: Registers directly with the local JioFiber router (`ka.wln.ims.jio.com:5068`) over TLS 1.3 using RFC 5626 instance identification and MD5 Digest authentication.
- **Standalone Extension**: Runs completely independent of mobile devices or Android ADB relays.
- **Modern Web Softphone**: Clean, dark-mode browser dialer with real-time keypad, call timer, caller ID, and live WebSocket state sync.
- **Amazon Echo Dot / Alexa Integration**: Hands-free voice calling via Alexa Skill webhook (`/api/alexa`).
- **REST & WebSocket API**: Full programmatic control for home automation platforms (Home Assistant, Node-RED, etc.).

## 🏗️ Architecture

```
[ JioWireline IMS Core ]
          ▲
          │
[ JioFiber Router (192.168.31.1:5068) ]
          ▲
          │  SIP-TLS (Digest MD5)
          ▼
[ JioFiber Voice Gateway (Port 8088) ]
          │
   ┌──────┴──────────────────────────┐
   │                                 │
   ▼                                 ▼
[ Web Softphone ]             [ Amazon Echo Dot ]
http://localhost:8088         Alexa Skill Webhook (/api/alexa)
```

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)
- PC connected to the JioFiber Wi-Fi network (IPv6 enabled)

### Installation

```bash
cd gateway
npm install
npm run build
```

### Running the Gateway

```bash
npm start
```

Once running:
- Open the web softphone at: `http://localhost:8088`
- Check gateway health & SIP registration: `http://localhost:8088/api/status`
- Alexa webhook endpoint: `http://localhost:8088/api/alexa`

## 📁 Repository Structure

- `gateway/` - Express + WebSocket + SIP-TLS engine (`sipClient.ts`)
- `client/` - Responsive web dialer softphone interface
- `alexa/` - Alexa Skill definition and documentation
- `shared/` - Shared TypeScript interfaces and call event definitions
