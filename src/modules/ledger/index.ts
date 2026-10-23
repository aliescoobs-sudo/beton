// Public surface of the ledger. Other modules import only from here.
export * from './domain';
export { nextDocNumber } from './service/doc-number';
export { createOrder, type CreatedOrder, type OrderError } from './service/order-service';
