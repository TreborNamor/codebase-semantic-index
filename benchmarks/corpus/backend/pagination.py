"""Stable traversal of large result collections."""
import base64
import json


def encode_cursor(created_at, row_id):
    return base64.urlsafe_b64encode(json.dumps([created_at, row_id]).encode()).decode()


def decode_cursor(value):
    """Validate an opaque continuation token before building database filters."""
    try:
        timestamp, row_id = json.loads(base64.urlsafe_b64decode(value))
        if not isinstance(timestamp, str) or type(row_id) is not int:
            raise ValueError()
        return timestamp, row_id
    except Exception as error:
        raise ValueError('Invalid continuation token') from error


def page_after(database, cursor, limit=50):
    """Keyset pagination uses timestamp plus ID to avoid duplicates on ties."""
    boundary = decode_cursor(cursor) if cursor else None
    rows = database.fetch_after(boundary, order_by=('created_at', 'id'), limit=min(200, limit) + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    next_token = encode_cursor(rows[-1].created_at, rows[-1].id) if more else None
    return rows, next_token
