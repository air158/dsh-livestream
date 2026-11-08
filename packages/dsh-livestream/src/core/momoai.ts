export const MOMOAI_ORIGIN = 'https://www.momoai.pro';
export const MOMOAI_MODEL = { provider: 'momoai-livestream', model: 'momo_247' } as const;
export const MOMOAI_KEY_REF = 'DSH_LIVESTREAM_MOMOAI_KEY';

export interface MomoStatus {
  linked: boolean;
  account: { name: string; purchased: number; gifted: number; autoPurchaseDisabled: boolean } | null;
  accountError?: string;
}
