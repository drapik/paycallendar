import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.USE_FIXTURE_DATA === '1') {
    const today = new Date();
    const pastDate = new Date(today);
    const futureDate = new Date(today);

    pastDate.setDate(today.getDate() - 7);
    futureDate.setDate(today.getDate() + 14);

    return NextResponse.json({
      accounts: [
        { id: 'acc-1', name: 'Расчётный счёт', balance: 0, created_at: today.toISOString() },
        { id: 'acc-2', name: 'Касса', balance: 0, created_at: today.toISOString() },
      ],
      suppliers: [{ id: 'sup-1', name: 'Тестовый поставщик', created_at: today.toISOString() }],
      counterparties: [],
      orders: [
        {
          id: 'ord-1',
          supplier_id: 'sup-1',
          supplier_name: 'Тестовый поставщик',
          title: 'Партию товара',
          total_amount: 39430649.39,
          deposit_amount: 14920655.19,
          deposit_date: pastDate.toISOString(),
          due_date: futureDate.toISOString(),
          currency: 'RUB',
          description: 'Фикстура для проверки расчёта кассового разрыва',
          created_at: today.toISOString(),
        },
      ],
      inflows: [],
      expenses: [],
      settings: normalizeSettings(DEFAULT_SETTINGS),
    });
  }

  const [accounts, suppliers, counterparties, orders, inflows, expenses, settings] = await Promise.all([
    supabase.from('accounts').select('*').order('created_at'),
    supabase.from('suppliers').select('*').order('name'),
    supabase.from('counterparties').select('*').order('name'),
    supabase
      .from('supplier_orders')
      .select('*, suppliers(name)')
      .order('due_date', { ascending: true }),
    supabase.from('incoming_payments').select('*, counterparties(name)').order('expected_date'),
    supabase.from('planned_expenses').select('*').order('created_at'),
    supabase.from('app_settings').select('*').eq('key', SETTINGS_KEY).maybeSingle(),
  ]);

  const error =
    accounts.error ||
    suppliers.error ||
    counterparties.error ||
    orders.error ||
    inflows.error ||
    expenses.error ||
    settings.error;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const normalizedOrders = orders.data?.map((row) => ({
    ...row,
    supplier_name: row.suppliers?.name ?? null,
  }));

  return NextResponse.json({
    accounts: accounts.data,
    suppliers: suppliers.data,
    counterparties: counterparties.data,
    orders: normalizedOrders,
    inflows: inflows.data,
    expenses: expenses.data,
    settings: normalizeSettings(settings.data ?? DEFAULT_SETTINGS),
  });
}
