import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import path from "path";
import { JioSipClient } from "./sipClient";

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
  private landlineNumber = "+91 81327 96216";
  private sipClient: JioSipClient;

  constructor() {
    this.app.use(cors());
    this.app.use(express.json());

    // Serve web dialer UI
    const clientPath = path.resolve(__dirname, "../../client");
    this.app.use(express.static(clientPath));

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // Initialize standalone Jio SIP Client
    this.sipClient = new JioSipClient();
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
      console.log(`[Gateway] Call ended`);
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
    });
  }

  private setupRoutes() {
    // Health and status
    this.app.get("/api/status", (req, res) => {
      res.json({
        service: "JioFiber Voice Standalone Gateway",
        status: "online",
        sipRegistered: this.sipClient.isRegistered(),
        landline: this.landlineNumber,
        activeCall: this.activeCall,
        connectedDevices: this.connectedClients.size,
      });
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
    this.app.post("/api/alexa", (req, res) => {
      const requestType = req.body?.request?.type;
      const intentName = req.body?.request?.intent?.name;

      console.log(`[Alexa] Request: ${requestType}, Intent: ${intentName}`);

      if (requestType === "LaunchRequest") {
        return res.json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: this.activeCall
                ? `You have an incoming landline call from ${this.activeCall.caller}. Say answer to pick up.`
                : `JioFiber Voice is online and registered directly on your router. Your number is ${this.landlineNumber}. Who would you like to call?`,
            },
            shouldEndSession: !this.activeCall,
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
          activeCall: this.activeCall,
        })
      );

      ws.on("message", async (data: string) => {
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
