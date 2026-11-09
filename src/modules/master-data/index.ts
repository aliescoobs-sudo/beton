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
export { defaultFieldCipher, fieldCipherFrom, type FieldCipher } from './service/field-cipher';
export { parseSiteInput, type ClientSite, type SiteInput } from './domain/site';
export { createSite, listSiteOptions, listSites, updateSite, type SiteError } from './service/site-service';
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
export { defaultEntryUnit, ENTRY_UNITS, parseEntryQty } from './domain/recette-units';
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
  parseOverrideInput,
  resolveSellingPrice,
  type ListPriceInput,
  type OverrideInput,
  type SellingPrice,
} from './domain/selling-price';
export {
  createClientOverride,
  createListPrice,
  listSellingPrices,
  resolveSellingPriceFor,
  type SellingPriceError,
} from './service/selling-price-service';
export { parsePlantInput, type Plant, type PlantInput } from './domain/plant';
export {
  createPlant,
  listPlants,
  plantIdOf,
  type PlantError,
  updatePlant,
  listPlantPhones,
  setPlantPhone,
  usePlant,
} from './service/plant-service';
export {
  PAY_BASES,
  STOPPED_DECISIONS,
  TRUCK_CODE_PREFIX,
  TRUCK_KINDS,
  type PayBasis,
  type StoppedDecision,
  type TruckKind,
} from './domain/truck';
export {
  DEFAULT_TRUCK_CAPACITY_L,
  formatCapacityM3,
  parseCapacityM3,
  parseTruckInput,
  parseTruckStatusInput,
  TRUCK_STATUSES,
  type Truck,
  type TruckInput,
  type TruckLogStatus,
  type TruckStatusEntry,
} from './domain/truck';
export {
  createTruck,
  listTruckStatusLog,
  listTrucks,
  logTruckStatus,
  unavailableDates,
  updateTruck,
  type TruckError,
} from './service/truck-service';
export { datesInRange, isTruckAvailable } from './domain/truck-availability';
