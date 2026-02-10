import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const file = path.join(process.cwd(), 'public', 'data', 'pool_volume.json');
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
