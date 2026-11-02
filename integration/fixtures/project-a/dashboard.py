"""Workspace A fixture for real VS Code / Copilot integration checks."""


def alpha_beacon():
    """Identify the opened dashboard project without any external service."""
    return "CODECONVERGE_PROJECT_ALPHA"


def update_dashboard_filters(current_filters, selected_region):
    """Return dashboard filters with the selected region applied."""
    updated = dict(current_filters)
    updated["region"] = selected_region
    return updated
