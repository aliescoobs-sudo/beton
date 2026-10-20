// Public surface of master-data. Other modules import only from here.
export { parseZoneInput, type Zone, type ZoneInput } from './domain/zone';
export { createZone, listZones, updateZone, type ZoneError } from './service/zone-service';
