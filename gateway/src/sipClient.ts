import tls from "tls";
import crypto from "crypto";
import EventEmitter from "events";
import dgram from "dgram";

export interface SipCallSession {
  callId: string;
  targetNumber: string;
  targetUri: string;
  fromTag: string;
  toTag?: string;
  branch: string;
  cseq: number;
  direction: "incoming" | "outgoing";
  state: "trying" | "ringing" | "active" | "terminating" | "ended";
  localRtpPort: number;
  remoteRtpIp?: string;
  remoteRtpPort?: number;
}

export class JioSipClient extends EventEmitter {
  private host: string;
  private port: number;
  private username: string;
  private password: string;
  private realm: string;
  private publicId: string;
  private uuid: string;

  private socket: tls.TLSSocket | null = null;
  private registered = false;
  private regCallId = "";
  private regCSeq = 1;
  private regFromTag = "";
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private activeSession: SipCallSession | null = null;
  private rxBuffer = "";
  private rtpSocket: dgram.Socket | null = null;
  private rtpPort = 20000;

  constructor(config?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    realm?: string;
    publicId?: string;
    uuid?: string;
  }) {
    super();
    this.host = config?.host || "2409:40f2:151:33e3:7ebf:77ff:fe04:495d";
    this.port = config?.port || 5068;
    this.username = config?.username || "918132796216@ka.wln.ims.jio.com";
    this.password = config?.password || "05858f6d35";
    this.realm = config?.realm || "ka.wln.ims.jio.com";
    this.publicId = config?.publicId || "+918132796216";
    this.uuid = config?.uuid || "00000000-0000-1000-8000-000085EA2C9F";

    this.initRtp();
  }

  private initRtp() {
    try {
      this.rtpSocket = dgram.createSocket("udp4");
      this.rtpSocket.bind(this.rtpPort, () => {
        console.log(`[SIP] RTP audio socket bound to UDP port ${this.rtpPort}`);
      });
      this.rtpSocket.on("error", (err) => {
        console.error("[SIP] RTP socket error:", err);
      });
    } catch (e) {
      console.warn("[SIP] Failed to bind local RTP socket:", e);
    }
  }

  private formatIp(ip?: string): string {
    if (!ip) return "127.0.0.1";
    return ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
  }

  public connect() {
    console.log(`[SIP] Connecting to JioFiber router SIP-TLS at [${this.host}]:${this.port}...`);
    try {
      this.socket = tls.connect(
        {
          host: this.host,
          port: this.port,
          rejectUnauthorized: false,
        },
        () => {
          console.log(`[SIP] TLS connection established with Jio router at [${this.host}]:${this.port}`);
          this.startRegistration();
        }
      );

      this.socket.on("data", (data) => {
        this.handleIncomingData(data.toString("utf8"));
      });

      this.socket.on("close", () => {
        console.log(`[SIP] TLS socket closed. Reconnecting in 5 seconds...`);
        this.registered = false;
        this.emit("registered", false);
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        setTimeout(() => this.connect(), 5000);
      });

      this.socket.on("error", (err) => {
        console.error(`[SIP] TLS socket error on ${this.host}:`, err.message);
        // Switch between IPv6 and IPv4 on connection error
        if (this.host.includes(":")) {
          console.log(`[SIP] Switching host fallback to IPv4 192.168.31.1`);
          this.host = "192.168.31.1";
        } else {
          this.host = "2409:40f2:151:33e3:7ebf:77ff:fe04:495d";
        }
      });
    } catch (e: any) {
      console.error(`[SIP] Exception initiating TLS connection:`, e.message);
    }
  }

  public isRegistered(): boolean {
    return this.registered;
  }

  public getActiveSession(): SipCallSession | null {
    return this.activeSession;
  }

  private startRegistration() {
    if (!this.socket) return;
    const localIp = this.socket.localAddress;
    const localPort = this.socket.localPort;

    this.regCallId = crypto.randomBytes(16).toString("hex") + "@jiofiber.local.html";
    this.regFromTag = crypto.randomBytes(4).toString("hex");
    this.regCSeq = 1;

    const branch = "z9hG4bK" + crypto.randomBytes(8).toString("hex");
    const fmtIp = this.formatIp(localIp);
    const registerReq = [
      `REGISTER sip:${this.realm} SIP/2.0`,
      `Via: SIP/2.0/TLS ${fmtIp}:${localPort};branch=${branch};rport`,
      `From: <sip:${this.publicId}@${this.realm}>;tag=${this.regFromTag}`,
      `To: <sip:${this.publicId}@${this.realm}>`,
      `Call-ID: ${this.regCallId}`,
      `CSeq: ${this.regCSeq} REGISTER`,
      `Contact: <sip:${this.publicId}@${fmtIp}:${localPort};transport=tls>;+sip.instance="<${this.uuid}>";reg-id=1;expires=3600`,
      `Max-Forwards: 70`,
      `User-Agent: JSEAndrd-1.0`,
      `X-Client: JSE`,
      `Supported: path, gruu, outbound`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n");

    console.log(`[SIP] Sending initial REGISTER...`);
    this.socket.write(registerReq);
  }

  private handleRegistrationChallenge(resp: string) {
    if (!this.socket) return;
    const localIp = this.socket.localAddress;
    const localPort = this.socket.localPort;

    const nonceMatch = resp.match(/nonce="([^"]+)"/);
    if (!nonceMatch) {
      console.error("[SIP] Failed to extract nonce from 401 response!");
      return;
    }
    const nonce = nonceMatch[1];
    const uri = `sip:${this.realm}`;

    const ha1 = crypto
      .createHash("md5")
      .update(`${this.username}:${this.realm}:${this.password}`)
      .digest("hex");
    const ha2 = crypto.createHash("md5").update(`REGISTER:${uri}`).digest("hex");
    const response = crypto
      .createHash("md5")
      .update(`${ha1}:${nonce}:${ha2}`)
      .digest("hex");

    this.regCSeq++;
    const branch = "z9hG4bK" + crypto.randomBytes(8).toString("hex");
    const authHeader = `Digest username="${this.username}",realm="${this.realm}",nonce="${nonce}",uri="${uri}",response="${response}",algorithm=MD5`;

    const fmtIp = this.formatIp(localIp);
    const registerReq2 = [
      `REGISTER sip:${this.realm} SIP/2.0`,
      `Via: SIP/2.0/TLS ${fmtIp}:${localPort};branch=${branch};rport`,
      `From: <sip:${this.publicId}@${this.realm}>;tag=${this.regFromTag}`,
      `To: <sip:${this.publicId}@${this.realm}>`,
      `Call-ID: ${this.regCallId}`,
      `CSeq: ${this.regCSeq} REGISTER`,
      `Contact: <sip:${this.publicId}@${fmtIp}:${localPort};transport=tls>;+sip.instance="<${this.uuid}>";reg-id=1;expires=3600`,
      `Authorization: ${authHeader}`,
      `Max-Forwards: 70`,
      `User-Agent: JSEAndrd-1.0`,
      `X-Client: JSE`,
      `Supported: path, gruu, outbound`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n");

    console.log(`[SIP] Sending Authenticated REGISTER (CSeq: ${this.regCSeq})...`);
    this.socket.write(registerReq2);
  }

  private handleIncomingData(data: string) {
    this.rxBuffer += data;

    // Process complete SIP messages separated by double CRLF or content length
    while (this.rxBuffer.length > 0) {
      const headerEnd = this.rxBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerText = this.rxBuffer.substring(0, headerEnd);
      const clMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
      const totalMessageLength = headerEnd + 4 + contentLength;

      if (this.rxBuffer.length < totalMessageLength) {
        break; // Wait for full body
      }

      const fullMessage = this.rxBuffer.substring(0, totalMessageLength);
      this.rxBuffer = this.rxBuffer.substring(totalMessageLength);

      this.processSipMessage(fullMessage);
    }
  }

  private processSipMessage(msg: string) {
    const lines = msg.split("\r\n");
    const startLine = lines[0] || "";

    // 1. Check Registration responses
    if (msg.includes("CSeq:") && msg.includes("REGISTER")) {
      if (startLine.includes("401 Unauthorized")) {
        console.log(`[SIP] Received 401 challenge for REGISTER.`);
        this.handleRegistrationChallenge(msg);
      } else if (startLine.includes("200 OK")) {
        console.log(`[SIP] ✅ 200 OK received! Standalone extension REGISTERED on Jio router.`);
        this.registered = true;
        this.emit("registered", true);

        // Keep-alive re-registration every 30 minutes
        if (!this.keepAliveTimer) {
          this.keepAliveTimer = setInterval(() => {
            console.log(`[SIP] Performing periodic keepalive re-registration...`);
            this.startRegistration();
          }, 1800 * 1000);
        }
      }
      return;
    }

    // 2. Incoming INVITE (Incoming Landline Call)
    if (startLine.startsWith("INVITE")) {
      console.log(`[SIP] 📞 INCOMING CALL INVITE RECEIVED!`);
      this.handleIncomingInvite(msg);
      return;
    }

    // 3. Outgoing Call Responses (INVITE responses)
    if (msg.includes("CSeq:") && msg.includes("INVITE")) {
      this.handleInviteResponse(startLine, msg);
      return;
    }

    // 4. Inbound BYE (Remote hung up)
    if (startLine.startsWith("BYE")) {
      console.log(`[SIP] BYE received from remote.`);
      this.sendResponse("200 OK", msg);
      if (this.activeSession) {
        this.activeSession.state = "ended";
        this.emit("call_ended", this.activeSession);
        this.activeSession = null;
      }
      return;
    }

    // 5. Inbound CANCEL
    if (startLine.startsWith("CANCEL")) {
      console.log(`[SIP] CANCEL received from remote.`);
      this.sendResponse("200 OK", msg);
      if (this.activeSession) {
        this.activeSession.state = "ended";
        this.emit("call_ended", this.activeSession);
        this.activeSession = null;
      }
      return;
    }

    // 6. Inbound ACK
    if (startLine.startsWith("ACK")) {
      if (this.activeSession && this.activeSession.state === "ringing") {
        this.activeSession.state = "active";
        this.emit("call_connected", this.activeSession);
      }
      return;
    }
  }

  private handleInviteResponse(startLine: string, msg: string) {
    if (!this.activeSession) return;

    // 100 Trying
    if (startLine.includes("100 Trying")) {
      console.log(`[SIP] Remote router returned 100 Trying.`);
    }

    // 180 Ringing or 183 Session Progress
    else if (startLine.includes("180 Ringing") || startLine.includes("183 Session Progress")) {
      console.log(`[SIP] 🔔 Remote party is RINGING (${startLine})!`);
      this.activeSession.state = "ringing";
      
      const tagMatch = msg.match(/To:.*tag=([a-zA-Z0-9_\-]+)/i);
      if (tagMatch) this.activeSession.toTag = tagMatch[1];

      // Parse remote SDP if early media present
      this.parseRemoteSdp(msg);

      this.emit("call_ringing", this.activeSession);
    }

    // 200 OK (Call Answered)
    else if (startLine.includes("200 OK")) {
      console.log(`[SIP] 🎉 Call ANSWERED by remote party!`);
      this.activeSession.state = "active";

      const tagMatch = msg.match(/To:.*tag=([a-zA-Z0-9_\-]+)/i);
      if (tagMatch) this.activeSession.toTag = tagMatch[1];

      this.parseRemoteSdp(msg);

      // Send ACK
      this.sendAck();

      this.emit("call_connected", this.activeSession);
    }

    // 407 / 401 Auth Challenge for Outgoing Call
    else if (startLine.includes("407 Proxy Authentication Required") || startLine.includes("401 Unauthorized")) {
      console.log(`[SIP] INVITE challenge received. Calculating response...`);
      const is407 = startLine.includes("407");
      const authHeaderName = is407 ? "Proxy-Authenticate" : "WWW-Authenticate";
      const nonceMatch =
        msg.match(new RegExp(`${authHeaderName}:.*nonce="([^"]+)"`, "i")) ||
        msg.match(/nonce="([^"]+)"/i);

      if (nonceMatch) {
        const nonce = nonceMatch[1];
        const uri = this.activeSession.targetUri;
        const ha1 = crypto
          .createHash("md5")
          .update(`${this.username}:${this.realm}:${this.password}`)
          .digest("hex");
        const ha2 = crypto.createHash("md5").update(`INVITE:${uri}`).digest("hex");
        const response = crypto
          .createHash("md5")
          .update(`${ha1}:${nonce}:${ha2}`)
          .digest("hex");

        const authHeader = `Digest username="${this.username}",realm="${this.realm}",nonce="${nonce}",uri="${uri}",response="${response}",algorithm=MD5`;

        // Send ACK for the 407 first
        this.sendAck(true);

        // Re-send INVITE with Proxy-Authorization
        this.activeSession.cseq++;
        this.sendInviteRequest(authHeader);
      }
    }

    // Call Rejected / Busy / Failed
    else if (
      startLine.includes("486 Busy Here") ||
      startLine.includes("603 Decline") ||
      startLine.includes("404 Not Found") ||
      startLine.includes("487 Request Terminated")
    ) {
      console.log(`[SIP] Call ended/rejected: ${startLine}`);
      this.sendAck();
      this.activeSession.state = "ended";
      this.emit("call_ended", this.activeSession);
      this.activeSession = null;
    }
  }

  private parseRemoteSdp(msg: string) {
    if (!this.activeSession) return;
    const sdpIndex = msg.indexOf("\r\n\r\n");
    if (sdpIndex === -1) return;
    const sdp = msg.substring(sdpIndex + 4);

    const cMatch = sdp.match(/c=IN IP6 ([^\s\r\n]+)/i) || sdp.match(/c=IN IP4 ([^\s\r\n]+)/i);
    const mMatch = sdp.match(/m=audio (\d+) RTP/i);

    if (cMatch) this.activeSession.remoteRtpIp = cMatch[1];
    if (mMatch) this.activeSession.remoteRtpPort = parseInt(mMatch[1], 10);

    if (this.activeSession.remoteRtpIp && this.activeSession.remoteRtpPort) {
      console.log(
        `[SIP] Remote RTP endpoint established: [${this.activeSession.remoteRtpIp}]:${this.activeSession.remoteRtpPort}`
      );
    }
  }

  private handleIncomingInvite(msg: string) {
    if (!this.socket) return;
    const localIp = this.socket.localAddress;
    const localPort = this.socket.localPort;

    // Extract Caller
    const callerMatch =
      msg.match(/P-Asserted-Identity:.*<sip:([^@>]+)@/i) ||
      msg.match(/From:.*<sip:([^@>]+)@/i) ||
      msg.match(/P-Com\.Siemens\.Calling-Party-ID:.*<sip:([^@>]+)@/i);
    const caller = callerMatch ? callerMatch[1] : "Unknown";

    const callIdMatch = msg.match(/Call-ID:\s*([^\r\n]+)/i);
    const callId = callIdMatch ? callIdMatch[1] : crypto.randomBytes(16).toString("hex");

    const fromTagMatch = msg.match(/From:.*tag=([a-zA-Z0-9_\-]+)/i);
    const fromTag = fromTagMatch ? fromTagMatch[1] : "";

    const cseqMatch = msg.match(/CSeq:\s*(\d+)/i);
    const cseq = cseqMatch ? parseInt(cseqMatch[1], 10) : 1;

    this.activeSession = {
      callId,
      targetNumber: caller,
      targetUri: `sip:${this.publicId}@${this.realm}`,
      fromTag,
      toTag: crypto.randomBytes(4).toString("hex"),
      branch: "z9hG4bK" + crypto.randomBytes(8).toString("hex"),
      cseq,
      direction: "incoming",
      state: "ringing",
      localRtpPort: this.rtpPort,
    };

    this.parseRemoteSdp(msg);

    // Send 180 Ringing back to router
    const resp180 = [
      `SIP/2.0 180 Ringing`,
      msg.match(/Via:[^\r\n]+/i)?.[0] || "",
      `From: ${msg.match(/From:[^\r\n]+/i)?.[0]?.replace(/^From:\s*/i, "")}`,
      `To: <sip:${this.publicId}@${this.realm}>;tag=${this.activeSession.toTag}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} INVITE`,
      `Contact: <sip:${this.publicId}@${this.formatIp(localIp)}:${localPort};transport=tls>;+sip.instance="<${this.uuid}>"`,
      `User-Agent: JSEAndrd-1.0`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n");

    this.socket.write(resp180);
    console.log(`[SIP] Sent 180 Ringing for incoming call from ${caller}`);

    this.emit("incoming_call", {
      caller,
      callId,
      session: this.activeSession,
    });
  }

  public dial(destination: string): SipCallSession {
    if (!this.socket) {
      throw new Error("SIP client is not connected to router.");
    }
    const localIp = this.socket.localAddress;

    // Clean destination format
    let cleanDest = destination.trim().replace(/[\s\-\(\)]/g, "");
    if (!cleanDest.startsWith("+")) {
      if (cleanDest.length === 10) cleanDest = "+91" + cleanDest;
      else if (cleanDest.startsWith("0")) cleanDest = "+91" + cleanDest.substring(1);
      else cleanDest = "+91" + cleanDest;
    }

    const callId = crypto.randomBytes(16).toString("hex") + "@jiofiber.local.html";
    const fromTag = crypto.randomBytes(4).toString("hex");
    const branch = "z9hG4bK" + crypto.randomBytes(8).toString("hex");
    const targetUri = `sip:${cleanDest}@${this.realm};user=phone`;

    this.activeSession = {
      callId,
      targetNumber: cleanDest,
      targetUri,
      fromTag,
      branch,
      cseq: 1,
      direction: "outgoing",
      state: "trying",
      localRtpPort: this.rtpPort,
    };

    console.log(`[SIP] Dialing ${cleanDest} directly via Jio SIP-TLS...`);
    this.sendInviteRequest();
    return this.activeSession;
  }

  private sendInviteRequest(authHeader?: string) {
    if (!this.socket || !this.activeSession) return;
    const localIp = this.socket.localAddress;
    const localPort = this.socket.localPort;

    const fmtIp = this.formatIp(localIp);
    const ipProto = localIp?.includes(":") ? "IP6" : "IP4";

    const sdpLines = [
      "v=0",
      `o=- ${Date.now()} 1 IN ${ipProto} ${localIp}`,
      "s=-",
      `c=IN ${ipProto} ${localIp}`,
      "t=0 0",
      `m=audio ${this.rtpPort} RTP/AVP 104 102 9 0 8 101`,
      "a=rtpmap:104 AMR-WB/16000/1",
      "a=fmtp:104 mode-change-capability=2;max-red=0",
      "a=rtpmap:102 AMR/8000/1",
      "a=fmtp:102 mode-change-capability=2;max-red=0",
      "a=rtpmap:9 G722/8000",
      "a=rtpmap:0 PCMU/8000",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:101 telephone-event/8000",
      "a=fmtp:101 0-15",
      "a=ptime:20",
      "a=maxptime:40",
      "a=sendrecv",
    ];
    const sdp = sdpLines.join("\r\n") + "\r\n";

    const branch = "z9hG4bK" + crypto.randomBytes(8).toString("hex");
    const headers = [
      `INVITE ${this.activeSession.targetUri} SIP/2.0`,
      `Via: SIP/2.0/TLS ${fmtIp}:${localPort};branch=${branch};rport`,
      `From: <sip:${this.publicId}@${this.realm}>;tag=${this.activeSession.fromTag}`,
      `To: <${this.activeSession.targetUri}>`,
      `Call-ID: ${this.activeSession.callId}`,
      `CSeq: ${this.activeSession.cseq} INVITE`,
      `Contact: <sip:${this.publicId}@${fmtIp}:${localPort};transport=tls>;+sip.instance="<${this.uuid}>"`,
      `Max-Forwards: 70`,
      `User-Agent: JSEAndrd-1.0`,
      `Allow: INVITE, ACK, CANCEL, BYE, NOTIFY, REFER, OPTIONS, INFO, PRACK, UPDATE`,
      `Supported: 100rel, timer`,
      `P-Preferred-Identity: <sip:${this.publicId}@${this.realm}>`,
      `Content-Type: application/sdp`,
      `Content-Length: ${Buffer.byteLength(sdp, "utf8")}`,
    ];

    if (authHeader) {
      headers.splice(7, 0, `Proxy-Authorization: ${authHeader}`);
    }

    const inviteMsg = headers.join("\r\n") + "\r\n\r\n" + sdp;
    this.socket.write(inviteMsg);
  }

  private sendAck(isForChallenge = false) {
    if (!this.socket || !this.activeSession) return;
    const localIp = this.socket.localAddress;
    const localPort = this.socket.localPort;
    const fmtIp = this.formatIp(localIp);

    const branch = "z9hG4bK" + crypto.randomBytes(8).toString("hex");
    const toTagPart = this.activeSession.toTag ? `;tag=${this.activeSession.toTag}` : "";

    const ack = [
      `ACK ${this.activeSession.targetUri} SIP/2.0`,
      `Via: SIP/2.0/TLS ${fmtIp}:${localPort};branch=${branch};rport`,
      `From: <sip:${this.publicId}@${this.realm}>;tag=${this.activeSession.fromTag}`,
      `To: <${this.activeSession.targetUri}>${toTagPart}`,
      `Call-ID: ${this.activeSession.callId}`,
      `CSeq: ${this.activeSession.cseq} ACK`,
      `Max-Forwards: 70`,
      `User-Agent: JSEAndrd-1.0`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n");

    this.socket.write(ack);
  }

  public answer() {
    if (!this.socket || !this.activeSession || this.activeSession.direction !== "incoming") {
      console.warn("[SIP] No active incoming call to answer.");
      return;
    }
    const localIp = this.socket.localAddress;
    const localPort = this.socket.localPort;
    const fmtIp = this.formatIp(localIp);
    const ipProto = localIp?.includes(":") ? "IP6" : "IP4";

    const sdpLines = [
      "v=0",
      `o=- ${Date.now()} 1 IN ${ipProto} ${localIp}`,
      "s=-",
      `c=IN ${ipProto} ${localIp}`,
      "t=0 0",
      `m=audio ${this.rtpPort} RTP/AVP 104 102 9 0 8 101`,
      "a=rtpmap:104 AMR-WB/16000/1",
      "a=fmtp:104 mode-change-capability=2;max-red=0",
      "a=rtpmap:102 AMR/8000/1",
      "a=fmtp:102 mode-change-capability=2;max-red=0",
      "a=rtpmap:9 G722/8000",
      "a=rtpmap:0 PCMU/8000",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:101 telephone-event/8000",
      "a=fmtp:101 0-15",
      "a=ptime:20",
      "a=sendrecv",
    ];
    const sdp = sdpLines.join("\r\n") + "\r\n";

    const toTagPart = this.activeSession.toTag ? `;tag=${this.activeSession.toTag}` : "";
    const resp200 = [
      `SIP/2.0 200 OK`,
      `Via: SIP/2.0/TLS ${fmtIp}:${localPort};rport`,
      `From: <sip:${this.activeSession.targetNumber}@${this.realm}>;tag=${this.activeSession.fromTag}`,
      `To: <sip:${this.publicId}@${this.realm}>${toTagPart}`,
      `Call-ID: ${this.activeSession.callId}`,
      `CSeq: ${this.activeSession.cseq} INVITE`,
      `Contact: <sip:${this.publicId}@${fmtIp}:${localPort};transport=tls>;+sip.instance="<${this.uuid}>"`,
      `User-Agent: JSEAndrd-1.0`,
      `Content-Type: application/sdp`,
      `Content-Length: ${Buffer.byteLength(sdp, "utf8")}`,
      "",
      sdp,
    ].join("\r\n");

    this.socket.write(resp200);
    this.activeSession.state = "active";
    console.log(`[SIP] Answered call ${this.activeSession.callId}`);
    this.emit("call_connected", this.activeSession);
  }

  public hangup() {
    if (!this.socket || !this.activeSession) {
      console.log(`[SIP] No active call to hangup.`);
      return;
    }
    const localIp = this.socket.localAddress;
    const localPort = this.socket.localPort;
    const fmtIp = this.formatIp(localIp);
    const toTagPart = this.activeSession.toTag ? `;tag=${this.activeSession.toTag}` : "";

    if (this.activeSession.direction === "outgoing" && this.activeSession.state === "trying") {
      // Send CANCEL
      const branch = "z9hG4bK" + crypto.randomBytes(8).toString("hex");
      const cancel = [
        `CANCEL ${this.activeSession.targetUri} SIP/2.0`,
        `Via: SIP/2.0/TLS ${fmtIp}:${localPort};branch=${branch};rport`,
        `From: <sip:${this.publicId}@${this.realm}>;tag=${this.activeSession.fromTag}`,
        `To: <${this.activeSession.targetUri}>`,
        `Call-ID: ${this.activeSession.callId}`,
        `CSeq: ${this.activeSession.cseq} CANCEL`,
        `Max-Forwards: 70`,
        `User-Agent: JSEAndrd-1.0`,
        `Content-Length: 0`,
        "",
        "",
      ].join("\r\n");

      this.socket.write(cancel);
      console.log(`[SIP] Sent CANCEL for call ${this.activeSession.callId}`);
    } else {
      // Send BYE
      const branch = "z9hG4bK" + crypto.randomBytes(8).toString("hex");
      const bye = [
        `BYE ${this.activeSession.targetUri} SIP/2.0`,
        `Via: SIP/2.0/TLS ${fmtIp}:${localPort};branch=${branch};rport`,
        `From: <sip:${this.publicId}@${this.realm}>;tag=${this.activeSession.fromTag}`,
        `To: <${this.activeSession.targetUri}>${toTagPart}`,
        `Call-ID: ${this.activeSession.callId}`,
        `CSeq: ${this.activeSession.cseq + 1} BYE`,
        `Max-Forwards: 70`,
        `User-Agent: JSEAndrd-1.0`,
        `Content-Length: 0`,
        "",
        "",
      ].join("\r\n");

      this.socket.write(bye);
      console.log(`[SIP] Sent BYE for call ${this.activeSession.callId}`);
    }

    this.activeSession.state = "ended";
    this.emit("call_ended", this.activeSession);
    this.activeSession = null;
  }

  private sendResponse(statusCode: string, reqMsg: string) {
    if (!this.socket) return;
    const via = reqMsg.match(/Via:[^\r\n]+/i)?.[0] || "";
    const from = reqMsg.match(/From:[^\r\n]+/i)?.[0] || "";
    const to = reqMsg.match(/To:[^\r\n]+/i)?.[0] || "";
    const callId = reqMsg.match(/Call-ID:[^\r\n]+/i)?.[0] || "";
    const cseq = reqMsg.match(/CSeq:[^\r\n]+/i)?.[0] || "";

    const resp = [
      `SIP/2.0 ${statusCode}`,
      via,
      from,
      to,
      callId,
      cseq,
      `User-Agent: JSEAndrd-1.0`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n");

    this.socket.write(resp);
  }
}
