export const ACTIVITY_KINDS = ['customer', 'payment'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
