# AgentShelf

Make any small shop buyable by AI agents in 5 minutes. A seller photographs their price list, AI builds a catalog, and the shop appears in one MCP connector. The buyer's assistant (Claude, ChatGPT) finds a product or a free slot and creates an order, and the buyer confirms payment in PayPal.

Early development. PayPal runs in sandbox only.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy

[`render.yaml`](render.yaml) defines the Render web service. Render deploys `main` automatically.

## License

[MIT](LICENSE)
