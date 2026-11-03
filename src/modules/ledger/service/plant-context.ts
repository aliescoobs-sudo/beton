import { inPlant, type SessionUser } from '@/modules/platform-security';

/**
 * The plant a new order or purchase is entered for (C3). With two active plants the database refuses a row that does not say its
 * plant, so the form picks one and it travels as the request's plant context. A plant manager is bound to their own plant by the
 * database, whatever the form says. The plant must be active and the trigger checks that; this only names it.
 */
export function plantContext(actor: SessionUser, plantId: string | null | undefined): SessionUser {
  if (!plantId || actor.role === 'plant_manager') return actor;
  return inPlant(actor, plantId);
}
