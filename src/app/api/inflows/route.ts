import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { data, error } = await supabase.from('incoming_payments').select('*').order('expected_date');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { counterparty_id, counterparty_name, amount, expected_date, kind, notes } = body;

  if ((!counterparty_id && !counterparty_name) || !amount || !expected_date) {
    return NextResponse.json({ error: 'Не хватает данных поступления' }, { status: 400 });
  }

  let resolvedName = counterparty_name as string | null;

  if (counterparty_id && !resolvedName) {
    const { data: counterpartyRow, error: counterpartyError } = await supabase
      .from('counterparties')
      .select('name')
      .eq('id', counterparty_id)
      .single();

    if (counterpartyError) {
      return NextResponse.json({ error: counterpartyError.message }, { status: 500 });
    }

    resolvedName = counterpartyRow?.name ?? null;
  }

  if (!resolvedName) {
    return NextResponse.json({ error: 'Контрагент не найден' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('incoming_payments')
    .insert([
      {
        counterparty_id: counterparty_id || null,
        counterparty: resolvedName,
        amount: Number(amount),
        expected_date,
        kind: kind || 'fixed',
        notes,
      },
    ])
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Не указан id поступления' }, { status: 400 });
  }

  const { error } = await supabase.from('incoming_payments').delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
