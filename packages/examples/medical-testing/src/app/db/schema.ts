import type { Db } from "../ports/db.js"

/** One statement per entry — the `Db` port runs a single statement per call, like a real pg client. */
const STATEMENTS = [
  `CREATE TABLE users (
    id uuid PRIMARY KEY,
    provider text NOT NULL,
    subject text NOT NULL,
    email text,
    name text,
    picture text,
    role text NOT NULL DEFAULT 'patient',
    notifications boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
  )`,
  `CREATE TABLE lab_tests (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    price_cents integer NOT NULL,
    catalog_test_id text NOT NULL
  )`,
  `CREATE TABLE orders (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    status text NOT NULL,
    checkout_session_id text UNIQUE NOT NULL,
    lab_order_id text,
    interpretation text,
    results_json text NOT NULL DEFAULT '[]',
    reviewed_at timestamptz,
    review_note text,
    reviewer text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE order_events (
    id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders (id),
    status text NOT NULL, detail text NOT NULL, actor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE audit_events (
    id uuid PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE order_items (
    id uuid PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders (id),
    lab_test_id uuid NOT NULL REFERENCES lab_tests (id),
    price_cents integer NOT NULL
  )`,
]

export const migrate = async (db: Db): Promise<void> => {
  for (const statement of STATEMENTS) await db.query(statement)
}
