import { ask } from '@/modules/assistant/service/endpoints';
import { assistantRoute, bodyOf } from '../context';

// @permission assistant.use (every role): one question to the assistant; every tool it calls runs as this user, under their row-level security
export async function POST(request: Request): Promise<Response> {
  return assistantRoute(request, { write: true }, async (ctx) => ask(ctx, await bodyOf(request)));
}
