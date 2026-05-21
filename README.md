# Dyna Store

A clean, modern game store demo built with React and Vite.

## Features

- Browse 12 sample games with category filters
- Search by title or genre
- Add to cart with slide-out drawer
- Responsive layout for mobile and desktop

## Quick start (no install)

Open **`index.html`** in the editor preview, double-click it in the folder, or use **`store.html`** (same UI).

**Top up** uses **Bakong KHQR** with **MD5 payment check**:

1. Pick an amount → *Pay with Bakong KHQR*
2. The app builds the KHQR string and its **MD5** hash
3. It polls `POST https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5` every 3 seconds (up to 10 minutes)
4. Token: copy `standalone/bakong.config.example.js` → `standalone/bakong.config.local.js` and paste your JWT (or use **Bakong API settings** in the UI)

```js
window.DYNA_BAKONG_CONFIG = {
  token: 'your_jwt',
  account: 'yourname@aba',
}
```

Browsers cannot call Bakong directly (CORS). Use the optional **proxy URL** (your backend forwards `{ md5, token }` to Bakong) or run without a token for **demo** polling.

### Fix CORS (recommended)

Browsers block direct calls to Bakong. Run the built-in server:

```bash
node server.mjs
```

Then open **http://localhost:8787/index.html** (not the Cursor preview on another port).

Payment checks use `/api/check-md5` on the same server — no CORS errors.

Or double-click **`start.bat`** on Windows.

Replace `MERCHANT.account` in `standalone/khqr.js` with your real Bakong ID for production.

## Run with React (optional)

Requires [Node.js](https://nodejs.org/).

```bash
npm install
npm run dev
```

Open **http://localhost:5173/react.html** for the React version, or run `npm run dev:react`.

## Build for production

```bash
npm run build
npm run preview
```
