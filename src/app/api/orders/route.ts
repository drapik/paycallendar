import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { SupplierOrder } from '@/types/finance';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { data, error } = await supabase
    .from('supplier_orders')
    .select('*, suppliers(name)')
    .order('due_date', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const normalized = (data as (SupplierOrder & { suppliers?: { name?: string | null } | null })[] | null)?.map(
    (row) => ({
      ...row,
      supplier_name: row.suppliers?.name ?? null,
    }),
  );

  return NextResponse.json({ data: normalized });
}

export async function POST(request: Request) {
  const body = await request.json();
  const {
    supplier_id,
    title,
    total_amount,
    deposit_amount,
    deposit_paid,
    deposit_date,
    due_date,
    currency,
    description,
  } = body;

  if (!title || !total_amount || !due_date) {
    return NextResponse.json({ error: 'Не хватает данных заказа' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('supplier_orders')
    .insert([
      {
        supplier_id: supplier_id || null,
        title,
        total_amount: Number(total_amount),
        deposit_amount: Number(deposit_amount) || 0,
        deposit_paid: Boolean(deposit_paid),
        deposit_date: deposit_date || new Date().toISOString().slice(0, 10),
        due_date,
        description,
        currency: currency === 'CNY' ? 'CNY' : 'RUB',
        updated_at: new Date().toISOString(),
      },
    ])
    .select('*, suppliers(name)')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const normalizedRow = data as SupplierOrder & { suppliers?: { name?: string | null } | null };
  const normalized = {
    ...normalizedRow,
    supplier_name: normalizedRow.suppliers?.name ?? null,
  };

  return NextResponse.json({ data: normalized }, { status: 201 });
}

export async function PUT(request: Request) {
  const body = await request.json();
  const {
    id,
    supplier_id,
    title,
    total_amount,
    deposit_amount,
    deposit_paid,
    deposit_date,
    due_date,
    currency,
    description,
    updated_at,
  } = body;

  if (!id) {
    return NextResponse.json({ error: 'Не указан id заказа' }, { status: 400 });
  }

  if (!title || !total_amount || !due_date) {
    return NextResponse.json({ error: 'Не хватает данных заказа' }, { status: 400 });
  }

  if (!updated_at) {
    return NextResponse.json({ error: 'Не указано время последнего обновления' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('supplier_orders')
    .update({
      supplier_id: supplier_id || null,
      title,
      total_amount: Number(total_amount),
      deposit_amount: Number(deposit_amount) || 0,
      deposit_paid: Boolean(deposit_paid),
      deposit_date: deposit_date || new Date().toISOString().slice(0, 10),
      due_date,
      description,
      currency: currency === 'CNY' ? 'CNY' : 'RUB',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('updated_at', updated_at)
    .select('*, suppliers(name)')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: 'Заказ уже обновлён другим пользователем. Обновите данные и повторите.' }, { status: 409 });
  }

  const normalizedRow = data as SupplierOrder & { suppliers?: { name?: string | null } | null };
  const normalized = {
    ...normalizedRow,
    supplier_name: normalizedRow.suppliers?.name ?? null,
  };

  return NextResponse.json({ data: normalized });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Не указан id заказа' }, { status: 400 });
  }

  const { error } = await supabase.from('supplier_orders').delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
