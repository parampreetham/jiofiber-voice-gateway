import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import path from "path";
import { JioSipClient } from "./sipClient";
import { loadConfig, saveConfig, isConfigured, detectDefaultGateway, JioConfig, JIO_CIRCLES } from "./config";
import { JioProvisioningService, ProvisioningSession } from "./provisioning";

export type CallState =
  | "idle"
  | "registering"
  | "registered"
  | "ringing"
  | "connecting"
  | "active"
  | "ending"
  | "failed";

export interface ActiveCall {
  callId: string;
  caller: string;
  direction: "incoming" | "outgoing";
  state: CallState;
  startTime: number;
}

class JioVoiceGateway {
  private app = express();
  private server: http.Server;
  private wss: WebSocketServer;
  private connectedClients = new Set<WebSocket>();

  private activeCall: ActiveCall | null = null;
  private currentConfig: JioConfig | null = null;
  private landlineNumber = "Not Configured";
  private sipClient: JioSipClient;
  private provisioningService = new JioProvisioningService();
  private pendingOtpSession: ProvisioningSession | null = null;

  constructor() {
    this.app.use(cors());
    this.app.use(express.json());

    // Serve web dialer UI
    const clientPath = path.resolve(__dirname, "../../client");
    this.app.use(express.static(clientPath));

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // Load configuration dynamically from config.json or environment
    this.currentConfig = loadConfig();
    if (this.currentConfig) {
      this.landlineNumber = this.currentConfig.username;
    }

    // Initialize standalone Jio SIP Client
    this.sipClient = new JioSipClient(this.currentConfig || undefined);
    this.setupSipEvents();

    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupSipEvents() {
    this.sipClient.on("registered", (isReg: boolean) => {
      console.log(`[Gateway] SIP Registration status: ${isReg ? "REGISTERED" : "UNREGISTERED"}`);
      this.broadcast({
        type: "sip_status",
        registered: isReg,
      });
    });

    this.sipClient.on("incoming_call", ({ caller, callId }) => {
      console.log(`[Gateway] 📞 Incoming call detected from ${caller}`);
      this.activeCall = {
        callId,
        caller,
        direction: "incoming",
        state: "ringing",
        startTime: Date.now(),
      };
      this.broadcast({
        type: "incoming_call",
        call: this.activeCall,
      });
    });

    this.sipClient.on("call_ringing", (session) => {
      console.log(`[Gateway] Call ringing to ${session.targetNumber}`);
      if (this.activeCall) {
        this.activeCall.state = "ringing";
        this.broadcast({
          type: "call_state",
          call: this.activeCall,
        });
      }
    });

    this.sipClient.on("call_connected", (session) => {
      console.log(`[Gateway] Call answered/active with ${session.targetNumber}`);
      if (this.activeCall) {
        this.activeCall.state = "active";
        this.broadcast({
          type: "call_state",
          call: this.activeCall,
        });
      }
    });

    this.sipClient.on("call_ended", () => {
      console.log(`[Gateway] Call ended event received from SIP client`);
      if (this.activeCall) {
        this.activeCall.state = "ending";
        this.broadcast({
          type: "call_state",
          call: this.activeCall,
        });
        setTimeout(() => {
          this.activeCall = null;
          this.broadcast({ type: "call_ended" });
        }, 100);
      } else {
        this.broadcast({ type: "call_ended" });
      }
    });

    // Forward incoming RTP audio from Jio IMS to connected softphone clients
    this.sipClient.on(
      "audio",
      ({ payload, payloadType }: { payload: Buffer; payloadType?: number }) => {
        // Prepend 1-byte payloadType header (8 = PCMA, 0 = PCMU) so client knows exact codec
        const packet = Buffer.alloc(1 + payload.length);
        packet[0] = payloadType ?? 8;
        payload.copy(packet, 1);
        for (const client of this.connectedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(packet);
          }
        }
      }
    );

    this.sipClient.on("codec_negotiated", ({ codec, payloadType }) => {
      console.log(`[Gateway] Broadcasting audio codec: ${codec} (PT ${payloadType})`);
      this.broadcast({
        type: "audio_codec",
        codec,
        payloadType,
      });
    });
  }

