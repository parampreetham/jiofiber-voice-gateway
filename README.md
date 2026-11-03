# JioFiber Voice Gateway & Standalone Softphone

A standalone cross-platform desktop VoIP application and home gateway for **JioFiber Fixed-Line Landlines**. Make and receive crystal-clear voice calls directly from your **Windows/Mac/Linux PC (Standalone Desktop App or Web Softphone)** and **Amazon Echo Dot (Alexa)** without requiring the JioJoin/JioCall mobile app or phone screen mirroring.

---

## 🌟 Key Features

- **Universal Multi-Router Support**: Works with any JioFiber Home Gateway (`192.168.29.1`, `192.168.31.1`, or custom subnets) across all 20+ Indian telecom circles.
- **Instant OTP Self-Pairing**: Built-in First-Run Setup Wizard pairs directly with the router via SMS OTP—no manual packet sniffing or password extraction required.
- **Standalone Desktop Application**: Native Electron app with system tray minimization, notifications, and call control (`launch-desktop.bat`).
- **Direct Router SIP-TLS**: Connects directly to the router's internal SIP-TLS proxy (`port 5068`) using standard RFC 3261 / RFC 5626 digest authentication.
- **High-Fidelity Audio Engine**: Bidirectional RTP audio streaming with dual G.711 A-law (`PCMA` PT 8) and $\mu$-law (`PCMU` PT 0) codec auto-negotiation and continuous jitter resampling.
- **Amazon Echo Dot (Alexa) Ready**: Webhook endpoint (`/api/alexa`) for voice-activated dialing and speakerphone routing.
- **Zero Credentials in Code**: All sensitive credentials (`config.json` / `.env`) are strictly decoupled and gitignored.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph PC ["Standalone PC Softphone"]
        Electron["Electron Desktop App\nlaunch-desktop.bat"]
        WebUI["Web Softphone UI\nhttp://localhost:8088"]
        Gateway["Voice Gateway (Node.js/Express/WS)\nport 8088"]
        SIP["SIP-TLS Engine (sipClient.ts)\nDigest Auth (MD5) + RFC 5626"]
        RTP["UDP RTP Media Engine\nPort 20000"]
    end

    subgraph AlexaEcho ["Amazon Alexa Integration"]
        Echo["Amazon Echo Dot"]
        AlexaSkill["Alexa Skill Webhook\n/api/alexa"]
    end

    subgraph LocalRouter ["JioFiber Router / ONT (Local Wi-Fi)"]
        ProvAPI["Provisioning Daemon (Port 8443)\nwap-provisioningdoc XML"]
        RouterSIP["SIP-TLS Proxy (Port 5068)\nJIDU6601/JUICEJFV"]
    end

    subgraph JioIMS ["Jio Core Wireline Telecom"]
        IMSCore["Jio IMS Core (P-CSCF / S-CSCF)\n[circle].wln.ims.jio.com"]
        PSTN["PSTN / Mobile Network Target"]
    end

    Electron <--> WebUI
    WebUI <--> |WebSocket / JSON| Gateway
    Echo <--> |Voice Command| AlexaSkill
    AlexaSkill <--> Gateway
    Gateway --> SIP
    Gateway --> ProvAPI
    SIP <==> |SIP-TLS (Port 5068)| RouterSIP
    RouterSIP <==> |Wireline Trunk| IMSCore
    IMSCore <==> |PSTN Interconnect| PSTN
    RTP <==> |G.711 A-law / u-law RTP| IMSCore
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)
- PC connected to your JioFiber Wi-Fi network

### Installation

```bash
git clone https://github.com/parampreetham/jiofiber-voice-gateway.git
cd jiofiber-voice-gateway/gateway
npm install
npm run build
```

---

## ⚡ First-Time Setup (2 Ways)

### Method 1: In-App OTP Pairing (Recommended)
1. Start the desktop app:
   ```bash
   npm run electron
   ```
   *(Or double-click `launch-desktop.bat` on Windows).*
2. On first launch, the **Router & Line Setup** wizard will open automatically.
3. Enter your Jio router IP (default is `192.168.29.1`).
4. Click **Request SMS OTP from Router**.
5. Enter the 5-digit OTP received on your registered Jio mobile number and click **Verify & Connect**.
6. The app automatically fetches your SIP credentials, creates `config.json`, and registers the softphone!

### Method 2: Manual Configuration (`.env` or `config.json`)
Copy `.env.example` to `.env` in the `gateway` folder:
```bash
cp .env.example gateway/.env
```
Fill in your details:
```env
JIO_ROUTER_HOST=192.168.29.1
JIO_ROUTER_PORT=5068
JIO_LANDLINE_NUMBER=+91XXXXXXXXXX
JIO_SIP_PASSWORD=your_32_character_password
JIO_IMS_REALM=ka.wln.ims.jio.com
```

---

## 🌐 Supported Telecom Circles

| Circle | IMS Realm | Circle | IMS Realm |
| :--- | :--- | :--- | :--- |
| **Karnataka** | `ka.wln.ims.jio.com` | **Delhi** | `dl.wln.ims.jio.com` |
| **Mumbai** | `mu.wln.ims.jio.com` | **Maharashtra & Goa** | `mh.wln.ims.jio.com` |
| **Tamil Nadu** | `tn.wln.ims.jio.com` | **AP & Telangana** | `ap.wln.ims.jio.com` |
| **Kolkata** | `ko.wln.ims.jio.com` | **West Bengal** | `wb.wln.ims.jio.com` |
| **Gujarat** | `gj.wln.ims.jio.com` | **Kerala** | `kl.wln.ims.jio.com` |
| **Punjab** | `pb.wln.ims.jio.com` | **Rajasthan** | `rj.wln.ims.jio.com` |
| **UP East** | `ue.wln.ims.jio.com` | **UP West** | `uw.wln.ims.jio.com` |

---

## 💻 Running the App

### Standalone Desktop App (Windows / macOS / Linux)
```bash
npm run electron --prefix gateway
```
*On Windows, you can simply double click `launch-desktop.bat`.*

### Web Softphone Only (Headless Server)
```bash
npm start --prefix gateway
```
Open **`http://localhost:8088`** in any browser on your local network.

---

## 🔒 Security & Privacy

- All user-specific authentication tokens and router IPs are stored locally in `config.json` / `.env` and are strictly ignored by git (`.gitignore`).
- The repository contains **zero** hardcoded personal phone numbers, passwords, or router IPs.
