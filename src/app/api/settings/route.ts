import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { data, error } = await supabase.from('app_settings').select('*').eq('key', SETTINGS_KEY).maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ settings: normalizeSettings(data ?? DEFAULT_SETTINGS) });
}

export async function POST(request: Request) {
  const body = await request.json();
  const cnyRate = Number(body.cnyRate ?? body.cny_rate ?? 0);

  const value = normalizeSettings({ cnyRate });

  const { data, error } = await supabase
    .from('app_settings')
    .upsert({ key: SETTINGS_KEY, value })
    .select('*')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ settings: normalizeSettings(data ?? DEFAULT_SETTINGS) });
}
