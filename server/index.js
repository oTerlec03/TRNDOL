"use strict";

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const express = require("express");
const axios = require("axios");

console.log("RUNNING FILE:", __filename);
console.log("CWD:", process.cwd());

const app = express();
app.use(express.json({ limit: "6mb" }));

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 3000;
const SELLER_ID = process.env.SELLER_ID;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

// Çalışan aile:
const BASE_APIGW = process.env.BASE_APIGW || "https://apigw.trendyol.com";
// Product Update için sapigw yolu (host aynı kalabilir, path farklı):
const BASE_SAPIGW = process.env.BASE_SAPIGW || "https://apigw.trendyol.com";

function assertEnv() {
  if (!SELLER_ID) throw new Error("ENV eksik: SELLER_ID");
  if (!API_KEY) throw new Error("ENV eksik: API_KEY");
  if (!API_SECRET) throw new Error("ENV eksik: API_SECRET");
}

function headers() {
  const token = Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "User-Agent": `TomaxWeb/1.0 (SellerId:${SELLER_ID})`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function pickError(err) {
  return {
    message: err?.message || "Unknown error",
    status: err?.response?.status || null,
    detail: err?.response?.data || null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

// =====================
// Storage (quantity yedeği)
// =====================
const DATA_DIR = path.join(__dirname, "data");
const STOCK_BACKUP_FILE = path.join(DATA_DIR, "stock-backup.json");

async function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STOCK_BACKUP_FILE)) {
    await fsp.writeFile(
      STOCK_BACKUP_FILE,
      JSON.stringify({ version: 1, items: {} }, null, 2),
      "utf8"
    );
  }
}

async function readBackup() {
  await ensureDataDir();
  const raw = await fsp.readFile(STOCK_BACKUP_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeBackup(obj) {
  await ensureDataDir();
  await fsp.writeFile(STOCK_BACKUP_FILE, JSON.stringify(obj, null, 2), "utf8");
}

// =====================
// Logs
// =====================
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// =====================
// Health + debug
// =====================
app.get("/health", (_, res) => res.status(200).send("OK"));

app.get("/debug/config", (_, res) => {
  res.json({
    runningFile: __filename,
    cwd: process.cwd(),
    port: String(PORT),
    sellerId: String(SELLER_ID || ""),
    baseApigw: BASE_APIGW,
    baseSapigw: BASE_SAPIGW,
    backupFile: STOCK_BACKUP_FILE,
  });
});

// =====================
// Trendyol test (1 ürün getir)
// =====================
app.get("/trendyol/test", async (_, res) => {
  try {
    assertEnv();
    const url = `${BASE_APIGW}/integration/product/sellers/${SELLER_ID}/products?page=0&size=1`;
    const r = await axios.get(url, { headers: headers(), timeout: 20000 });
    res.json({ success: true, status: r.status, data: r.data });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success: false, ...e });
  }
});

// =====================
// PRODUCTS list
// =====================
app.get("/api/products", async (req, res) => {
  try {
    assertEnv();
    const page = Number(req.query.page ?? 0);
    const size = Number(req.query.size ?? 20);
    const url = `${BASE_APIGW}/integration/product/sellers/${SELLER_ID}/products?page=${page}&size=${size}`;
    const r = await axios.get(url, { headers: headers(), timeout: 25000 });
    res.json({ success: true, status: r.status, data: r.data });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success: false, ...e });
  }
});

// Client-side filtre (archived)
app.get("/api/products/filter", async (req, res) => {
  try {
    assertEnv();
    const page = Number(req.query.page ?? 0);
    const size = Number(req.query.size ?? 20);
    const archived = req.query.archived;

    const url = `${BASE_APIGW}/integration/product/sellers/${SELLER_ID}/products?page=${page}&size=${size}`;
    const r = await axios.get(url, { headers: headers(), timeout: 25000 });

    let content = r.data.content || [];
    if (archived === "true") content = content.filter((p) => p.archived === true);
    if (archived === "false") content = content.filter((p) => p.archived === false);

    res.json({ success: true, content });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success: false, ...e });
  }
});

