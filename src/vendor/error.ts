export type ErrorObject = {
  name: string
  message: string
  stack?: string
  status?: number
  statusCode?: number
  code?: string
  rawError?: string
  responseBody?: string
  url?: string
  isRetryable?: boolean
  requestBodyValues?: string
  cause?: ErrorObject
}

interface ExtendedErrorProperties {
  status?: number
  statusCode?: number
  code?: string
  responseBody?: string
  url?: string
  isRetryable?: boolean
  requestBodyValues?: Record<string, unknown>
  cause?: unknown
}

function safeStringify(value: unknown, maxLength = 10000): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.slice(0, maxLength)
  try {
    const seen = new WeakSet()
    const str = JSON.stringify(
      value,
      (_, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]'
          seen.add(val)
        }
        return val
      },
      2,
    )
    return str?.slice(0, maxLength)
  } catch {
    return '[Unable to stringify]'
  }
}

export function getErrorObject(
  error: unknown,
  options: { includeRawError?: boolean } = {},
): ErrorObject {
  if (error instanceof Error) {
    const extError = error as Error & Partial<ExtendedErrorProperties>

    let responseBody: string | undefined
    if (extError.responseBody !== undefined) {
      responseBody = safeStringify(extError.responseBody)
    }

    let requestBodyValues: string | undefined
    if (
      extError.requestBodyValues !== undefined &&
      typeof extError.requestBodyValues === 'object'
    ) {
      requestBodyValues = safeStringify(extError.requestBodyValues)
    }

    let cause: ErrorObject | undefined
    if (extError.cause !== undefined) {
      cause = getErrorObject(extError.cause, options)
    }

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      status: typeof extError.status === 'number' ? extError.status : undefined,
      statusCode:
        typeof extError.statusCode === 'number'
          ? extError.statusCode
          : undefined,
      code: typeof extError.code === 'string' ? extError.code : undefined,
      rawError: options.includeRawError
        ? safeStringify(error)
        : undefined,
      responseBody,
      url: typeof extError.url === 'string' ? extError.url : undefined,
      isRetryable:
        typeof extError.isRetryable === 'boolean'
          ? extError.isRetryable
          : undefined,
      requestBodyValues,
      cause,
    }
  }

  return {
    name: 'Error',
    message: `${error}`,
  }
}
