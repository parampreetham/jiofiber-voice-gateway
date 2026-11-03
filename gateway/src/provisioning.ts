import https from "https";
import crypto from "crypto";
import { JioConfig } from "./config";

export interface ProvisioningSession {
  routerIp: string;
  macAddress: string;
  cookie?: string;
  uuid?: string;
}

export class JioProvisioningService {
  private agent = new https.Agent({ rejectUnauthorized: false });

  public requestOtp(
    routerIp: string,
    clientName = "JioFiberVoice"
  ): Promise<{ success: boolean; session: ProvisioningSession; message?: string }> {
    return new Promise((resolve) => {
      // Deterministic or random MAC address
      const randomBytes = crypto.randomBytes(4).toString("hex").match(/../g)?.join(":") || "85:ea:2c:9f";
      const mac = `00:00:${randomBytes}`;
      const uuid = `00000000-0000-1000-8000-${mac.replace(/:/g, "").toUpperCase()}`;

      const url = `https://${routerIp}:8443/?terminal_sw_version=RCSAndrd&terminal_vendor=${clientName}&terminal_model=${clientName}&mac_address=${mac}&alias=${clientName}&nwk_intf=wifi&op_type=add`;

      const req = https.get(url, { agent: this.agent, timeout: 8000 }, (res) => {
        const rawCookies = res.headers["set-cookie"] || [];
        const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");

        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          console.log(`[Provisioning] Router OTP response (status ${res.statusCode}):`, body.substring(0, 200));
          if (res.statusCode === 200 || body.toLowerCase().includes("otp")) {
            resolve({
              success: true,
              session: { routerIp, macAddress: mac, cookie, uuid },
              message: "OTP sent to registered Jio mobile number",
            });
          } else {
            resolve({
              success: false,
              session: { routerIp, macAddress: mac, cookie, uuid },
              message: `Router returned status ${res.statusCode}: ${body}`,
            });
          }
        });
      });

      req.on("error", (err) => {
        console.error(`[Provisioning] Failed contacting router at ${routerIp}:8443:`, err.message);
        resolve({
          success: false,
          session: { routerIp, macAddress: mac, uuid },
          message: `Could not connect to router at ${routerIp}:8443 (${err.message})`,
        });
      });
    });
  }

  public verifyOtp(
    session: ProvisioningSession,
    otp: string
  ): Promise<{ success: boolean; config?: JioConfig; error?: string }> {
    return new Promise((resolve) => {
      const url = `https://${session.routerIp}:8443/?OTP=${encodeURIComponent(otp.trim())}`;
      const headers: Record<string, string> = {};
      if (session.cookie) {
        headers["Cookie"] = session.cookie;
      }

      const req = https.get(url, { agent: this.agent, headers, timeout: 8000 }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          console.log(`[Provisioning] OTP verify response (status ${res.statusCode})`);
          try {
            const config = this.parseProvisioningXml(body, session);
            if (config) {
              resolve({ success: true, config });
            } else {
              resolve({ success: false, error: "Failed extracting SIP credentials from router XML response." });
            }
          } catch (e: any) {
            resolve({ success: false, error: e.message });
          }
        });
      });

      req.on("error", (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }

  private parseProvisioningXml(xml: string, session: ProvisioningSession): JioConfig | null {
    // Extract parameters from wap-provisioningdoc XML
    const getParm = (name: string): string => {
      const match =
        xml.match(new RegExp(`<parm\\s+name=["']${name}["']\\s+value=["']([^"']+)["']`, "i")) ||
        xml.match(new RegExp(`name=["']${name}["'][^>]*value=["']([^"']+)["']`, "i"));
      return match ? match[1] : "";
    };

    const password = getParm("AuthPassword") || getParm("UserPwd");
    const username = getParm("UserName") || getParm("AuthName");
    const realm = getParm("Realm") || "ka.wln.ims.jio.com";
    const publicId = getParm("Public_User_Identity") || username;
    const routerHost = session.routerIp;

    if (!password || !username) {
      console.warn("[Provisioning] Missing password or username in XML:", xml.substring(0, 300));
      return null;
    }

    return {
      host: routerHost,
      port: 5068,
      username: username,
      password: password,
      realm: realm,
      publicId: publicId,
      uuid: session.uuid || "00000000-0000-1000-8000-000085EA2C9F",
    };
  }
}
