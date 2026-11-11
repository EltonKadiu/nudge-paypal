import "dotenv/config";
import { createAndSendInvoice } from "./paypal.js";

const email = process.env.SEED_EMAIL;
if (!email) {
  console.error("Set SEED_EMAIL in .env");
  process.exit(1);
}

const jobs = [
  ["Acme Studio", "Logo redesign", 1200, 2],
  ["Nova Cafe", "Website maintenance (October)", 450, 4],
  ["Pixel Labs", "UX audit", 2800, 6],
  ["Green Fork", "Menu photography", 650, 1],
];
for (const [name, description, amount, dueInDays] of jobs) {
  try {
    const r = await createAndSendInvoice({
      name,
      email,
      description,
      amount,
      dueInDays,
    });
    console.log("Created", r.number, r.id);
  } catch (e) {
    console.error("FAILED:", e.message);
  }
}
