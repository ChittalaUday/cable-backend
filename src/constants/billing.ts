export const COLLECTION_OUTCOMES = ['full', 'partial', 'none', 'refund', 'others'] as const;
export type CollectionOutcome = (typeof COLLECTION_OUTCOMES)[number];

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

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
  CARD: 'card',
  BANK_TRANSFER: 'bank_transfer',
  CHEQUE: 'cheque',
} as const satisfies Record<string, PaymentMethod>;