  private setupRoutes() {
    // Health and status
    this.app.get("/api/status", (req, res) => {
      res.json({
        service: "JioFiber Voice Standalone Gateway",
        status: "online",
        sipRegistered: this.sipClient.isRegistered(),
        configured: isConfigured(this.currentConfig),
        landline: this.landlineNumber,
        activeCall: this.activeCall,
        connectedDevices: this.connectedClients.size,
      });
    });

    // Get current config / circles info & detected router IP
    this.app.get("/api/config", (req, res) => {
      const detectedIp = detectDefaultGateway();
      res.json({
        configured: isConfigured(this.currentConfig),
        landline: this.currentConfig?.username || "",
        host: this.currentConfig?.host || detectedIp,
        detectedRouterIp: detectedIp,
        port: this.currentConfig?.port || 5068,
        realm: this.currentConfig?.realm || "ka.wln.ims.jio.com",
        circles: JIO_CIRCLES,
      });
    });

    // Save manual config
    this.app.post("/api/config", (req, res) => {
      const { host, port, username, password, realm, uuid } = req.body;
      if (!username || !password || !realm) {
        return res.status(400).json({ error: "username, password, and realm are required." });
      }

      const newConfig: JioConfig = {
        host: host || "192.168.29.1",
        port: parseInt(port || 5068, 10),
        username: username.trim(),
        password: password.trim(),
        realm: realm.trim(),
        publicId: username.trim(),
        uuid: uuid || "00000000-0000-1000-8000-000085EA2C9F",
      };

      saveConfig(newConfig);
      this.currentConfig = newConfig;
      this.landlineNumber = newConfig.username;
      this.sipClient.updateConfig(newConfig);

      this.broadcast({
        type: "config_updated",
        configured: true,
        landline: this.landlineNumber,
      });

      res.json({ success: true, message: "Configuration saved successfully." });
    });

    // Request OTP from Jio router for automatic setup
    this.app.post("/api/provision/otp/request", async (req, res) => {
      const { routerIp, macAddress } = req.body;
      const targetHost = routerIp || this.currentConfig?.host || "192.168.31.1";
      console.log(`[Provisioning] Requesting pairing/provisioning from router at ${targetHost}...`);

      const result = await this.provisioningService.requestOtp(targetHost, macAddress);
      if (result.success) {
        if (result.autoConfigured && result.config) {
          saveConfig(result.config);
          this.currentConfig = result.config;
          this.landlineNumber = result.config.username;
          this.sipClient.updateConfig(result.config);

          this.broadcast({
            type: "config_updated",
            configured: true,
            landline: this.landlineNumber,
          });

          res.json({
            success: true,
            autoConfigured: true,
            config: result.config,
            message: result.message,
          });
          return;
        }

        this.pendingOtpSession = result.session || null;
        res.json({
          success: true,
          autoConfigured: false,
          message: result.message,
        });
      } else {
        res.status(400).json({ success: false, error: result.message });
      }
    });

    // Verify OTP and auto-configure
    this.app.post("/api/provision/otp/verify", async (req, res) => {
      const { otp } = req.body;
      if (!otp) {
        return res.status(400).json({ error: "OTP is required." });
      }
      if (!this.pendingOtpSession) {
        return res.status(400).json({ error: "No active OTP request session. Please request OTP first." });
      }

      console.log(`[Provisioning] Verifying OTP with router...`);
      const result = await this.provisioningService.verifyOtp(this.pendingOtpSession, otp);
      if (result.success && result.config) {
        saveConfig(result.config);
        this.currentConfig = result.config;
        this.landlineNumber = result.config.username;
        this.sipClient.updateConfig(result.config);

        this.broadcast({
          type: "config_updated",
          configured: true,
          landline: this.landlineNumber,
        });

        this.pendingOtpSession = null;
        res.json({
          success: true,
          message: "Router paired successfully! Softphone is ready.",
          config: {
            landline: result.config.username,
            realm: result.config.realm,
            host: result.config.host,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error || "Failed verifying OTP with router." });
      }
    });

    // Make outgoing call from Desktop UI or Alexa directly via Jio SIP-TLS
    this.app.post("/api/call/dial", async (req, res) => {
      const { destination } = req.body;
      if (!destination) {
        return res.status(400).json({ error: "Destination number required" });
      }

      console.log(`[Gateway] Initiating standalone SIP call directly from PC to ${destination}`);
      try {
        const session = this.sipClient.dial(destination);
        this.activeCall = {
          callId: session.callId,
          caller: destination,
          direction: "outgoing",
          state: "connecting",
          startTime: Date.now(),
        };

        this.broadcast({
          type: "call_state",
          call: this.activeCall,
        });

        res.json({ success: true, callId: session.callId });
      } catch (err: any) {
        console.error(`[Gateway] Failed to place SIP call:`, err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // Answer call
    this.app.post("/api/call/answer", async (req, res) => {
      console.log(`[Gateway] Answering call via standalone SIP client`);
      this.sipClient.answer();
      if (this.activeCall) {
        this.activeCall.state = "active";
        this.broadcast({
          type: "call_state",
          call: this.activeCall,
        });
      }
      res.json({ success: true });
    });

    // Hangup / Reject call
    this.app.post("/api/call/hangup", async (req, res) => {
      console.log(`[Gateway] Hanging up call via standalone SIP client`);
      this.sipClient.hangup();
      if (this.activeCall) {
        this.activeCall.state = "ending";
        this.broadcast({
          type: "call_state",
          call: this.activeCall,
        });
        setTimeout(() => {
          this.activeCall = null;
          this.broadcast({ type: "call_ended" });
        }, 300);
      }
      res.json({ success: true });
    });

    // Alexa Skill webhook for Amazon Echo Dot
    const handleAlexaRequest = (req: express.Request, res: express.Response) => {
      const requestType = req.body?.request?.type;
      const intentName = req.body?.request?.intent?.name;

      console.log(`[Alexa] Incoming request: ${requestType}, Intent: ${intentName}`);

      if (requestType === "LaunchRequest") {
        return res.json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: this.activeCall
                ? `You have an incoming landline call from ${this.activeCall.caller}. Say answer to pick up.`
                : `JioFiber Voice is online. Who would you like to call?`,
            },
            reprompt: {
              outputSpeech: {
                type: "PlainText",
                text: "Say call followed by the phone number you would like to dial.",
              },
            },
            shouldEndSession: false,
          },
        });
      }

      if (intentName === "DialIntent") {
        const destSlot = req.body?.request?.intent?.slots?.PhoneNumber?.value;
        if (destSlot) {
          this.sipClient.dial(destSlot);
          return res.json({
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: `Calling ${destSlot} from your JioFiber landline now.`,
              },
              shouldEndSession: false,
            },
          });
        }
      }

      if (intentName === "AnswerIntent") {
        if (this.activeCall) {
          this.sipClient.answer();
          return res.json({
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: "Call connected. You are on speaker.",
              },
              shouldEndSession: false,
            },
          });
        }
      }

      if (intentName === "HangupIntent") {
        this.sipClient.hangup();
        return res.json({
          version: "1.0",
          response: {
            outputSpeech: { type: "PlainText", text: "Call disconnected." },
            shouldEndSession: true,
          },
        });
      }

      if (intentName === "AMAZON.StopIntent" || intentName === "AMAZON.CancelIntent") {
        return res.json({
          version: "1.0",
          response: {
            outputSpeech: { type: "PlainText", text: "Goodbye." },
            shouldEndSession: true,
          },
        });
      }

      if (intentName === "AMAZON.HelpIntent") {
        return res.json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "You can say call followed by a number to make a call, answer to pick up, or hang up to disconnect. What would you like to do?",
            },
            reprompt: {
              outputSpeech: { type: "PlainText", text: "Who would you like to call?" },
            },
            shouldEndSession: false,
          },
        });
      }

      if (requestType === "SessionEndedRequest") {
        return res.json({
          version: "1.0",
          response: {},
        });
      }

      res.json({
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "JioFiber Voice standalone extension is ready.",
          },
          shouldEndSession: true,
        },
      });
    };

    this.app.post("/api/alexa", handleAlexaRequest);
    this.app.post("/", (req, res, next) => {
      if (req.body?.request?.type || req.body?.session?.application) {
        return handleAlexaRequest(req, res);
      }
      next();
    });
  }

  private setupWebSocket() {
    this.wss.on("connection", (ws: WebSocket) => {
      this.connectedClients.add(ws);
      console.log(
        `[Gateway] Client connected. Total devices: ${this.connectedClients.size}`
      );

      // Send initial status
      ws.send(
        JSON.stringify({
          type: "init",
          landline: this.landlineNumber,
          sipRegistered: this.sipClient.isRegistered(),
          configured: isConfigured(this.currentConfig),
          activeCall: this.activeCall,
        })
      );

      ws.on("message", async (data: any, isBinary: boolean) => {
        // If binary, it's microphone audio from browser softphone -> forward to Jio RTP
        if (isBinary || (Buffer.isBuffer(data) && !data.toString().startsWith("{"))) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const audioPayload = buf.length === 161 ? buf.subarray(1) : buf;
          this.sipClient.sendAudio(audioPayload);
          return;
        }

        try {
          const msg = JSON.parse(data.toString());
          console.log("[Gateway] Received WebSocket message:", msg.type);

          if (msg.type === "dial") {
            this.sipClient.dial(msg.destination);
          } else if (msg.type === "answer") {
            this.sipClient.answer();
          } else if (msg.type === "hangup") {
            this.sipClient.hangup();
          }
        } catch (e) {
          console.error("[Gateway] Error parsing message:", e);
        }
      });

      ws.on("close", () => {
        this.connectedClients.delete(ws);
        console.log(
          `[Gateway] Client disconnected. Total devices: ${this.connectedClients.size}`
        );
      });
    });
  }

  private broadcast(data: any) {
    const payload = JSON.stringify(data);
    for (const client of this.connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  public start(port = 8088) {
    this.sipClient.connect();

    this.server.listen(port, () => {
      console.log(`====================================================`);
      console.log(`🚀 JioFiber Standalone Home Gateway running on http://localhost:${port}`);
      console.log(`📞 Landline: ${this.landlineNumber}`);
      console.log(`🌐 Router Extension: Registered directly over SIP-TLS`);
      console.log(`🔊 Alexa Endpoint: http://localhost:${port}/api/alexa`);
      console.log(`💻 Web Softphone UI: http://localhost:${port}`);
      console.log(`====================================================`);
    });
  }
}

const gateway = new JioVoiceGateway();
gateway.start();
