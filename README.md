# Gemini AI Demo: PO → Notion

Upload a purchase order PDF. Gemini reads it, shows you what it extracted, and
with one click creates the PO in Notion as a **Project** with one **Job** row
per PO line.

```
Upload PDF  →  Gemini extracts fields + line items  →  Notion Project + Job rows
```

One file of server code (`server.mjs`), one page (`public/index.html`), no
dependencies. Needs Node 20+.

## What goes where in Notion

| Extracted | Notion property | Data source |
|---|---|---|
| PO title / subject (fallback: `customer — PO number`) | `Project Title` | Project |
| PO number | `Purchase Order No.` | Project |
| Subtotal before tax | `Contract Value` | Project |
| Tax | `SST` | Project |
| Grand total | `Total Contract Value (Inclusive SST)` | Project |
| Payment terms | `Payment Terms (days)` | Project |
| Customer, PO date, ship-to, the PDF | page body | Project |
| Line description | `Name` | Job |
| Line number | `Line Item` | Job |
| Line amount | `Line Value` | Job |
| Quantity | `Remarks` (`Qty: N`) | Job |
| PO number | `CUSTOMER PO` | Job |
| — | `Record Type` = Activity, `Project` → the new Project | Job |

If a Project with the same PO number already exists, nothing new is created and
the page links to the existing one.

## Setup

1. **Gemini key:** create one at <https://aistudio.google.com/apikey>.
2. **Notion integration:** at <https://www.notion.so/profile/integrations>,
   create an internal integration with *Read*, *Insert* and *Update content*.
   Then open the database that holds the Project and Job data sources →
   `•••` → **Connections** → add the integration.
3. Set the environment variables (see `.env.example`):

| Variable | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | yes | |
| `NOTION_API_KEY` | yes | the integration's secret |
| `NOTION_PROJECT_DATA_SOURCE_ID` | no | defaults to `0d5275a3-dd53-82d7-8c5b-87a972cb1a47` |
| `NOTION_JOB_DATA_SOURCE_ID` | no | defaults to `f33275a3-dd53-8230-80d5-07caf490132b` |
| `GEMINI_MODEL` | no | defaults to `gemini-3.5-flash-lite` |
| `OWN_COMPANY_NAME` | no | the company receiving the POs, so Gemini never picks it as the customer |
| `DEMO_PASSWORD` | no | if set, the page asks for this password (any username) |

## Run locally

```bash
export GEMINI_API_KEY=... NOTION_API_KEY=...
npm start          # http://localhost:3000
```

## Deploy on Railway

Create a service from this repo. Railway detects Node and runs `npm start`;
it provides `PORT` automatically. Add the variables above on the service, then
**Settings → Networking → Generate Domain** to get a public URL.

Set `DEMO_PASSWORD` if the URL will be shared, since anyone who can open the
page can create pages in Notion.

## Sample PO

`samples/sample-po.pdf` is a made-up 3-line PO (from Lembah Jernih Water
Services, RM 154,440 incl. SST) to try the demo with. `samples/sample-po.html`
is its source if you want to tweak it and print a new PDF.
