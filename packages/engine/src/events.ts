import type { EngineEvent } from "@patchcad/shared";

export type EngineEventListener = (event: EngineEvent) => void;

/** Minimal typed event bus; the server relays these over WebSocket. */
export class EventBus {
  private listeners = new Set<EngineEventListener>();

  emit(event: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A broken listener must never break the engine.
      }
    }
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
