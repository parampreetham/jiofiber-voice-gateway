export type CallState =
  | "idle"
  | "registering"
  | "registered"
  | "ringing"
  | "connecting"
  | "active"
  | "ending"
  | "failed";

export interface CallEvent {
  callId: string;
  caller: string;
  callerName?: string;
  direction: "incoming" | "outgoing";
  state: CallState;
  timestamp: number;
}

export interface CallingProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): CallState;
  dial(destination: string): Promise<string>;
  answer(callId: string): Promise<void>;
  reject(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  sendDtmf?(callId: string, digit: string): Promise<void>;
  onIncomingCall(handler: (call: CallEvent) => void): () => void;
  onStateChange(handler: (state: CallState) => void): () => void;
}
