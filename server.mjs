// PO → Gemini → Notion demo.
//
// One page: upload a PO PDF, Gemini extracts it, then a Project page (plus one
// Job row per PO line) is created in Notion. No dependencies — Node 20+ only.
//
//   POST /api/extract  multipart {file}          -> extracted PO JSON
//   POST /api/notion   multipart {file, po}      -> { url } of the new Project page

import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

const env = (name, fallback) => process.env[name] || fallback;

const PORT = Number(env("PORT", 3000));
const GEMINI_API_KEY = env("GEMINI_API_KEY");
const GEMINI_MODEL = env("GEMINI_MODEL", "gemini-3.5-flash-lite");
const NOTION_API_KEY = env("NOTION_API_KEY");
const PROJECT_DS = env("NOTION_PROJECT_DATA_SOURCE_ID", "0d5275a3-dd53-82d7-8c5b-87a972cb1a47");
const JOB_DS = env("NOTION_JOB_DATA_SOURCE_ID", "f33275a3-dd53-8230-80d5-07caf490132b");
const OWN_COMPANY_NAME = env("OWN_COMPANY_NAME", "");
const DEMO_PASSWORD = env("DEMO_PASSWORD", "");

const MAX_PDF_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------- Gemini

function buildPrompt() {
  const ownCompany = OWN_COMPANY_NAME
    ? `\nThe PO was sent TO "${OWN_COMPANY_NAME}" (the supplier). Never return
"${OWN_COMPANY_NAME}" as the customer — the customer is whoever ISSUED the PO
(the letterhead at the top of the document).\n`
    : "";

  return `You are extracting data from a Purchase Order (PO) PDF. If the document
is a similar commercial document instead (quotation, invoice, sales order), extract
it the same way, using its document number as po_number.
The customer is the company that ISSUED the PO — its letterhead/logo is at the
top of the document. Many POs print their own "VENDOR:" or "SUPPLIER:" box;
that is who the PO is addressed to, NOT the customer.
${ownCompany}
Return ONLY strict JSON in exactly this shape, no markdown:
{
  "po_number": "string, the PO/order number, empty if not found",
  "customer": "string, the issuing company's name, empty if not found",
  "po_date": "string, ISO 8601 date YYYY-MM-DD, empty if not found. Use locale cues (country, spelled-out months) to decide between DD/MM and MM/DD.",
  "title": "string, a short description of what the PO is for — its own title/subject/project line if it has one, else summarise the items in under 15 words",
  "ship_to_address": "string, the full Ship To / delivery address, empty if none",
  "currency": "string, ISO currency code such as MYR or USD, empty if not shown",
  "subtotal_amount": "number, total before tax, 0 if not shown",
  "tax_amount": "number, tax/SST/GST amount, 0 if not shown",
  "total_amount": "number, grand total including tax, 0 if not shown",
  "payment_terms_days": "number, payment terms in days (e.g. Net 30 -> 30), 0 if not stated",
  "line_items": [
    { "description": "string", "quantity": 0, "unit_price": 0, "amount": 0 }
  ],
  "confident": true or false,
  "reason": "string, only when confident is false: what is missing or unclear"
}

Set "confident" to true only if you found a clear po_number, customer and at
least one line item. Never invent values — leave them empty/0 instead.`;
}

// Forces Gemini's reply into exactly this shape (structured output).
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    po_number: { type: "STRING" },
    customer: { type: "STRING" },
    po_date: { type: "STRING" },
    title: { type: "STRING" },
    ship_to_address: { type: "STRING" },
    currency: { type: "STRING" },
    subtotal_amount: { type: "NUMBER" },
    tax_amount: { type: "NUMBER" },
    total_amount: { type: "NUMBER" },
    payment_terms_days: { type: "NUMBER" },
    line_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unit_price: { type: "NUMBER" },
          amount: { type: "NUMBER" },
        },
        required: ["description"],
      },
    },
    confident: { type: "BOOLEAN" },
    reason: { type: "STRING" },
  },
  required: ["po_number", "customer", "line_items", "confident"],
};

// Even with a schema, models occasionally wrap the object in an array, nest
// it under a key, or fence it in markdown. Dig the PO object out of any of those.
function unwrapPO(value) {
  if (Array.isArray(value)) return unwrapPO(value[0]);
  if (value && typeof value === "object") {
    if ("po_number" in value || "line_items" in value) return value;
    const nested = Object.values(value).find((v) => v && typeof v === "object");
    if (nested) return unwrapPO(nested);
  }
  return value ?? {};
}

