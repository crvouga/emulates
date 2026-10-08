# Getting started

Install a Mockingbird emulator, create a runtime, and send vendor-compatible requests. Each
service is a self-contained TypeScript package with its own coverage matrix and integration guide.

## Choose an emulator

Browse the [emulator catalog](https://mockingbird.chrisvouga.dev/services) for your vendor or
database. Read its package README and coverage matrix before choosing an operation. HTTP
emulators expose a Fetch handler; database emulators expose their documented SQL or protocol
interfaces. Each package declares the vendor surface it implements and its parity evidence.

## Featured emulators

The docs star four featured emulators as starting points for common integrations:

- ⭐ [Stripe](https://mockingbird.chrisvouga.dev/services/stripe): payments, billing, and webhooks.
- ⭐ [PostgreSQL](https://mockingbird.chrisvouga.dev/services/postgres): SQL data and a compatible wire protocol.
- ⭐ [Amazon S3](https://mockingbird.chrisvouga.dev/services/s3): buckets and object storage.
- ⭐ [Junction](https://mockingbird.chrisvouga.dev/services/junction): healthcare integrations and lab orders.

Use the [Featured filter](https://mockingbird.chrisvouga.dev/services?featured=1) to find them in the catalog. Stars mark editorial selections; check each emulator's coverage and parity separately.

## Install the packages

This checkout example uses PostgreSQL for products and orders, and Stripe for payments. Install both emulators alongside your development dependencies:

```bash
npm install -D @crvouga/mockingbird-service-postgres @crvouga/mockingbird-service-stripe
```

The portable entry runs in Node 22+, Bun 1.2+, browsers, and Workers. Listening servers use
the separate `./server` entry or CLI. Follow the service guide for SDK configuration and
synthetic credentials; local emulation needs no vendor account.

## Build a checkout

Save these three files in the same directory. The Data → API → Client flow reads a product, confirms a payment, and stores the order. The PostgreSQL engine, Stripe emulator, and application API all run locally.

### Data · `data.ts`

Seed a product catalog and an orders table in the PostgreSQL emulator.

```ts
import { Database } from "@crvouga/mockingbird-service-postgres"

export const db = new Database()

db.exec(`
  CREATE TABLE products (id text PRIMARY KEY, name text, price integer);
  CREATE TABLE orders (id text PRIMARY KEY, product_id text, payment_id text);

  INSERT INTO products VALUES ('starter-kit', 'Developer starter kit', 2900);
`)

// Real SQL, in memory. No database server to configure.
console.log(db.query("SELECT name, price FROM products"))
// [{ name: "Developer starter kit", price: 2900 }]
```

### API · `api.ts`

Read a product, charge through the Stripe emulator, and persist the order.

```ts
import { createRuntime } from "@crvouga/mockingbird-service-stripe"
import { db } from "./data.ts"

export const stripe = createRuntime()

export const api = {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/orders") {
      return Response.json({ error: "Not found" }, { status: 404 })
    }
    const { productId } = await request.json()
    const [product] = db.query<{ price: number }>(
      "SELECT price FROM products WHERE id = $1", [productId],
    )
    if (!product) return Response.json({ error: "Product not found" }, { status: 404 })

    const payment = await stripe.fetch(new Request("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: { authorization: "Bearer sk_test_mockingbird" },
      body: new URLSearchParams({
        amount: String(product.price), currency: "usd",
        payment_method: "pm_card_visa", confirm: "true",
      }),
    }))
    if (!payment.ok) return payment
    const intent = await payment.json()
    if (intent.status !== "succeeded") {
      return Response.json({ paymentStatus: intent.status }, { status: 402 })
    }

    const orderId = crypto.randomUUID()
    db.prepare("INSERT INTO orders VALUES ($1, $2, $3)").run(orderId, productId, intent.id)
    return Response.json({ orderId, paymentStatus: intent.status }, { status: 201 })
  },
}
```

### Client · `client.ts`

Place an order through the application's Fetch handler. The whole flow stays local.

```ts
import { api } from "./api.ts"

// The same Request / Response interface your client already uses.
export const response = await api.fetch(new Request("http://app.local/orders", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ productId: "starter-kit" }),
}))

export const order = await response.json()
console.log(response.status)       // 201
console.log(order.paymentStatus)   // "succeeded"

// Product read → payment confirmed → order saved.
// PostgreSQL + Stripe + your API, without a single network request.
```

### Run the client

```bash
bun client.ts
# Node: npx tsx client.ts
```

The client prints `201` and `succeeded`. The paid order remains in PostgreSQL, and the payment remains in the Stripe runtime. The vendor URL identifies the route; `stripe.fetch` handles it locally. Use fresh emulators or reset their state between independent tests.

When your SDK accepts a Fetch implementation, inject the emulator's handler as documented in the service guide. When the SDK requires a base URL, start a listening server.

## Serve an emulator on a local port

```bash
npx mockingbird-stripe serve --port 8787
```

Point your SDK's base URL at the printed endpoint. HTTP emulators share health, state,
request journals, and an admin UI under `/__admin`:

| Route | Purpose |
| --- | --- |
| `GET /__admin/health` | Readiness |
| `GET /__admin/state` | Collections and stored records |
| `GET /__admin/requests` | Request journal |
| `GET /__admin/ui` | Interactive runtime administration |

Use `adminPrefix` or `--admin-prefix` to relocate the control routes. Configure an admin
key when you need one; see [Authoring a service](AUTHORING_A_SERVICE.md) for the shared
control interface and [Fleets](FLEETS.md) for coordinating several emulators.

## Understand coverage and parity

The interactive playground executes the same package in your browser. Supported operations,
verified samples, and parity evidence are separate indicators. Read the package's documented
limits before relying on vendor behavior.

[Testing and parity](TESTING.md) explains reproducibility checks and differential verification
against an oracle. Report missing behavior using the [issue guide](REPORTING_ISSUES.md).
