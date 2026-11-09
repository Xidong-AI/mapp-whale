export type DebugSink = (label: string, value: unknown) => void;

let sink: DebugSink | null = null;

export function setDebugSink(next: DebugSink | null): void {
  sink = next;
}

export function debugLog(label: string, value: unknown): void {
  try {
    sink?.(label, value);
  } catch {
    // 调试通道不能影响主流程。
  }
}

export function describeDebug(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
