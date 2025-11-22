export interface Account {
  id: string;
  name: string;
  balance: number;
  created_at?: string;
}

export interface Supplier {
  id: string;
  name: string;
  created_at?: string;
}

export interface SupplierOrder {
  id: string;
  supplier_id: string | null;
  supplier_name?: string | null;
  title: string;
  total_amount: number;
  deposit_amount: number;
  deposit_date: string;
  due_date: string;
  currency: Currency;
  description?: string | null;
  created_at?: string;
}

export type IncomingKind = 'fixed' | 'planned';

export interface IncomingPayment {
  id: string;
  counterparty: string;
  amount: number;
  expected_date: string;
  kind: IncomingKind;
  notes?: string | null;
  created_at?: string;
}

export type CashEventType = 'opening' | 'inflow' | 'outflow';

export interface CashEvent {
  date: string;
  type: CashEventType;
  amount: number;
  description: string;
  source?: string;
}

export interface DailyStat {
  date: string;
  balance: number;
  events: CashEvent[];
}

export interface CashPlanResult {
  openingBalance: number;
  daily: DailyStat[];
  minBalance: number;
  cashGap: number;
}

export interface OrderImpact {
  ok: boolean;
  minBalance: number;
  cashGap: number;
}

export type Currency = 'RUB' | 'CNY';

export interface AppSettings {
  cnyRate: number;
}
