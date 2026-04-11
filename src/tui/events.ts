/**
 * Structured event system for evalbuff TUI.
 * Events are emitted in-process via EventEmitter and persisted as JSONL.
 */
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'

// --- Event types ---

export type Phase =
  | 'planning'
  | 'carving'
  | 'evaluating'
  | 'docs_writer'
  | 'complete'

export type FeatureStatus =
  | 'pending'
  | 'carving'
  | 'carved'
  | 'carve_failed'
  | 'agent_running'
  | 'judging'
  | 'scored'
  | 'eval_failed'

export interface RunStartEvent {
  type: 'run_start'
  repoPath: string
  n: number
  codingModel: string
  docsModel: string
  logDir: string
}

export interface PhaseChangeEvent {
  type: 'phase_change'
  phase: Phase
  round?: number
  loop?: number
  detail?: string
}

export interface FeaturePlannedEvent {
  type: 'feature_planned'
  totalCandidates: number
  selectedIds: string[]
}

export interface FeatureStatusEvent {
  type: 'feature_status'
  featureId: string
  status: FeatureStatus
  score?: number
  cost?: number
  detail?: string
}

export interface RoundCompleteEvent {
  type: 'round_complete'
  round: number
  avgScore: number
  totalCost: number
  scores: Record<string, number>
}

export interface DocsWriterEvent {
  type: 'docs_writer'
  action: 'start' | 'complete'
  loop: number
  suggestionCount?: number
}

export interface RunCompleteEvent {
  type: 'run_complete'
  scoreProgression: number[]
  totalCost: number
  duration: string
}

export interface LogEvent {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

export type EvalbuffEvent =
  | RunStartEvent
  | PhaseChangeEvent
  | FeaturePlannedEvent
  | FeatureStatusEvent
  | RoundCompleteEvent
  | DocsWriterEvent
  | RunCompleteEvent
  | LogEvent

export interface TimestampedEvent {
  ts: string
  event: EvalbuffEvent
}

// --- Event bus singleton ---

class EvalbuffEventBus extends EventEmitter {
  private logStream: fs.WriteStream | null = null
  private _buffer: TimestampedEvent[] = []

  /** Start persisting events to a JSONL file in the given directory */
  initLog(logDir: string): void {
    const logPath = path.join(logDir, 'events.jsonl')
    this.logStream = fs.createWriteStream(logPath, { flags: 'a' })
  }

  /** Emit a typed event */
  send(event: EvalbuffEvent): void {
    const stamped: TimestampedEvent = {
      ts: new Date().toISOString(),
      event,
    }
    // Buffer events for late subscribers
    this._buffer.push(stamped)
    this.emit('event', stamped)

    if (this.logStream) {
      this.logStream.write(JSON.stringify(stamped) + '\n')
    }
  }

  /** Replay buffered events to a new subscriber */
  replay(handler: (event: TimestampedEvent) => void): void {
    for (const event of this._buffer) {
      handler(event)
    }
  }

  /** Convenience: emit a log message */
  log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.send({ type: 'log', level, message })
  }

  /** Clear the event buffer (for switching between runs) */
  clearBuffer(): void {
    this._buffer = []
  }

  /** Close the log stream */
  close(): void {
    this.logStream?.end()
    this.logStream = null
  }
}

/** Global event bus — import this from anywhere */
export const events = new EvalbuffEventBus()
