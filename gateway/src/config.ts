import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

export interface JioConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  realm: string;
  publicId: string;
  uuid: string;
}

export const JIO_CIRCLES = [
  { code: "ka", name: "Karnataka", realm: "ka.wln.ims.jio.com" },
  { code: "dl", name: "Delhi", realm: "dl.wln.ims.jio.com" },
  { code: "mu", name: "Mumbai", realm: "mu.wln.ims.jio.com" },
  { code: "mh", name: "Maharashtra & Goa", realm: "mh.wln.ims.jio.com" },
  { code: "tn", name: "Tamil Nadu", realm: "tn.wln.ims.jio.com" },
  { code: "ap", name: "Andhra Pradesh & Telangana", realm: "ap.wln.ims.jio.com" },
  { code: "ko", name: "Kolkata", realm: "ko.wln.ims.jio.com" },
  { code: "wb", name: "West Bengal", realm: "wb.wln.ims.jio.com" },
  { code: "gj", name: "Gujarat", realm: "gj.wln.ims.jio.com" },
  { code: "kl", name: "Kerala", realm: "kl.wln.ims.jio.com" },
  { code: "pb", name: "Punjab", realm: "pb.wln.ims.jio.com" },
  { code: "hr", name: "Haryana", realm: "hr.wln.ims.jio.com" },
  { code: "rj", name: "Rajasthan", realm: "rj.wln.ims.jio.com" },
  { code: "ue", name: "Uttar Pradesh (East)", realm: "ue.wln.ims.jio.com" },
  { code: "uw", name: "Uttar Pradesh (West)", realm: "uw.wln.ims.jio.com" },
  { code: "br", name: "Bihar & Jharkhand", realm: "br.wln.ims.jio.com" },
  { code: "mp", name: "Madhya Pradesh & Chhattisgarh", realm: "mp.wln.ims.jio.com" },
  { code: "or", name: "Odisha", realm: "or.wln.ims.jio.com" },
  { code: "as", name: "Assam", realm: "as.wln.ims.jio.com" },
  { code: "ne", name: "North East", realm: "ne.wln.ims.jio.com" },
];

function getConfigFilePath(): string {
  // Check local gateway/config.json or project config.json
  const localPath = path.join(process.cwd(), "config.json");
  if (fs.existsSync(localPath)) return localPath;

  const gatewayPath = path.join(process.cwd(), "gateway", "config.json");
  if (fs.existsSync(gatewayPath)) return gatewayPath;

  const parentPath = path.join(process.cwd(), "..", "gateway", "config.json");
  if (fs.existsSync(parentPath)) return parentPath;

  return localPath;
}

export function loadConfig(): JioConfig | null {
  const filePath = getConfigFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data.username && data.password && data.realm) {
        return {
          host: data.host || process.env.JIO_ROUTER_HOST || "192.168.29.1",
          port: data.port || parseInt(process.env.JIO_ROUTER_PORT || "5068", 10),
          username: data.username,
          password: data.password,
          realm: data.realm,
          publicId: data.publicId || data.username,
          uuid: data.uuid || "00000000-0000-1000-8000-000085EA2C9F",
        };
      }
    } catch (e) {
      console.warn("[Config] Failed reading config.json:", e);
    }
  }

  // Fallback to environment variables
  if (process.env.JIO_LANDLINE_NUMBER && process.env.JIO_SIP_PASSWORD && process.env.JIO_IMS_REALM) {
    return {
      host: process.env.JIO_ROUTER_HOST || "192.168.29.1",
      port: parseInt(process.env.JIO_ROUTER_PORT || "5068", 10),
      username: process.env.JIO_LANDLINE_NUMBER,
      password: process.env.JIO_SIP_PASSWORD,
      realm: process.env.JIO_IMS_REALM,
      publicId: process.env.JIO_LANDLINE_NUMBER,
      uuid: process.env.JIO_CLIENT_UUID || "00000000-0000-1000-8000-000085EA2C9F",
    };
  }

  return null;
}

export function saveConfig(config: JioConfig): void {
  const filePath = getConfigFilePath();
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  console.log(`[Config] Configuration saved to ${filePath}`);
}

export function isConfigured(config: JioConfig | null): boolean {
  return !!(config && config.username && config.password && config.realm);
}
