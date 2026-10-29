import { proposals } from '@/modules/assistant/service/endpoints';
import { assistantRoute } from '../context';

// @permission assistant.use (every role): the drafts of this user only
export async function GET(request: Request): Promise<Response> {
  return assistantRoute(request, { write: false }, (ctx) => proposals(ctx));
}
