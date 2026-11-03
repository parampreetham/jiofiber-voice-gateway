# Amazon Echo Dot (Alexa) Integration for JioFiber Voice

This bridge connects your local JioFiber Voice Gateway to your **Amazon Echo Dot** smart speaker(s) across your home Wi-Fi network.

---

## 🔊 Supported Echo Dot Interactions

| What You Say to Alexa | Action Taken by Gateway |
|---|---|
| *"Alexa, open Landline"* | Alexa connects to the gateway and reports your fixed number and status. |
| *"Alexa, answer"* | Picks up the incoming landline call hands-free through the Echo Dot speaker & microphone. |
| *"Alexa, call Mom on landline"* | Alexa instructs the gateway to dial Mom's number over JioFiberVoice. |
| *"Alexa, hang up"* | Terminates the active call on the JioFiber landline. |

---

## Architecture Flow

```
[Incoming Call on JioFiber Landline]
                 │
                 ▼
[JioFiber Router 192.168.31.1]
                 │ SIP-TLS
                 ▼
[Home Gateway (localhost:8088)]
                 │
                 ├── 1. WebSocket Event ──────► Windows Desktop App (Pops up Call UI)
                 │
                 └── 2. Alexa Skill Event ────► Amazon Echo Dot ("Incoming call from Mom...")
```

---

## How to Deploy the Local Alexa Skill:

### Option A: Via Home Assistant (Easiest, 100% Local)
If you run Home Assistant on your PC or local network:
1. Enable the **Alexa Media Player** integration in Home Assistant.
2. In `gateway/src/index.ts`, when `POST /api/call/incoming` triggers, the gateway notifies Home Assistant via REST webhook:
   ```json
   POST http://homeassistant.local:8123/api/webhook/jiofiber_call
   { "caller": "Mom", "number": "+919845131764" }
   ```
3. Home Assistant uses TTS on all Echo Dots in the house:
   > *"Incoming call from Mom on Landline."*
4. Saying *"Alexa, answer"* routes audio through the Echo Dot speaker.

### Option B: Via Custom Alexa Skill (AWS Lambda / Cloudflare Tunnel)
1. Use `cloudflared` or `ngrok` to expose your local gateway port 8088:
   ```bash
   ngrok http 8088
   ```
2. In the [Amazon Developer Console](https://developer.amazon.com/alexa/console/ask):
   - Create a skill named **"Jio Landline"**
   - Set the HTTPS Endpoint to: `https://<your-ngrok-url>/api/alexa`
   - Import the intents from `skill-model.json`.
