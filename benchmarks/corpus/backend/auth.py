"""Account access and credentials."""
import hashlib
import hmac
import secrets
import time


def hash_password(password, salt=None):
    """Derive a salted password digest; never persist cleartext credentials."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 200_000)
    return salt.hex() + ':' + digest.hex()


def verify_password(password, stored):
    salt, expected = stored.split(':')
    actual = hash_password(password, bytes.fromhex(salt)).split(':')[1]
    return hmac.compare_digest(actual, expected)


def rotate_refresh_token(database, old_token, account_id):
    """Invalidate the previous session token and issue its replacement atomically."""
    replacement = secrets.token_urlsafe(32)
    with database.transaction():
        database.delete_token(old_token)
        database.save_token(account_id, replacement, expires=time.time() + 86400)
    return replacement


def require_role(user, required):
    """Reject requests from accounts missing the necessary permission."""
    if user is None or required not in user.roles:
        raise PermissionError('Insufficient access rights')
    return user
