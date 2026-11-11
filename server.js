import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { pp, createAndSendInvoice } from "./paypal.js";

for (const k of [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
])
  if (!process.env[k]) console.warn(`WARNING: ${k} is not set`);

const app = express();
app.use(express.json());
app.use(express.static("public"));

const ai = new OpenAI({
  baseURL: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
});
const MODEL = process.env.LLM_MODEL;
const clean = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

let dayOffset = 0; // demo clock (simulated days)
const now = () => new Date(Date.now() + dayOffset * 864e5);
const reminderLog = new Map(); // invoiceId -> [{at, tone}]
const proposals = new Map(); // id -> proposal
let nextProposal = 1;
const UNPAID = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"]);

async function getRows() {
  const data = await pp(
    "GET",
    "/v2/invoicing/invoices?page=1&page_size=50&total_required=true",
  );
  const today = now();
  const pending = new Set(
    [...proposals.values()]
      .filter((p) => p.status === "pending")
      .map((p) => p.invoiceId),
  );
  return (data.items || [])
    .map((inv) => {
      const b = inv.primary_recipients?.[0]?.billing_info || {};
      const due = inv.detail?.payment_term?.due_date || null;
      let daysOverdue = 0;
      if (UNPAID.has(inv.status) && due) {
        const diff = today - new Date(due + "T23:59:59Z");
        daysOverdue = diff > 0 ? Math.ceil(diff / 864e5) : 0;
      }
      return {
        id: inv.id,
        number: inv.detail?.invoice_number,
        client:
          b.business_name ||
          b.name?.full_name ||
          [b.name?.given_name, b.name?.surname].filter(Boolean).join(" ") ||
          b.email_address ||
          "Unknown",
        email: b.email_address || "",
        amount: Number(inv.amount?.value ?? 0),
        currency: inv.amount?.currency_code || "USD",
        status: inv.status,
        due,
        daysOverdue,
        reminders: (reminderLog.get(inv.id) || []).length,
        pendingProposal: pending.has(inv.id),
      };
    })
    .sort((a, b) => (a.due || "").localeCompare(b.due || ""));
}

// ---------- Agent ----------
const tools = [
  {
    name: "list_invoices",
    description:
      "List all PayPal invoices with status, due date, days overdue, reminders already sent, and whether a reminder is already awaiting approval.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_and_send_invoice",
    description: "Create a PayPal invoice and email it to the client.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        client_email: { type: "string" },
        description: { type: "string", description: "What the invoice is for" },
        amount: { type: "number" },
        currency: { type: "string", description: "ISO code, default USD" },
        due_in_days: { type: "integer", description: "Default 14" },
      },
      required: ["client_name", "client_email", "description", "amount"],
    },
  },
  {
    name: "propose_reminder",
    description:
      "Queue a payment reminder for HUMAN APPROVAL. It is not sent until the user approves it.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        tone: { type: "string", enum: ["friendly", "firm", "final"] },
        subject: { type: "string" },
        message: {
          type: "string",
          description: "Email body, plain text, no placeholders",
        },
      },
      required: ["invoice_id", "tone", "subject", "message"],
    },
  },
];
const oaiTools = tools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  },
}));

const handlers = {
  async list_invoices() {
    return {
      today: now().toISOString().slice(0, 10),
      invoices: await getRows(),
    };
  },
  async create_and_send_invoice(a) {
    if (!/\S+@\S+\.\S+/.test(String(a.client_email || "")))
      throw new Error("Invalid client_email");
    if (!(Number(a.amount) > 0))
      throw new Error("amount must be a positive number");
    const inv = await createAndSendInvoice({
      name: a.client_name,
      email: a.client_email,
      description: a.description,
      amount: Number(a.amount),
      currency: (a.currency || "USD").toUpperCase(),
      dueInDays: a.due_in_days ?? 14,
    });
    return { ok: true, ...inv };
  },
  async propose_reminder(a) {
    const row = (await getRows()).find((r) => r.id === a.invoice_id);
    if (!row) throw new Error("Unknown invoice_id");
    if (!UNPAID.has(row.status))
      throw new Error(`Invoice is ${row.status}; no reminder needed`);
    if (row.pendingProposal)
      throw new Error(
        "A reminder is already awaiting approval for this invoice",
      );
    const id = nextProposal++;
    proposals.set(id, {
      id,
      invoiceId: row.id,
      number: row.number,
      client: row.client,
      tone: a.tone,
      subject: String(a.subject).slice(0, 200),
      message: String(a.message).slice(0, 3500),
      daysOverdue: row.daysOverdue,
      status: "pending",
    });
    return { proposal_id: id, status: "awaiting_human_approval" };
  },
};

