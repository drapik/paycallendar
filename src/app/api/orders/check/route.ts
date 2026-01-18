import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { evaluateOrderImpact } from '@/lib/cashflow';
import { Account, IncomingPayment, SupplierOrder } from '@/types/finance';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const candidate = (await request.json()) as Partial<SupplierOrder>;

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
  const normalizedCandidate: Omit<SupplierOrder, 'id'> = {
    supplier_id: candidate.supplier_id ?? null,
    supplier_name: null,
    moysklad_id: candidate.moysklad_id ?? null,
    title: candidate.title || 'Новый заказ',
    deposit_date: candidate.deposit_date || new Date().toISOString().slice(0, 10),
    due_date: candidate.due_date || new Date().toISOString().slice(0, 10),
    description: candidate.description ?? null,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    deposit_amount: Number(candidate.deposit_amount) || 0,
    deposit_paid: Boolean(candidate.deposit_paid),
    total_amount: Number(candidate.total_amount) || 0,
    currency: candidate.currency === 'CNY' ? 'CNY' : 'RUB',
  };

  const relevantOrders = candidate.id ? ordersData.filter((order) => order.id !== candidate.id) : ordersData;

  const impact = evaluateOrderImpact(
    accountsData,
    inflowsData,
    relevantOrders,
    normalizedCandidate,
    normalizeSettings(settings.data ?? DEFAULT_SETTINGS),
  );

  return NextResponse.json({ impact });
}
