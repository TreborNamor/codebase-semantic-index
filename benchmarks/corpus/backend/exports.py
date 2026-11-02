"""Downloadable reporting files."""
import csv
import io


def protect_spreadsheet_cell(value):
    """Neutralize formula injection when a CSV is opened in a spreadsheet."""
    text = str(value)
    return "'" + text if text.startswith(('=', '+', '-', '@', '\t', '\r')) else text


def stream_csv(records, columns):
    """Yield report rows without materializing the whole export in memory."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    yield buffer.getvalue()
    for record in records:
        buffer.seek(0)
        buffer.truncate()
        writer.writerow([protect_spreadsheet_cell(record[column]) for column in columns])
        yield buffer.getvalue()


def redact_personal_data(record):
    """Hide contact details from analytics downloads."""
    return {key: value for key, value in record.items() if key not in {'email', 'phone', 'address'}}
