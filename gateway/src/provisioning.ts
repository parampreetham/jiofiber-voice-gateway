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
    customMac?: string,
    clientName = "JioFiberVoice"
  ): Promise<{
    success: boolean;
    session?: ProvisioningSession;
    autoConfigured?: boolean;
    config?: JioConfig;
    message?: string;
  }> {
    return new Promise((resolve) => {
      // Use persistent paired MAC (00:00:85:ea:2c:9f) by default so already-whitelisted devices connect immediately
      const mac = (customMac && customMac.trim()) || "00:00:85:ea:2c:9f";
      const uuid = `00000000-0000-1000-8000-${mac.replace(/:/g, "").toUpperCase()}`;

      const url = `https://${routerIp}:8443/?terminal_sw_version=RCSAndrd&terminal_vendor=${clientName}&terminal_model=${clientName}&mac_address=${mac}&alias=${clientName}&nwk_intf=wifi&op_type=add`;

      const req = https.get(url, { agent: this.agent, timeout: 8000 }, (res) => {
        const rawCookies = res.headers["set-cookie"] || [];
        const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");
        const maskedMobile = (res.headers["x-amn"] as string) || "";

        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          console.log(`[Provisioning] Router response (status ${res.statusCode}, x-amn: ${maskedMobile}):`, body.substring(0, 200));

          // Check if router directly returned XML configuration (already paired device!)
          if (body.includes("<wap-provisioningdoc")) {
            try {
              const config = this.parseProvisioningXml(body, { routerIp, macAddress: mac, uuid });
              if (config) {
                console.log("[Provisioning] Router returned active SIP credentials directly!");
                resolve({
                  success: true,
                  autoConfigured: true,
                  config,
                  message: `Device verified by JioFiber router! Automatically configured for line ${config.username}.`,
                });
                return;
              }
            } catch (e: any) {
              console.warn("[Provisioning] Failed parsing returned XML:", e.message);
            }
          }

          if (res.statusCode === 200 || body.toLowerCase().includes("otp")) {
            const message = maskedMobile
              ? `OTP sent to your registered mobile number (${maskedMobile})`
              : "OTP sent to your registered Jio mobile number";
            resolve({
              success: true,
              autoConfigured: false,
              session: { routerIp, macAddress: mac, cookie, uuid },
              message,
            });
          } else {
            let errorMsg = `Router returned status ${res.statusCode}: ${body || "Forbidden"}`;
            if (res.statusCode === 403) {
              errorMsg = "Router returned 403 Forbidden: JioFiber limit of 6 paired extensions reached or unauthorized MAC.";
            }
            resolve({
              success: false,
              session: { routerIp, macAddress: mac, cookie, uuid },
              message: errorMsg,
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

    const password = getParm("userpwd") || getParm("authpassword");
    let username = getParm("username") || getParm("authname");
    const realm = getParm("realm") || getParm("home_network_domain_name") || "ka.wln.ims.jio.com";
    const publicId = getParm("public_user_identity") || username;
    const routerHost = session.routerIp;
    const uuid = getParm("uuid_value") || session.uuid || "00000000-0000-1000-8000-000085EA2C9F";

    if (!password || !username) {
      console.warn("[Provisioning] Missing password or username in XML:", xml.substring(0, 300));
      return null;
    }

    // Clean username
    username = username.replace(/^sip:/i, "");
    if (!username.includes("@") && realm) {
      username = `${username}@${realm}`;
    }

    return {
      host: routerHost,
      port: 5068,
      username: username,
      password: password,
      realm: realm,
      publicId: publicId,
      uuid: uuid,
    };
  }
}
