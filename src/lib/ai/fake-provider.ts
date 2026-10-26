import type { LlmProvider, LlmRequest, LlmResponse } from './llm-provider';

/**
 * The deterministic provider of tests and of the demo (SPEC-assistant §3): it makes no network call, ever. Its behaviour is a
 * script given by the caller; it counts its calls and keeps every request it received, so a test can read exactly what would
 * have been sent to a real provider (the leak scan of AC-ASSIST-05) and prove that nothing was sent when the flag is off (AC-ASSIST-01).
 */
export class FakeProvider implements LlmProvider {
  readonly id = 'fake' as const;
  /** Number of `generate` calls. */
  calls = 0;
  /** Every request received, in order (what a real provider would have been sent). */
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly script: (request: LlmRequest, call: number) => LlmResponse | Promise<LlmResponse>,
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.calls += 1;
    this.requests.push(structuredClone(request));
    return this.script(request, this.calls);
  }
}
