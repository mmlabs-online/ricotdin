// Typed error for the Gemini pipeline. Thrown by lib/gemini/* and caught in
// processMeeting to write meetings.error_message and set status='failed'.

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'PipelineError'
  }
}
