import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

export class PhoneBridge {
  private static async runAdb(cmd: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`adb shell "${cmd}"`);
      return stdout.trim();
    } catch (e: any) {
      console.error(`[PhoneBridge] ADB command failed: ${cmd}`, e.message);
      return "";
    }
  }

  /**
   * Places an outbound call via JioJoin running on the whitelisted Android phone.
   */
  public static async dial(destination: string): Promise<boolean> {
    const cleanNumber = destination.replace(/[^0-9]/g, "");
    console.log(`[PhoneBridge] Dialing ${cleanNumber} through JioJoin phone relay...`);

    try {
      // 1. Bring JioJoin to foreground
      await this.runAdb("am start -n com.jio.jse/.mobile.ui.activity.MainActivity");
      await new Promise((r) => setTimeout(r, 400));

      // 2. Open dialer pad if not already open
      await this.runAdb("input tap 948 2044");
      await new Promise((r) => setTimeout(r, 400));

      // 3. Clear dialer text completely using backspace burst
      await this.runAdb(
        "input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67"
      );
      await new Promise((r) => setTimeout(r, 200));

      // 4. Type the exact destination number
      await this.runAdb(`input text "${cleanNumber}"`);
      await new Promise((r) => setTimeout(r, 400));

      // 5. Tap the audio call button (Center at [540, 1382] in dialer pad)
      await this.runAdb("input tap 540 1382");

      console.log(`[PhoneBridge] Call initiated to ${cleanNumber}!`);
      return true;
    } catch (err) {
      console.error("[PhoneBridge] Failed to dial:", err);
      return false;
    }
  }

  /**
   * Ends an active call.
   */
  public static async hangup(): Promise<boolean> {
    console.log("[PhoneBridge] Hanging up call...");
    try {
      // Tap the End Call red button [457,2113][622,2278] -> center (540, 2195)
      await this.runAdb("input tap 540 2195");
      await this.runAdb("input keyevent 6");

      // Dismiss any rating popup if shown
      await new Promise((r) => setTimeout(r, 400));
      await this.runAdb("input tap 285 2176"); // "Not now" button
      return true;
    } catch (err) {
      console.error("[PhoneBridge] Failed to hang up:", err);
      return false;
    }
  }

  /**
   * Answers an incoming call.
   */
  public static async answer(): Promise<boolean> {
    console.log("[PhoneBridge] Answering call...");
    try {
      await this.runAdb("input keyevent 5");
      return true;
    } catch (err) {
      console.error("[PhoneBridge] Failed to answer:", err);
      return false;
    }
  }
}
