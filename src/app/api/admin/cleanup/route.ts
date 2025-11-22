import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type CleanupTarget = 'all' | 'accounts' | 'suppliers' | 'counterparties' | 'orders' | 'inflows';

const TABLES: Record<Exclude<CleanupTarget, 'all'>, string> = {
  accounts: 'accounts',
  suppliers: 'suppliers',
  counterparties: 'counterparties',
  orders: 'supplier_orders',
  inflows: 'incoming_payments',
};

async function purgeTable(table: string) {
  const { data, error } = await supabase.from(table).delete().not('id', 'is', null).select('id');

  if (error) {
    throw new Error(error.message);
  }

  return data?.length ?? 0;
}

async function purgeAllTables() {
  const results: Record<string, number> = {};

  for (const table of Object.values(TABLES)) {
    results[table] = await purgeTable(table);
  }

  return results;
}

export async function POST(request: Request) {
  let target: CleanupTarget | undefined;

  try {
    const body = (await request.json()) as { target?: CleanupTarget };
    target = body.target;
  } catch {
    // ignore parsing errors, will validate below
  }

  if (!target || (target !== 'all' && !TABLES[target])) {
    return NextResponse.json(
      {
        error:
          'Укажите цель очистки: all, accounts, suppliers, counterparties, orders или inflows в поле target тела запроса.',
      },
      { status: 400 },
    );
  }

  try {
    if (target === 'all') {
      const results = await purgeAllTables();
      return NextResponse.json({ cleared: 'all', details: results });
    }

    const table = TABLES[target];
    const deleted = await purgeTable(table);
    return NextResponse.json({ cleared: target, deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось выполнить очистку';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
