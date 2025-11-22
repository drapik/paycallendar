import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { evaluateOrderImpact } from '@/lib/cashflow';
import { Account, IncomingPayment, SupplierOrder } from '@/types/finance';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const candidate = (await request.json()) as Omit<SupplierOrder, 'id' | 'supplier_name'>;

  const [accounts, inflows, orders] = await Promise.all([
    supabase.from('accounts').select('*'),
    supabase.from('incoming_payments').select('*'),
    supabase.from('supplier_orders').select('*'),
  ]);

  const error = accounts.error || inflows.error || orders.error;
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
  });

  return NextResponse.json({ impact });
}
