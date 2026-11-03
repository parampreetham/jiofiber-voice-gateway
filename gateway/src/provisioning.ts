import https from "https";
import crypto from "crypto";
import { JioConfig, getPhysicalMacAddress } from "./config";

export interface ProvisioningSession {
  routerIp: string;
  macAddress: string;
  cookie?: string;
  uuid?: string;
}

export class JioProvisioningService {
  private agent = new https.Agent({ rejectUnauthorized: false });

  private queryRouter(url: string): Promise<{
    statusCode?: number;
    cookie?: string;
    maskedMobile?: string;
    body: string;
    error?: string;
  }> {
    return new Promise((resolve) => {
      const req = https.get(url, { agent: this.agent, timeout: 8000 }, (res) => {
        const rawCookies = res.headers["set-cookie"] || [];
        const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");
        const maskedMobile = (res.headers["x-amn"] as string) || "";
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            cookie,
            maskedMobile,
            body,
          });
        });
      });
      req.on("error", (err) => {
        resolve({ body: "", error: err.message });
      });
    });
  }

  public async requestOtp(
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
    const physicalMac = getPhysicalMacAddress();
    // Try candidate MACs: first custom or paired MAC, then physical Wi-Fi MAC
    const candidates = customMac
      ? [customMac.trim()]
      : ["00:00:85:ea:2c:9f", physicalMac].filter((m, i, arr) => m && arr.indexOf(m) === i);

    let lastError = "Router returned 403 Forbidden: JioFiber limit of 6 paired extensions reached or unauthorized MAC.";

    for (const mac of candidates) {
      const uuid = `00000000-0000-1000-8000-${mac.replace(/:/g, "").toUpperCase()}`;
      const url = `https://${routerIp}:8443/?terminal_sw_version=RCSAndrd&terminal_vendor=${clientName}&terminal_model=${clientName}&mac_address=${mac}&alias=${clientName}&nwk_intf=wifi&op_type=add`;

      console.log(`[Provisioning] Trying router pairing at ${routerIp}:8443 with MAC ${mac}...`);
      const res = await this.queryRouter(url);

      if (res.error) {
        lastError = `Could not connect to router at ${routerIp}:8443 (${res.error})`;
        continue;
      }

      console.log(`[Provisioning] Router response (status ${res.statusCode}, x-amn: ${res.maskedMobile}):`, res.body.substring(0, 150));

      // Check if router directly returned XML configuration (already paired device!)
      if (res.body.includes("<wap-provisioningdoc")) {
        try {
          const config = this.parseProvisioningXml(res.body, { routerIp, macAddress: mac, uuid });
          if (config) {
            console.log("[Provisioning] Router returned active SIP credentials directly!");
            return {
              success: true,
              autoConfigured: true,
              config,
              message: `Device verified by JioFiber router! Automatically configured for line ${config.username}.`,
            };
          }
        } catch (e: any) {
          console.warn("[Provisioning] Failed parsing returned XML:", e.message);
        }
      }

      if (res.statusCode === 200 || res.body.toLowerCase().includes("otp")) {
        const message = res.maskedMobile
          ? `OTP sent to your registered mobile number (${res.maskedMobile})`
          : "OTP sent to your registered Jio mobile number";
        return {
          success: true,
          autoConfigured: false,
          session: { routerIp, macAddress: mac, cookie: res.cookie, uuid },
          message,
        };
      }

      if (res.statusCode === 403) {
        lastError = "Router returned 403 Forbidden: Limit of 6 paired extensions reached or unauthorized device. Use Manual Config tab to connect directly.";
      } else {
        lastError = `Router returned status ${res.statusCode}: ${res.body || "Error"}`;
      }
    }

    return {
      success: false,
      message: lastError,
    };
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
