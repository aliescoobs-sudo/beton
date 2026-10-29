import { confirm } from '@/modules/assistant/service/endpoints';
import { assistantRoute } from '../../../context';

// @permission assistant.use (every role) + sensitive action ai.confirm_command: a draft that writes a money record needs a fresh second factor
export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await route.params;
  return assistantRoute(request, { write: true }, (ctx) => confirm(ctx, id));
}
