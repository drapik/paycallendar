import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function parseDay(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const day = Math.trunc(parsed);
  if (day < 1 || day > 31) return null;
  return day;
}

function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export async function GET() {
  const { data, error } = await supabase.from('planned_expenses').select('*').order('created_at');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { title, amount, day_primary, day_secondary, amount_primary, amount_secondary } = body;

  const primaryDay = parseDay(day_primary);
  const secondaryDay = parseDay(day_secondary);
  const totalAmount = parseAmount(amount);
  const primaryAmount = parseAmount(amount_primary);
  const secondaryAmount = parseAmount(amount_secondary);

  if (!title || totalAmount === null || !primaryDay) {
    return NextResponse.json({ error: 'Не хватает данных расхода' }, { status: 400 });
  }

  if (totalAmount < 0) {
    return NextResponse.json({ error: 'Сумма расхода не может быть отрицательной' }, { status: 400 });
  }

  if (day_secondary && !secondaryDay) {
    return NextResponse.json({ error: 'Неверная дополнительная дата расхода' }, { status: 400 });
  }

  let resolvedPrimary: number | null = null;
  let resolvedSecondary: number | null = null;

  if (secondaryDay) {
    if (primaryAmount === null && secondaryAmount === null) {
      return NextResponse.json({ error: 'Укажите хотя бы одну сумму для двух дат' }, { status: 400 });
    }

    resolvedPrimary = primaryAmount;
    resolvedSecondary = secondaryAmount;

    if (resolvedPrimary !== null && resolvedSecondary === null) {
      resolvedSecondary = totalAmount - resolvedPrimary;
    }

    if (resolvedSecondary !== null && resolvedPrimary === null) {
      resolvedPrimary = totalAmount - resolvedSecondary;
    }

    if (resolvedPrimary === null || resolvedSecondary === null) {
      return NextResponse.json({ error: 'Не удалось рассчитать суммы расхода' }, { status: 400 });
    }

    if (resolvedPrimary < 0 || resolvedSecondary < 0) {
      return NextResponse.json({ error: 'Суммы частей не могут быть отрицательными' }, { status: 400 });
    }

    if (Math.abs(resolvedPrimary + resolvedSecondary - totalAmount) > 0.01) {
      return NextResponse.json({ error: 'Сумма частей должна равняться общей сумме' }, { status: 400 });
    }
  }

  const { data, error } = await supabase
    .from('planned_expenses')
    .insert([
      {
        title,
        amount: totalAmount,
        amount_primary: secondaryDay ? resolvedPrimary : null,
        amount_secondary: secondaryDay ? resolvedSecondary : null,
        day_primary: primaryDay,
        day_secondary: secondaryDay,
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
    return NextResponse.json({ error: 'Не указан id расхода' }, { status: 400 });
  }

  const { error } = await supabase.from('planned_expenses').delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
