"""Workspace B fixture for real VS Code / Copilot integration checks."""


def beta_beacon():
    """Identify the opened billing project without any external service."""
    return "CODECONVERGE_PROJECT_BETA"


def calculate_invoice_total(line_items):
    """Sum the price multiplied by quantity for each invoice line."""
    return sum(item["price"] * item["quantity"] for item in line_items)
