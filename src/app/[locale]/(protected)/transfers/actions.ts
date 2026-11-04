'use server';

import { revalidatePath } from 'next/cache';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { pickUpTransfer, receiveTransfer, sendTransfer, setFuelTankOpening } from '@/modules/operations';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

const deps = () => ({ getState: currentAuthState, appPool: getPool('app') });

// @permission transfers.write (owner, app_admin, plant_manager): sends material or fuel to the other plant; the database checks it is the sender's plant
export async function sendTransferAction(formData: FormData): Promise<void> {
  if (!getEnv().TRANSFERS_ENABLED) return;
  const allowed = await authorize('transfers.write', deps());
  if (!allowed.ok) return;
  const kind = formData.get('kind') === 'fuel' ? 'fuel' : 'material';
  await sendTransfer(getPool('app'), allowed.user, {
    kind,
    fromPlant: String(formData.get('fromPlant')),
    toPlant: String(formData.get('toPlant')),
    componentId: kind === 'material' ? String(formData.get('componentId')) : null,
    qty: Number(formData.get('qty')),
    date: (await getRequestClock()).today(),
    note: String(formData.get('note') ?? '') || null,
  });
  revalidatePath('/', 'layout');
}

// @permission transfers.write (owner, app_admin, plant_manager): the sender hands it to the carrier
export async function pickUpTransferAction(formData: FormData): Promise<void> {
  if (!getEnv().TRANSFERS_ENABLED) return;
  const allowed = await authorize('transfers.write', deps());
  if (!allowed.ok) return;
  await pickUpTransfer(getPool('app'), allowed.user, String(formData.get('id')));
  revalidatePath('/', 'layout');
}

// @permission transfers.write (owner, app_admin, plant_manager): the destination records what arrived; the variance is kept
export async function receiveTransferAction(formData: FormData): Promise<void> {
  if (!getEnv().TRANSFERS_ENABLED) return;
  const allowed = await authorize('transfers.write', deps());
  if (!allowed.ok) return;
  await receiveTransfer(getPool('app'), allowed.user, {
    id: String(formData.get('id')),
    qty: Number(formData.get('qty')),
    date: (await getRequestClock()).today(),
  });
  revalidatePath('/', 'layout');
}

// @permission transfers.write (owner, app_admin, plant_manager): the opening level of a plant fuel tank, once per plant
export async function fuelTankOpeningAction(formData: FormData): Promise<void> {
  if (!getEnv().TRANSFERS_ENABLED) return;
  const allowed = await authorize('transfers.write', deps());
  if (!allowed.ok) return;
  await setFuelTankOpening(getPool('app'), allowed.user, {
    plantId: String(formData.get('plantId')),
    litres: Number(formData.get('litres')),
    asOf: (await getRequestClock()).today(),
  });
  revalidatePath('/', 'layout');
}
