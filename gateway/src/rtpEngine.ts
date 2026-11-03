import dgram from "dgram";
import EventEmitter from "events";

export interface RtpConfig {
  localPort?: number;
  payloadType?: number; // 0 = PCMU (G.711 u-law), 8 = PCMA (G.711 a-law)
}

export class RtpEngine extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private localPort: number;
  private defaultPayloadType: number;

  private remoteIp: string | null = null;
  private remotePort: number | null = null;
  private currentPayloadType = 0;

  private seq = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private ssrc = Math.floor(Math.random() * 0xffffffff);
  private isActive = false;
  private packetsSent = 0;
  private packetsReceived = 0;

  constructor(config?: RtpConfig) {
    super();
    this.localPort = config?.localPort || 20000;
    this.defaultPayloadType = config?.payloadType ?? 0; // Default PCMU
  }

  public init(): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket({ type: "udp6", reuseAddr: true });

        this.socket.on("error", (err) => {
          console.error("[RTP] Socket error:", err.message);
        });

        this.socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          this.handleIncomingRtp(msg, rinfo);
        });

        this.socket.bind(this.localPort, () => {
          const addr = this.socket?.address();
          console.log(`[RTP] UDP6 socket bound on port ${addr?.port}`);
          resolve(addr ? addr.port : this.localPort);
        });
      } catch (err) {
        console.error("[RTP] Failed to create/bind udp6 socket:", err);
        reject(err);
      }
    });
  }

  public getPort(): number {
    return this.localPort;
  }

  public startSession(remoteIp: string, remotePort: number, payloadType = 0) {
    this.remoteIp = remoteIp.replace(/^\[|\]$/g, ""); // Strip brackets if passed
    this.remotePort = remotePort;
    this.currentPayloadType = payloadType;
    this.isActive = true;

    this.seq = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = Math.floor(Math.random() * 0xffffffff);

    console.log(
      `[RTP] Media session started: streaming to [${this.remoteIp}]:${this.remotePort} (Payload Type: ${this.currentPayloadType})`
    );
  }

  public stopSession() {
    console.log(`[RTP] Media session stopped.`);
    this.isActive = false;
    this.remoteIp = null;
    this.remotePort = null;
  }

  public sendAudio(payload: Buffer) {
    if (!this.isActive || !this.socket || !this.remoteIp || !this.remotePort) {
      return;
    }

    // RFC 3550 RTP Packet (12-byte header + payload)
    const packet = Buffer.alloc(12 + payload.length);

    // Byte 0: V=2, P=0, X=0, CC=0 -> 0x80
    packet[0] = 0x80;
    // Byte 1: M=0, PT
    packet[1] = this.currentPayloadType & 0x7f;
    // Bytes 2-3: Sequence Number (16-bit BE)
    packet.writeUInt16BE(this.seq & 0xffff, 2);
    // Bytes 4-7: Timestamp (32-bit BE)
    packet.writeUInt32BE(this.timestamp >>> 0, 4);
    // Bytes 8-11: SSRC (32-bit BE)
    packet.writeUInt32BE(this.ssrc >>> 0, 8);
    // Payload
    payload.copy(packet, 12);

    // Advance counters
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + payload.length) >>> 0;
    this.packetsSent++;
    if (this.packetsSent === 1 || this.packetsSent % 100 === 0) {
      console.log(`[RTP] 🎙️ Sent ${this.packetsSent} audio packets to [${this.remoteIp}]:${this.remotePort}`);
    }

    this.socket.send(packet, this.remotePort, this.remoteIp, (err) => {
      if (err) {
        console.error(`[RTP] Error sending RTP packet to [${this.remoteIp}]:${this.remotePort}:`, err.message);
      }
    });
  }

  private handleIncomingRtp(msg: Buffer, rinfo: dgram.RemoteInfo) {
    if (!this.isActive) return;

    if (msg.length < 12) {
      return; // Not a valid RTP packet
    }

    const version = (msg[0] >> 6) & 0x03;
    if (version !== 2) return; // Must be RTP v2

    const hasPadding = (msg[0] & 0x20) !== 0;
    const hasExtension = (msg[0] & 0x10) !== 0;
    const cc = msg[0] & 0x0f;
    const payloadType = msg[1] & 0x7f;

    let payloadOffset = 12 + cc * 4;

    if (hasExtension && msg.length >= payloadOffset + 4) {
      const extLength = msg.readUInt16BE(payloadOffset + 2) * 4;
      payloadOffset += 4 + extLength;
    }

    if (payloadOffset >= msg.length) return;

    let payloadEnd = msg.length;
    if (hasPadding) {
      const paddingCount = msg[msg.length - 1];
      if (paddingCount <= msg.length - payloadOffset) {
        payloadEnd -= paddingCount;
      }
    }

    const payload = msg.subarray(payloadOffset, payloadEnd);
    this.packetsReceived++;
    if (this.packetsReceived === 1 || this.packetsReceived % 100 === 0) {
      console.log(
        `[RTP] 🔊 Received ${this.packetsReceived} audio packets from Jio IMS (PT=${payloadType}, ${payload.length} bytes, hex: ${payload.subarray(0, 8).toString("hex")})`
      );
    }

    // Emit received audio payload
    this.emit("audio", {
      payload,
      payloadType,
      remoteAddress: rinfo.address,
      remotePort: rinfo.port,
    });
  }

  public close() {
    this.stopSession();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
      this.socket = null;
    }
  }
}
