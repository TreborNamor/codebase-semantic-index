"""Background work scheduling."""
import random
import time


def retry_delay(attempt, maximum=300):
    """Exponential backoff with jitter prevents synchronized retry storms."""
    return min(maximum, 2 ** attempt) * random.uniform(.5, 1.5)


def claim_next_job(database, worker_id):
    """Lease one pending task so concurrent workers cannot execute it together."""
    with database.transaction():
        row = database.select_pending_for_update(skip_locked=True)
        if row is None:
            return None
        database.lease(row.id, worker_id, until=time.time() + 60)
        return row


def recover_expired_leases(database, now=None):
    """Return abandoned tasks to the queue after a worker crashes."""
    return database.release_expired(now or time.time())


def schedule_digest(queue, account, now):
    """Send a daily summary once per user's local calendar day."""
    local = now.astimezone(account.timezone)
    key = f'digest:{account.id}:{local.date()}'
    return queue.enqueue_unique(key, account.id, run_at=local.replace(hour=9, minute=0))
