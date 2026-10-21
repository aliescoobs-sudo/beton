// Public surface of master-data. Other modules import only from here.
export { parseZoneInput, type Zone, type ZoneInput } from './domain/zone';
export { createZone, listZones, updateZone, type ZoneError } from './service/zone-service';
export { parseClientInput, type Client, type ClientInput } from './domain/client';
export { normalizeIce, normalizeName } from './domain/party';
export {
  archiveClient,
  createClient,
  findClientByIce,
  getClient,
  listClients,
  listSelectableClients,
  updateClient,
  type ClientError,
  type ClientRef,
  type SavedClient,
} from './service/client-service';
export { fieldCipherFrom, type FieldCipher } from './service/field-cipher';
export { parseSiteInput, type ClientSite, type SiteInput } from './domain/site';
export { createSite, listSites, updateSite, type SiteError } from './service/site-service';
export {
  parseSupplierInput,
  SUPPLIER_CATEGORIES,
  type Supplier,
  type SupplierInput,
} from './domain/supplier';
export {
  archiveSupplier,
  createSupplier,
  listSuppliers,
  updateSupplier,
  type SupplierError,
} from './service/supplier-service';
export {
  BASE_UNITS,
  parseComponentInput,
  parsePurchaseUnitInput,
  type BaseUnit,
  type Component,
  type ComponentInput,
  type PurchaseUnit,
  type PurchaseUnitInput,
} from './domain/component';
export {
  createComponent,
  createPurchaseUnit,
  listComponents,
  listPurchaseUnits,
  updateComponent,
  updatePurchaseUnit,
  type ComponentError,
} from './service/component-service';
export { parseConcreteTypeInput, type ConcreteType, type ConcreteTypeInput } from './domain/concrete-type';
export {
  createConcreteType,
  listConcreteTypes,
  listSelectableConcreteTypes,
  updateConcreteType,
  type ConcreteTypeError,
} from './service/concrete-type-service';
export {
  parseRecetteInput,
  resolveRecette,
  type Recette,
  type RecetteInput,
  type RecetteLine,
} from './domain/recette';
export {
  createRecetteVersion,
  listRecetteVersions,
  resolveRecetteFor,
  type RecetteError,
} from './service/recette-service';
export { assertSeedAllowed, seedPilotMasterData, type SeedGuardEnv } from './service/pilot-seed';
export {
  componentCostPerM3,
  parsePurchasePriceInput,
  resolvePurchasePrice,
  type PricePoint,
  type PurchasePrice,
  type PurchasePriceInput,
} from './domain/purchase-price';
export {
  componentCostPerM3For,
  createPurchasePrice,
  listPurchasePrices,
  proposePriceFromLastPurchase,
  type PurchasePriceError,
} from './service/purchase-price-service';
export {
  parseListPriceInput,
  resolveSellingPrice,
  type ListPriceInput,
  type SellingPrice,
} from './domain/selling-price';
export {
  createListPrice,
  listSellingPrices,
  resolveSellingPriceFor,
  type SellingPriceError,
} from './service/selling-price-service';