const system =
  () => `You are Nudge, an accounts-receivable agent for a freelancer. Today is ${now().toISOString().slice(0, 10)}.
Rules:
1. Create an invoice only when you have client name, client email, amount and what it is for. Otherwise ask ONE short question.
2. You cannot send reminders. propose_reminder queues them for the human to approve.
3. To chase payments: call list_invoices first. Propose reminders only for overdue invoices that have no pending proposal.
4. Tone by days overdue: 1-7 friendly, 8-21 firm but polite, 22+ final notice (calm). Consider reminders already sent. Never threaten, never invent fees or legal action. Write complete emails with no placeholders, signed "Thanks".
5. Be brief. Report only what tools actually returned.`;

let history = [];
const trim = (m) => {
  while (m.length > 40) {
    m.shift();
    while (m.length && m[0].role !== "user") m.shift();
  }
  return m;
};

async function runAgent(text) {
  const msgs = [...history, { role: "user", content: text }];
  for (let i = 0; i < 8; i++) {
    const res = await ai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: system() }, ...msgs],
      tools: oaiTools,
    });
    const msg = res.choices[0].message;
    msgs.push({
      role: "assistant",
      content: msg.content,
      tool_calls: msg.tool_calls,
    });
    if (!msg.tool_calls?.length) {
      history = trim(msgs);
      return clean(msg.content);
    }
    for (const call of msg.tool_calls) {
      let out;
      try {
        const fn = handlers[call.function.name];
        if (!fn) throw new Error(`Unknown tool ${call.function.name}`);
        out = JSON.stringify(
          await fn(JSON.parse(call.function.arguments || "{}")),
        );
      } catch (e) {
        out = `Error: ${e.message}`;
      }
      msgs.push({ role: "tool", tool_call_id: call.id, content: out });
    }
  }
  history = trim(msgs);
  return "I hit my step limit. Please try a more specific request.";
}

// ---------- Routes ----------
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  });

app.get(
  "/api/invoices",
  h(async (_, res) => res.json(await getRows())),
);
app.get("/api/state", (_, res) => res.json({ dayOffset }));
app.get("/api/proposals", (_, res) =>
  res.json([...proposals.values()].filter((p) => p.status === "pending")),
);

app.post(
  "/api/chat",
  h(async (req, res) => {
    const text = String(req.body?.message || "").trim();
    if (!text) return res.status(400).json({ error: "Empty message" });
    res.json({ reply: await runAgent(text) });
  }),
);

app.post(
  "/api/proposals/:id/approve",
  h(async (req, res) => {
    const p = proposals.get(Number(req.params.id));
    if (!p || p.status !== "pending")
      return res.status(404).json({ error: "Proposal not found" });
    await pp("POST", `/v2/invoicing/invoices/${p.invoiceId}/remind`, {
      subject: p.subject,
      note: p.message,
      send_to_invoicer: false,
    });
    p.status = "sent";
    reminderLog.set(p.invoiceId, [
      ...(reminderLog.get(p.invoiceId) || []),
      { at: new Date().toISOString(), tone: p.tone },
    ]);
    res.json({ ok: true });
  }),
);

app.post("/api/proposals/:id/reject", (req, res) => {
  const p = proposals.get(Number(req.params.id));
  if (p) p.status = "rejected";
  res.json({ ok: true });
});

app.post(
  "/api/invoices/:id/mark-paid",
  h(async (req, res) => {
    const row = (await getRows()).find((r) => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: "Invoice not found" });
    await pp("POST", `/v2/invoicing/invoices/${row.id}/payments`, {
      method: "OTHER",
      note: "Marked paid from Nudge demo",
      payment_date: new Date().toISOString().slice(0, 10),
      amount: { currency_code: row.currency, value: row.amount.toFixed(2) },
    });
    res.json({ ok: true });
  }),
);

app.post("/api/clock", (req, res) => {
  dayOffset = req.body?.reset ? 0 : dayOffset + (Number(req.body?.add) || 0);
  res.json({ dayOffset });
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`Nudge running on http://localhost:${port}`),
);
