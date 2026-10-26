// Public surface of the assistant. Other modules and routes import only from here.
export { allowedFrom, canonicalNumber, checkNumbers, type Allowed } from './domain/numbers-check';
export { type EntityRef, Pseudonymizer } from './domain/pseudonymizer';
export { type LeakIndex, scanForLeaks } from './domain/leak-scan';
export { prepareForModel, RESULT_LIMITS, sanitizeText, toDataBlock } from './domain/data-block';
