import { AppSettings, Currency } from '@/types/finance';

export const DEFAULT_SETTINGS: AppSettings = {
  cnyRate: 1,
};

export const SETTINGS_KEY = 'tech';

export function normalizeSettings(raw: unknown): AppSettings {
  const candidate = (raw as { value?: unknown })?.value ?? raw;
  const cnyRate = Number((candidate as Record<string, unknown>)?.cnyRate ?? 0);

  return {
    cnyRate: Number.isFinite(cnyRate) && cnyRate > 0 ? Number(cnyRate.toFixed(4)) : DEFAULT_SETTINGS.cnyRate,
  };
}

export function currencyRate(currency: Currency, settings?: AppSettings): number {
  const rate = currency === 'CNY' ? settings?.cnyRate ?? DEFAULT_SETTINGS.cnyRate : 1;
  return rate > 0 ? rate : 1;
}

export function convertToRub(amount: number | string | null, currency: Currency, settings?: AppSettings): number {
  const numeric = typeof amount === 'string' ? parseFloat(amount) : Number(amount ?? 0);
  const safeAmount = Number.isFinite(numeric) ? numeric : 0;

  return safeAmount * currencyRate(currency, settings);
}