function parseModelJson(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return unwrapPO(JSON.parse(cleaned));
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

async function extractPO(pdfBuffer) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: buildPrompt() },
            { inline_data: { mime_type: "application/pdf", data: pdfBuffer.toString("base64") } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no content");

  let parsed;
  try {
    parsed = parseModelJson(text);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 300)}`);
  }

  const lineItems = (Array.isArray(parsed.line_items) ? parsed.line_items : [])
    .filter((li) => li && str(li.description))
    .map((li) => ({
      description: str(li.description),
      quantity: toNumber(li.quantity),
      unit_price: toNumber(li.unit_price),
      amount: toNumber(li.amount),
    }));

  return {
    po_number: str(parsed.po_number),
    customer: str(parsed.customer),
    po_date: /^\d{4}-\d{2}-\d{2}$/.test(str(parsed.po_date)) ? str(parsed.po_date) : "",
    title: str(parsed.title),
    ship_to_address: str(parsed.ship_to_address),
    currency: str(parsed.currency),
    subtotal_amount: toNumber(parsed.subtotal_amount),
    tax_amount: toNumber(parsed.tax_amount),
    total_amount: toNumber(parsed.total_amount),
    payment_terms_days: toNumber(parsed.payment_terms_days),
    line_items: lineItems,
    confident: parsed.confident === true,
    reason: str(parsed.reason),
    model: GEMINI_MODEL,
    _raw: text,
  };
}

// ---------------------------------------------------------------- Notion

const NOTION_VERSION = "2025-09-03";
const text = (content) => [{ text: { content: String(content).slice(0, 2000) } }];

async function notion(path, method, body) {
  if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY is not set");
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion API error ${res.status} on ${path}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function uploadPdf(pdfBuffer, filename) {
  const created = await notion("/file_uploads", "POST", { filename });
  const form = new FormData();
  form.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), filename);
  const res = await fetch(`https://api.notion.com/v1/file_uploads/${created.id}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Notion-Version": NOTION_VERSION },
    body: form,
  });
  if (!res.ok) throw new Error(`Notion file upload error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return created.id;
}

async function findExistingProject(poNumber) {
  if (!poNumber) return null;
  const result = await notion(`/data_sources/${PROJECT_DS}/query`, "POST", {
    filter: { property: "Purchase Order No.", rich_text: { equals: poNumber } },
    page_size: 1,
  });
  return result.results[0] ?? null;
}

async function writeToNotion(po, pdfBuffer, filename) {
  const existing = await findExistingProject(po.po_number);
  if (existing) return { url: existing.url, duplicate: true, jobs: 0 };

  const fileUploadId = await uploadPdf(pdfBuffer, filename);

  const properties = {
    "Project Title": {
      title: text(po.title || [po.customer, po.po_number].filter(Boolean).join(" — ") || filename),
    },
  };
  if (po.po_number) properties["Purchase Order No."] = { rich_text: text(po.po_number) };
  // Contract Value is pre-tax; use the grand total only when no tax is shown.
  const contractValue = po.subtotal_amount || (po.tax_amount ? 0 : po.total_amount);
  if (contractValue) properties["Contract Value"] = { number: contractValue };
  if (po.tax_amount) properties["SST"] = { number: po.tax_amount };
  if (po.total_amount) properties["Total Contract Value (Inclusive SST)"] = { number: po.total_amount };
  if (po.payment_terms_days) properties["Payment Terms (days)"] = { number: po.payment_terms_days };

  // Project DB has no customer-name, PO-date or file property, so those go
  // in the page body.
  const summary = [
    `Created from an uploaded PO, read by Gemini (${po.model}).`,
    po.customer && `Customer: ${po.customer}`,
    po.po_number && `PO number: ${po.po_number}`,
    po.po_date && `PO date: ${po.po_date}`,
    po.ship_to_address && `Ship to: ${po.ship_to_address}`,
  ]
    .filter(Boolean)
    .join("\n");

  const page = await notion("/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: PROJECT_DS },
    properties,
    children: [
      { object: "block", type: "callout", callout: { rich_text: text(summary), icon: { emoji: "📥" } } },
      { object: "block", type: "file", file: { type: "file_upload", file_upload: { id: fileUploadId }, name: filename } },
    ],
  });

  for (const [i, item] of po.line_items.entries()) {
    const props = {
      Name: { title: text(item.description) },
      "Line Item": { number: i + 1 },
      Project: { relation: [{ id: page.id }] },
      "Record Type": { select: { name: "Activity" } },
    };
    if (po.po_number) props["CUSTOMER PO"] = { rich_text: text(po.po_number) };
    if (item.amount) props["Line Value"] = { number: item.amount };
    if (item.quantity) props["Remarks"] = { rich_text: text(`Qty: ${item.quantity}`) };
    await notion("/pages", "POST", { parent: { type: "data_source_id", data_source_id: JOB_DS }, properties: props });
  }

  return { url: page.url, duplicate: false, jobs: po.line_items.length };
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!DEMO_PASSWORD) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const password = Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(password);
  const b = Buffer.from(DEMO_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readForm(req) {
  const length = Number(req.headers["content-length"] ?? 0);
  if (length > MAX_PDF_BYTES * 1.5) throw Object.assign(new Error("File too large (max 15 MB)"), { status: 413 });
  const request = new Request("http://local/", { method: "POST", headers: req.headers, body: req, duplex: "half" });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) throw Object.assign(new Error("No PDF uploaded"), { status: 400 });
  if (file.size > MAX_PDF_BYTES) throw Object.assign(new Error("File too large (max 15 MB)"), { status: 413 });
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw Object.assign(new Error("That file isn't a PDF"), { status: 400 });
  }
  return { form, buffer, filename: file.name || "purchase-order.pdf" };
}

const indexHtml = await readFile(new URL("./public/index.html", import.meta.url));

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="PO demo"' });
      return res.end("Password required");
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(indexHtml);
    }

    if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });

    if (req.method === "POST" && req.url === "/api/extract") {
      const { buffer, filename } = await readForm(req);
      const started = Date.now();
      const { _raw, ...po } = await extractPO(buffer);
      console.log(
        `[extract] ${filename}: PO ${po.po_number || "?"}, ${po.line_items.length} line(s) (${Date.now() - started} ms)`
      );
      if (!po.po_number) console.log(`[extract] ${filename}: raw Gemini reply: ${_raw.slice(0, 1500)}`);
      return sendJson(res, 200, { po, ms: Date.now() - started });
    }

    if (req.method === "POST" && req.url === "/api/notion") {
      const { form, buffer, filename } = await readForm(req);
      const po = JSON.parse(String(form.get("po") ?? "{}"));
      const result = await writeToNotion(po, buffer, filename);
      console.log(`[notion] PO ${po.po_number || "?"}: ${result.duplicate ? "duplicate" : "created"} ${result.url}`);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, err.status ?? 500, { error: err.message ?? String(err) });
  }
});

server.listen(PORT, () => console.log(`PO demo listening on :${PORT}`));
