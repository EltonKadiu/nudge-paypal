import "dotenv/config";
import { pp } from "./paypal.js";

const cancel = new Set(["0005", "0006", "0007", "0008"]);
const data = await pp(
  "GET",
  "/v2/invoicing/invoices?page=1&page_size=50&total_required=true",
);
for (const inv of data.items || []) {
  const n = inv.detail?.invoice_number;
  if (!cancel.has(n)) continue;
  try {
    await pp("POST", `/v2/invoicing/invoices/${inv.id}/cancel`, {
      subject: "Duplicate demo invoice",
      note: "Cancelled duplicate",
      send_to_invoicer: false,
      send_to_recipient: false,
    });
    console.log("Cancelled", n);
  } catch (e) {
    console.error("FAILED", n, e.message);
  }
}
