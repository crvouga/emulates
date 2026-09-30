# @crvouga/mockingbird-service-kill-bill

> Familiar calls. Faithful echoes. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful Kill Bill REST mock for billing integration tests. It models tenant-scoped accounts, payment methods, subscriptions, bundles, invoices, payments, credits, refunds, retries, catalogs, audit metadata, a test clock, account overdue state, and secret-protected lifecycle webhooks.

## Install

```bash
npm install -D @crvouga/mockingbird-service-kill-bill
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-kill-bill/server"

const mock = await createServer()
process.env.KILL_BILL_URL = mock.url
```

The default credentials are Basic auth `admin:password` plus tenant headers `X-Killbill-ApiKey: bob` and `X-Killbill-ApiSecret: lazar`. Mutations also require `X-Killbill-CreatedBy`; optional reason and comment headers are recorded in the audit journal.

`POST /1.0/kb/tenants` creates another tenant with Basic auth and `X-Killbill-CreatedBy` only. Accounts created with that tenant's api key stay hidden from other tenants. `POST /1.0/kb/tenants/registerNotificationCallback?cb=` stores one push-notification URL for the tenant; invoice and payment events are POSTed there as Kill Bill notification JSON. The in-process `onEvent` hook still receives those events.

## Controls

- `POST /__admin/payments/decline-next` and `/pending-next` select the next payment outcome.
- `POST /__admin/payments/:id/retry` succeeds the latest failed or pending transaction.
- `POST /__admin/catalog/plans` seeds a plan.
- `GET /__admin/billing` inspects billing state and audit entries. `GET /__admin/state` is the shared collection view.
- `GET /1.0/kb/test/clock` returns Kill Bill's clock JSON (`currentUtcTime`, `localDate`, `timeZone`). `PUT /1.0/kb/test/clock?requestedDate=...` advances recurring billing.
- `PUT /1.0/kb/subscriptions/:id/undoChangePlan` cancels a pending plan change. With no pending change it returns 400 and Kill Bill error code 1071.
- `GET /1.0/kb/test/queues?timeoutSec=` returns 200 when no due notification or bus event is outstanding, and 412 after that many seconds when work remains. The default timeout is 5 seconds. A notification counts only when its `effectiveDate` is at or before the clock; rows in `kb_bus_events` always count. Both collections are visible through `GET /__admin/state`.
- Fault presets cover plugin failure, rate limiting, network loss, and webhook duplicate/reorder/drop delivery.

## API

- `KillBillAPI`, `KillBillAPIOptions`, `KillBillEvent`: REST handler and event contract.
- Account, subscription, bundle, invoice, payment, transaction, and catalog state types.
- `createRuntime`, `KillBillRuntime`, `KillBillRuntimeOptions`: full runtime and webhook hub.
- `KILL_BILL_NAMESPACE`, `KILL_BILL_PRESETS`: namespace and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `KillBillServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`.

## Fidelity boundary

The mock targets deterministic adapter and lifecycle tests. It does not run Kill Bill plugins, tax engines, databases, notification workers, or production entitlement and dunning algorithms. Invoice payments with `externalPayment=true` are the exception: they are stored on the built-in `__EXTERNAL_PAYMENT__` method and are not sent to a gateway. `GET /1.0/kb/invoices/{invoiceId}/payments` returns those payments with `targetInvoiceId`. `GET /1.0/kb/invoicePayments/{paymentId}` returns that payment plus `targetInvoiceId`. `POST /1.0/kb/invoicePayments/{paymentId}/refunds` adds a `REFUND` on the same payment (Kill Bill 0.24.10). `externalPayment=true` on that refund records a separate credit payment instead, and leaves the original `refundedAmount` unchanged. `GET /1.0/kb/test/queues` only reports whether due notifications and bus events are still outstanding. A future-dated notification, including an end-of-term plan change whose effective date is still ahead of the clock, does not count. `GET /1.0/kb/accounts/{accountId}/overdue` uses a fixed Kill Bill 0.24.10 config: the synthetic clear state `__KILLBILL__CLEAR__OVERDUE_STATE__`, and state `OD1` once the earliest unpaid invoice (positive balance, not void) is at least one day old (`timeSinceEarliestUnpaidInvoiceEqualsOrExceeds`). Uploading a replacement overdue config is not modelled.
