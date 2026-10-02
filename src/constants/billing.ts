export const COLLECTION_OUTCOMES = ['full', 'partial', 'none', 'refund', 'others'] as const;
export type CollectionOutcome = (typeof COLLECTION_OUTCOMES)[number];

export const MAX_COLLECTION_AMOUNT = '99000.00';

/** Methods accepted for a new collection. */
export const PAYMENT_METHODS = ['cash', 'upi'] as const;
export type PaymentEntryMethod = (typeof PAYMENT_METHODS)[number];

/** Legacy values remain readable on immutable historical receipts. */
export const STORED_PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque'] as const;
export type PaymentMethod = (typeof STORED_PAYMENT_METHODS)[number];

export const COLLECTION_OUTCOME = {
  FULL: 'full',
  PARTIAL: 'partial',
  NONE: 'none',
  REFUND: 'refund',
  OTHERS: 'others',
} as const satisfies Record<string, CollectionOutcome>;

export const PAYMENT_METHOD = {
  CASH: 'cash',
  UPI: 'upi',
} as const satisfies Record<string, PaymentEntryMethod>;
