import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface InflowInput {
  counterparty_name?: string;
  amount?: number;
  expected_date?: string;
  kind?: 'fixed' | 'planned';
  notes?: string | null;
}

export async function POST(request: Request) {
  let body: { items?: InflowInput[] } = {};

  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const items = Array.isArray(body.items) ? body.items : null;

  if (!items || items.length === 0) {
    return NextResponse.json({ error: 'items must be a non-empty array.' }, { status: 400 });
  }

  let rows: {
    counterparty_id: null;
    counterparty: string;
    amount: number;
    expected_date: string;
    kind: 'fixed' | 'planned';
    notes: string | null;
  }[] = [];

  try {
    rows = items.map((item, index) => {
      const name = (item.counterparty_name || '').trim();
      const expectedDate = (item.expected_date || '').trim();
      const amount = Number(item.amount);

      if (!name || !expectedDate || !Number.isFinite(amount)) {
        throw new Error(`Invalid inflow at index ${index}.`);
      }

      return {
        counterparty_id: null,
        counterparty: name,
        amount,
        expected_date: expectedDate,
        kind: item.kind ?? 'fixed',
        notes: item.notes ?? null,
      };
    });

    const { data, error } = await supabase.from('incoming_payments').insert(rows).select('id');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ inserted: data?.length ?? 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to insert inflows.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
