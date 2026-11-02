CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payment_events (
    event_id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_invoice_account_status ON invoices(account_id, status);

CREATE VIEW monthly_revenue AS
SELECT account_id, DATE_TRUNC('month', paid_at) AS period, SUM(amount) AS revenue
FROM invoices WHERE status = 'paid'
GROUP BY account_id, DATE_TRUNC('month', paid_at);
