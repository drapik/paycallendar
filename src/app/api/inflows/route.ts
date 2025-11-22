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
  const { counterparty, amount, expected_date, kind, notes } = body;

  if (!counterparty || !amount || !expected_date) {
    return NextResponse.json({ error: 'Не хватает данных поступления' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('incoming_payments')
    .insert([
      {
        counterparty,
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
