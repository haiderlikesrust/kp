export interface Log {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  /** Something a person needs to look at. Also goes to the alert webhook. */
  alert(message: string, detail?: unknown): void
}

const stamp = (): string => new Date().toISOString()

export function createLog(webhookUrl?: string): Log {
  return {
    info(message, detail) {
      console.log(stamp(), message, detail ?? '')
    },
    warn(message, detail) {
      console.warn(stamp(), 'WARN', message, detail ?? '')
    },
    alert(message, detail) {
      console.error(stamp(), 'ALERT', message, detail ?? '')
      if (!webhookUrl) return
      const content = `KeepRipping: ${message}${detail ? ` (${String(detail)})` : ''}`
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, text: content }),
      }).catch((err) => console.error(stamp(), 'alert webhook failed', err))
    },
  }
}

export const silentLog: Log = { info() {}, warn() {}, alert() {} }
