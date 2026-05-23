# Supabase Backend

Dashboard tetap bisa dipakai tanpa backend. Backend Supabase dipakai untuk cloud sync lintas device.

## Schema

Migration:

```text
supabase/migrations/20260523000100_trading_control_room_snapshots.sql
```

Tabel yang dibuat:

- `public.trading_control_snapshots`
- Satu row per `auth.users.id`
- Semua data jurnal disimpan sebagai JSON snapshot
- Row Level Security aktif
- User hanya bisa baca/tulis row miliknya sendiri

## Frontend Config

Di tab `Backend`, isi:

- Supabase project URL
- Supabase publishable/anon key
- Email login

Config ini disimpan di browser localStorage dan tidak masuk ke GitHub.

## Apply Migration

Jika memakai project baru atau existing project yang memang khusus untuk dashboard ini, apply SQL migration di Supabase SQL editor atau lewat Supabase CLI.

Jangan apply migration ini ke project yang tidak terkait tanpa konfirmasi, karena akan menambah tabel baru di schema `public`.
