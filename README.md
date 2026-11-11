# Nudge – an AI agent that chases invoices (politely)

Built for the PayPal AI Hackathon. Nudge lets a freelancer create and send PayPal invoices in plain English. It spots overdue invoices and drafts payment reminders, but **a human approves every reminder before PayPal sends it.**

## How it works
- **PayPal Invoicing API (sandbox):** create, send, remind, record payment, list invoices
- **AI agent:** NVIDIA Nemotron on Nebius Token Factory (OpenAI-compatible, tool calling)
- **AG Grid Community** for the invoice dashboard
- **Demo clock:** the "+7 days" button simulates time passing so invoices become overdue. Reminders are still sent through the real PayPal API.

## Run locally
1. Install Node.js 20+.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your PayPal sandbox Client ID/Secret, a sandbox Personal account email (`SEED_EMAIL`), and your Nebius API key.
4. `npm run llm-test` (should print PASS)
5. `npm run seed` (creates 4 demo invoices)
6. `npm start`, then open http://localhost:3000

Try: "Who owes me money?", click "+7 days" twice, then "Chase my overdue invoices".

## License
MIT