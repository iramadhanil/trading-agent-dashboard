# GitHub Pages Setup

Dashboard ini static dan bisa diserve langsung dari folder `docs/`.

## Deploy Otomatis

Repository ini sudah berisi workflow:

```text
.github/workflows/pages.yml
```

Workflow tersebut otomatis deploy folder `docs/` ke GitHub Pages setiap ada push ke branch `master` atau `main`.

## Setup Pertama di GitHub

1. Commit file di folder `docs/` dan `.github/workflows/pages.yml`.
2. Push repository ke GitHub.
3. Buka repository GitHub.
4. Masuk ke `Settings` > `Pages`.
5. Pilih `Build and deployment` > `Source` > `GitHub Actions`.
6. Simpan.

## Privasi

- GitHub Pages pada akun personal sering tetap dapat diakses publik melalui URL Pages. Jangan masukkan data yang terlalu sensitif jika repository atau Pages URL bisa dilihat orang lain.
- Data trading harian disimpan di `localStorage` browser, bukan di GitHub. File deploy tidak berisi jurnal performa Anda.
- Gunakan tombol `Export JSON` secara berkala untuk backup pribadi. Import JSON dipakai kalau pindah browser/device.

## Kalender

- Jadwal 2026-2028 memakai data resmi NYSE/Nasdaq yang dipaketkan di `assets/market-data.js`.
- Tahun setelah itu memakai fallback rule bursa AS umum.
- Jika ada penutupan mendadak seperti national day of mourning atau halt khusus, tambahkan lewat tab `Calendar` > `Manual closure`.