// =====================
// INVENTORY: price & stock
// =====================
async function postPriceAndInventory(items) {
  const url = `${BASE_APIGW}/integration/inventory/sellers/${SELLER_ID}/products/price-and-inventory`;
  return axios.post(url, { items }, { headers: headers(), timeout: 30000 });
}

app.post("/api/inventory/price-and-stock", async (req, res) => {
  try {
    assertEnv();
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "items array zorunlu" });
    }
    const r = await postPriceAndInventory(items);
    res.json({ success: true, status: r.status, data: r.data });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success: false, ...e });
  }
});

// =====================
// PASIF/AKTIF (quantity=0)
// =====================
app.post("/api/products/disable", async (req, res) => {
  try {
    assertEnv();
    const barcodes = req.body.barcodes;
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ success: false, message: 'Body: { "barcodes":["CLH..."] }' });
    }

    const backup = await readBackup();
    backup.items = backup.items || {};

    const normalized = barcodes.map((b) => String(b).trim()).filter(Boolean);
    const toUpdate = normalized.map((barcode) => {
      if (!backup.items[barcode]) {
        backup.items[barcode] = { lastKnownQuantity: null, savedAt: nowIso() };
      }
      return { barcode, quantity: 0 };
    });

    await writeBackup(backup);

    console.log("[DISABLE] quantity=0 =>", toUpdate.slice(0, 5));
    const r = await postPriceAndInventory(toUpdate);

    res.json({
      success: true,
      status: r.status,
      message: "Pasif edildi: quantity=0 gönderildi.",
      updatedCount: toUpdate.length,
      data: r.data,
    });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success: false, ...e });
  }
});

app.post("/api/products/enable", async (req, res) => {
  try {
    assertEnv();
    const barcodes = req.body.barcodes;
    const defaultQuantity = req.body.defaultQuantity;

    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ success: false, message: 'Body: { "barcodes":["CLH..."], "defaultQuantity": 10 }' });
    }

    const backup = await readBackup();
    backup.items = backup.items || {};

    const normalized = barcodes.map((b) => String(b).trim()).filter(Boolean);

    const toUpdate = normalized.map((barcode) => {
      const saved = backup.items[barcode]?.lastKnownQuantity;
      const qty =
        Number.isFinite(saved) && saved !== null
          ? Number(saved)
          : (Number.isFinite(Number(defaultQuantity)) ? Number(defaultQuantity) : 10);

      backup.items[barcode] = { lastKnownQuantity: qty, savedAt: nowIso() };
      return { barcode, quantity: qty };
    });

    await writeBackup(backup);

    console.log("[ENABLE] restore qty =>", toUpdate.slice(0, 5));
    const r = await postPriceAndInventory(toUpdate);

    res.json({
      success: true,
      status: r.status,
      message: "Aktif edildi: quantity geri set edildi.",
      updatedCount: toUpdate.length,
      data: r.data,
    });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success: false, ...e });
  }
});

app.get("/api/backup", async (_, res) => {
  try {
    const backup = await readBackup();
    res.json({ success: true, data: backup });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

app.post("/api/backup/set", async (req, res) => {
  try {
    const barcode = String(req.body.barcode || "").trim();
    const quantity = Number(req.body.quantity);

    if (!barcode) return res.status(400).json({ success: false, message: "barcode zorunlu" });
    if (!Number.isFinite(quantity)) return res.status(400).json({ success: false, message: "quantity sayı olmalı" });

    const backup = await readBackup();
    backup.items = backup.items || {};
    backup.items[barcode] = { lastKnownQuantity: quantity, savedAt: nowIso() };
    await writeBackup(backup);

    res.json({ success: true, message: "Backup quantity kaydedildi.", barcode, quantity });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

// =====================
// ARCHIVE / UNARCHIVE (Senin çalışıyor dediğin kısım)
// Not: Burada endpointi sabitlemedim; senin elindeki çalışan versiyon farklıysa
// bu blokları kendi çalışan sürümünle değiştir.
// =====================
async function archiveProducts(items) {
  // Burayı senin çalışan endpointin ile KİLİTLEMEK daha iyi.
  // Şimdilik en yaygın görülen entegrasyon yolu:
  const url = `${BASE_APIGW}/integration/product/sellers/${SELLER_ID}/archive-products`;
  return axios.put(url, { items }, { headers: headers(), timeout: 30000 });
}

app.post("/api/products/archive", async (req, res) => {
  try {
    assertEnv();
    const barcodes = req.body.barcodes;
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ success:false, message:'Body: { "barcodes":["CLH..."] }' });
    }

    const items = barcodes.map(b => ({ barcode: String(b).trim(), archived: true }));
    const r = await archiveProducts(items);

    res.json({ success:true, status:r.status, data:r.data, usedUrl: r.config?.url });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success:false, ...e });
  }
});

app.post("/api/products/unarchive", async (req, res) => {
  try {
    assertEnv();
    const barcodes = req.body.barcodes;
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ success:false, message:'Body: { "barcodes":["CLH..."] }' });
    }

    const items = barcodes.map(b => ({ barcode: String(b).trim(), archived: false }));
    const r = await archiveProducts(items);

    res.json({ success:true, status:r.status, data:r.data, usedUrl: r.config?.url });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success:false, ...e });
  }
});

