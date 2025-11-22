import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { data, error } = await supabase.from('accounts').select('*').order('created_at');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, balance } = body;

  if (!name) {
    return NextResponse.json({ error: 'Название счёта обязательно' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('accounts')
    .insert([{ name, balance: Number(balance) || 0 }])
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const { id, name, balance } = body;

  if (!id) {
    return NextResponse.json({ error: 'Не указан id счёта' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('accounts')
    .update({ name, balance: Number(balance) })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
