export type PrintModeToolCall = {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input: Record<string, any>
  agentId?: string
  parentAgentId?: string
  includeToolCall?: boolean
}

export type PrintModeToolResult = {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  output: Array<
    | { type: 'json'; value: unknown }
    | { type: 'media'; data: string; mediaType: string }
  >
  parentAgentId?: string
}

export type PrintModeText = {
  type: 'text'
  text: string
  agentId?: string
}

export type PrintModeStart = {
  type: 'start'
  agentId?: string
  messageHistoryLength: number
}

export type PrintModeError = {
  type: 'error'
  message: string
}

export type PrintModeDownloadStatus = {
  type: 'download'
  version: string
  status: 'complete' | 'failed'
}

export type PrintModeFinish = {
  type: 'finish'
  agentId?: string
  totalCost: number
}

export type PrintModeSubagentStart = {
  type: 'subagent_start'
  agentId: string
  agentType: string
  displayName: string
  onlyChild: boolean
  parentAgentId?: string
  params?: Record<string, any>
  prompt?: string
}

export type PrintModeSubagentFinish = {
  type: 'subagent_finish'
  agentId: string
  agentType: string
  displayName: string
  onlyChild: boolean
  parentAgentId?: string
  params?: Record<string, any>
  prompt?: string
}

export type PrintModeReasoningDelta = {
  type: 'reasoning_delta'
  text: string
  ancestorRunIds: string[]
  runId: string
}

export type PrintModeEvent =
  | PrintModeDownloadStatus
  | PrintModeError
  | PrintModeFinish
  | PrintModeStart
  | PrintModeSubagentFinish
  | PrintModeSubagentStart
  | PrintModeText
  | PrintModeToolCall
  | PrintModeToolResult
  | PrintModeReasoningDelta
