import { reject } from '@/modules/assistant/service/endpoints';
import { assistantRoute } from '../../../context';

// @permission assistant.use (every role): refuse a draft of this user
export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await route.params;
  return assistantRoute(request, { write: true }, (ctx) => reject(ctx, id));
}
