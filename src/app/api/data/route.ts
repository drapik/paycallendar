import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [accounts, suppliers, orders, inflows] = await Promise.all([
    supabase.from('accounts').select('*').order('created_at'),
    supabase.from('suppliers').select('*').order('name'),
    supabase.from('supplier_orders').select('*, suppliers(name)').order('due_date', { ascending: true }),
    supabase.from('incoming_payments').select('*').order('expected_date'),
  ]);

  const error = accounts.error || suppliers.error || orders.error || inflows.error;
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
    orders: normalizedOrders,
    inflows: inflows.data,
  });
}