// =====================
// TITLE UPDATE (barkoddan ürünü bul -> sapigw Product Update dene)
// =====================
async function findProductByBarcode(barcode) {
  const target = String(barcode).trim();
  const size = 200;

  for (let page = 0; page < 20; page++) { // 20*200=4000 ürün tarama limiti
    const url = `${BASE_APIGW}/integration/product/sellers/${SELLER_ID}/products?page=${page}&size=${size}`;
    const r = await axios.get(url, { headers: headers(), timeout: 30000 });
    const content = r.data?.content || [];
    const hit = content.find(p => String(p.barcode).trim() === target);
    if (hit) return hit;
    if (!content.length) break;
  }
  return null;
}

async function trendyolProductUpdate(items) {
  const url = `${BASE_SAPIGW}/sapigw/suppliers/${SELLER_ID}/v2/products`;
  return axios.put(url, { items }, { headers: headers(), timeout: 30000 });
}

app.post("/api/products/update-title", async (req, res) => {
  try {
    assertEnv();
    const barcode = String(req.body.barcode || "").trim();
    const newTitle = String(req.body.title || "").trim();

    if (!barcode) return res.status(400).json({ success:false, message:"barcode zorunlu" });
    if (!newTitle) return res.status(400).json({ success:false, message:"title zorunlu" });

    const p = await findProductByBarcode(barcode);
    if (!p) return res.status(404).json({ success:false, message:"Bu barkod ile ürün bulunamadı (listelemeden)." });

    // Best-effort payload: Trendyol eksik alan isterse response'ta görürüz.
    const item = {
      barcode: p.barcode,
      title: newTitle,

      productMainId: p.productMainId,
      brandId: p.brandId,
      categoryId: p.pimCategoryId,
      description: p.description,

      images: (p.images || []).map(x => ({ url: x.url })),

      attributes: (p.attributes || []).map(a => ({
        attributeId: a.attributeId,
        attributeValueId: a.attributeValueId
      })),
    };

    console.log("[TITLE-UPDATE] sending item keys =>", Object.keys(item));

    const r = await trendyolProductUpdate([item]);

    res.json({
      success: true,
      status: r.status,
      usedUrl: r.config?.url,
      data: r.data
    });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success:false, ...e });
  }
});

// =====================
// ORDERS
// =====================
app.get("/api/orders", async (req, res) => {
  try {
    assertEnv();
    const url = `${BASE_APIGW}/integration/order/sellers/${SELLER_ID}/shipment-packages`;
    const r = await axios.get(url, { headers: headers(), params: req.query, timeout: 30000 });
    res.json({ success: true, status: r.status, data: r.data });
  } catch (err) {
    const e = pickError(err);
    res.status(e.status || 500).json({ success: false, ...e });
  }
});

// =====================
// Static panel
// =====================
app.use("/", express.static(path.join(__dirname, "public")));

// =====================
// START
// =====================
app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Panel:          http://localhost:${PORT}/`);
  console.log(`Health:         http://localhost:${PORT}/health`);
  console.log(`Debug config:   http://localhost:${PORT}/debug/config`);
  console.log(`Backup view:    http://localhost:${PORT}/api/backup`);
});