const BASE = process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com";
let token = null,
  expires = 0;

async function getToken() {
  if (token && Date.now() < expires) return token;
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok)
    throw new Error(`PayPal auth failed: ${j.error_description || r.status}`);
  token = j.access_token;
  expires = Date.now() + (j.expires_in - 60) * 1000;
  return token;
}

export async function pp(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!r.ok)
    throw new Error(
      `PayPal ${r.status} ${data.name || ""}: ${data.message || ""} ${JSON.stringify(data.details || "")}`,
    );
  return data;
}

export async function createAndSendInvoice({
  name,
  email,
  description,
  amount,
  currency = "USD",
  dueInDays = 14,
}) {
  let number;
  try {
    number = (await pp("POST", "/v2/invoicing/generate-next-invoice-number"))
      .invoice_number;
  } catch {
    number = "NUDGE-" + Date.now();
  }
  const due = new Date(Date.now() + Number(dueInDays) * 864e5)
    .toISOString()
    .slice(0, 10);
  const draft = await pp("POST", "/v2/invoicing/invoices", {
    detail: {
      invoice_number: number,
      currency_code: currency,
      note: "Thank you for your business!",
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: due },
    },
    primary_recipients: [
      { billing_info: { business_name: name, email_address: email } },
    ],
    items: [
      {
        name: description,
        quantity: "1",
        unit_amount: {
          currency_code: currency,
          value: Number(amount).toFixed(2),
        },
      },
    ],
  });
  const id = draft.href.split("/").pop();
  await pp("POST", `/v2/invoicing/invoices/${id}/send`, {
    send_to_recipient: true,
    send_to_invoicer: false,
  });
  return { id, number, client: name, amount: Number(amount), currency, due };
}
