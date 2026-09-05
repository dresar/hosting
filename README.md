# Temporary File Hosting (Video) - Node.js + Express

Aplikasi Node.js + Express untuk temporary file hosting khusus video (`.mp4`, `.mov`, `.avi`)
yang sepenuhnya publik, dengan fitur:

- Upload file via API (tanpa login, tanpa API key)
- Direct download / streaming (mendukung HTTP Range untuk video streaming, misalnya Instagram API)
- Auto cleanup: hapus file otomatis setelah 3 jam
- CORS aktif untuk semua origin
- Health check endpoint
- Logging upload dan cleanup

---

## 1. Struktur Folder

```text
file-hosting/
├── server.js
├── package.json
├── .env.example
├── uploads/         # folder penyimpanan file (harus bisa ditulis / writable)
└── README.md
```

Pastikan folder `uploads/` ada dan bisa ditulis oleh proses Node.js (permission 755 atau 775
biasanya sudah cukup).

---

## 2. Persyaratan

- Node.js versi **18+** (disarankan)
- NPM sudah terinstall
- Akses ke Terminal / SSH atau panel Node.js di cPanel

---

## 3. Cara Install Secara Lokal

1. Clone / download folder `file-hosting` ke komputer kamu.
2. Masuk ke folder proyek:

   ```bash
   cd file-hosting
   ```

3. Salin file `.env.example` menjadi `.env` (opsional, default sudah cukup untuk lokal).

4. Install dependencies:

   ```bash
   npm install
   ```

5. Jalankan server (mode production sederhana):

   ```bash
   npm start
   ```

   Atau mode development (auto restart saat file berubah):

   ```bash
   npm run dev
   ```

6. Jika berhasil, server akan berjalan di `http://localhost:3000` (atau port yang kamu set di `.env`).

---

## 4. Endpoint API

### 4.1 Health Check

- **Method**: `GET`
- **URL**: `/health`
- **Response contoh**:

  ```json
  {
    "status": "ok",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
  ```

### 4.2 Upload File

- **Method**: `POST`
- **URL**: `/upload`
- **Headers**:
  - tidak perlu auth / API key
- **Body**: `multipart/form-data` dengan field:
  - `file`: file video (`.mp4`, `.mov`, `.avi`), maksimal ukuran **100MB**

**Contoh cURL:**

```bash
curl -X POST "http://localhost:3000/upload" \
  -F "file=@/path/to/video.mp4"
```

**Response sukses:**

```json
{
  "success": true,
  "url": "http://localhost:3000/files/xxxxx.mp4",
  "filename": "xxxxx.mp4",
  "size": 123456
}
```

Field `url` bisa langsung dipakai untuk keperluan API lain (misalnya Instagram API)
karena endpoint `/files/:filename` mendukung streaming dengan HTTP Range.

### 4.3 Download / Streaming File

- **Method**: `GET`
- **URL**: `/files/:filename`
  - `:filename` adalah nama file random yang diberikan oleh server saat upload
- **Contoh**:

  ```bash
  curl -L "http://localhost:3000/files/xxxxx.mp4" -o output.mp4
  ```

- Jika file tidak ditemukan, server akan merespon:

  ```json
  {
    "success": false,
    "message": "File tidak ditemukan"
  }
  ```

- Endpoint ini mendukung header `Range` sehingga bisa digunakan untuk video streaming
oleh klien seperti Instagram API, HTML5 video player, dan lain-lain.

---

## 5. Fitur Keamanan

- **Akses Publik**:
  - Semua endpoint (`/health`, `/upload`, `/files/:filename`) bisa diakses tanpa login.
- **CORS**:
  - Aktif untuk semua origin (`*`), memudahkan integrasi dari frontend mana pun.
- **Validasi Tipe File**:
  - Hanya mengizinkan file dengan ekstensi `.mp4`, `.mov`, `.avi` dan mimetype `video/*`.
- **Error Handling**:
  - Error ditangani secara terpusat:
    - File terlalu besar -> HTTP 413
    - Tipe file tidak diizinkan -> HTTP 400
    - API key invalid -> HTTP 401
    - File tidak ditemukan -> HTTP 404
    - Error internal -> HTTP 500

---

## 6. Auto Cleanup

- Server menjalankan background job setiap **1 jam**.
- Setiap job akan:
  - Membaca semua file di folder `uploads/`
  - Menghapus file yang terakhir dimodifikasi lebih dari **3 jam** yang lalu.
- Setiap file yang dihapus akan dilog ke console, contoh:

  ```text
  [CLEANUP] 2024-01-01T01:23:45.678Z | File dihapus: xxxxx.mp4 | age_ms=10800001
  ```

---

## 7. Logging

- Setiap upload berhasil akan dilog ke console:

  ```text
  [UPLOAD] 2024-01-01T00:00:00.000Z | ip=::1 | filename=xxxxx.mp4 | size=123456 bytes
  ```

- Setiap error dan proses cleanup juga akan tercatat di log.

Pastikan kamu memonitor log (via terminal / log viewer di hosting) untuk debugging
atau audit aktivitas.

---

## 8. Deploy di cPanel Node.js

Langkah umum (bisa sedikit berbeda tergantung provider):

1. **Login ke cPanel**.
2. Cari menu **"Setup Node.js App"** atau sejenisnya.
3. Klik **Create Application**:
   - Pilih versi Node.js (usahakan 18+).
   - Tentukan folder aplikasi, misalnya: `file-hosting`.
4. Upload isi folder proyek ke direktori aplikasi (via:
   - File Manager cPanel, atau
   - `git clone`, atau
   - Upload ZIP kemudian di-extract).
5. Pastikan folder `uploads/` ada dan memiliki permission yang cukup (misalnya 755 / 775).
6. Di halaman Node.js App:
   - Set **Application Startup File** ke `server.js`.
   - Jalankan perintah **"npm install"** dari UI Node.js App (atau dari terminal di folder aplikasi).
7. Atur **Environment Variables**:
   - `PORT` akan diisi otomatis oleh cPanel (biasanya), atau bisa kamu biarkan sesuai default.
8. Klik **Start** atau **Restart** aplikasi Node.js dari panel.
9. cPanel biasanya menyediakan URL atau subdomain untuk mengakses aplikasi.
   Endpoint yang sama tetap berlaku, misalnya:

   - `https://subdomain-kamu.com/health`
   - `https://subdomain-kamu.com/upload`
   - `https://subdomain-kamu.com/files/:filename`

Jika kamu ingin menggunakan domain khusus seperti `https://domain.com/files/xxxxx.mp4`,
pastikan domain atau subdomain diarahkan (proxy) ke aplikasi Node.js ini via pengaturan hosting / DNS / proxy (misalnya menggunakan route via Apache/Nginx ke Node.js app).

---

## 9. Catatan Produksi

- Pertimbangkan untuk:
  - Menambah logging ke file (misal pakai library seperti `winston`) untuk kebutuhan audit.
  - Menambah limit total penyimpanan (quota) jika diperlukan.
- Jangan lupa monitoring disk space karena file video berukuran besar.

---

Selesai.  
Kamu bisa langsung copy seluruh file di atas ke dalam folder `file-hosting`, jalankan `npm install` lalu `npm start`, dan API temporary file hosting-mu siap dipakai. Jika mau, saya bisa bantu buatkan contoh integrasi dengan Instagram API juga.
