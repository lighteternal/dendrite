import type { StreamEventPayload } from "@/lib/contracts";

const encoder = new TextEncoder();

export function encodeSseEvent(event: StreamEventPayload): Uint8Array {
  return encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
