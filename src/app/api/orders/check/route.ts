import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { evaluateOrderImpact } from '@/lib/cashflow';
import { Account, IncomingPayment, SupplierOrder } from '@/types/finance';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const candidate = (await request.json()) as Omit<SupplierOrder, 'id' | 'supplier_name'>;

  const [accounts, inflows, orders, settings] = await Promise.all([
    supabase.from('accounts').select('*'),
    supabase.from('incoming_payments').select('*'),
    supabase.from('supplier_orders').select('*'),
    supabase.from('app_settings').select('*').eq('key', SETTINGS_KEY).maybeSingle(),
  ]);

  const error = accounts.error || inflows.error || orders.error || settings.error;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const accountsData = (accounts.data ?? []) as Account[];
  const inflowsData = (inflows.data ?? []) as IncomingPayment[];
  const ordersData = (orders.data ?? []) as SupplierOrder[];

  const impact = evaluateOrderImpact(accountsData, inflowsData, ordersData, {
    ...candidate,
    supplier_name: null,
    deposit_amount: Number(candidate.deposit_amount) || 0,
    total_amount: Number(candidate.total_amount),
    currency: candidate.currency === 'CNY' ? 'CNY' : 'RUB',
  }, normalizeSettings(settings.data ?? DEFAULT_SETTINGS));

  return NextResponse.json({ impact });
}
