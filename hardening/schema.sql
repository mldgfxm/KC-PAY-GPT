CREATE TABLE IF NOT EXISTS activation_claims (
    job_key VARCHAR(64) PRIMARY KEY,
    account_key CHAR(64) NOT NULL,
    cdk_code VARCHAR(32) NOT NULL,
    lease_until DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_activation_account (account_key),
    UNIQUE KEY uniq_activation_cdk (cdk_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_receipts (
    job_key VARCHAR(64) PRIMARY KEY,
    payload JSON NOT NULL,
    paid_at DATETIME NOT NULL,
    recorded_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS renewal_jobs (
    job_key VARCHAR(64) PRIMARY KEY,
    state VARCHAR(24) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_owner VARCHAR(64) NULL,
    lease_until DATETIME NULL,
    last_message VARCHAR(255) NULL,
    confirmed_at DATETIME NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_renewal_due (state, next_attempt_at, lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
